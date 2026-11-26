package httpapi

import (
	"context"
	"io"
	"sync"

	"golang.org/x/crypto/ssh"

	"qxssh/internal/gui"
)

// sshTarget 把图形会话需要的命令执行与长驻进程，映射到一条已建立的 SSH 连接上。
// 连接本身属于连接池，这里不负责关闭，避免把别的模块正在用的连接一起断掉。
type sshTarget struct {
	client *ssh.Client
	hostID string
}

func (t *sshTarget) HostID() string { return t.hostID }
func (t *sshTarget) Label() string  { return "ssh:" + t.hostID }
func (t *sshTarget) Close() error   { return nil }

// Run 执行一条短命令并返回合并输出；ctx 取消时关闭会话，让远端命令尽快退出。
func (t *sshTarget) Run(ctx context.Context, cmd string) (string, error) {
	s, err := t.client.NewSession()
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

// Stream 启动长驻进程（画面编码器、输入代理），返回双向句柄。
func (t *sshTarget) Stream(ctx context.Context, cmd string) (gui.Proc, error) {
	s, err := t.client.NewSession()
	if err != nil {
		return nil, err
	}
	in, err := s.StdinPipe()
	if err != nil {
		_ = s.Close()
		return nil, err
	}
	out, err := s.StdoutPipe()
	if err != nil {
		_ = s.Close()
		return nil, err
	}
	if err := s.Start(cmd); err != nil {
		_ = s.Close()
		return nil, err
	}
	p := &sshProc{sess: s, in: in, out: out}
	go func() {
		<-ctx.Done()
		_ = p.Close()
	}()
	return p, nil
}

type sshProc struct {
	sess *ssh.Session
	in   io.WriteCloser
	out  io.Reader
	once sync.Once
}

func (p *sshProc) Read(b []byte) (int, error)  { return p.out.Read(b) }
func (p *sshProc) Write(b []byte) (int, error) { return p.in.Write(b) }
func (p *sshProc) Wait() error                 { return p.sess.Wait() }

func (p *sshProc) Close() error {
	var err error
	p.once.Do(func() { err = p.sess.Close() })
	return err
}
