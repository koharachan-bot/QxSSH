package tui

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"qxssh/internal/config"
)

// sessionExitKey 是退出远端会话的按键：Ctrl+]（0x1d）。
// 不使用 Esc 退出，把 Esc 完整留给远端程序。
const sessionExitKey = byte(0x1d)

// openShell 在 host 上打开远端 PTY shell，并把本机终端全屏转发给它。
//
// 会话期间本机 stdin 的原始字节写入远端 stdin，远端 stdout/stderr 原样写回
// 本机 stdout；窗口尺寸变化时调用 WindowChange 同步远端 PTY。Ctrl+] 退出会话，
// 远端 shell 自行退出时同样返回列表。返回前会清屏，调用方可直接重绘列表页。
func (a *app) openShell(ctx context.Context, host config.PublicHost) {
	a.drainInput()
	a.setMessage(fmt.Sprintf("正在连接「%s」…", host.Name), false)
	if err := a.drawHosts(); err != nil {
		a.setMessage("绘制界面失败: "+err.Error(), true)
		return
	}

	client, err := a.deps.Pool.Get(host.ID)
	if err != nil {
		a.setMessage(fmt.Sprintf("连接「%s」失败: %v", host.Name, err), true)
		a.logWarn("tui connect failed", "host", host.Name, "error", err.Error())
		return
	}
	sess, err := client.NewSession()
	if err != nil {
		a.setMessage(fmt.Sprintf("在「%s」上创建 SSH 会话失败: %v", host.Name, err), true)
		a.logWarn("tui new session failed", "host", host.Name, "error", err.Error())
		return
	}
	defer func() { _ = sess.Close() }()

	a.refreshSize()
	if err := sess.RequestPty("xterm-256color", a.height, a.width, ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}); err != nil {
		a.setMessage(fmt.Sprintf("向「%s」申请远端终端失败: %v", host.Name, err), true)
		a.logWarn("tui request pty failed", "host", host.Name, "error", err.Error())
		return
	}

	stdinW, err := sess.StdinPipe()
	if err != nil {
		a.setMessage(fmt.Sprintf("获取「%s」的远端输入通道失败: %v", host.Name, err), true)
		return
	}
	// 远端输出直接写入加锁的终端输出：Wait 返回时复制已经完成，
	// stdout 与 stderr 交错也不会写坏同一行。
	sess.Stdout = a.out
	sess.Stderr = a.out

	if !a.sessionBanner(ctx, host) {
		return
	}
	if err := a.screen.clear(); err != nil {
		a.setMessage("清屏失败: "+err.Error(), true)
		return
	}

	shellErr := make(chan error, 1)
	go func() { shellErr <- sess.Shell() }()

	writeCh := make(chan []byte, 32)
	stopPump := make(chan struct{})
	pumpDone := make(chan struct{})
	var pumpWG sync.WaitGroup
	pumpWG.Add(1)
	go func() {
		defer pumpWG.Done()
		defer close(pumpDone)
		pumpInput(stdinW, writeCh, stopPump)
	}()

	writable := true
	exitText := ""
	failed := false
session:
	for {
		select {
		case <-ctx.Done():
			exitText = "界面退出，会话已断开"
			failed = true
			break session
		case err := <-shellErr:
			exitText, failed = describeShellExit(err)
			break session
		case <-pumpDone:
			writable = false
			pumpDone = nil
		case chunk := <-a.rawCh:
			if !writable {
				continue
			}
			filtered, quit := filterExitKey(chunk)
			if quit {
				exitText = fmt.Sprintf("已断开与「%s」的会话（Ctrl+]）", host.Name)
				break session
			}
			if len(filtered) == 0 {
				continue
			}
			select {
			case writeCh <- filtered:
			case <-pumpDone:
				writable = false
			}
		case <-a.resizeCh:
			a.syncSessionSize(sess)
		case <-a.ticker.C:
			a.syncSessionSize(sess)
		}
	}

	close(stopPump)
	_ = sess.Close()
	_ = stdinW.Close()
	pumpWG.Wait()

	a.drainInput()
	_ = a.screen.clear()
	a.setMessage(exitText, failed)
	a.logInfo("tui session ended", "host", host.Name, "detail", exitText)
}

// sessionBanner 在远端 shell 接管屏幕前短暂提示退出方式。
// 返回 false 表示等待期间 ctx 已取消，调用方应直接结束会话。
func (a *app) sessionBanner(ctx context.Context, host config.PublicHost) bool {
	_ = a.screen.clear()
	line := fmt.Sprintf("已连接「%s」 · 按 Ctrl+] 退出会话 · 即将进入远端 shell", host.Name)
	_ = a.screen.frame([]string{"", "", line})
	select {
	case <-time.After(150 * time.Millisecond):
		return true
	case <-ctx.Done():
		return false
	}
}

// syncSessionSize 在终端尺寸变化时把新尺寸同步给远端 PTY。
func (a *app) syncSessionSize(sess *ssh.Session) {
	oldWidth, oldHeight := a.width, a.height
	a.refreshSize()
	if a.width == oldWidth && a.height == oldHeight {
		return
	}
	if err := sess.WindowChange(a.height, a.width); err != nil {
		a.logDebug("tui WindowChange failed", "error", err.Error())
	}
}

// filterExitKey 从输入块中剔除 Ctrl+] 字节，并报告是否应按该键退出会话。
func filterExitKey(chunk []byte) ([]byte, bool) {
	if bytes.IndexByte(chunk, sessionExitKey) < 0 {
		return chunk, false
	}
	out := make([]byte, 0, len(chunk))
	for _, c := range chunk {
		if c == sessionExitKey {
			continue
		}
		out = append(out, c)
	}
	return out, true
}

// describeShellExit 把远端 shell 的结束原因转换为中文提示，并报告是否属于异常结束。
func describeShellExit(err error) (string, bool) {
	if err == nil {
		return "远端 shell 已退出（状态码 0）", false
	}
	var exitErr *ssh.ExitError
	if errors.As(err, &exitErr) {
		return fmt.Sprintf("远端 shell 已退出（状态码 %d）", exitErr.ExitStatus()), exitErr.ExitStatus() != 0
	}
	var missingErr *ssh.ExitMissingError
	if errors.As(err, &missingErr) {
		return "远端 shell 已断开（服务器未返回退出状态）", true
	}
	return "会话异常结束: " + err.Error(), true
}

// drainInput 丢弃尚未处理的输入字节，避免上一页的残留按键影响下一页。
func (a *app) drainInput() {
	for {
		select {
		case <-a.rawCh:
		default:
			a.keyBuf = nil
			return
		}
	}
}

// pumpInput 把输入队列中的字节块写入远端 stdin，直到 stop 关闭或写失败。
//
// 即使远端输入已关闭也继续消费队列：主循环可能仍在向队列投递，
// 无人消费会让它永久阻塞在发送上。
func pumpInput(stdin io.WriteCloser, writeCh <-chan []byte, stop <-chan struct{}) {
	for {
		select {
		case <-stop:
			return
		case chunk := <-writeCh:
			if _, err := stdin.Write(chunk); err != nil {
				continue
			}
		}
	}
}
