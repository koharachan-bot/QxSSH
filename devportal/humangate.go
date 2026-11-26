package main

import (
	"net/http"
	"strings"
)

// humanGate 是"原地拦截"式人机验证中间件。
//
// 与先跳 /verify 再跳回的做法不同，这里**不改变 URL**：未通过验证时，
// 请求还是原来的地址，但响应体换成挑战页；浏览器跑完挑战后自行跳回同一地址，
// 拿到真正的页面。这就是 Cloudflare managed challenge 的交互形态。
//
// 豁免路径：静态资源、挑战接口本身、健康检查，否则会自己把自己锁死。
func (s *Server) humanGate(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if validPass(s.Cfg, clientIP(r), r.UserAgent(), readPassCookie(r)) {
			next(w, r)
			return
		}
		// 挑战页必须禁缓存，否则浏览器会把"待验证"的页面缓存下来反复展示。
		h := w.Header()
		h.Set("Cache-Control", "no-store, no-cache, must-revalidate")
		h.Set("X-Robots-Tag", "noindex")
		// 用 403 表达"被拦截"，与 CF 一致；页面本身仍可正常渲染。
		s.renderChallenge(w, r)
	}
}

// renderChallenge 输出挑战页，并带上回跳目标。
func (s *Server) renderChallenge(w http.ResponseWriter, r *http.Request) {
	target := r.URL.RequestURI()
	// 已经落在挑战相关路径上就别再包一层，避免死循环。
	if isChallengePath(r.URL.Path) {
		target = "/dashboard"
	}
	w.WriteHeader(http.StatusForbidden)
	s.render(w, r, "challenge_page.html", pageData{
		Title: "安全检查",
		Data:  target,
	})
}

// isHumanExempt 判断某路径是否跳过人机验证。
func isHumanExempt(path string) bool {
	if isChallengePath(path) {
		return true
	}
	switch {
	case strings.HasPrefix(path, "/static/"),
		strings.HasPrefix(path, "/cdn-cgi/"),
		path == "/favicon.ico",
		path == "/healthz",
		path == "/":
		return true
	}
	return false
}

func isChallengePath(p string) bool {
	switch p {
	case "/challenge", "/challenge/verify", "/challenge/check":
		return true
	}
	return false
}
