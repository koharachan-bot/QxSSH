package main

import (
	"embed"
	"errors"
	"fmt"
	"html/template"
	"io"
	"io/fs"
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

	mux.HandleFunc("GET /{$}", s.handleHome)
	mux.HandleFunc("GET /login", s.handleLoginPage)
	mux.HandleFunc("POST /login", s.handleLogin)
	mux.HandleFunc("GET /register", s.handleRegisterPage)
	mux.HandleFunc("GET /challenge", s.handleChallenge)
	mux.HandleFunc("POST /challenge/verify", s.handleChallengeVerify)
	mux.HandleFunc("POST /register", s.handleRegister)
	mux.HandleFunc("POST /logout", s.handleLogout)

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

// render 渲染模板页。
func (s *Server) render(w http.ResponseWriter, r *http.Request, name string, data pageData) {
	data.User = s.userOf(r)
	data.IsAdmin = data.User != nil && data.User.Role == "admin"
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
