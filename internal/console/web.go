package console

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"runtime"
)

// webPlugin 是浏览器控制台：监听 HTTP / WebSocket，把 API 网关暴露给前端页面。
type webPlugin struct{}

// Name 返回插件名。
func (webPlugin) Name() string { return nameWeb }

// Kind 返回实现族。
func (webPlugin) Kind() Kind { return KindWeb }

// Run 监听端口并服务浏览器控制台，直到 ctx 取消。
func (webPlugin) Run(ctx context.Context, env Env) error {
	return serveWeb(ctx, env, nameWeb)
}

// PrepareWeb 校验 web 插件的启动前提，返回 TLS 配置（未启用时为 nil）。
//
// 只有真正对用户指定地址监听 HTTP 的 web 插件受这些约束：非回环地址必须配置
// 鉴权令牌，证书与私钥必须成对提供。gui 只监听本机回环随机端口，TUI 不监听端口。
func PrepareWeb(addr, tlsCert, tlsKey, authToken string) (*tls.Config, error) {
	if (tlsCert == "") != (tlsKey == "") {
		return nil, errors.New("拒绝启动：-tls-cert 与 -tls-key 必须同时提供")
	}
	var cfg *tls.Config
	if tlsCert != "" {
		cert, err := tls.LoadX509KeyPair(tlsCert, tlsKey)
		if err != nil {
			return nil, fmt.Errorf("加载 TLS 证书失败: %w", err)
		}
		cfg = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	}
	if authToken == "" && !isLoopbackListen(addr) {
		return nil, fmt.Errorf(
			"拒绝启动：监听地址 %q 非回环，但未配置 -auth-token（或环境变量 QXSSH_AUTH_TOKEN）；"+
				"无鉴权地暴露到网络会把全部主机凭据与命令执行能力公开给任何能访问该地址的人", addr)
	}
	return cfg, nil
}

// serveWeb 是 web 插件的实际实现：监听、提示访问地址、等待取消并优雅关闭。
func serveWeb(ctx context.Context, env Env, name string) error {
	opts := env.Options

	if opts.TLS == nil && !isLoopbackListen(opts.Addr) {
		env.Log.Warn("listening on a non-loopback address without TLS; "+
			"auth tokens, host passwords and key passphrases will cross the network in clear text",
			"addr", opts.Addr)
	}

	host, err := startHTTP(env, opts.Addr, opts.TLS)
	if err != nil {
		return err
	}

	url := host.URL()
	env.Log.Info("console listening", "plugin", name, "url", url)
	if !env.Quiet {
		fmt.Printf("QxSSH %s console at %s\n", name, url)
	}
	if opts.Open {
		if err := openBrowser(url); err != nil {
			env.Log.Warn("open browser failed", "error", err.Error())
		}
	}
	if !env.Quiet {
		fmt.Println("Press Ctrl+C to stop.")
	}

	select {
	case err := <-host.Err():
		return serveErr(err)
	case <-ctx.Done():
	}
	host.Shutdown()
	return nil
}

// isLoopbackListen 判断监听地址是否指向回环（127.0.0.0/8、::1、localhost）。
// 空主机（如 ":8800"）视为非回环，因为它会监听所有网卡。
func isLoopbackListen(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	if host == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// openBrowser 用系统默认浏览器打开 url，按当前操作系统选择合适的外部命令。
func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
