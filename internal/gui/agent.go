package gui

import (
	_ "embed"
	"encoding/base64"
	"fmt"
)

// agentScript 是注入键鼠与剪贴板事件用的 Python 代理。它随二进制嵌入，
// 启动会话时写到目标主机的会话目录再执行，不要求对方预装任何 pip 包。
//
//go:embed agent.py
var agentScript []byte

// agentCommand 生成「把代理写进会话目录并前台运行」的命令。脚本用 base64
// 传输，避免 shell 转义与终端编码问题；exec 让 python 顶替 shell 进程，
// 退出码与信号都直达会话。
func agentCommand(dir string, display int) string {
	enc := base64.StdEncoding.EncodeToString(agentScript)
	path := dir + "/agent.py"
	disp := fmt.Sprintf(":%d", display)
	return fmt.Sprintf(
		"mkdir -p %s && printf %%s %s | base64 -d > %s && chmod 600 %s && exec env DISPLAY=%s python3 -u %s",
		ShellQuote(dir), enc, ShellQuote(path), ShellQuote(path), ShellQuote(disp), ShellQuote(path),
	)
}
