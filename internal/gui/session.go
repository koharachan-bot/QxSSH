package gui

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"path"
	"strings"
	"sync"
	"time"

	"qxssh/internal/logging"
)

// TargetOpener 由调用方注入：把主机 id 变成可执行目标（空 id 表示本机）。
type TargetOpener func(hostID string) (Target, error)

// StartRequest 描述一次启动请求。AppID 与 Name 只用于展示与审计，
// 真正的启动参数来自 Spec（即插件 manifest 的 gui 字段）。
type StartRequest struct {
	AppID  string
	Name   string
	HostID string
	Spec   Spec
}

// Info 是会话的只读快照，供列表接口与前端恢复现场。
type Info struct {
	ID        string    `json:"id"`
	AppID     string    `json:"appId"`
	Name      string    `json:"name"`
	HostID    string    `json:"host,omitempty"`
	Display   int       `json:"display"`
	Width     int       `json:"width"`
	Height    int       `json:"height"`
	FPS       int       `json:"fps"`
	StartedAt time.Time `json:"startedAt"`
	Running   bool      `json:"running"`
}

const (
	// maxSessions 限制同时存活的图形会话数：每个会话都占一个 X 显示与一路
	// 视频编码，开太多会把目标主机压垮。
	maxSessions = 6
	// startTimeout 覆盖探测依赖与拉起 X 显示；不含首次下载运行时。
	startTimeout = 45 * time.Second
	// installTimeout 给 Blender 这类几百 MB 的运行时留足下载与解压时间。
	installTimeout = 20 * time.Minute
	// stopTimeout 限制清理脚本的最长等待。
	stopTimeout = 15 * time.Second
)

// Session 是一个正在运行的图形应用会话：独立的 X 显示、应用进程与按需启动的
// 画面/输入通道。会话生命周期独立于浏览器连接，因此窗口关闭再打开能恢复现场。
type Session struct {
	id      string
	appID   string
	name    string
	hostID  string
	spec    Spec
	display int
	dir     string
	target  Target

	startedAt time.Time

	ctx    context.Context
	cancel context.CancelFunc

	mu       sync.Mutex
	agent    Proc
	agentOut chan []byte
	video    *VideoStream
	stopped  bool
	log      *logging.Logger
}

// ID 返回会话 id。
func (s *Session) ID() string { return s.id }

// Info 返回会话快照。
func (s *Session) Info() Info {
	s.mu.Lock()
	running := !s.stopped
	s.mu.Unlock()
	return Info{
		ID:        s.id,
		AppID:     s.appID,
		Name:      s.name,
		HostID:    s.hostID,
		Display:   s.display,
		Width:     s.spec.Screen.Width,
		Height:    s.spec.Screen.Height,
		FPS:       s.spec.FPS,
		StartedAt: s.startedAt,
		Running:   running,
	}
}

// Manager 管理全部图形会话。
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
	opener   TargetOpener
	log      *logging.Logger
}

// NewManager 构造会话管理器。opener 为空时本机启动一律失败。
func NewManager(opener TargetOpener, log *logging.Logger) *Manager {
	if opener == nil {
		opener = func(string) (Target, error) {
			return nil, errors.New("未配置主机连接器")
		}
	}
	return &Manager{sessions: make(map[string]*Session), opener: opener, log: log}
}

// Start 在目标主机上拉起一个新会话。
func (m *Manager) Start(ctx context.Context, req StartRequest) (*Session, error) {
	spec := req.Spec.Normalize()
	if err := spec.Validate(); err != nil {
		return nil, err
	}

	m.mu.Lock()
	n := len(m.sessions)
	m.mu.Unlock()
	if n >= maxSessions {
		return nil, fmt.Errorf("同时运行的图形应用已达上限（%d 个），请先关闭一些窗口", maxSessions)
	}

	target, err := m.opener(req.HostID)
	if err != nil {
		return nil, err
	}

	startCtx, cancel := context.WithTimeout(ctx, startTimeout)
	defer cancel()

	deps, derr := ProbeDeps(startCtx, target)
	if derr != nil {
		_ = target.Close()
		return nil, fmt.Errorf("探测目标主机依赖失败：%w", derr)
	}
	if miss := MissingRequired(deps); len(miss) > 0 {
		names := make([]string, 0, len(miss))
		for _, d := range miss {
			names = append(names, fmt.Sprintf("%s（%s）", d.Label, d.Bin))
		}
		install := InstallCommand(startCtx, target)
		_ = target.Close()
		msg := "目标主机缺少必要组件：" + strings.Join(names, "、")
		if install != "" {
			msg += "；可先执行（需要 sudo）：" + install
		}
		return nil, errors.New(msg)
	}

	if out, perr := target.Run(startCtx, "command -v python3 2>/dev/null || true"); perr != nil || strings.TrimSpace(out) == "" {
		_ = target.Close()
		return nil, errors.New("目标主机缺少 python3：图形会话的键鼠注入依赖它，请先安装 python3")
	}

	home, herr := target.Run(startCtx, "printf %s \"$HOME\"")
	if herr != nil || strings.TrimSpace(home) == "" {
		_ = target.Close()
		return nil, errors.New("无法确定目标主机的家目录")
	}

	id, err := sessionID()
	if err != nil {
		_ = target.Close()
		return nil, err
	}
	dir := path.Join(strings.TrimSpace(home), ".cache", "qxssh", "gui", "sess-"+id)

	display, err := m.pickDisplay(startCtx, target)
	if err != nil {
		_ = target.Close()
		return nil, err
	}

	if spec.Install != nil {
		dest := installDest(strings.TrimSpace(home), req.AppID, spec.Install)
		ictx, icancel := context.WithTimeout(ctx, installTimeout)
		err = ensureRuntime(ictx, target, spec.Install, dest, req.AppID, m.log)
		icancel()
		if err != nil {
			_ = target.Close()
			return nil, err
		}
		spec = applyInstall(spec, dest, spec.Install)
	}

	script := launchScript(display, dir, spec)
	out, err := target.Run(startCtx, script)
	if err != nil || !strings.Contains(out, "QXGUI_OK") {
		detail := strings.TrimSpace(out)
		if len(detail) > 600 {
			detail = detail[len(detail)-600:]
		}
		_ = target.Close()
		if detail == "" {
			detail = err.Error()
		}
		return nil, fmt.Errorf("图形会话启动失败：%s", detail)
	}

	sctx, scancel := context.WithCancel(context.Background())
	s := &Session{
		id:        id,
		appID:     req.AppID,
		name:      req.Name,
		hostID:    req.HostID,
		spec:      spec,
		display:   display,
		dir:       dir,
		target:    target,
		startedAt: time.Now(),
		ctx:       sctx,
		cancel:    scancel,
		agentOut:  make(chan []byte, 16),
		log:       m.log,
	}

	m.mu.Lock()
	m.sessions[id] = s
	m.mu.Unlock()

	if m.log != nil {
		m.log.Info("gui session started", "id", id, "app", req.AppID, "host", target.Label(), "display", display)
	}
	return s, nil
}

// Stop 结束会话并从管理器移除。
func (m *Manager) Stop(id string) error {
	m.mu.Lock()
	s := m.sessions[id]
	delete(m.sessions, id)
	m.mu.Unlock()
	if s == nil {
		return errors.New("图形会话不存在")
	}
	return s.stop()
}

// Get 按 id 取会话。
func (m *Manager) Get(id string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	return s, ok
}

// List 返回全部会话快照，按启动时间排序。
func (m *Manager) List() []Info {
	m.mu.Lock()
	list := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.mu.Unlock()
	out := make([]Info, 0, len(list))
	for _, s := range list {
		out = append(out, s.Info())
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].StartedAt.Before(out[j-1].StartedAt); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// Shutdown 结束全部会话，用于进程退出。
func (m *Manager) Shutdown() {
	m.mu.Lock()
	list := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()
	for _, s := range list {
		_ = s.stop()
	}
}

// pickDisplay 找一个空闲的 X 显示号：既避开本进程已有的会话，也避开目标主机上
// 已经存在的 X socket（用户自己的图形会话）。
func (m *Manager) pickDisplay(ctx context.Context, t Target) (int, error) {
	m.mu.Lock()
	used := make(map[int]bool, len(m.sessions))
	for _, s := range m.sessions {
		used[s.display] = true
	}
	m.mu.Unlock()
	for d := 100; d < 200; d++ {
		if used[d] {
			continue
		}
		out, err := t.Run(ctx, fmt.Sprintf("test -S /tmp/.X11-unix/X%d && echo used || echo free", d))
		if err != nil {
			return 0, err
		}
		if strings.Contains(out, "free") {
			return d, nil
		}
	}
	return 0, errors.New("目标主机上找不到空闲的 X 显示号（100~199 已被占用）")
}

// StartVideo 启动（或替换）画面流。同一会话只保留一条流，重连时旧流先关闭。
func (s *Session) StartVideo(codec string) (*VideoStream, error) {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return nil, errors.New("图形会话已结束")
	}
	old := s.video
	s.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}

	v, err := s.startStream(s.ctx, codec)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.video = v
	s.mu.Unlock()
	return v, nil
}

// SendInput 把一条输入指令交给远端代理。代理按需启动并在会话内复用。
func (s *Session) SendInput(line []byte) error {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return errors.New("图形会话已结束")
	}
	p := s.agent
	s.mu.Unlock()

	if p == nil {
		var err error
		p, err = s.target.Stream(s.ctx, agentCommand(s.dir, s.display))
		if err != nil {
			return err
		}
		s.mu.Lock()
		if s.stopped {
			s.mu.Unlock()
			_ = p.Close()
			return errors.New("图形会话已结束")
		}
		s.agent = p
		s.mu.Unlock()
		go s.drainAgent(p)
	}
	_, err := p.Write(append(line, '\n'))
	return err
}

// AgentOutput 返回代理的控制台输出（剪贴板回读、告警等），供 WebSocket 转发。
func (s *Session) AgentOutput() <-chan []byte { return s.agentOut }

func (s *Session) drainAgent(p Proc) {
	sc := bufio.NewScanner(p)
	sc.Buffer(make([]byte, 0, 8<<10), 256<<10)
	for sc.Scan() {
		line := append([]byte(nil), sc.Bytes()...)
		select {
		case s.agentOut <- line:
		default:
		}
	}
}

// stop 结束画面流、输入代理与目标主机上的进程，最后释放连接。
func (s *Session) stop() error {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return nil
	}
	s.stopped = true
	video, agent := s.video, s.agent
	s.video, s.agent = nil, nil
	s.mu.Unlock()

	if video != nil {
		_ = video.Close()
	}
	if agent != nil {
		_ = agent.Close()
	}

	ctx, cancel := context.WithTimeout(context.Background(), stopTimeout)
	defer cancel()
	_, _ = s.target.Run(ctx, cleanupScript(s.dir, s.display))
	_ = s.target.Close()
	s.cancel()

	if s.log != nil {
		s.log.Info("gui session stopped", "id", s.id, "app", s.appID, "host", s.hostID, "display", s.display)
	}
	return nil
}

func sessionID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
