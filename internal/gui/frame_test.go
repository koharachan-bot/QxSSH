package gui

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// annexB 把若干 NAL 拼成 Annex-B 码流（3 字节起始码）。测试数据刻意不以
// 0x00 结尾：NAL 末尾的零字节按标准会并入下一个起始码，会让长度断言失真。
func annexB(nalus ...[]byte) []byte {
	var b []byte
	for _, n := range nalus {
		b = append(b, 0, 0, 1)
		b = append(b, n...)
	}
	return b
}

func testParams() (sps, pps, aud, idr, inter []byte) {
	return []byte{0x67, 0x42, 0xE0, 0x1E, 0x89, 0x11},
		[]byte{0x68, 0xCE, 0x3C, 0x80},
		[]byte{0x09, 0xF0},
		[]byte{0x65, 0x88, 0x84, 0x11},
		[]byte{0x41, 0x9A, 0x02, 0x11}
}

func TestAUFramerSplitsAccessUnits(t *testing.T) {
	sps, pps, aud, idr, inter := testParams()
	stream := annexB(aud, sps, pps, idr, aud, inter)

	f := NewAUFramer()
	var got []AccessUnit
	// 每次只喂 3 字节，覆盖起始码跨块、NAL 跨块的情况。
	for i := 0; i < len(stream); i += 3 {
		end := i + 3
		if end > len(stream) {
			end = len(stream)
		}
		got = append(got, f.Feed(stream[i:end])...)
	}
	if len(got) != 1 {
		t.Fatalf("分帧后应得 1 个完整访问单元，实际 %d", len(got))
	}
	if !got[0].Keyframe {
		t.Fatal("含 IDR 的访问单元应标记为关键帧")
	}
	want := len(sps) + len(pps) + len(idr) + 12
	if len(got[0].Data) != want {
		t.Fatalf("访问单元长度 %d，期望 %d", len(got[0].Data), want)
	}
	// 第一个 NAL 的 4 字节长度前缀应等于 SPS 长度。
	if n := binary.BigEndian.Uint32(got[0].Data[:4]); int(n) != len(sps) {
		t.Fatalf("首个 NAL 长度前缀 %d，期望 %d", n, len(sps))
	}

	rest := f.Flush()
	if len(rest) != 1 {
		t.Fatalf("Flush 应取出末尾未结束的 1 个访问单元，实际 %d", len(rest))
	}
	if rest[0].Keyframe {
		t.Fatal("非 IDR 片不应标记为关键帧")
	}
	if len(rest[0].Data) != len(inter)+4 {
		t.Fatalf("末尾单元长度 %d，期望 %d", len(rest[0].Data), len(inter)+4)
	}
}

func TestAUFramerConfigAndCodec(t *testing.T) {
	sps, pps, _, _, _ := testParams()
	f := NewAUFramer()
	f.Feed(annexB([]byte{0x09, 0xF0}, sps, pps, []byte{0x65, 0x88}))
	cfg := f.Config()
	if len(cfg) != 11+len(sps)+len(pps) {
		t.Fatalf("avcC 长度 %d，期望 %d", len(cfg), 11+len(sps)+len(pps))
	}
	if cfg[0] != 1 || cfg[1] != 0x42 || cfg[2] != 0xE0 || cfg[3] != 0x1E {
		t.Fatalf("avcC 头字段不符合 SPS：% x", cfg[:4])
	}
	if cfg[4] != 0xff || cfg[5] != 0xe1 {
		t.Fatalf("avcC NAL 长度/数量字段错误：% x", cfg[4:6])
	}
	if got := f.CodecString(); got != "avc1.42E01E" {
		t.Fatalf("codec 字符串 %q，期望 avc1.42E01E", got)
	}
}

func TestAUFramerWithoutAUD(t *testing.T) {
	sps, pps, aud, idr, inter := testParams()
	inter2 := []byte{0x41, 0x9A, 0x03, 0x22}

	f := NewAUFramer()
	// 末尾补一个 AUD 模拟持续码流，使最后一个片也能被切出来。
	got := f.Feed(annexB(sps, pps, idr, inter, inter2, aud))
	// 末尾的 AUD 没有后继起始码，尚未确定边界；前两个单元已经可以切出。
	if len(got) != 2 {
		t.Fatalf("无 AUD 码流应切出 2 个完整单元，实际 %d", len(got))
	}
	if !got[0].Keyframe {
		t.Fatal("第一个单元含 IDR，应标记关键帧")
	}
	if len(got[0].Data) != len(sps)+len(pps)+len(idr)+12 {
		t.Fatalf("首个单元内容长度错误：%d", len(got[0].Data))
	}
	if got[1].Keyframe || len(got[1].Data) != len(inter)+4 {
		t.Fatalf("第二个单元异常：keyframe=%v len=%d", got[1].Keyframe, len(got[1].Data))
	}
	rest := f.Flush()
	if len(rest) != 1 {
		t.Fatalf("Flush 应补齐最后 1 个单元，实际 %d", len(rest))
	}
	if rest[0].Keyframe || len(rest[0].Data) != len(inter2)+4 {
		t.Fatalf("第三个单元异常：keyframe=%v len=%d", rest[0].Keyframe, len(rest[0].Data))
	}
}

func TestSplitAnnexBFourByteStartCode(t *testing.T) {
	stream := []byte{0, 0, 0, 1, 0x09, 0xF0, 0, 0, 0, 1, 0x65, 0x88}
	got := SplitAnnexB(stream)
	if len(got) != 2 {
		t.Fatalf("应切出 2 个 NAL，实际 %d", len(got))
	}
	if !bytes.Equal(got[0], []byte{0x09, 0xF0}) || !bytes.Equal(got[1], []byte{0x65, 0x88}) {
		t.Fatalf("NAL 内容错误：% x / % x", got[0], got[1])
	}
}

func TestJPEGFramerAcrossChunks(t *testing.T) {
	frameA := []byte{0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9}
	frameB := []byte{0xff, 0xd8, 0x03, 0xff, 0xd9}
	all := append(append([]byte{}, frameA...), frameB...)

	f := NewJPEGFramer()
	var got [][]byte
	for i := 0; i < len(all); i += 4 {
		end := i + 4
		if end > len(all) {
			end = len(all)
		}
		got = append(got, f.Feed(all[i:end])...)
	}
	if len(got) != 2 {
		t.Fatalf("应切出 2 帧 JPEG，实际 %d", len(got))
	}
	if !bytes.Equal(got[0], frameA) || !bytes.Equal(got[1], frameB) {
		t.Fatalf("JPEG 帧内容错误")
	}
}
