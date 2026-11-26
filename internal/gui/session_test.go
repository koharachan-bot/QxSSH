package gui

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fakeTarget 是无副作用的 Target：默认所有探测都返回空（即依赖缺失）。
type fakeTarget struct {
	run    func(cmd string) (string, error)
	stream func(cmd string) (Proc, error)
}

func (f *fakeTarget) HostID() string { return "" }
func (f *fakeTarget) Label() string  { return "fake" }
func (f *fakeTarget) Close() error   { return nil }

func (f *fakeTarget) Run(ctx context.Context, cmd string) (string, error) {
	if f.run != nil {
		return f.run(cmd)
	}
	return "", nil
}

func (f *fakeTarget) Stream(ctx context.Context, cmd string) (Proc, error) {
	if f.stream != nil {
		return f.stream(cmd)
	}
	return nil, errors.New("not implemented")
}

func TestLaunchScriptCoreParts(t *testing.T) {
	spec := Spec{Command: []string{"wechat"}}.Normalize()
	script := launchScript(107, "/home/u/.cache/qxssh/gui/sess-1", spec)
	for _, want := range []string{
		"DISPLAY=:107",
		"setsid Xvfb :107 -screen 0 1280x800x24",
		"/tmp/.X11-unix/X107",
		"setsid env DISPLAY=:107",
		"setsid openbox",
		"wechat",
		"QXGUI_OK",
		"/home/u/.cache/qxssh/gui/sess-1/app.log",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("启动脚本缺少片段 %q：\n%s", want, script)
		}
	}
}

func TestLaunchScriptSoftwareGLAndEnv(t *testing.T) {
	spec := Spec{
		Command:    []string{"/opt/Blender/blender"},
		Args:       []string{"--factory-startup"},
		SoftwareGL: true,
		Env:        map[string]string{"LANG": "zh_CN.UTF-8"},
	}.Normalize()
	script := launchScript(110, "/s", spec)
	for _, want := range []string{"LIBGL_ALWAYS_SOFTWARE=1", "GALLIUM_DRIVER=llvmpipe", "LANG=zh_CN.UTF-8", "--factory-startup"} {
		if !strings.Contains(script, want) {
			t.Fatalf("启动脚本缺少 %q：\n%s", want, script)
		}
	}
}

func TestLaunchScriptWindowManagerNone(t *testing.T) {
	spec := Spec{Command: []string{"x"}, WindowManager: "none"}.Normalize()
	script := launchScript(120, "/s", spec)
	if strings.Contains(script, "openbox") || strings.Contains(script, "fluxbox") {
		t.Fatalf("windowManager=none 时不应启动窗口管理器：\n%s", script)
	}
}

func TestCleanupScript(t *testing.T) {
	script := cleanupScript("/s", 111)
	for _, want := range []string{"kill -TERM", "kill -KILL", "Xvfb :111 ", "rm -rf /s"} {
		if !strings.Contains(script, want) {
			t.Fatalf("清理脚本缺少 %q：\n%s", want, script)
		}
	}
}

func TestInstallDest(t *testing.T) {
	if got := installDest("/home/u", "blender46", &Install{}); got != "/home/u/.local/share/qxssh/runtimes/blender46" {
		t.Fatalf("默认安装目录错误：%s", got)
	}
	if got := installDest("/home/u", "blender46", &Install{Dest: "~/apps/b46"}); got != "/home/u/apps/b46" {
		t.Fatalf("~ 展开错误：%s", got)
	}
	if got := installDest("/home/u", "b", &Install{Dest: "rel"}); got != "/home/u/.local/share/qxssh/runtimes/b/rel" {
		t.Fatalf("相对目录应落在默认根下：%s", got)
	}
}

func TestApplyInstall(t *testing.T) {
	in := &Install{Bin: "blender"}
	got := applyInstall(Spec{Command: []string{"blender", "--version"}}, "/opt/b", in)
	if got.Command[0] != "/opt/b/blender" || got.Command[1] != "--version" {
		t.Fatalf("命令未替换为绝对路径：%v", got.Command)
	}
	got = applyInstall(Spec{}, "/opt/b", in)
	if len(got.Command) != 1 || got.Command[0] != "/opt/b/blender" {
		t.Fatalf("空命令应回退到运行时可执行文件：%v", got.Command)
	}
	got = applyInstall(Spec{Command: []string{"/usr/bin/blender"}}, "/opt/b", in)
	if got.Command[0] != "/usr/bin/blender" {
		t.Fatalf("已带路径的命令不应被替换：%v", got.Command)
	}
}

func TestNormalizeCodec(t *testing.T) {
	cases := map[string]string{
		"":        CodecH264,
		"h264":    CodecH264,
		"jpeg":    CodecJPEG,
		"mjpeg":   CodecJPEG,
		"no-such": CodecH264,
	}
	for in, want := range cases {
		if got := normalizeCodec([]string{in}); got != want {
			t.Fatalf("normalizeCodec(%q)=%q，期望 %q", in, got, want)
		}
	}
}

func TestVideoCommand(t *testing.T) {
	h := videoCommand(105, CodecH264, 30, 2500, 1280, 800)
	for _, want := range []string{"x11grab", "-i :105.0", "libx264", "aud=1", "1280x800"} {
		if !strings.Contains(h, want) {
			t.Fatalf("h264 命令缺少 %q：%s", want, h)
		}
	}
	j := videoCommand(105, CodecJPEG, 30, 2500, 1280, 800)
	if !strings.Contains(j, "mjpeg") {
		t.Fatalf("jpeg 命令缺少 mjpeg：%s", j)
	}
}

func TestManagerStartReportsMissingDeps(t *testing.T) {
	ft := &fakeTarget{}
	m := NewManager(func(string) (Target, error) { return ft, nil }, nil)
	_, err := m.Start(context.Background(), StartRequest{
		AppID: "x", Name: "x", Spec: Spec{Command: []string{"x"}},
	})
	if err == nil {
		t.Fatal("依赖缺失时应拒绝启动")
	}
	if !strings.Contains(err.Error(), "缺少必要组件") {
		t.Fatalf("错误信息应指出缺少组件：%v", err)
	}
}

func TestManagerStopUnknown(t *testing.T) {
	m := NewManager(nil, nil)
	if err := m.Stop("nope"); err == nil {
		t.Fatal("停止不存在的会话应报错")
	}
	if len(m.List()) != 0 {
		t.Fatal("空管理器不应有会话")
	}
}
