//go:build windows

package console

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	webview2 "github.com/jchv/go-webview2"
)

// guiPlugin 是 Windows 桌面外壳：内部起一个只绑回环随机端口的 HTTP 服务，
// 再用 WebView2 窗口加载它，从而复用与浏览器控制台完全相同的前端与 API。
//
// WebView2Loader.dll 由依赖库以 go:embed 打进可执行文件，运行时从内存加载，
// 因此发布物仍然是单个 exe；使用者只需系统里装有 WebView2 Runtime（Windows
// 10/11 通常随 Edge 预装）。
type guiPlugin struct{}

// Name 返回插件名。
func (guiPlugin) Name() string { return nameGUI }

// Kind 返回实现族。
func (guiPlugin) Kind() Kind { return KindGUI }

// Run 启动内部 HTTP 服务并打开 WebView2 窗口，直到窗口关闭或 ctx 取消。
func (guiPlugin) Run(ctx context.Context, env Env) error {
	host, err := startHTTP(env, "127.0.0.1:0", nil)
	if err != nil {
		return err
	}
	defer host.Shutdown()

	dataDir := filepath.Join(env.Core.Store().Dir(), "webview")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("创建 WebView 数据目录失败: %w", err)
	}

	// WebView2 的窗口与消息循环必须固定在同一个 OS 线程上，Run 也会阻塞该线程。
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		DataPath:  dataDir,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title: "QxSSH",
			// IconId=1 对应 rsrc 用 internal/webui/favicon.ico 生成的
			// RT_GROUP_ICON 资源（见仓库根目录的 rsrc_windows_*.syso）。
			IconId: 1,
			Width:  1280,
			Height: 800,
			Center: true,
		},
	})
	if w == nil {
		return errors.New("创建 WebView2 窗口失败：请确认已安装 Microsoft Edge WebView2 Runtime" +
			"（Windows 10/11 通常已预装，缺失时可从微软官网安装）")
	}
	defer w.Destroy()

	url := host.URL()
	env.Log.Info("gui window opening", "url", url)
	w.Navigate(url)

	// 窗口关闭后 Run 返回；ctx 取消时从外部关闭窗口（PostMessage 线程安全）。
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			w.Destroy()
		case <-done:
		}
	}()
	w.Run()
	close(done)

	env.Log.Info("gui window closed")
	return nil
}
