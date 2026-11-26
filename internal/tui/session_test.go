package tui

import (
	"bytes"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// TestFilterExitKey 验证 Ctrl+] 被剔除并触发退出，其余字节原样保留。
func TestFilterExitKey(t *testing.T) {
	in := []byte("ls\r")
	got, quit := filterExitKey(in)
	if quit {
		t.Error("不含 Ctrl+] 时不应退出")
	}
	if !bytes.Equal(got, in) {
		t.Errorf("不含 Ctrl+] 时字节被改写: %q", got)
	}

	got, quit = filterExitKey([]byte{'a', sessionExitKey, 'b'})
	if !quit {
		t.Error("包含 Ctrl+] 时应退出会话")
	}
	if !bytes.Equal(got, []byte{'a', 'b'}) {
		t.Errorf("过滤后=%q, 期望 %q", got, []byte{'a', 'b'})
	}
}

// failingWriter 模拟远端输入已关闭的通道：写入总是失败，并通知调用方。
type failingWriter struct {
	mu     sync.Mutex
	closed int
	wrote  chan struct{}
}

func (w *failingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	w.closed++
	w.mu.Unlock()
	select {
	case w.wrote <- struct{}{}:
	default:
	}
	return 0, io.ErrClosedPipe
}

func (w *failingWriter) Close() error { return nil }

// count 返回失败的写入次数。
func (w *failingWriter) count() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.closed
}

// chanWriter 把写入的数据转发到 channel，便于测试同步观察。
type chanWriter struct {
	ch chan []byte
}

func (w chanWriter) Write(p []byte) (int, error) {
	w.ch <- append([]byte(nil), p...)
	return len(p), nil
}

func (w chanWriter) Close() error { return nil }

// TestPumpInput 验证输入泵把队列内容原样写入远端通道。
func TestPumpInput(t *testing.T) {
	written := make(chan []byte, 4)
	writeCh := make(chan []byte, 4)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		pumpInput(chanWriter{ch: written}, writeCh, stop)
	}()

	writeCh <- []byte("世界")
	select {
	case got := <-written:
		if string(got) != "世界" {
			t.Errorf("输入泵写入 %q, 期望 %q", got, "世界")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("输入泵没有写入任何数据")
	}
	close(stop)
	<-done
}

// TestPumpInputKeepsDraining 验证写失败后泵仍消费队列，避免发送方阻塞。
func TestPumpInputKeepsDraining(t *testing.T) {
	fw := &failingWriter{wrote: make(chan struct{}, 1)}
	writeCh := make(chan []byte, 1)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		pumpInput(fw, writeCh, stop)
	}()

	waitWrote := func(step string) {
		select {
		case <-fw.wrote:
		case <-time.After(2 * time.Second):
			t.Fatalf("%s: 输入泵没有消费队列", step)
		}
	}
	writeCh <- []byte("x")
	waitWrote("第一次写入")
	writeCh <- []byte("y")
	waitWrote("写失败后的第二次写入")
	close(stop)
	<-done
	if got := fw.count(); got != 2 {
		t.Errorf("失败写入次数=%d, 期望 2", got)
	}
}

// TestDescribeShellExit 验证远端退出原因被转换为中文提示并标记是否异常。
func TestDescribeShellExit(t *testing.T) {
	text, failed := describeShellExit(nil)
	if failed || text == "" {
		t.Errorf("正常退出: text=%q failed=%v", text, failed)
	}
	text, failed = describeShellExit(&ssh.ExitMissingError{})
	if !failed || text == "" {
		t.Errorf("缺少退出状态: text=%q failed=%v", text, failed)
	}
	if text, _ = describeShellExit(&ssh.ExitError{}); text == "" {
		t.Error("ExitError 应产生非空提示")
	}
	text, failed = describeShellExit(errors.New("connection lost"))
	if !failed || text == "" {
		t.Errorf("异常结束: text=%q failed=%v", text, failed)
	}
}
