package tui

import "unicode/utf8"

// keyKind 标识按键的种类。
type keyKind uint8

const (
	// keyNone 表示没有解析出按键。
	keyNone keyKind = iota
	// keyRune 是可打印字符（含中文等宽字符）。
	keyRune
	// keyCtrl 是 Ctrl 组合键，具体字节值见 key.ctrl。
	keyCtrl
	// keyEnter 是回车。
	keyEnter
	// keyTab 是制表符。
	keyTab
	// keyBackspace 是退格。
	keyBackspace
	// keyEsc 是单独的 Esc 键。
	keyEsc
	// keyDelete 是 Delete 键。
	keyDelete
	// keyInsert 是 Insert 键。
	keyInsert
	// keyUp、keyDown、keyLeft、keyRight 是方向键。
	keyUp
	keyDown
	keyLeft
	keyRight
	// keyHome 与 keyEnd 是行首、行尾键。
	keyHome
	keyEnd
	// keyPageUp 与 keyPageDown 是翻页键。
	keyPageUp
	keyPageDown
)

// key 是解析后的一个按键事件。
type key struct {
	kind keyKind
	r    rune // kind 为 keyRune 时有效
	ctrl byte // kind 为 keyCtrl 时有效，例如 0x03 表示 Ctrl+C
}

// nextKey 从 buf 开头解析一个按键。
//
// 返回解析出的按键、消耗的字节数以及是否解析成功。当 buf 中的转义序列或
// UTF-8 编码尚不完整时返回 ok=false，调用方应保留 buf 并等待更多字节。
//
// 单独一个 ESC 字节会被立即识别为 Esc 键：终端发送方向键等序列时通常在
// 同一次写入里给出全部字节，不会把 ESC 与后续字节拆开。
func nextKey(buf []byte) (key, int, bool) {
	if len(buf) == 0 {
		return key{}, 0, false
	}
	switch b := buf[0]; {
	case b == 0x1b:
		return nextEscapeKey(buf)
	case b == '\r' || b == '\n':
		return key{kind: keyEnter}, 1, true
	case b == '\t':
		return key{kind: keyTab}, 1, true
	case b == 0x7f || b == 0x08:
		return key{kind: keyBackspace}, 1, true
	case b < 0x20:
		return key{kind: keyCtrl, ctrl: b}, 1, true
	case b < utf8.RuneSelf:
		return key{kind: keyRune, r: rune(b)}, 1, true
	}

	r, size := utf8.DecodeRune(buf)
	if r == utf8.RuneError && size == 1 && !utf8.FullRune(buf) {
		// UTF-8 编码还不完整，等待后续字节。
		return key{}, 0, false
	}
	if r == utf8.RuneError && size == 1 {
		// 非法字节：丢弃这一个字节，避免卡住输入流。
		return key{}, 1, true
	}
	return key{kind: keyRune, r: r}, size, true
}

// nextEscapeKey 解析以 ESC 开头的按键：方向键等 CSI 序列、Alt 组合键或单独的 Esc。
func nextEscapeKey(buf []byte) (key, int, bool) {
	if len(buf) == 1 {
		return key{kind: keyEsc}, 1, true
	}
	switch buf[1] {
	case '[':
		return nextCSIKey(buf)
	case 'O':
		if len(buf) < 3 {
			return key{}, 0, false
		}
		switch buf[2] {
		case 'A':
			return key{kind: keyUp}, 3, true
		case 'B':
			return key{kind: keyDown}, 3, true
		case 'C':
			return key{kind: keyRight}, 3, true
		case 'D':
			return key{kind: keyLeft}, 3, true
		case 'H':
			return key{kind: keyHome}, 3, true
		case 'F':
			return key{kind: keyEnd}, 3, true
		}
		return key{}, 3, true
	case 0x1b:
		return key{kind: keyEsc}, 1, true
	}
	// Alt + 字符：忽略 Alt 前缀，按普通字符返回，避免 Alt 组合把输入卡住。
	r, size := utf8.DecodeRune(buf[1:])
	if r == utf8.RuneError && size == 1 && !utf8.FullRune(buf[1:]) {
		return key{}, 0, false
	}
	return key{kind: keyRune, r: r}, 1 + size, true
}

// nextCSIKey 解析 CSI 序列（ESC [ 参数 终止符）。
func nextCSIKey(buf []byte) (key, int, bool) {
	i := 2
	for i < len(buf) && buf[i] >= 0x30 && buf[i] <= 0x3F {
		i++
	}
	if i >= len(buf) {
		return key{}, 0, false
	}
	final := buf[i]
	n := i + 1
	switch final {
	case 'A':
		return key{kind: keyUp}, n, true
	case 'B':
		return key{kind: keyDown}, n, true
	case 'C':
		return key{kind: keyRight}, n, true
	case 'D':
		return key{kind: keyLeft}, n, true
	case 'H':
		return key{kind: keyHome}, n, true
	case 'F':
		return key{kind: keyEnd}, n, true
	case '~':
		switch string(buf[2:i]) {
		case "1", "7":
			return key{kind: keyHome}, n, true
		case "2":
			return key{kind: keyInsert}, n, true
		case "3":
			return key{kind: keyDelete}, n, true
		case "4", "8":
			return key{kind: keyEnd}, n, true
		case "5":
			return key{kind: keyPageUp}, n, true
		case "6":
			return key{kind: keyPageDown}, n, true
		}
	}
	// 未知或不需要的 CSI 序列：整体丢弃。
	return key{}, n, true
}
