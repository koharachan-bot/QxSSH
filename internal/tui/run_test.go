package tui

import (
	"context"
	"os"
	"strings"
	"testing"

	"qxssh/internal/config"
	"qxssh/internal/logging"
	"qxssh/internal/sshpool"
)

// TestRunRejectsNonInteractiveTerminal 验证非交互式终端下 Run 立即返回明确的中文错误，
// 而不是阻塞等待输入。
func TestRunRejectsNonInteractiveTerminal(t *testing.T) {
	if isTerminal(os.Stdin) && isTerminal(os.Stdout) {
		t.Skip("当前测试进程运行在交互式终端中，跳过非 TTY 用例")
	}
	store, err := config.Load(t.TempDir())
	if err != nil {
		t.Fatalf("准备配置存储失败: %v", err)
	}
	defer func() { _ = store.Close() }()

	err = Run(context.Background(), Deps{
		Store: store,
		Pool:  sshpool.New(store, logging.New(logging.LevelSilent)),
	})
	if err == nil {
		t.Fatal("非 TTY 下 Run 应返回错误")
	}
	if !strings.Contains(err.Error(), "TTY") {
		t.Errorf("错误信息应说明需要 TTY，实际: %v", err)
	}
}

// TestRunRequiresDeps 验证缺少依赖时返回中文错误。
func TestRunRequiresDeps(t *testing.T) {
	if err := Run(context.Background(), Deps{}); err == nil {
		t.Fatal("缺少依赖时 Run 应返回错误")
	}
}
