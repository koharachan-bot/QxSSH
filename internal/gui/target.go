package gui

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"runtime"
	"sync"
)

// Proc 是一个长驻进程的双向句柄：远端输入代理、画面编码器都通过它收发数据。
type Proc interface {
	io.Reader
	io.Writer
	Wait() error
	Close() error
}

// Target 抽象「命令在哪台机器上执行」：QxSSH 跑在 Linux 上时的本机，
// 或经 SSH 连接的远端主机。会话管理只依赖这个接口，便于单测替换。
type Target interface {
	// HostID 为空表示本机。
	HostID() string
	// Label 用于日志与审计，例如 local 或 host id。
	Label() string
	// Run 执行一条短命令并返回合并后的输出。
	Run(ctx context.Context, cmd string) (string, error)
	// Stream 启动长驻进程并返回双向句柄。
	Stream(ctx context.Context, cmd string) (Proc, error)
	// Close 释放连接（本机目标是空操作）。
	Close() error
}

// LocalTarget 在本机执行命令。只有 Linux 宿主才能承载图形会话，
// 其他平台在构造阶段就明确拒绝，避免运行到一半才失败。
type LocalTarget struct {
	shell string
}

// NewLocalTarget 构造本机目标。
func NewLocalTarget() (*LocalTarget, error) {
	if runtime.GOOS != "linux" {
		return nil, errors.New("当前宿主不是 Linux：Linux 图形应用需要运行在 Linux 主机上，请选择一台受管 Linux 主机")
	}
	shell, err := exec.LookPath("bash")
	if err != nil {
		if shell, err = exec.LookPath("sh"); err != nil {
			return nil, errors.New("宿主机缺少 bash/sh，无法启动图形会话")
		}
	}
	return &LocalTarget{shell: shell}, nil
}

// HostID 返回空字符串，表示本机。
func (t *LocalTarget) HostID() string { return "" }

// Label 返回日志用的目标名。
func (t *LocalTarget) Label() string { return "local" }

// Run 执行短命令。
func (t *LocalTarget) Run(ctx context.Context, cmd string) (string, error) {
	out, err := exec.CommandContext(ctx, t.shell, "-lc", cmd).CombinedOutput()
	return string(out), err
}

// Stream 启动长驻进程。ctx 取消时进程被结束，避免会话取消后残留进程。
func (t *LocalTarget) Stream(ctx context.Context, cmd string) (Proc, error) {
	c := exec.Command(t.shell, "-lc", cmd)
	in, err := c.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := c.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := c.Start(); err != nil {
		return nil, err
	}
	p := &localProc{cmd: c, in: in, out: out}
	if ctx != nil {
		go func() {
			<-ctx.Done()
			_ = p.Close()
		}()
	}
	return p, nil
}

// Close 对本地目标是空操作。
func (t *LocalTarget) Close() error { return nil }

type localProc struct {
	cmd  *exec.Cmd
	in   io.WriteCloser
	out  io.ReadCloser
	once sync.Once
	mu   sync.Mutex
	err  error
	done bool
}

func (p *localProc) Read(b []byte) (int, error)  { return p.out.Read(b) }
func (p *localProc) Write(b []byte) (int, error) { return p.in.Write(b) }

// Wait 等待进程退出；与 Close 并发调用时只返回一次结果。
func (p *localProc) Wait() error {
	p.mu.Lock()
	if p.done {
		err := p.err
		p.mu.Unlock()
		return err
	}
	p.mu.Unlock()
	err := p.cmd.Wait()
	p.mu.Lock()
	p.err = err
	p.done = true
	p.mu.Unlock()
	return err
}

// Close 结束进程并关闭管道，可重复调用。
func (p *localProc) Close() error {
	var first error
	p.once.Do(func() {
		_ = p.in.Close()
		if p.cmd.Process != nil {
			first = p.cmd.Process.Kill()
		}
		_ = p.out.Close()
	})
	return first
}
