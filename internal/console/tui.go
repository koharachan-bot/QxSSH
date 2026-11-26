package console

import (
	"context"

	"qxssh/internal/bootstrap"
	"qxssh/internal/tui"
)

// tuiPlugin 是终端界面插件：不监听端口，直接使用核心层的存储与 SSH 连接池。
type tuiPlugin struct{}

// Name 返回插件名。
func (tuiPlugin) Name() string { return nameTUI }

// Kind 返回实现族。
func (tuiPlugin) Kind() Kind { return KindTUI }

// Run 以全屏终端界面运行，直到用户退出或 ctx 取消。
func (tuiPlugin) Run(ctx context.Context, env Env) error {
	return tui.Run(ctx, tui.Deps{
		Store:   env.Core.Store(),
		Pool:    env.Core.Pool(),
		Log:     env.Log,
		Version: bootstrap.Version,
	})
}
