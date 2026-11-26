// Package gui 为 Linux 图形应用（微信、QQ、WPS、Blender 等）提供插件运行时：
// 在目标主机的独立 X 显示上启动应用，采集画面编码后经 WebSocket 送到浏览器，
// 并把浏览器的键鼠与剪贴板操作注入远端。它刻意不依赖 VNC 协议，而是按 RDP 的
// 思路做「常驻会话 + 视频编码 + 精细输入」，窗口缩放、断线重连与多会话互不干扰。
package gui

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Screen 是图形会话的虚拟显示参数。宽度与高度决定 Xvfb 的初始画布，
// 前端按窗口大小等比缩放显示；深度固定 24 位（无 alpha 通道）。
type Screen struct {
	Width  int `json:"width,omitempty"`
	Height int `json:"height,omitempty"`
	Depth  int `json:"depth,omitempty"`
}

// Install 描述首次启动前需要准备的运行时（例如 Blender 的官方 tar.xz）。
// 应用包体积受限，因此重量级程序不塞进 .qxp，而是在目标主机上按需下载。
type Install struct {
	URL             string `json:"url"`
	SHA256          string `json:"sha256,omitempty"`
	Dest            string `json:"dest,omitempty"`
	StripComponents int    `json:"stripComponents,omitempty"`
	Bin             string `json:"bin,omitempty"`
	Size            int64  `json:"size,omitempty"`
}

// Spec 是 manifest.json 里 gui 字段的完整结构，描述「怎么把程序跑到屏幕会话里」。
type Spec struct {
	Command       []string          `json:"command"`
	Args          []string          `json:"args,omitempty"`
	Env           map[string]string `json:"env,omitempty"`
	Screen        Screen            `json:"screen,omitempty"`
	DPI           int               `json:"dpi,omitempty"`
	SoftwareGL    bool              `json:"softwareGL,omitempty"`
	WindowManager string            `json:"windowManager,omitempty"`
	Clipboard     bool              `json:"clipboard,omitempty"`
	FPS           int               `json:"fps,omitempty"`
	BitrateKbps   int               `json:"bitrateKbps,omitempty"`
	Install       *Install          `json:"install,omitempty"`
}

const (
	// 默认画布：偏保守，兼顾笔记本屏幕与带宽；用户可在插件里覆盖。
	defaultScreenWidth  = 1280
	defaultScreenHeight = 800
	defaultScreenDepth  = 24
	defaultDPI          = 96
	defaultFPS          = 30
	defaultBitrateKbps  = 2500

	// 画布下限按常见最小可用窗口定，上限避免一次请求就把显存与带宽吃满。
	minScreenDim = 320
	maxScreenDim = 3840

	minFPS     = 5
	maxFPS     = 60
	minBitrate = 300
	maxBitrate = 20000

	maxCommandLen = 64
	maxEnvLen     = 32
)

// 窗口管理器取值：auto 表示按 openbox → fluxbox 顺序探测，none 表示不启动。
var windowManagers = map[string]bool{"": true, "auto": true, "none": true, "openbox": true, "fluxbox": true}

// Normalize 返回补齐默认值后的副本：它不修改接收者，方便清单校验与运行时复用同一份数据。
func (s Spec) Normalize() Spec {
	out := s
	out.Command = trimList(out.Command)
	out.Args = trimList(out.Args)
	out.WindowManager = strings.TrimSpace(out.WindowManager)
	if out.WindowManager == "" {
		out.WindowManager = "auto"
	}
	if out.Screen.Width <= 0 {
		out.Screen.Width = defaultScreenWidth
	}
	if out.Screen.Height <= 0 {
		out.Screen.Height = defaultScreenHeight
	}
	if out.Screen.Depth <= 0 {
		out.Screen.Depth = defaultScreenDepth
	}
	if out.DPI <= 0 {
		out.DPI = defaultDPI
	}
	if out.FPS <= 0 {
		out.FPS = defaultFPS
	}
	if out.BitrateKbps <= 0 {
		out.BitrateKbps = defaultBitrateKbps
	}
	if out.Env != nil {
		env := make(map[string]string, len(out.Env))
		for k, v := range out.Env {
			k = strings.TrimSpace(k)
			if k == "" {
				continue
			}
			env[k] = v
		}
		out.Env = env
	}
	return out
}

// Validate 校验清单里的 gui 配置。错误信息直接面向用户（出现在安装界面），
// 因此全部用中文描述，并指出具体字段。
func (s Spec) Validate() error {
	n := s.Normalize()
	if len(n.Command) == 0 {
		return errors.New("manifest.gui.command 不能为空（至少要给出要启动的程序）")
	}
	if len(n.Command) > maxCommandLen {
		return fmt.Errorf("manifest.gui.command 条目过多（上限 %d）", maxCommandLen)
	}
	for i, c := range n.Command {
		if c == "" {
			return fmt.Errorf("manifest.gui.command[%d] 不能是空字符串", i)
		}
		if strings.ContainsAny(c, "\x00\r\n") {
			return fmt.Errorf("manifest.gui.command[%d] 含非法控制字符", i)
		}
	}
	for i, a := range n.Args {
		if strings.ContainsAny(a, "\x00\r\n") {
			return fmt.Errorf("manifest.gui.args[%d] 含非法控制字符", i)
		}
	}
	if len(n.Env) > maxEnvLen {
		return fmt.Errorf("manifest.gui.env 变量过多（上限 %d）", maxEnvLen)
	}
	if n.Screen.Width < minScreenDim || n.Screen.Width > maxScreenDim {
		return fmt.Errorf("manifest.gui.screen.width 需在 %d~%d 之间", minScreenDim, maxScreenDim)
	}
	if n.Screen.Height < minScreenDim || n.Screen.Height > maxScreenDim {
		return fmt.Errorf("manifest.gui.screen.height 需在 %d~%d 之间", minScreenDim, maxScreenDim)
	}
	if n.Screen.Depth != 16 && n.Screen.Depth != 24 {
		return errors.New("manifest.gui.screen.depth 只支持 16 或 24")
	}
	if n.DPI < 48 || n.DPI > 288 {
		return errors.New("manifest.gui.dpi 需在 48~288 之间")
	}
	if n.FPS < minFPS || n.FPS > maxFPS {
		return fmt.Errorf("manifest.gui.fps 需在 %d~%d 之间", minFPS, maxFPS)
	}
	if n.BitrateKbps < minBitrate || n.BitrateKbps > maxBitrate {
		return fmt.Errorf("manifest.gui.bitrateKbps 需在 %d~%d 之间", minBitrate, maxBitrate)
	}
	if !windowManagers[strings.ToLower(n.WindowManager)] {
		return fmt.Errorf("manifest.gui.windowManager 取值非法：%q（支持 auto/none/openbox/fluxbox）", s.WindowManager)
	}
	if n.Install != nil {
		if err := n.Install.validate(); err != nil {
			return err
		}
	}
	return nil
}

func (in *Install) validate() error {
	if in.URL == "" {
		return errors.New("manifest.gui.install.url 不能为空")
	}
	if !strings.HasPrefix(in.URL, "https://") && !strings.HasPrefix(in.URL, "http://") {
		return errors.New("manifest.gui.install.url 必须是 http(s) 链接")
	}
	if in.SHA256 != "" && len(in.SHA256) != 64 {
		return errors.New("manifest.gui.install.sha256 需为 64 位十六进制")
	}
	if in.Dest != "" && strings.Contains(in.Dest, "..") {
		return errors.New("manifest.gui.install.dest 不能包含 ..")
	}
	if in.StripComponents < 0 || in.StripComponents > 8 {
		return errors.New("manifest.gui.install.stripComponents 需在 0~8 之间")
	}
	return nil
}

// AppCommand 返回应用自身的启动命令行，供 shell 执行。调用者需保证每个参数
// 都经过 ShellQuote，这里统一处理，避免插件清单里出现命令注入。
func (s Spec) AppCommand() string {
	n := s.Normalize()
	parts := make([]string, 0, len(n.Command)+len(n.Args))
	for _, c := range n.Command {
		parts = append(parts, ShellQuote(c))
	}
	for _, a := range n.Args {
		parts = append(parts, ShellQuote(a))
	}
	return strings.Join(parts, " ")
}

// EnvLines 以 KEY=VALUE 形式返回需要注入的额外环境变量，按变量名排序保证可复现。
func (s Spec) EnvLines() []string {
	keys := make([]string, 0, len(s.Env))
	for k := range s.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+s.Env[k])
	}
	return out
}

// ShellQuote 用单引号包裹参数，内部单引号按 shell 规则转义。
func ShellQuote(s string) string {
	if s == "" {
		return "''"
	}
	// 仅含安全字符时省掉引号，便于日志阅读。
	safe := true
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case strings.IndexByte("@%_+=:,./-", c) >= 0:
		default:
			safe = false
		}
	}
	if safe {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func trimList(in []string) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}
