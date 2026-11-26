// Command guitest 直接调用 internal/gui 验证图形会话的启动/停止链路。
// 它不经过 HTTP 网关，用于在真实 Linux 主机上确认会话编排本身是否正确。
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"qxssh/internal/gui"
	"qxssh/internal/logging"
)

type sshT struct {
	c      *ssh.Client
	hostID string
}

func (t *sshT) HostID() string { return t.hostID }
func (t *sshT) Label() string  { return "ssh:" + t.hostID }
func (t *sshT) Close() error   { return nil }

func (t *sshT) Run(ctx context.Context, cmd string) (string, error) {
	s, err := t.c.NewSession()
	if err != nil {
		return "", err
	}
	defer s.Close()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			_ = s.Close()
		case <-done:
		}
	}()
	out, err := s.CombinedOutput(cmd)
	return string(out), err
}

func (t *sshT) Stream(ctx context.Context, cmd string) (gui.Proc, error) {
	s, err := t.c.NewSession()
	if err != nil {
		return nil, err
	}
	in, err := s.StdinPipe()
	if err != nil {
		s.Close()
		return nil, err
	}
	out, err := s.StdoutPipe()
	if err != nil {
		s.Close()
		return nil, err
	}
	if err := s.Start(cmd); err != nil {
		s.Close()
		return nil, err
	}
	return &proc{s: s, in: in, out: out}, nil
}

type proc struct {
	s   *ssh.Session
	in  interface{ Write([]byte) (int, error) }
	out interface{ Read([]byte) (int, error) }
}

func (p *proc) Read(b []byte) (int, error)  { return p.out.Read(b) }
func (p *proc) Write(b []byte) (int, error) { return p.in.Write(b) }
func (p *proc) Wait() error                 { return p.s.Wait() }
func (p *proc) Close() error                { return p.s.Close() }

func main() {
	host := flag.String("host", "", "目标主机")
	user := flag.String("user", "", "用户名")
	cmd := flag.String("cmd", "xev -geometry 640x480", "图形程序命令")
	keep := flag.Bool("keep", false, "启动后保持运行（不自动停止）")
	flag.Parse()

	pass := os.Getenv("QX_PASS")
	if pass == "" {
		fmt.Fprintln(os.Stderr, "缺少 QX_PASS")
		os.Exit(2)
	}
	conf := &ssh.ClientConfig{
		User:            *user,
		Auth:            []ssh.AuthMethod{ssh.Password(pass)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         15 * time.Second,
	}
	client, err := ssh.Dial("tcp", *host+":22", conf)
	if err != nil {
		fmt.Println("dial:", err)
		os.Exit(1)
	}
	defer client.Close()

	lg := logging.New(logging.LevelDebug)
	opener := func(string) (gui.Target, error) { return &sshT{c: client, hostID: "live"}, nil }
	m := gui.NewManager(opener, lg)

	args := strings.Fields(*cmd)
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "命令为空")
		os.Exit(2)
	}
	spec := gui.Spec{
		Command:       args,
		Screen:        gui.Screen{Width: 1024, Height: 768, Depth: 24},
		DPI:           96,
		FPS:           20,
		BitrateKbps:   2000,
		WindowManager: "openbox",
		Clipboard:     true,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	t := &sshT{c: client, hostID: "live"}

	fmt.Println("STEP deps ...")
	deps, derr := gui.ProbeDeps(ctx, t)
	fmt.Printf("DEPS n=%d err=%v\n", len(deps), derr)

	fmt.Println("STEP python3 ...")
	pyOut, pyErr := t.Run(ctx, "command -v python3 2>/dev/null || true")
	fmt.Printf("PY out=%q err=%v\n", strings.TrimSpace(pyOut), pyErr)

	fmt.Println("STEP home ...")
	homeOut, homeErr := t.Run(ctx, "printf %s $HOME")
	fmt.Printf("HOME out=%q err=%v\n", strings.TrimSpace(homeOut), homeErr)

	fmt.Println("STEP display ...")
	dispOut, dispErr := t.Run(ctx, "test -S /tmp/.X11-unix/X100 && echo used || echo free")
	fmt.Printf("DISP out=%q err=%v\n", strings.TrimSpace(dispOut), dispErr)

	fmt.Println("STEP manager start ...")
	started := time.Now()
	sess, err := m.Start(ctx, gui.StartRequest{AppID: "live", Name: "Live", Spec: spec})
	if err != nil {
		fmt.Println("START_ERR:", err)
		os.Exit(1)
	}
	fmt.Printf("START_OK id=%s display=%d in %dms\n", sess.ID(), sess.Info().Display, time.Since(started).Milliseconds())

	// 画面流：统计 2 秒内收到的帧
	stream, err := sess.StartVideo(gui.CodecH264)
	if err != nil {
		fmt.Println("VIDEO_ERR:", err)
	} else {
		frames, bytes, keys := 0, 0, 0
		deadline := time.After(2 * time.Second)
	loop:
		for {
			select {
			case fr, ok := <-stream.Frames():
				if !ok {
					break loop
				}
				frames++
				bytes += len(fr.Data)
				if fr.Keyframe {
					keys++
				}
			case <-deadline:
				break loop
			}
		}
		cfg, cs := stream.Format()
		fmt.Printf("VIDEO frames=%d bytes=%d keyframes=%d codec=%s avcC=%d\n", frames, bytes, keys, cs, len(cfg))
		_ = stream.Close()
	}

	if *keep {
		fmt.Println("KEEPING session; stop manually")
		return
	}
	if err := m.Stop(sess.ID()); err != nil {
		fmt.Println("STOP_ERR:", err)
		os.Exit(1)
	}
	fmt.Println("STOP_OK")
}
