//go:build darwin || freebsd || netbsd || openbsd || dragonfly

package tui

import "golang.org/x/sys/unix"

// ioctlReadTermios 与 ioctlWriteTermios 是 BSD 系（含 macOS）读写终端属性的 ioctl 请求码。
const (
	ioctlReadTermios  = unix.TIOCGETA
	ioctlWriteTermios = unix.TIOCSETA
)
