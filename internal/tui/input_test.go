package tui

import "testing"

// TestNextKey 覆盖普通字符、方向键、Ctrl 组合键与中文输入。
func TestNextKey(t *testing.T) {
	cases := []struct {
		name    string
		in      []byte
		want    key
		consume int
	}{
		{"ASCII", []byte("a"), key{kind: keyRune, r: 'a'}, 1},
		{"中文", []byte("中"), key{kind: keyRune, r: '中'}, 3},
		{"Ctrl+C", []byte{0x03}, key{kind: keyCtrl, ctrl: 0x03}, 1},
		{"Ctrl+]", []byte{0x1d}, key{kind: keyCtrl, ctrl: 0x1d}, 1},
		{"Enter", []byte("\r"), key{kind: keyEnter}, 1},
		{"Backspace", []byte{0x7f}, key{kind: keyBackspace}, 1},
		{"Esc", []byte("\x1b"), key{kind: keyEsc}, 1},
		{"上方向键", []byte("\x1b[A"), key{kind: keyUp}, 3},
		{"下方向键", []byte("\x1b[B"), key{kind: keyDown}, 3},
		{"右方向键", []byte("\x1b[C"), key{kind: keyRight}, 3},
		{"左方向键", []byte("\x1b[D"), key{kind: keyLeft}, 3},
		{"SS3 上方向键", []byte("\x1bOA"), key{kind: keyUp}, 3},
		{"Delete", []byte("\x1b[3~"), key{kind: keyDelete}, 4},
		{"PageUp", []byte("\x1b[5~"), key{kind: keyPageUp}, 4},
		{"Home", []byte("\x1b[H"), key{kind: keyHome}, 3},
		{"End", []byte("\x1b[F"), key{kind: keyEnd}, 3},
	}
	for _, tc := range cases {
		got, n, ok := nextKey(tc.in)
		if !ok {
			t.Errorf("%s: nextKey(%q) 未解析出按键", tc.name, tc.in)
			continue
		}
		if got != tc.want {
			t.Errorf("%s: nextKey(%q)=%+v, 期望 %+v", tc.name, tc.in, got, tc.want)
		}
		if n != tc.consume {
			t.Errorf("%s: 消耗字节=%d, 期望 %d", tc.name, n, tc.consume)
		}
	}
}

// TestNextKeyIncomplete 验证不完整的转义序列与 UTF-8 编码返回 ok=false，调用方应等待更多字节。
func TestNextKeyIncomplete(t *testing.T) {
	incomplete := [][]byte{
		[]byte("\x1b["),
		{0x1b, 0x5b, '3'},
		{0xe4, 0xb8}, // “中”的前两个字节
	}
	for _, in := range incomplete {
		if _, n, ok := nextKey(in); ok {
			t.Errorf("nextKey(%q) 不应解析成功（消耗 %d 字节）", in, n)
		}
	}
}

// TestNextKeySequence 验证一次读取多个按键时能逐个解析。
func TestNextKeySequence(t *testing.T) {
	buf := []byte("jk\x1b[Aq")
	kinds := []keyKind{}
	for len(buf) > 0 {
		k, n, ok := nextKey(buf)
		if !ok {
			t.Fatalf("解析 %q 时意外不完整", buf)
		}
		kinds = append(kinds, k.kind)
		buf = buf[n:]
	}
	want := []keyKind{keyRune, keyRune, keyUp, keyRune}
	if len(kinds) != len(want) {
		t.Fatalf("解析出 %d 个按键, 期望 %d 个", len(kinds), len(want))
	}
	for i := range want {
		if kinds[i] != want[i] {
			t.Errorf("第 %d 个按键类型=%v, 期望 %v", i, kinds[i], want[i])
		}
	}
}
