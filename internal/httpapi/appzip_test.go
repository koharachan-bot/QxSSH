package httpapi

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

// zipOf 构造内存中的 .qxp，键是包内路径，值是内容。
func zipOf(t *testing.T, files map[string]string) ([]byte, int64) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("创建 zip 条目失败：%v", err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("写入 zip 条目失败：%v", err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("关闭 zip 失败：%v", err)
	}
	return buf.Bytes(), int64(buf.Len())
}

const guiManifestJSON = `{
  "id": "wechat",
  "name": "微信",
  "version": "1.0.0",
  "runtime": "linux-gui",
  "icon": "icon.svg",
  "gui": {
    "command": ["wechat"],
    "screen": { "width": 1200, "height": 820, "depth": 24 },
    "fps": 30,
    "bitrateKbps": 2500
  }
}`

// GUI 插件不需要入口页：窗口由宿主渲染，manifest.entry 允许为空。
func TestParseGUIAppPackageWithoutEntry(t *testing.T) {
	files := map[string]string{
		"manifest.json": guiManifestJSON,
		"icon.svg":      "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
	}
	data, size := zipOf(t, files)
	var a Gateway
	m, _, err := a.parseAppZip(bytes.NewReader(data), size)
	if err != nil {
		t.Fatalf("图形应用包应通过校验：%v", err)
	}
	if m.Runtime != appRuntimeLinuxGUI {
		t.Fatalf("runtime 未归一为 linux-gui：%q", m.Runtime)
	}
	if m.Entry != "" {
		t.Fatalf("图形应用不应被补上入口页，实际 %q", m.Entry)
	}
	if m.GUI == nil || len(m.GUI.Command) != 1 || m.GUI.Command[0] != "wechat" {
		t.Fatalf("gui 启动参数解析异常：%+v", m.GUI)
	}
	if m.GUI.Screen.Width != 1200 || m.GUI.FPS != 30 {
		t.Fatalf("gui 参数未保留声明值：%+v", m.GUI)
	}
}

// 普通 Web 应用仍然必须有入口页，缺了要报错而不是悄悄放行。
func TestParseWebAppRequiresEntry(t *testing.T) {
	files := map[string]string{
		"manifest.json": `{"id":"plain","name":"Plain"}`,
	}
	data, size := zipOf(t, files)
	var a Gateway
	if _, _, err := a.parseAppZip(bytes.NewReader(data), size); err == nil {
		t.Fatal("缺少入口页的 Web 应用应被拒绝")
	}
}

// 声明了 gui 却没有运行时（或反之）都必须被拒绝。
func TestParseGUIAppRequiresRuntime(t *testing.T) {
	cases := []map[string]string{
		{"manifest.json": `{"id":"x","name":"X","gui":{"command":["x"]}}`},
		{"manifest.json": `{"id":"x","name":"X","runtime":"linux-gui"}`},
		{"manifest.json": `{"id":"x","name":"X","runtime":"vnc","gui":{"command":["x"]}}`},
	}
	for i, files := range cases {
		data, size := zipOf(t, files)
		var a Gateway
		_, _, err := a.parseAppZip(bytes.NewReader(data), size)
		if err == nil {
			t.Fatalf("第 %d 个非法组合应被拒绝", i+1)
		}
		if !strings.Contains(err.Error(), "runtime") && !strings.Contains(err.Error(), "gui") {
			t.Fatalf("第 %d 个错误信息不够具体：%v", i+1, err)
		}
	}
}
