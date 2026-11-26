package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// JS 挑战式人机验证。
//
// 设计取舍：不引第三方验证码（要外网/要账号），而是让浏览器算一段哈希：
//   1. 服务端签发带 HMAC 签名的挑战（id + nonce + 难度 + 过期时间），无状态；
//   2. 浏览器 JS 需要找到 nonce+counter 使 SHA-256 结果有 N 个前导 0，
//      正常浏览器几百毫秒完成，纯脚本批量刷要付出同样的 CPU 成本；
//   3. 通过后发一张短期通行 Cookie，注册/登录提交时必须带上。
//
// 它挡不住"愿意付 CPU 的定向攻击"，但配合按 IP 限速足以挡住无差别刷站。
const (
	challengeTTL     = 5 * time.Minute
	challengePassTTL = 15 * time.Minute
	// 难度 4 表示哈希结果前 4 个十六进制字符为 0，期望约 65536 次尝试。
	challengeDifficulty = 4
	challengePassCookie = "qxportal_pass"
)

// challengeMgr 保存最近用过的解答，防重放。
type challengeMgr struct {
	mu   sync.Mutex
	used map[string]time.Time
}

func newChallengeMgr() *challengeMgr {
	return &challengeMgr{used: map[string]time.Time{}}
}

// consume 记录一次解答；返回 false 表示该解答已被用过（重放）。
func (m *challengeMgr) consume(key string) bool {
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	for k, t := range m.used {
		if now.Sub(t) > challengeTTL*2 {
			delete(m.used, k)
		}
	}
	if _, ok := m.used[key]; ok {
		return false
	}
	m.used[key] = now
	return true
}

// signChallenge 给挑战字段做签名，客户端无法伪造难度或延长有效期。
func signChallenge(key, id, nonce string, difficulty int, expires int64) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(id + "|" + nonce + "|" + strconv.Itoa(difficulty) + "|" + strconv.FormatInt(expires, 10)))
	return hex.EncodeToString(mac.Sum(nil))
}

// issueChallenge 生成一个新挑战。
func issueChallenge(cfg *Config) map[string]any {
	id := randomToken(8)
	nonce := randomToken(8)
	exp := time.Now().Add(challengeTTL).Unix()
	return map[string]any{
		"id":         id,
		"nonce":      nonce,
		"difficulty": challengeDifficulty,
		"expires":    exp,
		"sig":        signChallenge(cfg.SessionKey, id, nonce, challengeDifficulty, exp),
	}
}

// verifyChallenge 校验解答与签名。
func verifyChallenge(cfg *Config, m *challengeMgr, id, nonce, sig, solution string, difficulty int, expires int64) error {
	if id == "" || nonce == "" || sig == "" || solution == "" {
		return fmt.Errorf("挑战参数不完整")
	}
	if time.Now().Unix() > expires {
		return fmt.Errorf("挑战已过期，请刷新页面")
	}
	if difficulty < 1 || difficulty > 6 {
		return fmt.Errorf("挑战难度异常")
	}
	want := signChallenge(cfg.SessionKey, id, nonce, difficulty, expires)
	if !hmac.Equal([]byte(want), []byte(sig)) {
		return fmt.Errorf("挑战签名无效")
	}
	// 与浏览器端的算法保持完全一致：sha256(nonce + ":" + counter) 的十六进制串
	// 前 difficulty 位必须是 0。
	sum := sha256.Sum256([]byte(nonce + ":" + solution))
	hexstr := hex.EncodeToString(sum[:])
	if !strings.HasPrefix(hexstr, strings.Repeat("0", difficulty)) {
		return fmt.Errorf("验证未通过，请重试")
	}
	if !m.consume(id + ":" + solution) {
		return fmt.Errorf("该验证已使用过，请刷新页面")
	}
	return nil
}

// passToken 生成短期通行凭证，绑定来源 IP。
func passToken(cfg *Config, ip string) string {
	exp := time.Now().Add(challengePassTTL).Unix()
	mac := hmac.New(sha256.New, []byte(cfg.SessionKey))
	mac.Write([]byte("pass|" + ip + "|" + strconv.FormatInt(exp, 10)))
	return strconv.FormatInt(exp, 10) + "." + hex.EncodeToString(mac.Sum(nil))
}

// validPass 校验通行凭证。
func validPass(cfg *Config, ip, tok string) bool {
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
	mac.Write([]byte("pass|" + ip + "|" + parts[0]))
	return hmac.Equal([]byte(hex.EncodeToString(mac.Sum(nil))), []byte(parts[1]))
}

func setPassCookie(w http.ResponseWriter, r *http.Request, cfg *Config, ip string) {
	http.SetCookie(w, &http.Cookie{
		Name:     challengePassCookie,
		Value:    passToken(cfg, ip),
		Path:     "/",
		HttpOnly: true,
		Secure:   isHTTPSRequest(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(challengePassTTL.Seconds()),
	})
}

func readPassCookie(r *http.Request) string {
	ck, err := r.Cookie(challengePassCookie)
	if err != nil || ck == nil {
		return ""
	}
	return ck.Value
}
