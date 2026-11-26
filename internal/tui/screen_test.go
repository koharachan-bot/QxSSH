package tui

import (
	"bytes"
	"strings"
	"testing"
)

// TestScreenFrame 验证整帧渲染：回到左上角、行间回车换行、行尾清行。
func TestScreenFrame(t *testing.T) {
	var buf bytes.Buffer
	s := newScreen(&output{w: &buf})
	if err := s.frame([]string{"第一行", "abc"}); err != nil {
		t.Fatalf("frame 失败: %v", err)
	}
	got := buf.String()
	if !strings.HasPrefix(got, seqHome) {
		t.Errorf("帧未以光标归位开头: %q", got)
	}
	if !strings.Contains(got, "第一行"+seqClearLine+"\r\n"+"abc"+seqClearLine) {
		t.Errorf("帧内容不符合预期: %q", got)
	}
	if !strings.HasSuffix(got, seqReset) {
		t.Errorf("帧未以颜色重置结尾: %q", got)
	}
}

// TestScreenEnterLeave 验证进出 alternate screen 与光标恢复。
func TestScreenEnterLeave(t *testing.T) {
	var buf bytes.Buffer
	s := newScreen(&output{w: &buf})
	if err := s.enter(); err != nil {
		t.Fatalf("enter 失败: %v", err)
	}
	if !strings.Contains(buf.String(), seqAltScreenOn) || !strings.Contains(buf.String(), seqHideCursor) {
		t.Errorf("enter 未开启 alternate screen 或未隐藏光标: %q", buf.String())
	}
	buf.Reset()
	if err := s.leave(); err != nil {
		t.Fatalf("leave 失败: %v", err)
	}
	if !strings.Contains(buf.String(), seqShowCursor) || !strings.Contains(buf.String(), seqAltScreenOff) {
		t.Errorf("leave 未恢复光标或未关闭 alternate screen: %q", buf.String())
	}
}

// TestHostRowWidth 验证含中文与 emoji 的表格行显示宽度精确等于列宽和间距。
func TestHostRowWidth(t *testing.T) {
	widths := []int{8, 12, 6, 6}
	cells := []string{"生产机", "10.0.0.1:22", "root", "prod"}
	row := hostRow(cells, widths, false)
	if got, want := stringWidth(row), tableWidth(widths); got != want {
		t.Errorf("表格行显示宽度=%d, 期望 %d（%q）", got, want, row)
	}

	selected := hostRow(cells, widths, true)
	if !strings.HasPrefix(selected, seqReverse) {
		t.Errorf("选中行未反色: %q", selected)
	}
}

// TestHostRowCJKAlignment 验证超长中文单元格按显示宽度截断，不会破坏对齐。
func TestHostRowCJKAlignment(t *testing.T) {
	widths := []int{6, 10, 4, 4}
	cells := []string{"非常长的主机名称", "192.168.100.200:2222", "用户名字", "分组名称"}
	row := hostRow(cells, widths, false)
	if got, want := stringWidth(row), tableWidth(widths); got != want {
		t.Errorf("超宽单元格渲染后宽度=%d, 期望 %d（%q）", got, want, row)
	}
}
