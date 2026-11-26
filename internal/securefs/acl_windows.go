//go:build windows

package securefs

import (
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	advapi32ACL         = syscall.NewLazyDLL("advapi32.dll")
	kernel32ACL         = syscall.NewLazyDLL("kernel32.dll")
	procConvertSDDL     = advapi32ACL.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	procSetFileSecurity = advapi32ACL.NewProc("SetFileSecurityW")
	procLocalFree       = kernel32ACL.NewProc("LocalFree")
)

const daclSecurityInformation = 0x00000004

// Protect 用显式 DACL 替换文件或目录的权限，只保留 SYSTEM、当前进程用户与文件所有者。
//
// 当前进程用户必须显式写入：同一台机器上一个人可能用多个身份登录（例如本地账户
// 与微软账户），配置文件的所有者可能是另一个 SID 表示。若只授予 OW（所有者），
// 双击启动时的进程就会把自己刚收紧的配置目录锁死，表现为无法创建数据库。
// Callers must fail closed if it returns an error.
func Protect(path string) error {
	pathPtr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sddlStr := "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;OW)"
	if sid := currentUserSID(); sid != "" {
		sddlStr = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;OW)"
	}
	sddl, err := syscall.UTF16PtrFromString(sddlStr)
	if err != nil {
		return err
	}
	var sd uintptr
	var size uint32
	r1, _, callErr := procConvertSDDL.Call(
		uintptr(unsafe.Pointer(sddl)), 1,
		uintptr(unsafe.Pointer(&sd)), uintptr(unsafe.Pointer(&size)),
	)
	if r1 == 0 {
		return fmt.Errorf("convert secure DACL: %w", callErr)
	}
	defer procLocalFree.Call(sd)
	r1, _, callErr = procSetFileSecurity.Call(
		uintptr(unsafe.Pointer(pathPtr)), daclSecurityInformation, sd,
	)
	if r1 == 0 {
		return fmt.Errorf("set secure DACL on %q: %w", path, callErr)
	}
	return nil
}

// currentUserSID 返回当前进程 token 的用户 SID 字符串；取不到时返回空串，
// 此时 Protect 退回到只授予 SYSTEM 与所有者的严格 DACL。
func currentUserSID() string {
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return ""
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil || user == nil || user.User.Sid == nil {
		return ""
	}
	return user.User.Sid.String()
}
