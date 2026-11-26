package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"time"
)

// CSRF 防护采用「双重提交 + 签名」：
//
//	- 每个浏览器拿一张随机 CSRF Cookie（HttpOnly，跨站读不到）；
//	- 表单渲染时把同一个值嵌进 hidden 字段；
//	- 提交时比对 Cookie 与表单字段，不一致就拒绝。
//
// 跨站攻击者既读不到 Cookie（HttpOnly），也猜不出随机值，因此无法伪造表单。
// SameSite=Lax 已能挡住大部分跨站 POST，这层是纵深防御。
const (
	csrfCookie = "qxportal_csrf"
	csrfField  = "csrf_token"
	csrfTTL    = 12 * time.Hour
)

// ensureCSRF 读取或下发 CSRF Cookie，返回当前令牌。
func (s *Server) ensureCSRF(w http.ResponseWriter, r *http.Request) string {
	if ck, err := r.Cookie(csrfCookie); err == nil && ck != nil && len(ck.Value) >= 32 {
		return ck.Value
	}
	tok := randomToken(24)
	http.SetCookie(w, &http.Cookie{
		Name:     csrfCookie,
		Value:    tok,
		Path:     "/",
		HttpOnly: true,
		Secure:   isHTTPSRequest(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(csrfTTL.Seconds()),
	})
	return tok
}

// checkCSRF 校验表单里的令牌与 Cookie 是否一致。
func checkCSRF(r *http.Request) bool {
	ck, err := r.Cookie(csrfCookie)
	if err != nil || ck == nil || ck.Value == "" {
		return false
	}
	want := r.FormValue(csrfField)
	if want == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(ck.Value), []byte(want)) == 1
}

// requireCSRF 在写操作入口做统一校验，失败直接 403。
func (s *Server) requireCSRF(w http.ResponseWriter, r *http.Request) bool {
	if checkCSRF(r) {
		return true
	}
	s.render(w, r, "error.html", pageData{
		Title: "请求被拒绝",
		Error: "表单校验失败（CSRF）。请刷新页面后重试。",
	})
	return false
}

// csrfSign 用于把 CSRF 令牌绑到具体会话，避免令牌跨账号复用。
func csrfSign(key, tok string) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("csrf|" + tok))
	return hex.EncodeToString(mac.Sum(nil))[:16]
}
