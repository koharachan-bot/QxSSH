//go:build !windows && !linux && !darwin && !freebsd && !netbsd && !openbsd && !dragonfly

package tui

import (
	"context"
	"errors"
	"os"
	"time"
)

// errTerminalUnsupported 表示当前平台没有实现 TUI 的终端控制层。
var errTerminalUnsupported = errors.New("当前平台不支持 TUI 终端控制")

// isTerminal 在未适配的平台上恒为 false，Run 会据此返回明确的中文错误。
func isTerminal(_ *os.File) bool {
	return false
}

// enterRawState 在未适配的平台上直接返回不支持错误。
func enterRawState(_, _ *os.File) (func() error, error) {
	return nil, errTerminalUnsupported
}

// termSize 在未适配的平台上直接返回不支持错误。
func termSize(_ *os.File) (int, int, error) {
	return 0, 0, errTerminalUnsupported
}

// waitReadable 在未适配的平台上退回阻塞读取。
func waitReadable(_ *os.File, _ time.Duration, _ <-chan struct{}) bool {
	return true
}

// watchResize 在未适配的平台上返回空操作。
func watchResize(_ context.Context, _ chan<- struct{}) func() {
	return func() {}
}
