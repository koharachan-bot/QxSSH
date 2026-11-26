// Package bootstrap 负责 QxSSH 的运行时装配与生命周期管理。
//
// 它把配置存储、SSH 连接池、端口转发注册表、内网 Web 代理注册表和 API 网关
// 组装成一个与界面无关的核心 Runtime，注册“主机失效即停止其转发/代理”的联动钩子，
// 并在退出时按 后台任务 → 转发/代理 → 连接池 → 配置库 的顺序做优雅关闭。
//
// Runtime 不监听任何端口：HTTP 服务归 web（或 gui）界面插件，TUI 插件则直接
// 使用 Core() 暴露的存储与连接池。这样核心层不会为了某个界面而多背一个服务器。
package bootstrap

import (
	"net/http"
	"sync"

	"qxssh/internal/config"
	"qxssh/internal/httpapi"
	"qxssh/internal/logging"
	"qxssh/internal/proxy"
	"qxssh/internal/sshpool"
	"qxssh/internal/tunnel"
)

// Runtime 持有 QxSSH 运行期间的全部长生命周期核心组件及其关闭逻辑。
type Runtime struct {
	mgr      *sshpool.Pool
	tunnels  *tunnel.Registry
	proxies  *proxy.Registry
	store    *config.Store
	handler  http.Handler
	closeAPI func()
	log      *logging.Logger

	closeOnce sync.Once
}

// Version 是 QxSSH 的版本号，会在启动横幅与 version API 中展示。
const Version = "1.0.0"

// New 组装并返回一个 Runtime。log 为 nil 时使用默认的 info 级日志。
// 它同时建立“SSH 连接失效 → 停止该主机上的转发与代理”的联动。
// 签名密钥等初始化失败时返回 error：宁可起不来，也不要给出一个应用拿不到可用令牌的半可用服务。
func New(store *config.Store, log *logging.Logger) (*Runtime, error) {
	if log == nil {
		log = logging.New(logging.LevelInfo)
	}
	// 凭据解密失败等静默故障接入日志（QX-074）。
	store.SetWarnFn(func(msg string) { log.Warn("config store diagnostic", "detail", msg) })
	mgr := sshpool.New(store, log)
	tunnels := tunnel.New(mgr, store)
	wp := proxy.New()
	handler, closeAPI, err := httpapi.New(store, mgr, tunnels, wp, Version, store.Dir(), log)
	if err != nil {
		return nil, err
	}
	mgr.OnInvalidate(func(hostID string) {
		if n := tunnels.StopByHost(hostID); n > 0 {
			log.Info("ssh invalidated: stopped tunnels", "host", hostID, "count", n)
		}
		if n := wp.StopByHost(hostID); n > 0 {
			log.Info("ssh invalidated: stopped webproxies", "host", hostID, "count", n)
		}
	})
	return &Runtime{
		mgr:      mgr,
		tunnels:  tunnels,
		proxies:  wp,
		store:    store,
		handler:  handler,
		closeAPI: closeAPI,
		log:      log,
	}, nil
}

// Store 返回配置存储，供界面插件读取主机与偏好。
func (a *Runtime) Store() *config.Store { return a.store }

// Pool 返回 SSH 连接池，供界面插件建立会话。
func (a *Runtime) Pool() *sshpool.Pool { return a.mgr }

// Handler 返回 API 网关的 HTTP 处理器，供 web / gui 插件监听服务。
func (a *Runtime) Handler() http.Handler { return a.handler }

// Log 返回与核心层共享的结构化日志器。
func (a *Runtime) Log() *logging.Logger { return a.log }

// Shutdown 优雅停止全部核心组件。它只执行一次，重复调用是安全的。
// HTTP 服务已由界面插件先一步关闭，这里只负责核心资源。
func (a *Runtime) Shutdown() {
	a.closeOnce.Do(func() {
		a.log.Info("shutdown: stopping background exec, proxies and tunnels")
		if a.closeAPI != nil {
			a.closeAPI()
		}
		a.proxies.StopAll()
		a.tunnels.StopAll()
		a.mgr.CloseAll()

		if a.store != nil {
			if err := a.store.Close(); err != nil {
				a.log.Warn("config db close failed", "error", err.Error())
			}
		}
	})
}
