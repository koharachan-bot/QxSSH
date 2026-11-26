package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// handleVerifyPage 渲染 interstitial 挑战页。
func (s *Server) handleVerifyPage(w http.ResponseWriter, r *http.Request) {
	next := strings.TrimSpace(r.URL.Query().Get("next"))
	// 只允许站内相对路径，避免被当成开放重定向。
	if !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") {
		next = "/dashboard"
	}
	// 已通过验证就不必再挑战一次。
	if validPass(s.Cfg, clientIP(r), r.UserAgent(), readPassCookie(r)) {
		http.Redirect(w, r, next, http.StatusSeeOther)
		return
	}
	s.render(w, r, "verify.html", pageData{Title: "安全验证", Data: next})
}

// handleChallengeIssue 签发挑战：绑定当前 IP 与 UA，存服务端。
func (s *Server) handleChallengeIssue(w http.ResponseWriter, r *http.Request) {
	if ok, _ := s.chalLimiter.allow(clientIP(r)); !ok {
		writeJSONError(w, http.StatusTooManyRequests, "验证请求过于频繁，请稍后再试")
		return
	}
	cs := s.challenges.issue(clientIP(r), r.UserAgent())
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"id":         cs.ID,
		"nonce":      cs.Nonce,
		"difficulty": cs.Difficulty,
		"ttlMs":      int(chalTTL / time.Millisecond),
	})
}

type challengeSubmitReq struct {
	ID       string        `json:"id"`
	Solution string        `json:"solution"`
	Evidence chalEvidence  `json:"evidence"`
	Signals  map[string]any `json:"signals"`
}

// handleChallengeSubmit 校验解答 + 行为证据，通过后发放通行 Cookie。
func (s *Server) handleChallengeSubmit(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	ua := r.UserAgent()
	if ok, _ := s.chalLimiter.allow(ip); !ok {
		writeJSONError(w, http.StatusTooManyRequests, "验证请求过于频繁，请稍后再试")
		return
	}
	var req challengeSubmitReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "请求格式错误")
		return
	}

	cs, ok := s.challenges.get(req.ID)
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "挑战不存在或已过期，请刷新页面")
		return
	}
	if cs.Used {
		writeJSONError(w, http.StatusBadRequest, "该挑战已使用，请刷新页面")
		return
	}
	if time.Since(cs.IssuedAt) > chalTTL {
		writeJSONError(w, http.StatusBadRequest, "挑战已超时，请刷新页面")
		return
	}
	// 绑定校验：换 IP 或换 UA 的请求直接作废，防止挑战被搬运到别的环境复用。
	if cs.IP != ip || cs.UA != ua {
		writeJSONError(w, http.StatusBadRequest, "验证环境发生变化，请刷新页面")
		return
	}
	if !verifySolution(cs.Nonce, req.Solution, cs.Difficulty) {
		writeJSONError(w, http.StatusBadRequest, "验证未通过，请重试")
		return
	}
	if err := checkEvidence(req.Evidence); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !s.challenges.consume(req.ID) {
		writeJSONError(w, http.StatusBadRequest, "该挑战已使用，请刷新页面")
		return
	}

	setPassCookie(w, r, s.Cfg, ip, ua)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

// requireHuman 保留给非中间件路径的兜底检查。
//
// 主流程已经由 humanGate 中间件原地拦截，能走到这里的请求必然已通过验证；
// 这里再校验一次是为了防止将来有人直接挂 handler 时漏掉防护。
func (s *Server) requireHuman(w http.ResponseWriter, r *http.Request, next string) bool {
	if validPass(s.Cfg, clientIP(r), r.UserAgent(), readPassCookie(r)) {
		return true
	}
	s.renderChallenge(w, r)
	return false
}

func writeJSONError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
