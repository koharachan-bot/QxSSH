package tui

import (
	"io"
	"strings"
	"sync"
)

// ANSI 转义序列。渲染层只使用这些已经验证过的序列，
// 避免依赖任何第三方终端库。
const (
	seqReset        = "\x1b[0m"
	seqBold         = "\x1b[1m"
	seqDim          = "\x1b[2m"
	seqReverse      = "\x1b[7m"
	seqRed          = "\x1b[31m"
	seqGreen        = "\x1b[32m"
	seqYellow       = "\x1b[33m"
	seqClear        = "\x1b[2J"
	seqHome         = "\x1b[H"
	seqClearLine    = "\x1b[K"
	seqHideCursor   = "\x1b[?25l"
	seqShowCursor   = "\x1b[?25h"
	seqAltScreenOn  = "\x1b[?1049h"
	seqAltScreenOff = "\x1b[?1049l"
)

// output 是加锁保护的终端输出。
//
// 渲染只发生在主循环里，但远端会话的输出由 SSH 会话的复制协程直接写入，
// 两者可能并发，因此所有写入统一经过这把锁，保证不会出现半行交错的乱码。
type output struct {
	mu sync.Mutex
	w  io.Writer
}

// Write 实现 io.Writer，串行化对底层终端的写入。
func (o *output) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.w.Write(p)
}

// screen 负责全屏渲染：进出 alternate screen、整帧重绘与表格布局。
type screen struct {
	out *output
}

// newScreen 创建一个向 out 写出的屏幕。
func newScreen(out *output) *screen {
	return &screen{out: out}
}

// enter 进入 alternate screen、清屏并隐藏光标。
func (s *screen) enter() error {
	_, err := io.WriteString(s.out, seqAltScreenOn+seqHideCursor+seqClear+seqHome)
	return err
}

// leave 恢复光标、重置颜色并退出 alternate screen。
// 退出路径上无论之前处于什么状态都要调用它，保证终端可用。
func (s *screen) leave() error {
	_, err := io.WriteString(s.out, seqReset+seqShowCursor+seqAltScreenOff)
	return err
}

// clear 清空屏幕并把光标移回左上角。
func (s *screen) clear() error {
	_, err := io.WriteString(s.out, seqReset+seqClear+seqHome)
	return err
}

// frame 用整帧替换的方式重绘屏幕。
//
// 光标先回到左上角，然后逐行输出并用 ESC[K 清除行尾残留。
// 行之间使用 \r\n：原始模式下 OPOST 可能已关闭，单独的 \n 不会回到行首。
func (s *screen) frame(lines []string) error {
	var b strings.Builder
	b.WriteString(seqHome)
	for i, line := range lines {
		if i > 0 {
			b.WriteString("\r\n")
		}
		b.WriteString(line)
		b.WriteString(seqClearLine)
	}
	b.WriteString(seqReset)
	_, err := io.WriteString(s.out, b.String())
	return err
}

// tableWidth 返回一组列宽加列间距后的总显示宽度。
func tableWidth(widths []int) int {
	if len(widths) == 0 {
		return 0
	}
	sum := 0
	for _, w := range widths {
		sum += w
	}
	return sum + 2*(len(widths)-1)
}

// fitColumns 把可用总宽度 total 分配给各列。
//
// natural 是每列内容的自然宽度。总宽富余时把余量全部给最后一列
// （通常是分组列，适合吸收多余空间）；总宽不足时反复压缩当前最宽的列，
// 直到放得下或每列都到达下限，保证表格不会横向溢出。
func fitColumns(natural []int, total int) []int {
	n := len(natural)
	out := make([]int, n)
	copy(out, natural)
	if n == 0 {
		return out
	}
	const gap = 2
	avail := total - gap*(n-1)
	if avail < n {
		avail = n
	}
	sum := 0
	for _, w := range out {
		sum += w
	}
	minWidth := 4
	if avail/n < minWidth {
		minWidth = avail / n
		if minWidth < 1 {
			minWidth = 1
		}
	}
	for sum > avail {
		idx := widestIndex(out)
		if out[idx] <= minWidth {
			break
		}
		out[idx]--
		sum--
	}
	for sum < avail {
		out[n-1]++
		sum++
	}
	return out
}

// widestIndex 返回最宽一列的下标；等宽时返回靠前的列。
func widestIndex(widths []int) int {
	idx := 0
	for i := 1; i < len(widths); i++ {
		if widths[i] > widths[idx] {
			idx = i
		}
	}
	return idx
}

// tableHeader 渲染表头行：名称、地址、用户名、分组。
func tableHeader(widths []int) string {
	return seqDim + hostRow([]string{"名称", "地址", "用户名", "分组"}, widths, false) + seqReset
}

// separatorLine 渲染表头与内容之间的分隔线。
func separatorLine(width int) string {
	if width < 1 {
		width = 1
	}
	return seqDim + strings.Repeat("-", width) + seqReset
}
