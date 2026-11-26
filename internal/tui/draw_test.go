package tui

import (
	"bytes"
	"strings"
	"testing"
)

// TestDrawHostsPage 验证主机列表页渲染出表格、主机内容、消息与状态栏版本号。
func TestDrawHostsPage(t *testing.T) {
	var buf bytes.Buffer
	out := &output{w: &buf}
	a := newApp(Deps{Version: "1.2.3"}, out, newScreen(out))
	defer a.ticker.Stop()

	a.hosts.all = testHosts()
	a.hosts.applyFilter()
	a.setMessage("最近一条提示", false)
	a.width, a.height = 80, 20

	if err := a.drawHosts(); err != nil {
		t.Fatalf("渲染主机列表页失败: %v", err)
	}
	page := buf.String()
	wants := []string{
		"名称", "地址", "用户名", "分组",
		"生产 Web", "10.0.0.1:22", "root", "prod",
		"最近一条提示", "主机列表", "QxSSH v1.2.3",
	}
	for _, want := range wants {
		if !strings.Contains(page, want) {
			t.Errorf("页面缺少 %q", want)
		}
	}
	if !strings.HasPrefix(page, seqHome) {
		t.Errorf("页面未从左上角开始绘制")
	}
}

// TestDrawHostsEmpty 验证空列表显示中文提示与快捷键。
func TestDrawHostsEmpty(t *testing.T) {
	var buf bytes.Buffer
	out := &output{w: &buf}
	a := newApp(Deps{}, out, newScreen(out))
	defer a.ticker.Stop()

	a.width, a.height = 80, 20
	if err := a.drawHosts(); err != nil {
		t.Fatalf("渲染空列表失败: %v", err)
	}
	page := buf.String()
	if !strings.Contains(page, "暂无主机") {
		t.Errorf("空列表缺少中文提示: %q", page)
	}
	if !strings.Contains(page, "q 退出") {
		t.Errorf("空列表缺少快捷键提示: %q", page)
	}
}

// TestDrawHostsFilterMode 验证过滤模式的状态栏显示过滤条件与匹配数量。
func TestDrawHostsFilterMode(t *testing.T) {
	var buf bytes.Buffer
	out := &output{w: &buf}
	a := newApp(Deps{Version: "2.0.0"}, out, newScreen(out))
	defer a.ticker.Stop()

	a.hosts.all = testHosts()
	a.hosts.applyFilter()
	a.hosts.beginFilter()
	a.hosts.appendFilter('p')
	a.width, a.height = 80, 20
	if err := a.drawHosts(); err != nil {
		t.Fatalf("渲染过滤页面失败: %v", err)
	}
	page := buf.String()
	if !strings.Contains(page, "过滤: p") {
		t.Errorf("状态栏缺少过滤条件: %q", page)
	}
	if !strings.Contains(page, "/4 台") {
		t.Errorf("状态栏缺少匹配数量: %q", page)
	}
}
