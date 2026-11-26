package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 人机验证（interstitial 挑战页）。
//
// 与上一版的关键差别：挑战变成**服务端有状态、一次性、短时效**，并且要证据链：
//
//	1. PoW：要求浏览器算出一段带前导零的 SHA-256，抬高纯脚本的 CPU 成本；
//	2. 指针轨迹：采集真实鼠标/触摸移动，要求点数、路径长度与非直线性都达标——
//	   curl/requests 这类客户端根本没有指针事件，直接出局；
//	3. 时间下限：人类从看到页面到完成交互不可能快于 1.2 秒，自动脚本往往瞬间完成；
//	4. 绑定：挑战与签发时的 IP、User-Agent 绑定，换环境作废；
//	5. 一次性：解答被使用后立即标记，重放无效。
//
// 需要说明的边界：这能把「几条 curl 就刷穿」抬到「需要真实浏览器 + 模拟指针轨迹」，
// 但无法在密码学意义上证明"对面是人"——任何纯客户端验证都有这个上限。
const (
	chalTTL       = 90 * time.Second
	chalPassTTL   = 15 * time.Minute
	chalDifficulty = 4
	chalPassCookie = "qxportal_pass"

	// 证据阈值。
	chalMinPointerPoints = 10
	chalMinPathLength    = 220.0 // 归一化坐标系下累计移动距离
	chalMinDuration      = 1200   // 毫秒
	// 路径长度 / 首尾直线距离：数学意义上的完美直线比值为 1.000，
	// 只可能来自程序生成的轨迹；真人鼠标哪怕快速直拖也会因亚像素抖动 >1.01。
	chalMinCurvature = 1.004
)

type chalState struct {
	ID         string
	Nonce      string
	Difficulty int
	IssuedAt   time.Time
	IP         string
	UA         string
	Used       bool
}

// challengeMgr 保存进行中的挑战与已发放的通行证。
type challengeMgr struct {
	mu    sync.Mutex
	chals map[string]*chalState
	pass  map[string]time.Time
}

func newChallengeMgr() *challengeMgr {
	return &challengeMgr{chals: map[string]*chalState{}, pass: map[string]time.Time{}}
}

// issue 新建一个挑战并记录绑定信息。
func (m *challengeMgr) issue(ip, ua string) *chalState {
	now := time.Now()
	cs := &chalState{
		ID:         randomToken(10),
		Nonce:      randomToken(10),
		Difficulty: chalDifficulty,
		IssuedAt:   now,
		IP:         ip,
		UA:         ua,
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	// 顺带清理过期项，避免 map 无限增长。
	for id, st := range m.chals {
		if now.Sub(st.IssuedAt) > chalTTL*2 {
			delete(m.chals, id)
		}
	}
	for k, t := range m.pass {
		if now.Sub(t) > chalPassTTL*2 {
			delete(m.pass, k)
		}
	}
	m.chals[cs.ID] = cs
	return cs
}

// get 取挑战（不消费）。
func (m *challengeMgr) get(id string) (*chalState, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cs, ok := m.chals[id]
	return cs, ok
}

// consume 标记挑战已使用；已用过返回 false。
func (m *challengeMgr) consume(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	cs, ok := m.chals[id]
	if !ok || cs.Used {
		return false
	}
	cs.Used = true
	return true
}

// 证据结构。
type chalEvidence struct {
	DurationMs int       `json:"durationMs"`
	Points     [][2]int  `json:"points"`
	Clicks     [][2]int  `json:"clicks"`
	KeyEvents  int       `json:"keyEvents"`
	Signals    map[string]any `json:"signals"`
}

// errEvidence 描述证据为何不达标（直接返回给前端，便于用户重试）。
func checkEvidence(ev chalEvidence) error {
	if ev.DurationMs < chalMinDuration {
		return fmt.Errorf("交互过快，请重试")
	}
	if len(ev.Points) < chalMinPointerPoints {
		return fmt.Errorf("未检测到指针移动，请移动鼠标后重试")
	}
	// 累计路径长度与非直线性：真实指针轨迹既不是零长度，也不会是一条完美直线。
	var path float64
	for i := 1; i < len(ev.Points); i++ {
		dx := float64(ev.Points[i][0] - ev.Points[i-1][0])
		dy := float64(ev.Points[i][1] - ev.Points[i-1][1])
		path += math.Hypot(dx, dy)
	}
	if path < chalMinPathLength {
		return fmt.Errorf("指针轨迹过短，请正常移动鼠标后重试")
	}
	first := ev.Points[0]
	last := ev.Points[len(ev.Points)-1]
	straight := math.Hypot(float64(last[0]-first[0]), float64(last[1]-first[1]))
	if straight < 1 {
		return fmt.Errorf("指针轨迹异常，请重试")
	}
	if path/straight < chalMinCurvature {
		return fmt.Errorf("指针轨迹过于平直，请正常移动鼠标后重试")
	}
	return nil
}

// verifySolution 校验 PoW 解答。
func verifySolution(nonce, solution string, difficulty int) bool {
	if difficulty < 1 || difficulty > 6 {
		return false
	}
	sum := sha256.Sum256([]byte(nonce + ":" + solution))
	return strings.HasPrefix(hex.EncodeToString(sum[:]), strings.Repeat("0", difficulty))
}

// passToken 生成短期通行凭证，绑定 IP 与 UA。
func passToken(cfg *Config, ip, ua string) string {
	exp := time.Now().Add(chalPassTTL).Unix()
	mac := hmac.New(sha256.New, []byte(cfg.SessionKey))
	mac.Write([]byte("pass|" + ip + "|" + uaFingerprint(ua) + "|" + strconv.FormatInt(exp, 10)))
	return strconv.FormatInt(exp, 10) + "." + hex.EncodeToString(mac.Sum(nil))
}

// validPass 校验通行凭证。
func validPass(cfg *Config, ip, ua, tok string) bool {
	if tok == "" {
		return false
	}
	parts := strings.SplitN(tok, ".", 2)
	if len(parts) != 2 {
		return false
	}
	exp, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return false
	}
	mac := hmac.New(sha256.New, []byte(cfg.SessionKey))
	mac.Write([]byte("pass|" + ip + "|" + uaFingerprint(ua) + "|" + parts[0]))
	return hmac.Equal([]byte(hex.EncodeToString(mac.Sum(nil))), []byte(parts[1]))
}

// uaFingerprint 取 UA 的哈希前缀，避免把长 UA 拼进签名串。
func uaFingerprint(ua string) string {
	sum := sha256.Sum256([]byte(ua))
	return hex.EncodeToString(sum[:8])
}

func setPassCookie(w http.ResponseWriter, r *http.Request, cfg *Config, ip, ua string) {
	http.SetCookie(w, &http.Cookie{
		Name:     chalPassCookie,
		Value:    passToken(cfg, ip, ua),
		Path:     "/",
		HttpOnly: true,
		Secure:   isHTTPSRequest(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(chalPassTTL.Seconds()),
	})
}

func readPassCookie(r *http.Request) string {
	ck, err := r.Cookie(chalPassCookie)
	if err != nil || ck == nil {
		return ""
	}
	return ck.Value
}
