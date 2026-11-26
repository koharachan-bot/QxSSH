// Package console 把 QxSSH 的界面层做成可插拔的插件集合。
//
// 三套界面共用同一个与界面无关的核心（配置存储、SSH 连接池、端口转发、Web 代理）：
//   - web：浏览器控制台，监听 HTTP / WebSocket；
//   - gui：桌面外壳，当前是 web 的别名，等原生窗口落地后在本包内单独实现；
//   - tui：终端界面，直接使用核心层，不经过 HTTP。
//
// 命令行可同时选择多个插件（例如 -web -tui 同时开放浏览器与终端界面）；
// 一个进程内可以自由组合，所有插件退出后进程随之结束。
package console

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"sync"

	"qxssh/internal/bootstrap"
	"qxssh/internal/logging"
)

// Kind 标识界面插件背后的实现族。别名插件与本体共用同一个 Kind，
// 选择时按 Kind 去重，避免同一实现被启动两次（例如 gui 与 web 抢同一个端口）。
type Kind string

const (
	// KindWeb 是 HTTP 控制台实现族（对用户指定地址监听）。
	KindWeb Kind = "web"
	// KindTUI 是终端界面实现族（直接使用核心层，不监听端口）。
	KindTUI Kind = "tui"
	// KindGUI 是桌面外壳实现族（Windows WebView2 窗口，内部只绑回环）。
	KindGUI Kind = "gui"
)

// 插件名：命令行开关、日志与冲突提示统一使用这三个名字。
const (
	nameWeb = "web"
	nameGUI = "gui"
	nameTUI = "tui"
)

// order 是插件名的固定顺序：选择、解析与运行都按它排序，保证日志与测试稳定。
var order = []string{nameWeb, nameTUI, nameGUI}

// factories 是插件名到构造函数的注册表。新增一套界面只需在这里挂一项，
// 并在 order 中排好位置；选择、去重、运行都不必改动。
var factories = map[string]func() Plugin{
	nameWeb: func() Plugin { return webPlugin{} },
	nameTUI: func() Plugin { return tuiPlugin{} },
	nameGUI: func() Plugin { return guiPlugin{} },
}

// Options 是与具体界面无关的启动参数，由命令行解析后传入。
type Options struct {
	// Addr 是 web / gui 插件的 HTTP 监听地址。
	Addr string
	// TLS 非 nil 时 web / gui 插件以 HTTPS 提供服务。
	TLS *tls.Config
	// Open 为真时 web / gui 插件在监听成功后打开系统默认浏览器。
	Open bool
}

// Env 是插件运行所需的共享依赖。
type Env struct {
	// Core 是已装配好的核心运行时，进程退出前由调用方关闭。
	Core *bootstrap.Runtime
	// Log 与核心层共享的结构化日志器。
	Log *logging.Logger
	// Options 是命令行解析出的界面参数。
	Options Options
	// Quiet 为真表示终端已被 TUI 占用：其它插件不得再往控制台打印，
	// 否则会破坏全屏渲染。
	Quiet bool
}

// Plugin 是一套可插拔的 QxSSH 界面实现。
//
// 插件只负责自己的前台资源（HTTP 监听、终端屏幕等）与生命周期；
// 共享的核心资源由 Env 传入，插件不得关闭它们。
type Plugin interface {
	// Name 返回插件名（web / tui / gui），用于日志与选择。
	Name() string
	// Kind 返回实现族；同族插件只启动一次。
	Kind() Kind
	// Run 阻塞运行界面，直到 ctx 取消或界面自行退出。
	// 返回 nil 表示正常退出，返回 error 表示该界面启动失败或异常结束。
	Run(ctx context.Context, env Env) error
}

// Default 返回未显式指定任何界面开关时使用的插件：gui。
// gui 是当前默认入口，也是未来原生桌面的落点。
func Default() []string {
	return []string{nameGUI}
}

// Select 把三个界面开关转换为按固定顺序排列的插件名。
// 一个开关都没给时返回 Default。
func Select(web, tui, gui bool) []string {
	flags := map[string]bool{nameWeb: web, nameTUI: tui, nameGUI: gui}
	picked := make([]string, 0, len(order))
	for _, name := range order {
		if flags[name] {
			picked = append(picked, name)
		}
	}
	if len(picked) == 0 {
		return Default()
	}
	return picked
}

// Resolve 把插件名解析为可运行的插件实例：按固定顺序排序，并按实现族去重。
// gui 与 web 目前同族，同时选中时只启动一次，监听端口不会冲突。
func Resolve(names []string) ([]Plugin, error) {
	wanted := make(map[string]bool, len(names))
	for _, name := range names {
		if _, ok := factories[name]; !ok {
			return nil, fmt.Errorf("未知的界面插件 %q（可选：%s / %s / %s）", name, nameWeb, nameTUI, nameGUI)
		}
		wanted[name] = true
	}

	plugins := make([]Plugin, 0, len(wanted))
	seen := make(map[Kind]bool, len(wanted))
	for _, name := range order {
		if !wanted[name] {
			continue
		}
		p := factories[name]()
		if seen[p.Kind()] {
			// 同族插件只启动一次。当前只有 gui → web 这一条别名关系。
			continue
		}
		seen[p.Kind()] = true
		plugins = append(plugins, p)
	}
	if len(plugins) == 0 {
		return nil, errors.New("没有可启动的界面插件")
	}
	return plugins, nil
}

// HasKind 报告插件集合中是否存在指定实现族。
// 用于只对 web / gui 生效的启动前检查（例如 HTTP 安全约束）。
func HasKind(plugins []Plugin, kind Kind) bool {
	for _, p := range plugins {
		if p.Kind() == kind {
			return true
		}
	}
	return false
}

// RunAll 并发运行所有插件，直到 ctx 取消或任一插件退出。
// 任一插件退出都会取消其余插件，保证进程整体退出；返回第一个非 nil 错误。
func RunAll(ctx context.Context, plugins []Plugin, env Env) error {
	if len(plugins) == 0 {
		return errors.New("没有可启动的界面插件")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// TUI 独占终端时，其它插件的日志与提示会打断全屏渲染：统一静默控制台
	// （已配置的日志文件不受影响），web / gui 插件也据此跳过 URL 打印。
	env.Quiet = HasKind(plugins, KindTUI)
	if env.Log != nil {
		env.Log.SetConsole(!env.Quiet)
	}

	type result struct {
		name string
		err  error
	}
	results := make(chan result, len(plugins))
	var wg sync.WaitGroup

	for _, p := range plugins {
		env.Log.Info("console plugin enabled", "plugin", p.Name(), "kind", string(p.Kind()))
		wg.Add(1)
		go func(p Plugin) {
			defer wg.Done()
			err := p.Run(ctx, env)
			results <- result{name: p.Name(), err: err}
			// 任一面板结束都请求其余插件收尾：进程级生命周期保持一致。
			cancel()
		}(p)
	}
	go func() {
		wg.Wait()
		close(results)
	}()

	var firstErr error
	for r := range results {
		if r.err == nil || errors.Is(r.err, context.Canceled) || errors.Is(r.err, context.DeadlineExceeded) {
			continue
		}
		if firstErr == nil {
			firstErr = fmt.Errorf("界面插件 %s: %w", r.name, r.err)
		}
	}
	return firstErr
}
