package httpapi

import (
	"strings"
	"testing"

	"qxssh/internal/gui"
)

func TestNormalizeAppRuntime(t *testing.T) {
	valid := gui.Spec{Command: []string{"wechat"}}
	cases := []struct {
		name    string
		m       appManifest
		wantErr string
	}{
		{"普通 Web 应用", appManifest{}, ""},
		{"合法图形应用", appManifest{Runtime: "linux-gui", GUI: &valid}, ""},
		{"运行时大写归一", appManifest{Runtime: " LINUX-GUI ", GUI: &valid}, ""},
		{"只有图形配置", appManifest{GUI: &valid}, "manifest.runtime"},
		{"缺少图形配置", appManifest{Runtime: "linux-gui"}, "manifest.gui"},
		{"非法运行时", appManifest{Runtime: "vnc"}, "取值非法"},
		{"图形配置非法", appManifest{Runtime: "linux-gui", GUI: &gui.Spec{}}, "command"},
	}
	for _, c := range cases {
		m := c.m
		err := normalizeAppRuntime(&m)
		if c.wantErr == "" {
			if err != nil {
				t.Fatalf("%s：不应报错，实际 %v", c.name, err)
			}
			continue
		}
		if err == nil {
			t.Fatalf("%s：应报错但通过了", c.name)
		}
		if !strings.Contains(err.Error(), c.wantErr) {
			t.Fatalf("%s：错误 %q 未包含 %q", c.name, err.Error(), c.wantErr)
		}
	}
}

func TestNormalizeAppRuntimeFillsDefaults(t *testing.T) {
	m := appManifest{Runtime: "linux-gui", GUI: &gui.Spec{Command: []string{"blender"}}}
	if err := normalizeAppRuntime(&m); err != nil {
		t.Fatalf("合法清单应通过：%v", err)
	}
	if m.GUI.Screen.Width != 1280 || m.GUI.Screen.Height != 800 {
		t.Fatalf("归一后画布默认值异常：%+v", m.GUI.Screen)
	}
	if m.GUI.FPS != 30 || m.GUI.WindowManager != "auto" {
		t.Fatalf("归一后码流/窗口管理器异常：fps=%d wm=%q", m.GUI.FPS, m.GUI.WindowManager)
	}
}

func TestNormalizeAuthType(t *testing.T) {
	ok := map[string]string{
		"":         "",
		"password": "password",
		"KEY":      "key",
		"none":     "none",
		"  None  ": "none",
	}
	for in, want := range ok {
		got, err := normalizeAuthType(in)
		if err != nil || got != want {
			t.Fatalf("normalizeAuthType(%q) = %q, %v；期望 %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"kerberos", "publickey", "密码"} {
		if _, err := normalizeAuthType(bad); err == nil {
			t.Fatalf("authType %q 应被拒绝", bad)
		}
	}
}
