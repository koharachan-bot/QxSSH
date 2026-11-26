//go:build !windows

package console

import (
	"context"
	"errors"
)

// guiPlugin 在非 Windows 平台没有可用的 WebView2 实现，启动时给出明确提示。
// 命令行与去重逻辑保持与 Windows 完全一致，用户可继续使用 -web 或 -tui。
type guiPlugin struct{}

// Name 返回插件名。
func (guiPlugin) Name() string { return nameGUI }

// Kind 返回实现族。
func (guiPlugin) Kind() Kind { return KindGUI }

// Run 在非 Windows 平台直接返回不支持错误。
func (guiPlugin) Run(_ context.Context, _ Env) error {
	return errors.New("gui 插件当前仅支持 Windows（WebView2）；请改用 -web 或 -tui")
}
