package tui

import (
	"strconv"
	"strings"

	"qxssh/internal/config"
)

// hostList 维护主机列表、过滤条件与选中位置。
//
// 它不持有任何终端资源，可在单元测试中直接构造和验证。
type hostList struct {
	all       []config.PublicHost // 全部主机
	view      []config.PublicHost // 过滤后的可见主机
	filter    string              // 当前过滤条件
	filtering bool                // 是否处于过滤输入模式
	sel       int                 // 选中下标（相对 view）
	offset    int                 // 列表滚动起点
}

// load 从配置存储重新读取主机列表，并保持当前过滤条件。
func (h *hostList) load(store *config.Store) {
	h.all = store.ListHosts()
	h.applyFilter()
}

// hostAddr 返回主机的 host:port 显示形式，IPv6 地址会加方括号。
func hostAddr(h config.PublicHost) string {
	if h.Port <= 0 {
		return h.Address
	}
	if strings.Contains(h.Address, ":") && !strings.HasPrefix(h.Address, "[") {
		return "[" + h.Address + "]:" + strconv.Itoa(h.Port)
	}
	return h.Address + ":" + strconv.Itoa(h.Port)
}

// matchHost 报告主机是否匹配过滤条件。
//
// 过滤词按空格拆分，每个词都必须出现在名称、地址、端口、用户名或分组的
// 任意位置（大小写不敏感，词序无关），即多词模糊匹配的 AND 语义。
func matchHost(h config.PublicHost, query string) bool {
	terms := strings.Fields(strings.ToLower(query))
	if len(terms) == 0 {
		return true
	}
	haystack := strings.ToLower(strings.Join([]string{
		h.Name, hostAddr(h), h.User, h.Group,
	}, "\x00"))
	for _, term := range terms {
		if !strings.Contains(haystack, term) {
			return false
		}
	}
	return true
}

// applyFilter 按当前过滤条件重建可见列表，并修正选中位置。
func (h *hostList) applyFilter() {
	if strings.TrimSpace(h.filter) == "" {
		h.view = h.all
	} else {
		view := make([]config.PublicHost, 0, len(h.all))
		for _, host := range h.all {
			if matchHost(host, h.filter) {
				view = append(view, host)
			}
		}
		h.view = view
	}
	if h.sel >= len(h.view) {
		h.sel = len(h.view) - 1
	}
	if h.sel < 0 {
		h.sel = 0
	}
}

// selected 返回当前选中的主机；列表为空时第二个返回值是 false。
func (h *hostList) selected() (config.PublicHost, bool) {
	if h.sel < 0 || h.sel >= len(h.view) {
		return config.PublicHost{}, false
	}
	return h.view[h.sel], true
}

// move 按 delta 移动选中项，并在边界处停住。
func (h *hostList) move(delta int) {
	if len(h.view) == 0 {
		h.sel = 0
		return
	}
	h.sel += delta
	if h.sel < 0 {
		h.sel = 0
	}
	if h.sel >= len(h.view) {
		h.sel = len(h.view) - 1
	}
}

// selectFirst 把选中项移到列表首行。
func (h *hostList) selectFirst() {
	h.sel = 0
}

// selectLast 把选中项移到列表末行。
func (h *hostList) selectLast() {
	h.sel = len(h.view) - 1
	if h.sel < 0 {
		h.sel = 0
	}
}

// ensureVisible 调整滚动起点，使选中项落在 rows 行的可视窗口内。
func (h *hostList) ensureVisible(rows int) {
	if rows < 1 {
		rows = 1
	}
	if h.sel < h.offset {
		h.offset = h.sel
	}
	if h.sel >= h.offset+rows {
		h.offset = h.sel - rows + 1
	}
	maxOffset := len(h.view) - rows
	if maxOffset < 0 {
		maxOffset = 0
	}
	if h.offset > maxOffset {
		h.offset = maxOffset
	}
	if h.offset < 0 {
		h.offset = 0
	}
}

// beginFilter 进入过滤输入模式。
func (h *hostList) beginFilter() {
	h.filtering = true
}

// appendFilter 追加一个过滤字符并立即重新过滤。
func (h *hostList) appendFilter(r rune) {
	h.filter += string(r)
	h.applyFilter()
}

// backspaceFilter 删除过滤条件末尾的一个字符（按 rune 删除）并重新过滤。
func (h *hostList) backspaceFilter() {
	rs := []rune(h.filter)
	if len(rs) > 0 {
		h.filter = string(rs[:len(rs)-1])
	}
	h.applyFilter()
}

// endFilter 退出过滤输入模式；clear 为真时同时清空过滤条件。
func (h *hostList) endFilter(clear bool) {
	h.filtering = false
	if clear {
		h.clearFilter()
	}
}

// clearFilter 清空过滤条件并恢复完整列表。
func (h *hostList) clearFilter() {
	h.filter = ""
	h.applyFilter()
}

// hostCells 返回主机在表格中的四个单元格文本：名称、地址、用户名、分组。
func hostCells(h config.PublicHost) []string {
	return []string{h.Name, hostAddr(h), h.User, h.Group}
}

// hostRow 把单元格渲染为一行表格文本；selected 为真时整行反色显示。
func hostRow(cells []string, widths []int, selected bool) string {
	var b strings.Builder
	for i := range widths {
		if i > 0 {
			b.WriteString("  ")
		}
		cell := ""
		if i < len(cells) {
			cell = cells[i]
		}
		b.WriteString(padWidth(cell, widths[i]))
	}
	row := b.String()
	if selected {
		return seqReverse + row + seqReset
	}
	return row
}
