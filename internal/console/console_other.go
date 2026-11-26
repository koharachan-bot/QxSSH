//go:build !windows

package console

import (
	"fmt"
	"os"
)

// PrepareConsole 在非 Windows 平台无需附加控制台。
func PrepareConsole(_ []Plugin) {}

// HasConsole 在非 Windows 平台恒为真：进程的 stdin/stdout 就是终端。
func HasConsole() bool { return true }

// ReportError 在非 Windows 平台写入 stderr。
func ReportError(msg string) {
	fmt.Fprintln(os.Stderr, msg)
}
