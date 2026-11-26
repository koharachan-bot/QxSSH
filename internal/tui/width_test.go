package tui

import "testing"

// TestRuneWidth 覆盖 ASCII、中文、emoji、全角、组合符号与控制字符的显示宽度。
func TestRuneWidth(t *testing.T) {
	cases := []struct {
		name string
		r    rune
		want int
	}{
		{"ASCII 字母", 'a', 1},
		{"ASCII 空格", ' ', 1},
		{"ASCII 标点", ']', 1},
		{"汉字", '中', 2},
		{"汉字 2", '汉', 2},
		{"全角字母", 'Ａ', 2},
		{"全角空格", '\u3000', 2},
		{"平假名", 'あ', 2},
		{"谚文音节", '한', 2},
		{"emoji 笑脸", '😀', 2},
		{"emoji 庆祝", '🎉', 2},
		{"emoji 点赞", '👍', 2},
		{"组合重音", '\u0301', 0},
		{"零宽连接符", '\u200d', 0},
		{"变体选择符", '\ufe0f', 0},
		{"NUL", 0, 0},
		{"换行", '\n', 0},
		{"DEL", 0x7f, 0},
		{"制表边框", '─', 1},
		{"带重音的字母", 'é', 1},
	}
	for _, tc := range cases {
		if got := runeWidth(tc.r); got != tc.want {
			t.Errorf("runeWidth(%q)=%d, 期望 %d（%s）", tc.r, got, tc.want, tc.name)
		}
	}
}

// TestStringWidth 验证整串文本的显示宽度按字符宽度累加，而不是按字符个数。
func TestStringWidth(t *testing.T) {
	cases := []struct {
		s    string
		want int
	}{
		{"", 0},
		{"abc", 3},
		{"中文", 4},
		{"中文abc", 7},
		{"主机 host", 9},
		{"😀", 2},
		{"a😀中", 5},
		{"e\u0301", 1},
	}
	for _, tc := range cases {
		if got := stringWidth(tc.s); got != tc.want {
			t.Errorf("stringWidth(%q)=%d, 期望 %d", tc.s, got, tc.want)
		}
	}
}

// TestTruncateWidth 验证按显示宽度截断，覆盖 ASCII、中文、emoji 与边界情况。
func TestTruncateWidth(t *testing.T) {
	cases := []struct {
		s    string
		max  int
		want string
	}{
		{"abc", 0, ""},
		{"abc", 1, "…"},
		{"abc", 2, "a…"},
		{"abc", 3, "abc"},
		{"abc", 10, "abc"},
		{"中文", 3, "中…"},
		{"中文", 4, "中文"},
		{"中文", 2, "…"},
		{"中文abc", 5, "中文…"},
		{"中文abc", 6, "中文a…"},
		{"😀😀", 3, "😀…"},
		{"😀😀", 4, "😀😀"},
		{"主机列表", 6, "主机…"},
	}
	for _, tc := range cases {
		got := truncateWidth(tc.s, tc.max)
		if got != tc.want {
			t.Errorf("truncateWidth(%q, %d)=%q, 期望 %q", tc.s, tc.max, got, tc.want)
		}
		if w := stringWidth(got); w > tc.max {
			t.Errorf("truncateWidth(%q, %d) 宽度 %d 超过上限", tc.s, tc.max, w)
		}
	}
}

// TestPadWidth 验证按显示宽度补空格。
func TestPadWidth(t *testing.T) {
	if got := padWidth("abc", 5); got != "abc  " {
		t.Errorf("padWidth(abc,5)=%q", got)
	}
	if got := padWidth("中文", 6); got != "中文  " {
		t.Errorf("padWidth(中文,6)=%q", got)
	}
	if got := padWidth("abcdef", 3); got != "ab…" {
		t.Errorf("padWidth(abcdef,3)=%q", got)
	}
	if got := padWidth("中", 2); stringWidth(got) != 2 {
		t.Errorf("padWidth(中,2) 宽度=%d", stringWidth(got))
	}
}

// TestFitColumns 验证列宽分配：富余宽度给最后一列，不足时压缩且不溢出。
func TestFitColumns(t *testing.T) {
	got := fitColumns([]int{10, 30, 10, 10}, 80)
	if want := []int{10, 30, 10, 24}; !equalInts(got, want) {
		t.Errorf("fitColumns 富余场景=%v, 期望 %v", got, want)
	}
	if total := columnTotal(got); total != 80 {
		t.Errorf("fitColumns 总宽=%d, 期望 80", total)
	}

	got = fitColumns([]int{20, 40, 20, 20}, 30)
	if total := columnTotal(got); total > 30 {
		t.Errorf("fitColumns 压缩后总宽=%d, 超过 30（列宽 %v）", total, got)
	}
	for i, w := range got {
		if w < 1 {
			t.Errorf("fitColumns 第 %d 列宽度=%d, 应 ≥1", i, w)
		}
	}

	got = fitColumns(nil, 80)
	if len(got) != 0 {
		t.Errorf("fitColumns(nil)=%v, 期望空", got)
	}
}

// equalInts 比较两个整数切片。
func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// columnTotal 返回列宽加列间距后的总宽度。
func columnTotal(widths []int) int {
	return tableWidth(widths)
}
