package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"qxssh/internal/gui"
)

// Linux 图形应用（runtime=linux-gui）的网关入口：启动/停止会话、探测依赖，
// 以及把画面与输入代理桥接到浏览器的 WebSocket 通道。
//
// 安全边界：启动命令永远来自插件 manifest，前端只能提交「应用 id + 目标主机」，
// 因此浏览器侧拿不到拼命令的能力；会话本身仍受 gui:launch（Danger 3）约束。

// guiFrame 是浏览器侧收到的二进制帧首字节，用来区分编码与关键帧。
const (
	guiFrameKey   = 0x01 // H.264 关键帧（AVCC）
	guiFrameDelta = 0x02 // H.264 增量帧（AVCC）
	guiFrameJPEG  = 0x03 // 完整 JPEG
)

// guiInputMaxBytes 限制单条输入指令的长度，避免被用来做内存放大。
const guiInputMaxBytes = 8 << 10

type guiStartReq struct {
	App  string `json:"app"`
	Host string `json:"host"`
}

type guiStopReq struct {
	ID string `json:"id"`
}

type guiStartResp struct {
	Session gui.Info `json:"session"`
}

type guiListResp struct {
	Sessions []gui.Info `json:"sessions"`
}

type guiDepsResp struct {
	Host    string          `json:"host,omitempty"`
	Deps    []gui.DepStatus `json:"deps"`
	Missing []string        `json:"missing,omitempty"`
	Install string          `json:"install,omitempty"`
	Ready   bool            `json:"ready"`
}

type guiHelloMsg struct {
	T       string   `json:"t"`
	Session gui.Info `json:"session"`
	Codec   string   `json:"codec"`
}

type guiConfigMsg struct {
	T           string `json:"t"`
	Codec       string `json:"codec"`
	Description string `json:"description"`
}

type guiErrMsg struct {
	T       string `json:"t"`
	Message string `json:"message"`
}

// guiTarget 把主机 id 变成可执行目标：空表示本机（仅 Linux 宿主可用），
// 否则走 SSH 连接池，复用已建立的连接。
func (a *Gateway) guiTarget(hostID string) (gui.Target, error) {
	hostID = strings.TrimSpace(hostID)
	if hostID == "" {
		return gui.NewLocalTarget()
	}
	client, err := a.mgr.Get(hostID)
	if err != nil {
		return nil, fmt.Errorf("连接主机失败：%w", err)
	}
	return &sshTarget{client: client, hostID: hostID}, nil
}

// guiSpecOf 读取插件清单里的图形启动参数。内置应用暂不支持图形运行时，
// 因此只查第三方应用目录（含软链接的开发目录）。
func (a *Gateway) guiSpecOf(appID string) (gui.Spec, string, error) {
	if !appIDRe.MatchString(appID) {
		return gui.Spec{}, "", errors.New("应用 id 非法")
	}
	b, err := os.ReadFile(filepath.Join(a.appsDir(), appID, "manifest.json"))
	if err != nil {
		return gui.Spec{}, "", errors.New("应用不存在或缺少清单")
	}
	var m appManifest
	if err := json.Unmarshal(b, &m); err != nil {
		return gui.Spec{}, "", fmt.Errorf("应用清单损坏：%w", err)
	}
	if m.Runtime != appRuntimeLinuxGUI || m.GUI == nil {
		return gui.Spec{}, "", fmt.Errorf("应用「%s」不是 Linux 图形应用", appID)
	}
	return *m.GUI, m.Name.Get(defaultLang), nil
}

func (a *Gateway) handleGuiStart(w http.ResponseWriter, r *http.Request) {
	var req guiStartReq
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	spec, name, err := a.guiSpecOf(strings.TrimSpace(req.App))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	sess, err := a.guiMgr.Start(r.Context(), gui.StartRequest{
		AppID:  strings.TrimSpace(req.App),
		Name:   name,
		HostID: strings.TrimSpace(req.Host),
		Spec:   spec,
	})
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, guiStartResp{Session: sess.Info()})
}

func (a *Gateway) handleGuiStop(w http.ResponseWriter, r *http.Request) {
	var req guiStopReq
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if err := a.guiMgr.Stop(strings.TrimSpace(req.ID)); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, okResp{OK: true})
}

func (a *Gateway) handleGuiList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, guiListResp{Sessions: a.guiMgr.List()})
}

func (a *Gateway) handleGuiDeps(w http.ResponseWriter, r *http.Request) {
	host := strings.TrimSpace(r.URL.Query().Get("host"))
	t, err := a.guiTarget(host)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	defer t.Close()

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	deps, err := gui.ProbeDeps(ctx, t)
	if err != nil {
		writeErr(w, http.StatusBadGateway, fmt.Errorf("探测依赖失败：%w", err))
		return
	}
	missing := make([]string, 0, len(deps))
	for _, d := range gui.MissingRequired(deps) {
		missing = append(missing, d.Bin)
	}
	resp := guiDepsResp{
		Host:    host,
		Deps:    deps,
		Missing: missing,
		Ready:   len(missing) == 0,
	}
	if !resp.Ready {
		resp.Install = gui.InstallCommand(ctx, t)
	}
	writeJSON(w, resp)
}

// serveGuiWS 是画面与输入的双向通道。上行是二进制帧，下行是 JSON 输入指令：
// 编码在连接建立时协商，H.264 会先发一条 avcC 配置消息再发帧。
func (a *Gateway) serveGuiWS(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	sess, ok := a.guiMgr.Get(id)
	if !ok {
		writeErr(w, http.StatusNotFound, errors.New("图形会话不存在或已结束"))
		return
	}
	codec := r.URL.Query().Get("codec")

	release, ok := a.acquireWSSlot(w)
	if !ok {
		return
	}
	defer release()

	up, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer up.Close()
	up.SetReadLimit(guiInputMaxBytes)

	stream, err := sess.StartVideo(codec)
	if err != nil {
		_ = up.WriteJSON(guiErrMsg{T: "error", Message: "启动画面通道失败：" + err.Error()})
		return
	}
	defer stream.Close()

	if err := up.WriteJSON(guiHelloMsg{T: "hello", Session: sess.Info(), Codec: stream.Codec}); err != nil {
		return
	}

	done := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(done) }) }
	wsKeepalive(up, done, finish)

	// 读方向：浏览器输入 → 远端代理。
	go func() {
		defer finish()
		for {
			mt, data, rerr := up.ReadMessage()
			if rerr != nil {
				return
			}
			if mt != websocket.TextMessage || len(data) == 0 || len(data) > guiInputMaxBytes {
				continue
			}
			if !validGuiInput(data) {
				continue
			}
			if serr := sess.SendInput(data); serr != nil {
				return
			}
		}
	}()

	configSent := false
	for {
		select {
		case <-done:
			return
		case line := <-sess.AgentOutput():
			if len(line) == 0 {
				continue
			}
			if werr := up.WriteMessage(websocket.TextMessage, line); werr != nil {
				return
			}
		case fr, ok := <-stream.Frames():
			if !ok {
				_ = up.WriteJSON(guiErrMsg{T: "error", Message: "远端画面流已结束"})
				return
			}
			if stream.Codec == gui.CodecH264 && !configSent {
				if cfg, codecStr := stream.Format(); cfg != nil {
					msg := guiConfigMsg{T: "config", Codec: codecStr, Description: base64.StdEncoding.EncodeToString(cfg)}
					if werr := up.WriteJSON(msg); werr != nil {
						return
					}
					configSent = true
				}
			}
			kind := byte(guiFrameDelta)
			if stream.Codec == gui.CodecJPEG {
				kind = guiFrameJPEG
			} else if fr.Keyframe {
				kind = guiFrameKey
			}
			buf := make([]byte, 1+len(fr.Data))
			buf[0] = kind
			copy(buf[1:], fr.Data)
			if werr := up.WriteMessage(websocket.BinaryMessage, buf); werr != nil {
				return
			}
		}
	}
}

// validGuiInput 只放行输入代理支持的指令类型，其余一律丢弃：
// 代理本身还会再校验一次，这里是第一道门。
func validGuiInput(data []byte) bool {
	var msg struct {
		T string `json:"t"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		return false
	}
	switch msg.T {
	case "m", "b", "w", "k", "cb", "cbget", "ping", "size":
		return true
	}
	return false
}
