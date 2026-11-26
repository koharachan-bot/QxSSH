package gui

import (
	"bytes"
	"encoding/binary"
)

// H.264 编码后的码流是 Annex-B 格式（NAL 之间用 00 00 01 分隔），而浏览器
// WebCodecs 的 VideoDecoder 在带 avcC 描述时要求长度前缀（AVCC）格式。
// 本文件负责把 ffmpeg 的裸 H.264 输出切成访问单元（access unit）并转换格式。

// NAL 单元类型（H.264 第 7.3.1 节）。
const (
	nalSliceNonIDR = 1
	nalSliceIDR    = 5
	nalSEI         = 6
	nalSPS         = 7
	nalPPS         = 8
	nalAUD         = 9
)

// AccessUnit 是一个完整的解码单元：Data 已是 AVCC 长度前缀格式，
// Keyframe 供前端标记 EncodedVideoChunk 的 type。
type AccessUnit struct {
	Data     []byte
	Keyframe bool
}

// AUFramer 增量解析 Annex-B 码流并产出访问单元。它假定码流带 AUD
// （ffmpeg 侧用 -x264-params aud=1 生成）；若某个码流没有 AUD，
// 则退化为「每个 VCL 片开始新单元」的分组方式，仍能正常解码。
type AUFramer struct {
	rest []byte // 尚未确定边界的尾部字节

	sps []byte
	pps []byte

	cur      [][]byte // 当前访问单元已收集的 NAL（不含起始码）
	hasVCL   bool
	keyframe bool
}

// NewAUFramer 创建访问单元解析器。
func NewAUFramer() *AUFramer { return &AUFramer{} }

// Feed 追加一段码流并返回已完整的访问单元，可一次返回 0~N 个。
func (f *AUFramer) Feed(p []byte) []AccessUnit {
	buf := append(f.rest, p...)
	var out []AccessUnit

	pos := 0
	for {
		start, scLen := findStartCode(buf, pos)
		if start < 0 {
			// 没有新的起始码：最多保留 3 字节，防止把 00 00 01 的跨界前缀丢掉。
			if len(buf)-pos > 3 {
				buf = buf[len(buf)-3:]
			} else {
				buf = buf[pos:]
			}
			break
		}
		next, _ := findStartCode(buf, start+scLen)
		if next < 0 {
			// 当前 NAL 尚未结束，从这里继续等待后续数据。
			buf = buf[start:]
			break
		}
		nal := buf[start+scLen : next]
		pos = next
		if au, ok := f.push(nal); ok {
			out = append(out, au)
		}
	}
	f.rest = bytes.Clone(buf)
	return out
}

// Flush 在码流结束时收尾：先把尾部那个没有后继起始码的 NAL 并入当前单元，
// 再交出所有尚未输出的访问单元。单元边界依赖「下一个起始码」，所以不收尾
// 就会丢掉最后一帧。
func (f *AUFramer) Flush() []AccessUnit {
	var out []AccessUnit
	if start, sc := findStartCode(f.rest, 0); start >= 0 {
		nal := bytes.TrimRight(f.rest[start+sc:], "\x00")
		if len(nal) > 0 {
			if au, ok := f.push(nal); ok {
				out = append(out, au)
			}
		}
	}
	f.rest = nil
	if f.hasVCL {
		out = append(out, f.finish())
	}
	return out
}

// push 把一个 NAL 并入当前访问单元，必要时结束上一个单元。
func (f *AUFramer) push(nal []byte) (AccessUnit, bool) {
	if len(nal) == 0 {
		return AccessUnit{}, false
	}
	typ := nal[0] & 0x1f

	// 只有已经收集到片数据时，新的 AUD（或没有 AUD 时的下一个片）才是切分点；
	// 紧跟 AUD 之后的 SPS/PPS 属于下一个单元，不能单独成组。
	cut := false
	switch typ {
	case nalAUD:
		cut = f.hasVCL
	case nalSliceNonIDR, nalSliceIDR:
		cut = f.hasVCL
	}
	var ready AccessUnit
	if cut {
		ready = f.finish()
	}

	switch typ {
	case nalSPS:
		f.sps = bytes.Clone(nal)
	case nalPPS:
		f.pps = bytes.Clone(nal)
	case nalSliceIDR:
		f.keyframe = true
	}
	if typ == nalAUD {
		return ready, cut
	}
	f.cur = append(f.cur, bytes.Clone(nal))
	if typ == nalSliceIDR || typ == nalSliceNonIDR {
		f.hasVCL = true
	}
	return ready, cut
}

// finish 把当前单元转成 AVCC 字节并重置状态。
func (f *AUFramer) finish() AccessUnit {
	if len(f.cur) == 0 {
		return AccessUnit{}
	}
	size := 0
	for _, n := range f.cur {
		size += 4 + len(n)
	}
	out := make([]byte, 0, size)
	var lb [4]byte
	for _, n := range f.cur {
		binary.BigEndian.PutUint32(lb[:], uint32(len(n)))
		out = append(out, lb[:]...)
		out = append(out, n...)
	}
	au := AccessUnit{Data: out, Keyframe: f.keyframe}
	f.cur = f.cur[:0]
	f.hasVCL = false
	f.keyframe = false
	return au
}

// Config 返回 avcC 描述（AVCDecoderConfigurationRecord），供前端
// VideoDecoder.configure 的 description 字段使用。SPS/PPS 未就绪时返回 nil。
func (f *AUFramer) Config() []byte {
	if len(f.sps) < 4 || len(f.pps) == 0 {
		return nil
	}
	sps, pps := f.sps, f.pps
	out := make([]byte, 0, 11+len(sps)+len(pps))
	out = append(out, 1)      // configurationVersion
	out = append(out, sps[1]) // AVCProfileIndication
	out = append(out, sps[2]) // profile_compatibility
	out = append(out, sps[3]) // AVCLevelIndication
	out = append(out, 0xff)   // 6 位保留 + lengthSizeMinusOne=3
	out = append(out, 0xe1)   // 3 位保留 + numOfSequenceParameterSets=1
	var lb [2]byte
	binary.BigEndian.PutUint16(lb[:], uint16(len(sps)))
	out = append(out, lb[:]...)
	out = append(out, sps...)
	out = append(out, 1) // numOfPictureParameterSets
	binary.BigEndian.PutUint16(lb[:], uint16(len(pps)))
	out = append(out, lb[:]...)
	out = append(out, pps...)
	return out
}

// CodecString 由 SPS 拼出 WebCodecs 需要的 codec 字符串，如 avc1.42E01E。
func (f *AUFramer) CodecString() string {
	if len(f.sps) < 4 {
		return ""
	}
	const hexDigits = "0123456789ABCDEF"
	b := []byte("avc1.")
	for _, v := range f.sps[1:4] {
		b = append(b, hexDigits[v>>4], hexDigits[v&0x0f])
	}
	return string(b)
}

// findStartCode 从 from 开始找 Annex-B 起始码，返回起始码位置与长度
// （3 表示 00 00 01，4 表示 00 00 00 01）。找不到返回 -1, 0。
func findStartCode(b []byte, from int) (int, int) {
	if from < 0 {
		from = 0
	}
	for i := from; i+2 < len(b); i++ {
		if b[i] != 0 || b[i+1] != 0 {
			continue
		}
		if b[i+2] == 1 {
			return i, 3
		}
		if b[i+2] == 0 && i+3 < len(b) && b[i+3] == 1 {
			return i, 4
		}
	}
	return -1, 0
}

// SplitAnnexB 是一次性工具：把完整码流切成 NAL 列表（不含起始码），
// 主要供测试与打包工具使用。
func SplitAnnexB(b []byte) [][]byte {
	var out [][]byte
	pos := 0
	for {
		start, sc := findStartCode(b, pos)
		if start < 0 {
			return out
		}
		next, _ := findStartCode(b, start+sc)
		end := len(b)
		if next >= 0 {
			end = next
		}
		if end > start+sc {
			out = append(out, bytes.Clone(b[start+sc:end]))
		}
		if next < 0 {
			return out
		}
		pos = next
	}
}
