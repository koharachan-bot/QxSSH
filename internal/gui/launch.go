package gui

import (
	"fmt"
	"strings"
)

// launchScript 生成目标主机上的启动脚本：拉起独立 Xvfb、可选窗口管理器与应用。
// 所有后台进程都用 setsid + </dev/null 彻底脱离 SSH 会话：既不会被 SIGHUP 带走，
// 也不会让 ssh 命令一直等它们退出（写 "A && B &" 时 bash 会把 openbox 当前台进程等，
// 会话就永远不返回）。
func launchScript(display int, dir string, spec Spec) string {
	var b strings.Builder
	b.WriteString("set -u\n")
	fmt.Fprintf(&b, "export DISPLAY=:%d\n", display)
	fmt.Fprintf(&b, "mkdir -p %s || exit 5\n", ShellQuote(dir))

	fmt.Fprintf(&b, "setsid Xvfb :%d -screen 0 %dx%dx%d -nolisten tcp -dpi %d </dev/null > %s 2>&1 &\n",
		display, spec.Screen.Width, spec.Screen.Height, spec.Screen.Depth, spec.DPI,
		ShellQuote(dir+"/xvfb.log"))
	fmt.Fprintf(&b, "echo $! > %s\n", ShellQuote(dir+"/xvfb.pid"))
	fmt.Fprintf(&b, "i=0\nwhile [ $i -lt 100 ]; do [ -S /tmp/.X11-unix/X%d ] && break; i=$((i+1)); sleep 0.05; done\n", display)
	fmt.Fprintf(&b, "if [ ! -S /tmp/.X11-unix/X%d ]; then echo QXGUI_ERR; tail -n 20 %s 2>/dev/null; exit 3; fi\n",
		display, ShellQuote(dir+"/xvfb.log"))

	wmLog := ShellQuote(dir + "/wm.log")
	switch strings.ToLower(spec.WindowManager) {
	case "none":
		// 显式要求不要窗口管理器：有些全屏应用（游戏、播放器）自己摆放窗口更稳。
	case "auto":
		fmt.Fprintf(&b, "if command -v openbox >/dev/null 2>&1; then\n  setsid openbox </dev/null > %s 2>&1 &\n", wmLog)
		fmt.Fprintf(&b, "elif command -v fluxbox >/dev/null 2>&1; then\n  setsid fluxbox </dev/null > %s 2>&1 &\nfi\n", wmLog)
	default:
		wm := strings.ToLower(spec.WindowManager)
		fmt.Fprintf(&b, "if command -v %s >/dev/null 2>&1; then\n  setsid %s </dev/null > %s 2>&1 &\nfi\n", wm, wm, wmLog)
	}

	envs := spec.EnvLines()
	if spec.SoftwareGL {
		// 目标主机通常没有 GPU，强制走 Mesa 的软件光栅化，Blender 这类应用
		// 才不会因为找不到 OpenGL 上下文而直接退出。
		envs = append(envs, "LIBGL_ALWAYS_SOFTWARE=1", "GALLIUM_DRIVER=llvmpipe", "MESA_GL_VERSION_OVERRIDE=4.5")
	}
	envLine := ""
	if len(envs) > 0 {
		quoted := make([]string, 0, len(envs))
		for _, kv := range envs {
			quoted = append(quoted, ShellQuote(kv))
		}
		envLine = strings.Join(quoted, " ") + " "
	}

	fmt.Fprintf(&b, "setsid env DISPLAY=:%d %s%s </dev/null > %s 2>&1 &\n", display, envLine, spec.AppCommand(), ShellQuote(dir+"/app.log"))
	fmt.Fprintf(&b, "echo $! > %s\n", ShellQuote(dir+"/app.pid"))
	b.WriteString("echo QXGUI_OK\n")
	return b.String()
}

// cleanupScript 结束会话进程并删除会话目录。先 TERM 让应用有机会保存，
// 再 KILL 兜底，最后按显示号清理可能残留的 Xvfb。
func cleanupScript(dir string, display int) string {
	var b strings.Builder
	b.WriteString("set +e\n")
	for _, name := range []string{"app", "xvfb"} {
		fmt.Fprintf(&b, "if [ -f %s ]; then kill -TERM \"$(cat %s)\" 2>/dev/null; fi\n",
			ShellQuote(dir+"/"+name+".pid"), ShellQuote(dir+"/"+name+".pid"))
	}
	b.WriteString("sleep 0.3\n")
	for _, name := range []string{"app", "xvfb"} {
		fmt.Fprintf(&b, "if [ -f %s ]; then kill -KILL \"$(cat %s)\" 2>/dev/null; fi\n",
			ShellQuote(dir+"/"+name+".pid"), ShellQuote(dir+"/"+name+".pid"))
	}
	// 用正则锚定命令行开头：否则这条 pkill 会匹配到执行清理脚本的 bash 自身
	// （它的命令行里同样含有 "Xvfb :N "），脚本被自己杀掉后 rm -rf 就不会执行。
	fmt.Fprintf(&b, "pkill -KILL -f '^Xvfb :%d ' >/dev/null 2>&1\n", display)
	fmt.Fprintf(&b, "rm -rf %s >/dev/null 2>&1\n", ShellQuote(dir))
	b.WriteString("exit 0\n")
	return b.String()
}
