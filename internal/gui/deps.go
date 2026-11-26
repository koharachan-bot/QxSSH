package gui

import (
	"context"
	"strings"
)

// Dep 描述图形会话在目标主机上需要的一个外部程序。图形会话本身不绑定发行版，
// 但「把 X 显示跑起来」与「把画面编码成视频」必须借助系统工具，因此这里给出
// 探测与安装建议，让用户在第一次启动时一次补齐，而不是反复踩错。
type Dep struct {
	Bin      string `json:"bin"`
	Pkg      string `json:"pkg"`
	Label    string `json:"label"`
	Optional bool   `json:"optional,omitempty"`
}

// Deps 是图形会话的依赖清单：Xvfb 提供虚拟显示，ffmpeg 负责采集与编码，
// xclip 负责剪贴板（缺失只影响剪贴板），窗口管理器缺失时应用靠自身摆放窗口。
var Deps = []Dep{
	{Bin: "Xvfb", Pkg: "xvfb", Label: "虚拟 X 显示"},
	{Bin: "ffmpeg", Pkg: "ffmpeg", Label: "画面采集与编码"},
	{Bin: "xrandr", Pkg: "x11-xserver-utils", Label: "显示信息查询"},
	{Bin: "xclip", Pkg: "xclip", Label: "剪贴板同步", Optional: true},
	{Bin: "openbox", Pkg: "openbox", Label: "窗口管理器", Optional: true},
}

// DepStatus 是单个依赖在目标主机上的探测结果。
type DepStatus struct {
	Dep
	Present bool   `json:"present"`
	Path    string `json:"path,omitempty"`
}

// ProbeDeps 在目标主机上逐个探测依赖。探测失败不视为错误：全部标记为缺失，
// 由调用方决定是否阻止启动（ffmpeg 与 Xvfb 缺失才阻止）。
func ProbeDeps(ctx context.Context, t Target) ([]DepStatus, error) {
	out := make([]DepStatus, 0, len(Deps))
	if _, err := t.Run(ctx, "command -v sh >/dev/null 2>&1 || echo nosh"); err != nil {
		return nil, err
	}
	for _, d := range Deps {
		res, err := t.Run(ctx, "command -v "+ShellQuote(d.Bin)+" 2>/dev/null || true")
		if err != nil {
			return nil, err
		}
		p := strings.TrimSpace(res)
		out = append(out, DepStatus{Dep: d, Present: p != "", Path: p})
	}
	return out, nil
}

// MissingRequired 返回缺失且不可省略的依赖。
func MissingRequired(list []DepStatus) []DepStatus {
	var out []DepStatus
	for _, d := range list {
		if !d.Present && !d.Optional {
			out = append(out, d)
		}
	}
	return out
}

// InstallCommand 按目标主机的包管理器生成一条安装命令。它只生成建议，
// 真正的执行仍然经过宿主的 sudo 流程与审计（QxSSH 不静默提权）。
func InstallCommand(ctx context.Context, t Target) string {
	if _, err := t.Run(ctx, "command -v apt-get >/dev/null 2>&1"); err == nil {
		return "apt-get update && apt-get install -y xvfb ffmpeg x11-xserver-utils xclip openbox"
	}
	if _, err := t.Run(ctx, "command -v dnf >/dev/null 2>&1"); err == nil {
		return "dnf install -y xorg-x11-server-Xvfb ffmpeg xrandr xclip openbox"
	}
	if _, err := t.Run(ctx, "command -v pacman >/dev/null 2>&1"); err == nil {
		return "pacman -S --noconfirm xorg-server-xvfb ffmpeg xorg-xrandr xclip openbox"
	}
	if _, err := t.Run(ctx, "command -v zypper >/dev/null 2>&1"); err == nil {
		return "zypper install -y xvfb ffmpeg xrandr xclip openbox"
	}
	return ""
}
