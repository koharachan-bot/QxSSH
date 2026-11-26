package gui

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// 画面编码候选：h264 带宽最低、观感最接近远程桌面，jpeg 是浏览器不支持
// WebCodecs 时的降级通道。
const (
	CodecH264 = "h264"
	CodecJPEG = "jpeg"
)

// Frame 是送到浏览器的一帧画面。H.264 时 Data 是 AVCC 格式的访问单元，
// JPEG 时是完整的 JPEG 图片字节。
type Frame struct {
	Data     []byte
	Keyframe bool
}

// VideoStream 是一条正在运行的画面流。Frames 关闭表示流结束。
type VideoStream struct {
	Codec string

	proc   Proc
	frames chan Frame

	cancel context.CancelFunc
	once   sync.Once

	mu       sync.Mutex
	cfg      []byte
	codecStr string
	err      error
	done     chan struct{}
}

// Format 返回当前流的 avcC 描述与 codec 字符串；JPEG 流返回空值。
func (v *VideoStream) Format() (cfg []byte, codec string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.cfg, v.codecStr
}

// Frames 返回帧通道。
func (v *VideoStream) Frames() <-chan Frame { return v.frames }

// Done 在流出错或结束时关闭。
func (v *VideoStream) Done() <-chan struct{} { return v.done }

// Err 返回流终止原因（正常关闭时为 nil）。
func (v *VideoStream) Err() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.err
}

// Close 结束编码进程与读循环。
func (v *VideoStream) Close() error {
	var err error
	v.once.Do(func() {
		if v.cancel != nil {
			v.cancel()
		}
		if v.proc != nil {
			err = v.proc.Close()
		}
	})
	return err
}

// videoCommand 生成 ffmpeg 采集命令。screen 参数带 .0 表示第 0 号屏幕；
// -draw_mouse 0 让前端自己画光标，避免远端光标在缩放后错位。
func videoCommand(display int, codec string, fps, bitrate, width, height int) string {
	base := fmt.Sprintf(
		"env DISPLAY=:%d ffmpeg -hide_banner -loglevel error -nostdin -f x11grab -framerate %d -video_size %dx%d -draw_mouse 0 -i :%d.0 -threads 2 ",
		display, fps, width, height, display)
	switch codec {
	case CodecJPEG:
		return base + "-c:v mjpeg -q:v 5 -f mjpeg pipe:1"
	default:
		return base + fmt.Sprintf(
			"-c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p -x264-params aud=1 -g %d -b:v %dk -f h264 pipe:1",
			fps*2, bitrate)
	}
}

// normalizeCodec 把前端声明的候选编码归一为受支持的一种；未声明时优先 h264。
func normalizeCodec(candidates []string) string {
	for _, c := range candidates {
		switch strings.ToLower(strings.TrimSpace(c)) {
		case CodecH264, "avc", "avc1":
			return CodecH264
		case CodecJPEG, "mjpeg", "jpg":
			return CodecJPEG
		}
	}
	return CodecH264
}
