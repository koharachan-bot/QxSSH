// Package tui 实现 QxSSH 的全屏终端界面。
//
// 它直接使用与界面无关的核心运行时（配置存储与 SSH 连接池），不经过 HTTP：
//   - 主机列表页：浏览、过滤并选择主机；
//   - 会话页：把本机终端全屏转发到远端 PTY shell，Ctrl+] 断开；
//   - 状态栏：显示当前页、主机数量、选中主机与最近一条提示，并带版本号。
//
// 渲染使用 ANSI 转义序列与 alternate screen，退出时恢复光标、颜色与终端模式；
// 宽字符（CJK、emoji）按显示宽度计算列宽，保证表格对齐。
package tui

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"qxssh/internal/config"
	"qxssh/internal/logging"
	"qxssh/internal/sshpool"
)

// Deps 是 TUI 运行时所需的共享核心依赖，由调用方装配并持有生命周期。
type Deps struct {
	Store   *config.Store
	Pool    *sshpool.Pool
	Log     *logging.Logger
	Version string
}

// Run 以全屏终端界面运行，直到用户退出或 ctx 取消；退出时必须恢复终端状态。
//
// 非交互式终端（stdin 或 stdout 不是 TTY）会立即返回错误，绝不阻塞等待输入。
// ctx 取消时 Run 停止输入协程、恢复光标与终端模式，然后返回 ctx 的错误。
func Run(ctx context.Context, deps Deps) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if deps.Store == nil {
		return errors.New("TUI 缺少配置存储（Store 为 nil）")
	}
	if deps.Pool == nil {
		return errors.New("TUI 缺少 SSH 连接池（Pool 为 nil）")
	}
	if !isTerminal(os.Stdin) || !isTerminal(os.Stdout) {
		return errors.New("TUI 需要交互式终端（stdin/stdout 不是 TTY）")
	}

	restore, err := enterRawState(os.Stdin, os.Stdout)
	if err != nil {
		return fmt.Errorf("切换到终端原始模式失败: %w", err)
	}
	defer func() { _ = restore() }()

	out := &output{w: os.Stdout}
	scr := newScreen(out)
	if err := scr.enter(); err != nil {
		return fmt.Errorf("初始化全屏终端失败: %w", err)
	}
	defer func() { _ = scr.leave() }()

	return newApp(deps, out, scr).run(ctx)
}

// actionKind 是主机列表页交给主循环的操作类型。
type actionKind uint8

const (
	// actionNone 表示没有操作，继续停留在列表页。
	actionNone actionKind = iota
	// actionQuit 表示用户要求退出界面。
	actionQuit
	// actionOpen 表示用户要求连接选中主机。
	actionOpen
)

// action 是列表页产生的一次操作请求。
type action struct {
	kind actionKind
	host config.PublicHost
}

// app 持有 TUI 的全部可变状态。
//
// 状态只在主循环协程中读写；输入协程只向 channel 投递原始字节，
// 因此不需要对界面状态额外加锁。终端写入由 output 串行化。
type app struct {
	deps   Deps
	out    *output
	screen *screen

	width  int
	height int

	hosts *hostList

	rawCh    chan []byte
	inputErr chan error
	resizeCh chan struct{}
	ticker   *time.Ticker
	done     chan struct{}

	readerWG sync.WaitGroup
	stopOnce sync.Once

	keyBuf []byte

	message    string
	messageErr bool
}

// newApp 构造界面状态机。
func newApp(deps Deps, out *output, scr *screen) *app {
	return &app{
		deps:     deps,
		out:      out,
		screen:   scr,
		width:    80,
		height:   24,
		hosts:    &hostList{},
		rawCh:    make(chan []byte, 64),
		inputErr: make(chan error, 1),
		resizeCh: make(chan struct{}, 1),
		ticker:   time.NewTicker(200 * time.Millisecond),
		done:     make(chan struct{}),
	}
}

// run 是界面主循环：在主机列表页与会话页之间切换，直到用户退出或 ctx 取消。
func (a *app) run(ctx context.Context) error {
	defer a.ticker.Stop()
	a.startReader()
	defer a.stopReader()

	stopResizeWatch := watchResize(ctx, a.resizeCh)
	defer stopResizeWatch()

	a.hosts.load(a.deps.Store)
	a.refreshSize()
	a.logInfo("tui started", "version", a.version(), "hosts", len(a.hosts.all))

	for {
		act, err := a.hostsLoop(ctx)
		if err != nil {
			return err
		}
		switch act.kind {
		case actionQuit:
			a.logInfo("tui exit")
			return nil
		case actionOpen:
			a.openShell(ctx, act.host)
			if err := ctx.Err(); err != nil {
				return err
			}
		default:
			return nil
		}
	}
}

// hostsLoop 运行主机列表页的事件循环，直到用户退出、选择主机或 ctx 取消。
//
// 只有状态变化或窗口尺寸变化才重绘整页：ticker 仅用于 Windows 等没有
// SIGWINCH 的平台轮询尺寸，尺寸没变时不会触发重绘，避免无谓的全屏刷新。
func (a *app) hostsLoop(ctx context.Context) (action, error) {
	for {
		if err := a.drawHosts(); err != nil {
			return action{}, err
		}
		redraw := false
		for !redraw {
			select {
			case <-ctx.Done():
				return action{}, ctx.Err()
			case err := <-a.inputErr:
				return action{}, fmt.Errorf("读取终端输入失败: %w", err)
			case <-a.resizeCh:
				a.refreshSize()
				redraw = true
			case <-a.ticker.C:
				oldWidth, oldHeight := a.width, a.height
				a.refreshSize()
				redraw = oldWidth != a.width || oldHeight != a.height
			case chunk := <-a.rawCh:
				redraw = true
				if act := a.handleHostBytes(chunk); act.kind != actionNone {
					return act, nil
				}
			}
		}
	}
}

// startReader 启动 stdin 读取协程，把原始字节投递给主循环。
//
// 这里不做按键解析：会话页需要未经加工的字节流，列表页则在主循环里解析，
// 两种用途共用同一个读取协程。
func (a *app) startReader() {
	a.readerWG.Add(1)
	go func() {
		defer a.readerWG.Done()
		buf := make([]byte, 1024)
		for {
			select {
			case <-a.done:
				return
			default:
			}
			if !waitReadable(os.Stdin, 200*time.Millisecond, a.done) {
				continue
			}
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				select {
				case a.rawCh <- chunk:
				case <-a.done:
					return
				}
			}
			if err != nil {
				select {
				case a.inputErr <- err:
				default:
				}
				return
			}
		}
	}()
}

// stopReader 通知读取协程退出，并有限时间等待它结束。
//
// Unix 上用 poll 轮询，阻塞读取可以被及时打断；Windows 控制台在没有输入时
// 会阻塞在一次 Read 上，系统调用无法用 context 中断，因此最多等待 300ms。
// 这次阻塞读随进程退出被回收，不影响终端恢复。
func (a *app) stopReader() {
	a.stopOnce.Do(func() { close(a.done) })
	finished := make(chan struct{})
	go func() {
		a.readerWG.Wait()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(300 * time.Millisecond):
	}
}

// handleHostBytes 把新到的字节追加到按键缓冲区并逐个处理完整按键。
func (a *app) handleHostBytes(chunk []byte) action {
	a.keyBuf = append(a.keyBuf, chunk...)
	for len(a.keyBuf) > 0 {
		k, n, ok := nextKey(a.keyBuf)
		if !ok {
			break
		}
		a.keyBuf = a.keyBuf[n:]
		if act := a.handleHostKey(k); act.kind != actionNone {
			return act
		}
	}
	if len(a.keyBuf) == 0 {
		a.keyBuf = nil
	}
	return action{}
}

// handleHostKey 处理主机列表页的一个按键。
func (a *app) handleHostKey(k key) action {
	if a.hosts.filtering {
		return a.handleFilterKey(k)
	}
	switch k.kind {
	case keyUp:
		a.hosts.move(-1)
	case keyDown:
		a.hosts.move(1)
	case keyPageUp:
		a.hosts.move(-a.listRows())
	case keyPageDown:
		a.hosts.move(a.listRows())
	case keyHome:
		a.hosts.selectFirst()
	case keyEnd:
		a.hosts.selectLast()
	case keyEnter:
		host, ok := a.hosts.selected()
		if !ok {
			a.setMessage("主机列表为空，请先在 Web 控制台添加主机", true)
			return action{}
		}
		return action{kind: actionOpen, host: host}
	case keyEsc:
		if a.hosts.filter != "" {
			a.hosts.clearFilter()
			a.setMessage("已清除过滤条件", false)
		}
	case keyRune:
		switch k.r {
		case 'q', 'Q':
			return action{kind: actionQuit}
		case 'r', 'R':
			a.reloadHosts()
		case '/':
			a.hosts.clearFilter()
			a.hosts.beginFilter()
		case 'k':
			a.hosts.move(-1)
		case 'j':
			a.hosts.move(1)
		case 'g':
			a.hosts.selectFirst()
		case 'G':
			a.hosts.selectLast()
		}
	case keyCtrl:
		if k.ctrl == 0x03 { // Ctrl+C
			return action{kind: actionQuit}
		}
	}
	return action{}
}

// handleFilterKey 处理过滤输入模式下的按键：可打印字符进入过滤条件，
// 退格删除、Enter 确认、Esc 取消并清空过滤。
func (a *app) handleFilterKey(k key) action {
	switch k.kind {
	case keyEsc:
		a.hosts.endFilter(true)
	case keyEnter:
		a.hosts.endFilter(false)
	case keyBackspace:
		a.hosts.backspaceFilter()
	case keyRune:
		a.hosts.appendFilter(k.r)
	case keyUp:
		a.hosts.move(-1)
	case keyDown:
		a.hosts.move(1)
	case keyCtrl:
		if k.ctrl == 0x03 { // Ctrl+C
			return action{kind: actionQuit}
		}
	}
	return action{}
}

// reloadHosts 从配置存储重新载入主机列表并给出提示。
func (a *app) reloadHosts() {
	a.hosts.load(a.deps.Store)
	a.hosts.ensureVisible(a.listRows())
	a.setMessage(fmt.Sprintf("已重新载入 %d 台主机", len(a.hosts.all)), false)
}

// listRows 返回当前尺寸下主机列表区可显示的行数。
func (a *app) listRows() int {
	if a.height >= 7 {
		return maxInt(1, a.height-5)
	}
	return maxInt(1, a.height-2)
}

// drawHosts 渲染主机列表页：标题、表头、列表、消息行与状态栏各占固定区域。
// 尺寸由事件循环刷新，这里只按当前尺寸绘制，避免每帧重复读取终端。
func (a *app) drawHosts() error {
	width, height := a.width, a.height
	if width < 12 {
		width = 12
	}
	if height < 3 {
		height = 3
	}
	lineWidth := width - 1
	if lineWidth < 8 {
		lineWidth = 8
	}

	rows := a.listRows()
	a.hosts.ensureVisible(rows)
	widths := a.hostColumnWidths(lineWidth)

	lines := make([]string, 0, height)
	if height >= 7 {
		lines = append(lines, a.titleLine(lineWidth))
		lines = append(lines, tableHeader(widths))
		lines = append(lines, separatorLine(lineWidth))
	}
	lines = append(lines, a.hostRows(widths, rows)...)
	lines = append(lines, a.messageLine(lineWidth))
	lines = append(lines, a.statusLine(lineWidth))
	if len(lines) > height {
		lines = lines[:height]
	}
	return a.screen.frame(lines)
}

// titleLine 渲染标题行。
func (a *app) titleLine(width int) string {
	title := fmt.Sprintf("QxSSH 终端界面 · 共 %d 台主机", len(a.hosts.all))
	return seqBold + truncateWidth(title, width) + seqReset
}

// messageLine 渲染最近一条提示或错误；没有消息时显示快捷键提示。
func (a *app) messageLine(width int) string {
	text := a.message
	color := seqDim
	if text == "" {
		text = "↑/↓ 或 k/j 选择 · Enter 连接 · r 重新载入 · / 过滤 · q 退出"
	} else if a.messageErr {
		color = seqRed
	}
	return color + truncateWidth(text, width) + seqReset
}

// statusLine 渲染反色的状态栏：页名、主机数量、选中主机、过滤状态与版本号。
func (a *app) statusLine(width int) string {
	var text string
	if a.hosts.filtering {
		text = fmt.Sprintf("过滤: %s_ · 匹配 %d/%d 台 · Enter 确认 · Esc 取消",
			a.hosts.filter, len(a.hosts.view), len(a.hosts.all))
	} else {
		selected := "—"
		if host, ok := a.hosts.selected(); ok {
			selected = host.Name
		}
		text = fmt.Sprintf("主机列表 · 共 %d 台", len(a.hosts.all))
		if a.hosts.filter != "" {
			text += fmt.Sprintf("（过滤后 %d 台）", len(a.hosts.view))
		}
		text += fmt.Sprintf(" · 选中: %s · QxSSH v%s", selected, a.version())
	}
	return seqReverse + padWidth(truncateWidth(text, width), width) + seqReset
}

// hostColumnWidths 计算名称、地址、用户名、分组四列的显示宽度。
func (a *app) hostColumnWidths(total int) []int {
	natural := []int{
		stringWidth("名称"),
		stringWidth("地址"),
		stringWidth("用户名"),
		stringWidth("分组"),
	}
	const maxNatural = 24
	for _, host := range a.hosts.view {
		for i, cell := range hostCells(host) {
			if w := stringWidth(cell); w > natural[i] {
				natural[i] = w
			}
		}
	}
	for i := range natural {
		if natural[i] > maxNatural {
			natural[i] = maxNatural
		}
	}
	return fitColumns(natural, total)
}

// hostRows 渲染列表区内容；不足 rows 行时补空行，保证状态栏固定在底部。
func (a *app) hostRows(widths []int, rows int) []string {
	if rows < 1 {
		rows = 1
	}
	out := make([]string, 0, rows)
	if len(a.hosts.view) == 0 {
		hint := "（暂无主机）请先在 Web 控制台添加主机，然后按 r 重新载入"
		if a.hosts.filter != "" {
			hint = "（没有匹配的主机）按 Esc 清除过滤条件"
		}
		out = append(out, seqDim+padWidth(hint, tableWidth(widths))+seqReset)
	} else {
		end := a.hosts.offset + rows
		if end > len(a.hosts.view) {
			end = len(a.hosts.view)
		}
		for i := a.hosts.offset; i < end; i++ {
			out = append(out, hostRow(hostCells(a.hosts.view[i]), widths, i == a.hosts.sel))
		}
	}
	for len(out) < rows {
		out = append(out, "")
	}
	if len(out) > rows {
		out = out[:rows]
	}
	return out
}

// setMessage 更新状态消息；isErr 为真时以红色显示。
func (a *app) setMessage(msg string, isErr bool) {
	a.message = msg
	a.messageErr = isErr
}

// refreshSize 读取终端当前尺寸；读取失败时保留上一次的尺寸。
func (a *app) refreshSize() {
	width, height, err := termSize(os.Stdout)
	if err != nil || width <= 0 || height <= 0 {
		return
	}
	a.width = width
	a.height = height
}

// version 返回展示用版本号，未注入时显示 dev。
func (a *app) version() string {
	if a.deps.Version == "" {
		return "dev"
	}
	return a.deps.Version
}

// logInfo 写一条信息级日志；未注入日志器时静默跳过。
func (a *app) logInfo(msg string, kv ...any) {
	if a.deps.Log != nil {
		a.deps.Log.Info(msg, kv...)
	}
}

// logWarn 写一条警告级日志。
func (a *app) logWarn(msg string, kv ...any) {
	if a.deps.Log != nil {
		a.deps.Log.Warn(msg, kv...)
	}
}

// logDebug 写一条调试级日志。
func (a *app) logDebug(msg string, kv ...any) {
	if a.deps.Log != nil {
		a.deps.Log.Debug(msg, kv...)
	}
}

// maxInt 返回两个整数中较大的一个。
func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
