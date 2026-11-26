//go:build windows

package console

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32DLL = windows.NewLazySystemDLL("kernel32.dll")
	user32DLL   = windows.NewLazySystemDLL("user32.dll")

	procGetConsoleWindow = kernel32DLL.NewProc("GetConsoleWindow")
	procAttachConsole    = kernel32DLL.NewProc("AttachConsole")
	procAllocConsole     = kernel32DLL.NewProc("AllocConsole")
	procMessageBoxW      = user32DLL.NewProc("MessageBoxW")
)

const (
	attachParentProcess = 0xFFFFFFFF // ATTACH_PARENT_PROCESS
	mbOK                = 0x00000000
	mbIconError         = 0x00000010
	mbIconInformation   = 0x00000040
)

// PrepareConsole 为需要终端的界面接回控制台。
//
// Windows 发布版以 GUI 子系统链接（-H windowsgui），双击启动时不会创建任何控制台
// 窗口。gui 插件保持这种无控制台状态；tui 必须有控制台；web 则把输出接回父终端，
// 从资源管理器双击运行时不会为它额外开一个黑窗。
func PrepareConsole(plugins []Plugin) {
	if HasKind(plugins, KindTUI) {
		// TUI 需要独占终端。GUI 子系统进程从终端启动时，父 shell 不会等待它，
		// 若附加父控制台会与 shell 争抢输入，因此始终使用自己的控制台；
		// 双击启动时同样新建一个。
		if !HasConsole() {
			if ok, _, _ := procAllocConsole.Call(); ok != 0 {
				bindStdConsole()
			}
		}
		return
	}
	if !HasKind(plugins, KindWeb) {
		return
	}
	// web 只输出访问地址后转到后台，接回父终端是安全的；没有父终端时不分配
	// 控制台，避免双击启动时多出一个黑窗。
	if HasConsole() {
		bindStdConsole()
		return
	}
	if attach, _, _ := procAttachConsole.Call(attachParentProcess); attach != 0 {
		bindStdConsole()
	}
}

// HasConsole 报告当前进程是否拥有控制台。
func HasConsole() bool {
	hwnd, _, _ := procGetConsoleWindow.Call()
	return hwnd != 0
}

// bindStdConsole 把标准流重新绑定到当前控制台。
//
// GUI 子系统进程启动时标准句柄是空的，即使 AttachConsole / AllocConsole 成功，
// 也必须重新打开 CONIN$ / CONOUT$ 才能读写。
func bindStdConsole() {
	if in, err := os.OpenFile("CONIN$", os.O_RDWR, 0); err == nil {
		os.Stdin = in
	}
	if out, err := os.OpenFile("CONOUT$", os.O_RDWR, 0); err == nil {
		os.Stdout = out
		os.Stderr = out
	}
}

// ReportError 向用户报告启动或运行错误。
//
// 有控制台时写 stderr；没有控制台（双击 GUI）时弹出一个错误对话框，
// 避免程序静默退出。设置 QXSSH_NO_MESSAGEBOX 可强制走 stderr，便于自动化测试。
func ReportError(msg string) {
	if HasConsole() || os.Getenv("QXSSH_NO_MESSAGEBOX") != "" {
		fmt.Fprintln(os.Stderr, msg)
		return
	}
	messageBox("QxSSH 启动失败", msg, mbOK|mbIconError)
}

// messageBox 弹出原生消息框。调用会阻塞到用户关闭窗口。
func messageBox(title, text string, flags uintptr) {
	t, err := windows.UTF16PtrFromString(text)
	if err != nil {
		return
	}
	c, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	_, _, _ = procMessageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags)
}
