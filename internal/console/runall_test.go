package console

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"qxssh/internal/logging"
)

// fakePlugin 是只实现 Plugin 接口的测试替身。
type fakePlugin struct {
	name string
	kind Kind
	run  func(ctx context.Context) error
}

func (f fakePlugin) Name() string                         { return f.name }
func (f fakePlugin) Kind() Kind                           { return f.kind }
func (f fakePlugin) Run(ctx context.Context, _ Env) error { return f.run(ctx) }

func TestRunAllPropagatesErrorAndCancelsSiblings(t *testing.T) {
	lg := logging.New(logging.LevelSilent)
	failErr := errors.New("listen failed")
	var siblingStopped atomic.Bool
	plugins := []Plugin{
		fakePlugin{name: "web", kind: KindWeb, run: func(ctx context.Context) error {
			<-ctx.Done()
			siblingStopped.Store(true)
			return ctx.Err()
		}},
		fakePlugin{name: "tui", kind: KindTUI, run: func(context.Context) error {
			return failErr
		}},
	}

	err := RunAll(context.Background(), plugins, Env{Log: lg})
	if !errors.Is(err, failErr) {
		t.Fatalf("RunAll 应返回插件的真实错误，实际 %v", err)
	}
	if !siblingStopped.Load() {
		t.Fatal("一个插件失败后应取消其余插件")
	}
}

func TestRunAllReturnsNilOnContextCancel(t *testing.T) {
	lg := logging.New(logging.LevelSilent)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	plugins := []Plugin{
		fakePlugin{name: "tui", kind: KindTUI, run: func(ctx context.Context) error {
			<-ctx.Done()
			return ctx.Err()
		}},
	}
	if err := RunAll(ctx, plugins, Env{Log: lg}); err != nil {
		t.Fatalf("ctx 取消导致的退出不应视为错误，实际 %v", err)
	}
}

func TestRunAllRejectsEmptySet(t *testing.T) {
	if err := RunAll(context.Background(), nil, Env{Log: logging.New(logging.LevelSilent)}); err == nil {
		t.Fatal("空插件集合应返回错误")
	}
}
