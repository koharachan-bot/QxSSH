// Command qxssh 启动 QxSSH —— 一个自托管的 SSH 管理控制台。
//
// 它解析命令行参数，初始化加密配置存储与日志，装配与界面无关的核心运行时，
// 再按 -web / -tui / -gui 选择界面插件启动。三个开关可以自由组合；一个都不给时
// 默认启动 gui（当前是 web 的别名，未来换成原生桌面窗口）。
package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"qxssh/internal/bootstrap"
	"qxssh/internal/config"
	"qxssh/internal/console"
	"qxssh/internal/httpapi"
	"qxssh/internal/logging"
)

const banner = `
   ____      __  __
  /___ \_  _/ _\/ _\  /\  /\
 //  / | \/ | \ \ \  / /_/ /
/ \_/ / >  <_\ \_\ \/ __  /
\___,_\/_/\_\__/\__/\/ /_/

--------QxSSH v` + bootstrap.Version + `--------

`

func main() {
	os.Exit(run())
}

// envStr 读取字符串环境变量；未设置或为空时返回默认值。
func envStr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

// envBool 读取布尔环境变量，接受 1 / true / yes / on（大小写不敏感）。
func envBool(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// pluginNames 返回插件名列表，用于启动日志。
func pluginNames(plugins []console.Plugin) string {
	names := make([]string, 0, len(plugins))
	for _, p := range plugins {
		names = append(names, p.Name())
	}
	return strings.Join(names, ",")
}

// run 是程序的真正主体，返回进程退出码（0 表示正常）。
func run() int {
	addr := flag.String("addr", envStr("QXSSH_ADDR", "127.0.0.1:8800"), "listen address for the -web console plugin")
	confDir := flag.String("conf", envStr("QXSSH_CONF", ""), "config directory (default: user config dir)")
	open := flag.Bool("open", envBool("QXSSH_OPEN"), "open the console URL in the default browser on startup (-web only)")
	web := flag.Bool("web", envBool("QXSSH_WEB"), "run the web console plugin")
	tui := flag.Bool("tui", envBool("QXSSH_TUI"), "run the terminal UI plugin")
	gui := flag.Bool("gui", envBool("QXSSH_GUI"), "run the desktop GUI plugin (Windows WebView2 window)")
	logLevel := flag.String("log-level", os.Getenv("QXSSH_LOG_LEVEL"), "log level: debug|info|warn|error|silent")
	logFile := flag.String("log-file", os.Getenv("QXSSH_LOG_FILE"), "log file path; 'auto' = <conf>/logs/qxssh.log; empty = stdout only")
	authToken := flag.String("auth-token", os.Getenv("QXSSH_AUTH_TOKEN"), "optional auth token for remote access; empty = no auth")
	tlsCert := flag.String("tls-cert", os.Getenv("QXSSH_TLS_CERT"), "TLS certificate file (PEM); with -tls-key enables HTTPS")
	tlsKey := flag.String("tls-key", os.Getenv("QXSSH_TLS_KEY"), "TLS private key file (PEM)")
	kidRotate := flag.Bool("kid-rotate", false, "rotate the IdP signing key at startup; the old key is kept for token verification")
	flag.Parse()

	if *authToken != "" {
		_ = os.Setenv("QXSSH_AUTH_TOKEN", *authToken)
	}

	// 界面插件先解析：只有真正要监听 HTTP 的插件才需要做 Web 安全预检。
	plugins, err := console.Resolve(console.Select(*web, *tui, *gui))
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return 2
	}

	// 发布版以 Windows GUI 子系统链接：纯 gui 模式保持无控制台，双击启动不会
	// 出现黑窗；-web / -tui 则把标准流接回父终端（没有父终端时 tui 自建控制台）。
	console.PrepareConsole(plugins)

	if *authToken != "" && console.HasConsole() {
		fmt.Fprintln(os.Stderr, "提示：-auth-token 会出现在进程命令行（同机进程可见），建议改用环境变量 QXSSH_AUTH_TOKEN 注入。")
	}

	var tlsCfg *tls.Config
	if console.HasKind(plugins, console.KindWeb) {
		tlsCfg, err = console.PrepareWeb(*addr, *tlsCert, *tlsKey, *authToken)
		if err != nil {
			console.ReportError(err.Error())
			return 1
		}
	}

	if console.HasConsole() {
		fmt.Print(banner)
	}

	store, err := config.Load(*confDir)
	if err != nil {
		console.ReportError(fmt.Sprintf("加载配置失败: %v", err))
		return 1
	}

	level := logging.ParseLevel(*logLevel)
	lg := logging.New(level)
	switch *logFile {
	case "":
	case "auto":
		if err := lg.SetFile(logging.DefaultFile(store.Dir())); err != nil {
			lg.Warn("log file disabled", "error", err.Error())
		}
	default:
		path := *logFile
		if !filepath.IsAbs(path) {
			path = filepath.Join(store.Dir(), path)
		}
		if err := lg.SetFile(path); err != nil {
			lg.Warn("log file disabled", "error", err.Error())
		}
	}
	defer lg.Close()

	if *kidRotate {
		if err := httpapi.RotateIDPKeys(store.Dir()); err != nil {
			console.ReportError(fmt.Sprintf("rotate signing key: %v", err))
			return 1
		}
		if console.HasConsole() {
			fmt.Println("签名密钥已轮换；旧公钥保留在 <conf>/keys/archive/ 仅用于验签，旧私钥已销毁。")
		}
	}

	core, err := bootstrap.New(store, lg)
	if err != nil {
		console.ReportError("初始化失败: " + err.Error())
		return 1
	}

	lg.Info("QxSSH started",
		"version", bootstrap.Version,
		"configDir", store.Dir(),
		"hosts", len(store.ListHosts()),
		"logLevel", strings.ToLower(level.String()),
		"plugins", pluginNames(plugins),
	)
	if p := lg.Path(); p != "" {
		lg.Info("log file", "path", p)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()

	env := console.Env{
		Core:    core,
		Log:     lg,
		Options: console.Options{Addr: *addr, TLS: tlsCfg, Open: *open},
	}
	runErr := console.RunAll(ctx, plugins, env)

	if console.HasConsole() {
		fmt.Println("\nshutting down...")
	}
	lg.Info("shutting down")
	core.Shutdown()
	if runErr != nil {
		lg.Error("console plugin failed", "error", runErr.Error())
		console.ReportError(runErr.Error())
		return 1
	}
	return 0
}
