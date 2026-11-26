package main

import (
	"embed"
	"errors"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

//go:embed templates/*.html static/*
var assets embed.FS

// Server 聚合一次请求需要的全部依赖。
type Server struct {
	Cfg   *Config
	Store *Store
	COS   *COS
	Pub   *Publisher
	tpl   *template.Template
	// Mail 是邮箱验证码的发信器；未配置 SMTP 时为 nil，注册流程跳过邮箱验证。
	Mail *Mailer

	// 注册与登录的限速器：两者都是公开端点，不限速会被脚本刷穿。
	regLimiter   *rateLimiter
	loginLimiter *rateLimiter
	// 人机验证：挑战解答的去重表与签发频率限制。
	challenges *challengeMgr
	chalLimiter *rateLimiter
}

// pageData 是所有模板共用的上下文。
type pageData struct {
	Title   string
	User    *User
	IsAdmin bool
	Flash   string
	Error   string
	Data    any

	// 品牌信息由 render 统一注入，模板里可直接用。
	Brand     string
	BrandLogo string
	SiteURL   string

	// CSRF 令牌：所有表单都嵌一个 hidden，提交时与 Cookie 比对。
	CSRF string
}

func newServer(cfg *Config, st *Store, cos *COS) (*Server, error) {
	tpl, err := template.New("root").Funcs(template.FuncMap{
		"size":   humanSize,
		"age":    func(t time.Time) string { return ageString(t) },
		"date":   func(t time.Time) string { return t.Format("2006-01-02 15:04") },
		"status": statusLabel,
	}).ParseFS(assets, "templates/*.html")
	if err != nil {
		return nil, fmt.Errorf("解析模板失败：%w", err)
	}
	s := &Server{
		Cfg: cfg, Store: st, COS: cos, tpl: tpl,
		// 每 IP 每小时最多 5 次注册；每 IP 每 10 分钟最多 10 次登录尝试。
		regLimiter:   newRateLimiter(5, time.Hour),
		loginLimiter: newRateLimiter(10, 10*time.Minute),
		challenges:   newChallengeMgr(),
		chalLimiter:  newRateLimiter(60, 10*time.Minute),
	}
	s.Pub = &Publisher{Store: st, COS: cos, Cfg: cfg}
	s.Mail = newMailer(cfg)
	return s, nil
}

// statusLabel 把内部状态值翻成中文。
func statusLabel(s string) string {
	switch s {
	case "draft":
		return "草稿"
	case "pending":
		return "待审核"
	case "approved":
		return "已通过"
	case "rejected":
		return "已驳回"
	case "published":
		return "已上架"
	default:
		return s
	}
}

// Routes 注册全部路由。
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	staticFS, _ := fs.Sub(assets, "static")
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))

	// 面向脚本/CI 的 JSON API：用 API Key 认证，不走浏览器会话与 CSRF。
	mux.HandleFunc("GET /api/v1/me", s.handleAPIMe)
	mux.HandleFunc("GET /api/v1/apps", s.handleAPIListApps)
	mux.HandleFunc("POST /api/v1/apps", s.handleAPICreateApp)
	mux.HandleFunc("POST /api/v1/apps/{id}/upload", s.handleAPIUpload)
	mux.HandleFunc("POST /api/v1/apps/{id}/submit", s.handleAPISubmit)
	mux.HandleFunc("POST /api/v1/apps/{id}/publish", s.handleAPIPublish)
	mux.HandleFunc("POST /api/v1/apps/{id}/reject", s.handleAPIReject)
	mux.HandleFunc("GET /api/v1/catalog", s.handleAPICatalog)
	mux.HandleFunc("POST /api/v1/catalog/rebuild", s.handleAPIRebuild)
	mux.HandleFunc("POST /api/v1/apps/{id}/status", s.handleAPISetStatus)

	mux.HandleFunc("GET /{$}", s.handleHome)
	// 原地拦截：未通过人机验证时，同一 URL 返回挑战页，验证后自动回到原地址。
	// GET 页面正常渲染（页内挂件自动完成验证），只有提交动作被人机门禁保护。
	mux.HandleFunc("GET /login", s.handleLoginPage)
	mux.HandleFunc("POST /login", s.humanGate(s.handleLogin))
	mux.HandleFunc("GET /register", s.handleRegisterPage)
	mux.HandleFunc("POST /register", s.humanGate(s.handleRegister))
	mux.HandleFunc("GET /verify", s.handleVerifyPage)
	mux.HandleFunc("GET /challenge", s.handleChallengeIssue)
	mux.HandleFunc("POST /challenge/verify", s.handleChallengeSubmit)
	mux.HandleFunc("POST /logout", s.handleLogout)
	mux.HandleFunc("GET /verify-email", s.handleVerifyEmailPage)
	mux.HandleFunc("POST /verify-email", s.handleVerifyEmailSubmit)
	mux.HandleFunc("POST /verify-email/resend", s.handleResendCode)

	mux.HandleFunc("GET /login/2fa", s.handleTOTPPage)
	mux.HandleFunc("POST /login/2fa", s.handleTOTPVerify)

	mux.HandleFunc("GET /account", s.requireLogin(s.handleAccount))
	mux.HandleFunc("POST /account/apikeys", s.requireLogin(s.handleCreateAPIKey))
	mux.HandleFunc("POST /account/apikeys/revoke", s.requireLogin(s.handleRevokeAPIKey))
	mux.HandleFunc("GET /account/2fa/setup", s.requireLogin(s.handleTOTPSetup))
	mux.HandleFunc("POST /account/2fa/enable", s.requireLogin(s.handleTOTPEnable))
	mux.HandleFunc("POST /account/2fa/disable", s.requireLogin(s.handleTOTPDisable))

	mux.HandleFunc("GET /dashboard", s.requireLogin(s.handleDashboard))
	mux.HandleFunc("POST /apps", s.requireLogin(s.handleCreateApp))
	mux.HandleFunc("GET /apps/{id}", s.requireLogin(s.handleAppDetail))
	mux.HandleFunc("POST /apps/{id}/upload", s.requireLogin(s.handleUpload))
	mux.HandleFunc("POST /apps/{id}/submit", s.requireLogin(s.handleSubmit))
	mux.HandleFunc("POST /apps/{id}/delete", s.requireLogin(s.handleDeleteApp))

	mux.HandleFunc("GET /admin", s.requireAdmin(s.handleAdmin))
	mux.HandleFunc("POST /admin/{id}/approve", s.requireAdmin(s.handleApprove))
	mux.HandleFunc("POST /admin/{id}/reject", s.requireAdmin(s.handleReject))
	mux.HandleFunc("POST /admin/{id}/publish", s.requireAdmin(s.handlePublish))
	mux.HandleFunc("POST /admin/publish-all", s.requireAdmin(s.handlePublishAll))

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, "ok")
	})
	return s.withCommon(mux)
}

// withCommon 注入基础安全响应头。
func (s *Server) withCommon(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

// logf 是服务端日志的统一出口，便于运维从 journalctl 里定位问题。
func (s *Server) logf(format string, args ...any) {
	log.Printf(format, args...)
}

// render 渲染模板页。
func (s *Server) render(w http.ResponseWriter, r *http.Request, name string, data pageData) {
	data.User = s.userOf(r)
	data.IsAdmin = data.User != nil && data.User.Role == "admin"
	data.Brand = s.Cfg.Brand
	data.BrandLogo = s.Cfg.BrandLogo
	data.SiteURL = s.Cfg.SiteURL
	data.CSRF = s.ensureCSRF(w, r)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := s.tpl.ExecuteTemplate(w, name, data); err != nil {
		fmt.Fprintf(w, "渲染页面失败：%v", err)
	}
}

// userOf 取当前登录用户；未登录返回 nil。
func (s *Server) userOf(r *http.Request) *User {
	uid := currentUID(r, s.Cfg)
	if uid == 0 {
		return nil
	}
	u, err := s.Store.UserByID(uid)
	if err != nil {
		return nil
	}
	return u
}

func (s *Server) requireLogin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.userOf(r) == nil {
			http.Redirect(w, r, "/login?next="+r.URL.Path, http.StatusSeeOther)
			return
		}
		next(w, r)
	}
}

func (s *Server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return s.requireLogin(func(w http.ResponseWriter, r *http.Request) {
		u := s.userOf(r)
		if u == nil || u.Role != "admin" {
			s.render(w, r, "error.html", pageData{Title: "无权访问", Error: "该页面仅管理员可用"})
			return
		}
		next(w, r)
	})
}

func redirectWith(w http.ResponseWriter, r *http.Request, to, msg, kind string) {
	sep := "?"
	if strings.Contains(to, "?") {
		sep = "&"
	}
	http.Redirect(w, r, to+sep+kind+"="+msg, http.StatusSeeOther)
}

func parseID(r *http.Request, key string) int64 {
	v, _ := strconv.ParseInt(r.PathValue(key), 10, 64)
	return v
}

func isNotFound(err error) bool { return errors.Is(err, ErrNotFound) }
