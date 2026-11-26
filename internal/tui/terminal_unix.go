//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly

package tui

import (
	"context"
	"os"
	"os/signal"
	"time"

	"golang.org/x/sys/unix"
)

// isTerminal 报告 f 是否是终端设备：能读到终端属性即视为 TTY。
func isTerminal(f *os.File) bool {
	_, err := unix.IoctlGetTermios(int(f.Fd()), ioctlReadTermios)
	return err == nil
}

// enterRawState 把 stdin 切到原始模式，返回恢复函数。
//
// 关闭行缓冲、回显与信号快捷键（Ctrl+C 作为普通字节交给界面处理），
// 关闭输出后处理以免 \n 被改写，并让每次读取至少返回一个字节。
func enterRawState(in, _ *os.File) (func() error, error) {
	fd := int(in.Fd())
	old, err := unix.IoctlGetTermios(fd, ioctlReadTermios)
	if err != nil {
		return nil, err
	}
	raw := *old
	raw.Iflag &^= unix.IGNBRK | unix.BRKINT | unix.PARMRK | unix.ISTRIP |
		unix.INLCR | unix.IGNCR | unix.ICRNL | unix.IXON
	raw.Oflag &^= unix.OPOST
	raw.Lflag &^= unix.ECHO | unix.ECHONL | unix.ICANON | unix.ISIG | unix.IEXTEN
	raw.Cflag &^= unix.CSIZE | unix.PARENB
	raw.Cflag |= unix.CS8
	raw.Cc[unix.VMIN] = 1
	raw.Cc[unix.VTIME] = 0
	if err := unix.IoctlSetTermios(fd, ioctlWriteTermios, &raw); err != nil {
		return nil, err
	}
	return func() error {
		return unix.IoctlSetTermios(fd, ioctlWriteTermios, old)
	}, nil
}

// termSize 返回终端的列数与行数。
func termSize(f *os.File) (int, int, error) {
	ws, err := unix.IoctlGetWinsize(int(f.Fd()), unix.TIOCGWINSZ)
	if err != nil {
		return 0, 0, err
	}
	return int(ws.Col), int(ws.Row), nil
}

// waitReadable 等待 stdin 变为可读，最多等待 timeout。
//
// 用 poll 带超时轮询，使输入协程能在退出信号到达后及时结束，
// 而不是永久阻塞在阻塞式 Read 上。
func waitReadable(f *os.File, timeout time.Duration, done <-chan struct{}) bool {
	ms := int(timeout / time.Millisecond)
	if ms < 1 {
		ms = 1
	}
	fds := []unix.PollFd{{Fd: int32(f.Fd()), Events: unix.POLLIN}}
	n, err := unix.Poll(fds, ms)
	if err != nil {
		select {
		case <-done:
			return false
		default:
			return true // 无法轮询时退回阻塞读取
		}
	}
	return n > 0
}

// watchResize 监听 SIGWINCH，在窗口尺寸变化时向 ch 发送通知（非阻塞）。
// 返回的函数用于停止监听。
func watchResize(ctx context.Context, ch chan<- struct{}) func() {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, unix.SIGWINCH)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-sig:
				select {
				case ch <- struct{}{}:
				default:
				}
			}
		}
	}()
	return func() {
		signal.Stop(sig)
	}
}
