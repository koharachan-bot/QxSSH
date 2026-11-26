//go:build windows

package tui

import (
	"context"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

// isTerminal 报告 f 是否连接到 Windows 控制台。
// GetConsoleMode 成功即说明它是控制台句柄而不是文件或管道。
func isTerminal(f *os.File) bool {
	var mode uint32
	return windows.GetConsoleMode(windows.Handle(f.Fd()), &mode) == nil
}

// enterRawState 切换终端到全屏界面工作模式，返回恢复函数。
//
// stdin 关闭行输入、回显与 Ctrl+C 处理，并尽量启用虚拟终端输入（让方向键
// 以 ESC 序列返回）；stdout 启用虚拟终端处理，使 ANSI 转义序列生效。
// 老系统不支持虚拟终端输入时回退到传统模式，界面仍可工作。
func enterRawState(in, out *os.File) (func() error, error) {
	inHandle := windows.Handle(in.Fd())
	var inOld uint32
	if err := windows.GetConsoleMode(inHandle, &inOld); err != nil {
		return nil, err
	}
	inMode := inOld
	inMode &^= windows.ENABLE_LINE_INPUT | windows.ENABLE_ECHO_INPUT | windows.ENABLE_PROCESSED_INPUT
	inMode |= windows.ENABLE_EXTENDED_FLAGS | windows.ENABLE_VIRTUAL_TERMINAL_INPUT
	if err := windows.SetConsoleMode(inHandle, inMode); err != nil {
		inMode &^= windows.ENABLE_VIRTUAL_TERMINAL_INPUT
		if err := windows.SetConsoleMode(inHandle, inMode); err != nil {
			return nil, err
		}
	}

	outHandle := windows.Handle(out.Fd())
	var outOld uint32
	outChanged := false
	if err := windows.GetConsoleMode(outHandle, &outOld); err == nil {
		outMode := outOld | windows.ENABLE_PROCESSED_OUTPUT | windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING
		if outMode != outOld {
			if err := windows.SetConsoleMode(outHandle, outMode); err == nil {
				outChanged = true
			}
		}
	}

	return func() error {
		err := windows.SetConsoleMode(inHandle, inOld)
		if outChanged {
			if restoreErr := windows.SetConsoleMode(outHandle, outOld); restoreErr != nil && err == nil {
				err = restoreErr
			}
		}
		return err
	}, nil
}

// termSize 返回控制台可见窗口的列数与行数。
// 使用窗口矩形而不是缓冲区尺寸：控制台的缓冲区通常比可见窗口高得多。
func termSize(f *os.File) (int, int, error) {
	var info windows.ConsoleScreenBufferInfo
	if err := windows.GetConsoleScreenBufferInfo(windows.Handle(f.Fd()), &info); err != nil {
		return 0, 0, err
	}
	cols := int(info.Window.Right-info.Window.Left) + 1
	rows := int(info.Window.Bottom-info.Window.Top) + 1
	return cols, rows, nil
}

// waitReadable 在 Windows 上直接放行读取。
//
// 控制台输入句柄不保证支持带超时的可中断等待（重定向或伪控制台场景下
// 等待语义不明确），因此这里退回阻塞读取；退出时由调用方用超时等待收尾。
func waitReadable(_ *os.File, _ time.Duration, _ <-chan struct{}) bool {
	return true
}

// watchResize 在 Windows 上没有窗口变化信号，返回空操作。
// 尺寸由渲染前的轮询读取兜底，同样能自适应窗口变化。
func watchResize(_ context.Context, _ chan<- struct{}) func() {
	return func() {}
}
