//go:build linux

package tui

import "golang.org/x/sys/unix"

// ioctlReadTermios 与 ioctlWriteTermios 是 Linux 读写终端属性的 ioctl 请求码。
const (
	ioctlReadTermios  = unix.TCGETS
	ioctlWriteTermios = unix.TCSETS
)
