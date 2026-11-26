package console

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"
)

// httpShutdownTimeout 是 HTTP 服务优雅关闭时等待在途请求完成的最长时间。
const httpShutdownTimeout = 5 * time.Second

// httpHost 是一个已启动的 HTTP 服务，封装监听、TLS 与优雅关闭。
//
// web 与 gui 插件共用它：web 监听用户指定地址，gui 只绑本机随机端口供内嵌
// WebView 窗口加载，因此两者的服务器参数、超时与关闭顺序保持一致。
type httpHost struct {
	srv    *http.Server
	ln     net.Listener
	scheme string
	errCh  chan error
}

// startHTTP 在 addr 上启动 API 网关。tlsCfg 非 nil 时对外提供 HTTPS。
func startHTTP(env Env, addr string, tlsCfg *tls.Config) (*httpHost, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("listen %s: %w", addr, err)
	}
	scheme := "http"
	if tlsCfg != nil {
		ln = tls.NewListener(ln, tlsCfg)
		scheme = "https"
	}
	srv := &http.Server{
		Handler: env.Core.Handler(),
		// 慢速攻击防护交给 ReadHeaderTimeout；不设 WriteTimeout，否则会切断
		// WebSocket 与流式响应（QX-064）。
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	h := &httpHost{srv: srv, ln: ln, scheme: scheme, errCh: make(chan error, 1)}
	go func() { h.errCh <- srv.Serve(ln) }()
	return h, nil
}

// URL 返回服务的访问地址；监听端口为 0 时是内核分配的真实端口。
func (h *httpHost) URL() string {
	return h.scheme + "://" + h.ln.Addr().String()
}

// Err 返回服务结束的错误通道，正常关闭时值为 nil。
func (h *httpHost) Err() <-chan error { return h.errCh }

// Shutdown 优雅关闭服务，并等待 Serve 返回，避免遗留监听器与在途请求。
func (h *httpHost) Shutdown() {
	ctx, cancel := context.WithTimeout(context.Background(), httpShutdownTimeout)
	defer cancel()
	if err := h.srv.Shutdown(ctx); err != nil {
		_ = h.srv.Close()
	}
	<-h.errCh
}

// serveErr 把 Serve 的返回值归一化：正常关闭视为成功。
func serveErr(err error) error {
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
