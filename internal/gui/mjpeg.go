package gui

import "bytes"

// JPEGFramer 从连续的 JPEG 字节流（ffmpeg 的 -f mjpeg 输出）中切出完整帧。
// 它是 H.264 不可用时的降级通道：每帧独立解码，代价是带宽更高、运动画面有块效应，
// 但在没有 WebCodecs 或需要极简实现的浏览器上仍可用。
type JPEGFramer struct {
	rest []byte
}

// NewJPEGFramer 创建 JPEG 帧解析器。
func NewJPEGFramer() *JPEGFramer { return &JPEGFramer{} }

// Feed 追加数据并返回其中已完整的 JPEG 帧（含 SOI/EOI 标记）。
func (f *JPEGFramer) Feed(p []byte) [][]byte {
	buf := append(f.rest, p...)
	var out [][]byte
	for {
		start := bytes.Index(buf, []byte{0xff, 0xd8})
		if start < 0 {
			// 保留最后一个 0xff，防止 SOI 标记被切断。
			if len(buf) > 0 && buf[len(buf)-1] == 0xff {
				buf = buf[len(buf)-1:]
			} else {
				buf = buf[:0]
			}
			break
		}
		end := bytes.Index(buf[start+2:], []byte{0xff, 0xd9})
		if end < 0 {
			buf = buf[start:]
			break
		}
		frame := buf[start : start+2+end+2]
		out = append(out, bytes.Clone(frame))
		buf = buf[start+2+end+2:]
	}
	f.rest = bytes.Clone(buf)
	return out
}
