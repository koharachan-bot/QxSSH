package main

import (
	"encoding/json"
	"net/http"
)

// handleChallenge 签发一个 JS 挑战。
func (s *Server) handleChallenge(w http.ResponseWriter, r *http.Request) {
	// 签发本身也要限速：否则攻击者可以无限拿挑战、攒解答池。
	if ok, _ := s.chalLimiter.allow(clientIP(r)); !ok {
		writeJSONError(w, http.StatusTooManyRequests, "验证请求过于频繁，请稍后再试")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(issueChallenge(s.Cfg))
}

type challengeVerifyReq struct {
	ID         string          `json:"id"`
	Nonce      string          `json:"nonce"`
	Sig        string          `json:"sig"`
	Solution   string          `json:"solution"`
	Difficulty int             `json:"difficulty"`
	Expires    int64           `json:"expires"`
	Signals    json.RawMessage `json:"signals"`
}

// handleChallengeVerify 校验解答并发放短期通行 Cookie。
func (s *Server) handleChallengeVerify(w http.ResponseWriter, r *http.Request) {
	if ok, _ := s.chalLimiter.allow(clientIP(r)); !ok {
		writeJSONError(w, http.StatusTooManyRequests, "验证请求过于频繁，请稍后再试")
		return
	}
	var req challengeVerifyReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if err := verifyChallenge(s.Cfg, s.challenges, req.ID, req.Nonce, req.Sig, req.Solution, req.Difficulty, req.Expires); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	ip := clientIP(r)
	setPassCookie(w, r, s.Cfg, ip)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

// requireHuman 检查通行 Cookie；未通过时退回相应页面并提示。
func (s *Server) requireHuman(w http.ResponseWriter, r *http.Request, back string) bool {
	if validPass(s.Cfg, clientIP(r), readPassCookie(r)) {
		return true
	}
	redirectWith(w, r, back, "请先完成浏览器验证", "err")
	return false
}

func writeJSONError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
