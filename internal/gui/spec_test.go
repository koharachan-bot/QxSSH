package gui

import (
	"strings"
	"testing"
)

func TestSpecValidateDefaults(t *testing.T) {
	s := Spec{Command: []string{"wechat"}}
	if err := s.Validate(); err != nil {
		t.Fatalf("最小清单应通过校验：%v", err)
	}
	n := s.Normalize()
	if n.Screen.Width != defaultScreenWidth || n.Screen.Height != defaultScreenHeight {
		t.Fatalf("默认画布异常：%+v", n.Screen)
	}
	if n.FPS != defaultFPS || n.BitrateKbps != defaultBitrateKbps {
		t.Fatalf("默认码流参数异常：fps=%d bitrate=%d", n.FPS, n.BitrateKbps)
	}
	if n.WindowManager != "auto" {
		t.Fatalf("默认窗口管理器应为 auto，实际 %q", n.WindowManager)
	}
}

func TestSpecValidateRejects(t *testing.T) {
	cases := []struct {
		name string
		spec Spec
		want string
	}{
		{"空命令", Spec{}, "command"},
		{"命令含换行", Spec{Command: []string{"a\nb"}}, "控制字符"},
		{"屏幕过小", Spec{Command: []string{"x"}, Screen: Screen{Width: 100, Height: 800}}, "width"},
		{"深度非法", Spec{Command: []string{"x"}, Screen: Screen{Width: 800, Height: 600, Depth: 32}}, "depth"},
		{"DPI 越界", Spec{Command: []string{"x"}, DPI: 600}, "dpi"},
		{"帧率越界", Spec{Command: []string{"x"}, FPS: 240}, "fps"},
		{"码率越界", Spec{Command: []string{"x"}, BitrateKbps: 99999}, "bitrateKbps"},
		{"窗口管理器非法", Spec{Command: []string{"x"}, WindowManager: "kwin"}, "windowManager"},
		{"安装地址非 http", Spec{Command: []string{"x"}, Install: &Install{URL: "ftp://a/b"}}, "install.url"},
	}
	for _, c := range cases {
		err := c.spec.Validate()
		if err == nil {
			t.Fatalf("%s：应报错但通过了", c.name)
		}
		if !strings.Contains(err.Error(), c.want) {
			t.Fatalf("%s：错误信息 %q 未包含 %q", c.name, err.Error(), c.want)
		}
	}
}

func TestShellQuote(t *testing.T) {
	cases := map[string]string{
		"wechat":     "wechat",
		"/opt/a b/x": "'/opt/a b/x'",
		"it's":       `'it'\''s'`,
		"":           "''",
	}
	for in, want := range cases {
		if got := ShellQuote(in); got != want {
			t.Fatalf("ShellQuote(%q) = %q，期望 %q", in, got, want)
		}
	}
}

func TestAppCommandQuotesArgs(t *testing.T) {
	s := Spec{Command: []string{"/opt/My App/run"}, Args: []string{"--profile", "中文 路径"}}
	want := "'/opt/My App/run' --profile '中文 路径'"
	if got := s.AppCommand(); got != want {
		t.Fatalf("AppCommand() = %q，期望 %q", got, want)
	}
}

func TestEnvLinesSorted(t *testing.T) {
	s := Spec{Command: []string{"x"}, Env: map[string]string{"LANG": "zh_CN.UTF-8", "FOO": "1"}}
	got := s.EnvLines()
	if len(got) != 2 || got[0] != "FOO=1" || got[1] != "LANG=zh_CN.UTF-8" {
		t.Fatalf("EnvLines 未按名称排序：%v", got)
	}
}
