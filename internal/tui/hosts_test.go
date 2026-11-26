package tui

import (
	"testing"

	"qxssh/internal/config"
)

// testHosts 构造一组用于过滤测试的主机。
func testHosts() []config.PublicHost {
	return []config.PublicHost{
		{ID: "1", Name: "生产 Web", Group: "prod", Address: "10.0.0.1", Port: 22, User: "root"},
		{ID: "2", Name: "生产 DB", Group: "prod", Address: "10.0.0.2", Port: 2222, User: "dba"},
		{ID: "3", Name: "测试机", Group: "test", Address: "192.168.1.5", Port: 22, User: "dev"},
		{ID: "4", Name: "Gateway", Group: "edge", Address: "example.com", Port: 22, User: "ops"},
	}
}

// TestHostAddr 验证地址列渲染为 host:port，IPv6 加方括号。
func TestHostAddr(t *testing.T) {
	cases := []struct {
		host config.PublicHost
		want string
	}{
		{config.PublicHost{Address: "10.0.0.1", Port: 22}, "10.0.0.1:22"},
		{config.PublicHost{Address: "example.com", Port: 2222}, "example.com:2222"},
		{config.PublicHost{Address: "::1", Port: 22}, "[::1]:22"},
		{config.PublicHost{Address: "host"}, "host"},
	}
	for _, tc := range cases {
		if got := hostAddr(tc.host); got != tc.want {
			t.Errorf("hostAddr(%+v)=%q, 期望 %q", tc.host, got, tc.want)
		}
	}
}

// TestMatchHost 验证按名称、地址、用户名、分组的模糊匹配与多词 AND 语义。
func TestMatchHost(t *testing.T) {
	hosts := testHosts()
	cases := []struct {
		query string
		want  int // 期望匹配的数量
	}{
		{"", 4},
		{"生产", 2},
		{"prod", 2},
		{"prod web", 1},
		{"PROD", 2},
		{"10.0", 2},
		{"2222", 1},
		{"dba", 1},
		{"edge", 1},
		{"测试", 1},
		{"不存在的词", 0},
		{"prod nomatch", 0},
	}
	for _, tc := range cases {
		n := 0
		for _, host := range hosts {
			if matchHost(host, tc.query) {
				n++
			}
		}
		if n != tc.want {
			t.Errorf("matchHost 查询 %q 匹配 %d 台, 期望 %d 台", tc.query, n, tc.want)
		}
	}
}

// TestHostListFilter 验证过滤会修正选中位置，清空过滤后恢复完整列表。
func TestHostListFilter(t *testing.T) {
	h := &hostList{all: testHosts()}
	h.applyFilter()
	if len(h.view) != 4 {
		t.Fatalf("初始可见主机=%d, 期望 4", len(h.view))
	}

	h.selectLast()
	h.appendFilter('测')
	if len(h.view) != 1 {
		t.Fatalf("过滤“测”后可见主机=%d, 期望 1", len(h.view))
	}
	if h.sel != 0 {
		t.Errorf("过滤后选中项=%d, 期望归零", h.sel)
	}
	host, ok := h.selected()
	if !ok || host.ID != "3" {
		t.Errorf("过滤后选中主机=%+v, ok=%v", host, ok)
	}

	h.backspaceFilter()
	if len(h.view) != 4 {
		t.Errorf("删除过滤字符后可见主机=%d, 期望 4", len(h.view))
	}

	h.appendFilter('p')
	h.clearFilter()
	if len(h.view) != 4 || h.filter != "" {
		t.Errorf("清空过滤后可见主机=%d, filter=%q", len(h.view), h.filter)
	}
}

// TestHostListMove 验证移动与滚动窗口边界。
func TestHostListMove(t *testing.T) {
	h := &hostList{all: testHosts()}
	h.applyFilter()

	h.move(-1)
	if h.sel != 0 {
		t.Errorf("首行上移后 sel=%d, 期望 0", h.sel)
	}
	h.move(100)
	if h.sel != 3 {
		t.Errorf("下移越界后 sel=%d, 期望 3", h.sel)
	}
	h.ensureVisible(2)
	if h.offset != 2 {
		t.Errorf("ensureVisible(2) 后 offset=%d, 期望 2", h.offset)
	}
	h.selectFirst()
	h.ensureVisible(2)
	if h.offset != 0 {
		t.Errorf("回到首行后 offset=%d, 期望 0", h.offset)
	}
}

// TestHostListEmpty 验证空列表下 selected 返回 false 且移动不越界。
func TestHostListEmpty(t *testing.T) {
	h := &hostList{}
	h.applyFilter()
	h.move(5)
	if h.sel != 0 {
		t.Errorf("空列表 sel=%d, 期望 0", h.sel)
	}
	if _, ok := h.selected(); ok {
		t.Error("空列表 selected 应返回 false")
	}
}
