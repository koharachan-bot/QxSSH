package console

import (
	"reflect"
	"testing"
)

func TestSelectDefaultsToGui(t *testing.T) {
	got := Select(false, false, false)
	if want := []string{"gui"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Select(false,false,false) = %v, want %v", got, want)
	}
}

func TestSelectKeepsFixedOrder(t *testing.T) {
	cases := []struct {
		web, tui, gui bool
		want          []string
	}{
		{true, false, false, []string{"web"}},
		{false, true, false, []string{"tui"}},
		{false, false, true, []string{"gui"}},
		{true, true, true, []string{"web", "tui", "gui"}},
		{true, false, true, []string{"web", "gui"}},
	}
	for _, c := range cases {
		got := Select(c.web, c.tui, c.gui)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("Select(%v,%v,%v) = %v, want %v", c.web, c.tui, c.gui, got, c.want)
		}
	}
}

func TestResolveKeepsGuiSeparate(t *testing.T) {
	plugins, err := Resolve([]string{"web", "gui"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(plugins) != 2 {
		t.Fatalf("web 与 gui 是两套实现，应各启动一个，实际 %d 个", len(plugins))
	}
	if plugins[0].Kind() != KindWeb || plugins[1].Kind() != KindGUI {
		t.Fatalf("应固定按 web、gui 排序，实际 %q、%q", plugins[0].Kind(), plugins[1].Kind())
	}
	if !HasKind(plugins, KindGUI) {
		t.Fatal("HasKind 未识别 gui")
	}
}

func TestResolveDedupesRepeatedName(t *testing.T) {
	plugins, err := Resolve([]string{"web", "web"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(plugins) != 1 {
		t.Fatalf("重复名字应去重，实际 %d 个", len(plugins))
	}
}

func TestGuiPluginIdentity(t *testing.T) {
	p := guiPlugin{}
	if p.Name() != "gui" {
		t.Errorf("Name = %q, want gui", p.Name())
	}
	if p.Kind() != KindGUI {
		t.Errorf("Kind = %q, want %q", p.Kind(), KindGUI)
	}
}

func TestResolveCombination(t *testing.T) {
	plugins, err := Resolve([]string{"tui", "web"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(plugins) != 2 {
		t.Fatalf("web 与 tui 应各启动一个，实际 %d 个", len(plugins))
	}
	if plugins[0].Kind() != KindWeb || plugins[1].Kind() != KindTUI {
		t.Fatalf("应固定按 web、tui 排序，实际 %q、%q", plugins[0].Kind(), plugins[1].Kind())
	}
	if !HasKind(plugins, KindWeb) || !HasKind(plugins, KindTUI) {
		t.Fatal("HasKind 未正确识别 web 与 tui")
	}
	if HasKind(plugins, "missing") {
		t.Fatal("HasKind 对未知实现族应返回 false")
	}
}

func TestResolveRejectsUnknownName(t *testing.T) {
	if _, err := Resolve([]string{"web", "terminal"}); err == nil {
		t.Fatal("未知插件名应返回错误")
	}
}
