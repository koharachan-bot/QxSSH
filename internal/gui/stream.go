package gui

import (
	"context"
	"io"
)

// startStream 启动画面编码进程，并把 stdout 解析成帧送到通道。
func (s *Session) startStream(ctx context.Context, codec string) (*VideoStream, error) {
	codec = normalizeCodec([]string{codec})
	spec := s.spec
	cmd := videoCommand(s.display, codec, spec.FPS, spec.BitrateKbps*8/1000, spec.Screen.Width, spec.Screen.Height)
	proc, err := s.target.Stream(ctx, cmd)
	if err != nil {
		return nil, err
	}
	_, cancel := context.WithCancel(ctx)
	v := &VideoStream{
		Codec:  codec,
		proc:   proc,
		frames: make(chan Frame, 8),
		cancel: cancel,
		done:   make(chan struct{}),
	}
	go func() {
		defer close(v.frames)
		defer close(v.done)
		var ferr error
		if codec == CodecJPEG {
			ferr = v.pumpJPEG(proc)
		} else {
			ferr = v.pumpH264(proc)
		}
		if ferr != nil {
			v.mu.Lock()
			v.err = ferr
			v.mu.Unlock()
		}
		_ = proc.Close()
		cancel()
	}()
	return v, nil
}

func (v *VideoStream) offer(fr Frame) {
	select {
	case v.frames <- fr:
	default:
		// 消费端跟不上时丢最旧的一帧，避免延迟无限累积。
		select {
		case <-v.frames:
		default:
		}
		select {
		case v.frames <- fr:
		default:
		}
	}
}

func (v *VideoStream) pumpH264(r io.Reader) error {
	framer := NewAUFramer()
	buf := make([]byte, 64<<10)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			for _, au := range framer.Feed(buf[:n]) {
				// 先发布 avcC 再入队帧：浏览器拿到第一帧时解码器必须已经配置好，
				// 否则首帧（通常是关键帧）会被丢弃，画面要等下一个关键帧才恢复。
				if cfg, cs := framer.Config(), framer.CodecString(); cfg != nil {
					v.mu.Lock()
					v.cfg, v.codecStr = cfg, cs
					v.mu.Unlock()
				}
				v.offer(Frame{Data: au.Data, Keyframe: au.Keyframe})
			}
		}
		if err != nil {
			for _, au := range framer.Flush() {
				v.offer(Frame{Data: au.Data, Keyframe: au.Keyframe})
			}
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

func (v *VideoStream) pumpJPEG(r io.Reader) error {
	framer := NewJPEGFramer()
	buf := make([]byte, 64<<10)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			for _, frame := range framer.Feed(buf[:n]) {
				v.offer(Frame{Data: frame, Keyframe: true})
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}
