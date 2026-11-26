package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

/* ------------------------------ 公开页 ------------------------------ */

func (s *Server) handleHome(w http.ResponseWriter, r *http.Request) {
	if s.userOf(r) != nil {
		http.Redirect(w, r, "/dashboard", http.StatusSeeOther)
		return
	}
	s.render(w, r, "home.html", pageData{Title: "开发者平台"})
}

func (s *Server) handleLoginPage(w http.ResponseWriter, r *http.Request) {
	s.render(w, r, "login.html", pageData{
		Title: "登录",
		Flash: r.URL.Query().Get("ok"),
		Error: r.URL.Query().Get("err"),
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !s.requireCSRF(w, r) {
		return
	}
	if !s.requireHuman(w, r, "/login") {
		return
	}
	ip := clientIP(r)
	if ok, wait := s.loginLimiter.allow(ip); !ok {
		redirectWith(w, r, "/login",
			fmt.Sprintf("尝试过于频繁，请 %d 秒后再试", int(wait.Seconds())+1), "err")
		return
	}

	email := r.FormValue("email")
	pw := r.FormValue("password")
	u, err := s.Store.UserByEmail(email)
	if err != nil || !checkPassword(u.PassHash, pw) {
		redirectWith(w, r, "/login", "邮箱或密码不正确", "err")
		return
	}
	// 登录成功清零，正常用户不会因为之前的失败被锁。
	s.loginLimiter.reset(ip)

	// 未验证邮箱的账号不能登录，直接引导去验证页。
	if s.Cfg.RequireEmailVerify && !u.EmailVerified {
		setPendingEmail(w, r, s.Cfg, u.ID)
		redirectWith(w, r, "/verify-email", "请先完成邮箱验证", "err")
		return
	}

	// 已启用两步验证：先发一张 5 分钟的待验证票，走第二步。
	if u.TOTPEnabled {
		setPending(w, r, s.Cfg, u.ID)
		http.Redirect(w, r, "/login/2fa", http.StatusSeeOther)
		return
	}
	issueSession(w, r, s.Cfg, u.ID)
	http.Redirect(w, r, "/dashboard", http.StatusSeeOther)
}

func (s *Server) handleRegisterPage(w http.ResponseWriter, r *http.Request) {
	if s.Cfg.Registration == "closed" {
		s.render(w, r, "error.html", pageData{
			Title: "注册已关闭",
			Error: "平台暂不开放自助注册，请联系管理员开通账号。",
		})
		return
	}
	s.render(w, r, "register.html", pageData{Title: "注册", Error: r.URL.Query().Get("err")})
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !s.requireCSRF(w, r) {
		return
	}
	if !s.requireHuman(w, r, "/register") {
		return
	}
	if s.Cfg.Registration == "closed" {
		redirectWith(w, r, "/register", "注册已关闭", "err")
		return
	}
	if ok, wait := s.regLimiter.allow(clientIP(r)); !ok {
		redirectWith(w, r, "/register",
			fmt.Sprintf("注册过于频繁，请 %d 分钟后再试", int(wait.Minutes())+1), "err")
		return
	}

	email := r.FormValue("email")
	pw := r.FormValue("password")
	nick := r.FormValue("nickname")
	// 首个注册账号自动成为管理员，之后一律是开发者。
	role := "developer"
	if n, err := s.Store.CountUsers(); err == nil && n == 0 {
		role = "admin"
	}
	u, err := s.Store.CreateUser(email, pw, nick, role)
	if err != nil {
		redirectWith(w, r, "/register", err.Error(), "err")
		return
	}

	// 配置了 SMTP 时，新账号必须先完成邮箱验证才能登录。
	if s.Cfg.RequireEmailVerify {
		if err := s.Store.SetEmailVerified(u.ID, false); err != nil {
			redirectWith(w, r, "/register", "初始化账号状态失败", "err")
			return
		}
		setPendingEmail(w, r, s.Cfg, u.ID)
		if err := s.sendEmailCode(w, r, u); err != nil {
			s.logf("发送注册验证码失败 email=%s err=%v", u.Email, err)
			redirectWith(w, r, "/verify-email", "验证码发送失败，请点击重新发送", "err")
			return
		}
		s.logf("注册验证码已发送 email=%s", u.Email)
		redirectWith(w, r, "/verify-email", "验证码已发送到你的邮箱", "ok")
		return
	}

	s.loginLimiter.reset(clientIP(r))
	issueSession(w, r, s.Cfg, u.ID)
	http.Redirect(w, r, "/dashboard", http.StatusSeeOther)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	clearSession(w, r)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

/* ------------------------------ 开发者 ------------------------------ */

type dashData struct {
	Apps []*App
	Published int
	Pending   int
	Rejected  int
}

func (s *Server) handleDashboard(w http.ResponseWriter, r *http.Request) {
	u := s.userOf(r)
	apps, err := s.Store.AppsByOwner(u.ID)
	if err != nil {
		s.render(w, r, "error.html", pageData{Title: "出错了", Error: err.Error()})
		return
	}
	d := dashData{Apps: apps}
	for _, a := range apps {
		switch a.Status {
		case "published":
			d.Published++
		case "pending":
			d.Pending++
		case "rejected":
			d.Rejected++
		}
	}
	s.render(w, r, "dashboard.html", pageData{
		Title: "我的应用",
		Flash: r.URL.Query().Get("ok"),
		Error: r.URL.Query().Get("err"),
		Data:  d,
	})
}

func (s *Server) handleCreateApp(w http.ResponseWriter, r *http.Request) {
	if !s.requireCSRF(w, r) {
		return
	}
	u := s.userOf(r)
	id := strings.TrimSpace(r.FormValue("app_id"))
	name := strings.TrimSpace(r.FormValue("name"))
	if !appIDRe.MatchString(id) {
		redirectWith(w, r, "/dashboard", "应用 id 非法（只允许字母、数字、- 与 _）", "err")
		return
	}
	if name == "" {
		redirectWith(w, r, "/dashboard", "应用名称不能为空", "err")
		return
	}
	a := &App{
		OwnerID:  u.ID,
		AppID:    id,
		Name:     name,
		Summary:  strings.TrimSpace(r.FormValue("summary")),
		Category: strings.TrimSpace(r.FormValue("category")),
		Author:   strings.TrimSpace(r.FormValue("author")),
		Status:   "draft",
	}
	if err := s.Store.UpsertApp(a); err != nil {
		redirectWith(w, r, "/dashboard", err.Error(), "err")
		return
	}
	redirectWith(w, r, fmt.Sprintf("/apps/%d", a.ID), "应用已创建，下一步上传安装包", "ok")
}

func (s *Server) handleAppDetail(w http.ResponseWriter, r *http.Request) {
	u := s.userOf(r)
	a, err := s.Store.AppByID(parseID(r, "id"))
	if err != nil {
		s.render(w, r, "error.html", pageData{Title: "找不到应用", Error: "该应用不存在"})
		return
	}
	if a.OwnerID != u.ID && u.Role != "admin" {
		s.render(w, r, "error.html", pageData{Title: "无权访问", Error: "这不是你的应用"})
		return
	}
	s.render(w, r, "app.html", pageData{
		Title: a.Name,
		Flash: r.URL.Query().Get("ok"),
		Error: r.URL.Query().Get("err"),
		Data:  a,
	})
}

// handleUpload 接收 .qxp 并就地校验，校验通过才落盘并回填清单字段。
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if !s.requireCSRF(w, r) {
		return
	}
	id := parseID(r, "id")
	u := s.userOf(r)
	a, err := s.Store.AppByID(id)
	if err != nil {
		redirectWith(w, r, "/dashboard", "应用不存在", "err")
		return
	}
	if a.OwnerID != u.ID {
		redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "无权修改他人应用", "err")
		return
	}

	maxBytes := s.Cfg.MaxUploadMB << 20
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+1024)
	file, hdr, err := r.FormFile("package")
	if err != nil {
		redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "请选择 .qxp 文件（上限 "+fmt.Sprint(s.Cfg.MaxUploadMB)+"MB）", "err")
		return
	}
	defer file.Close()
	if !strings.HasSuffix(strings.ToLower(hdr.Filename), ".qxp") {
		redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "文件后缀必须是 .qxp", "err")
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "读取上传文件失败", "err")
		return
	}
	if int64(len(data)) > maxBytes {
		redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "安装包过大", "err")
		return
	}

	parsed, perr := parsePackage(data)
	if perr != nil {
		redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "校验失败："+perr.Error(), "err")
		return
	}
	// 包内 manifest 的 id 必须与平台登记的一致，避免“挂着 A 名装 B 包”。
	if parsed.Manifest.ID != a.AppID {
		redirectWith(w, r, fmt.Sprintf("/apps/%d", id),
			fmt.Sprintf("包内 manifest.id 是「%s」，与平台登记的应用 id「%s」不一致", parsed.Manifest.ID, a.AppID), "err")
		return
	}

	// 纵深防御：即便解析层已校验过 id 与 version，落盘前再确认一次，
	// 并验证最终路径确实落在 packages 目录内（防止任何形式的穿越）。
	pkgDir := filepath.Join(s.Cfg.DataDir, "packages")
	if !appIDRe.MatchString(a.AppID) || !versionRe.MatchString(parsed.Manifest.Version) {
		redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "应用 id 或版本号包含非法字符", "err")
		return
	}
	dest := filepath.Join(pkgDir, fmt.Sprintf("%s-%s.qxp", a.AppID, parsed.Manifest.Version))
	if rel, rerr := filepath.Rel(pkgDir, dest); rerr != nil || strings.HasPrefix(rel, "..") {
		redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "安装包路径非法", "err")
		return
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o750); err != nil {
		redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "创建目录失败", "err")
		return
	}
	if err := os.WriteFile(dest, data, 0o640); err != nil {
		redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "保存安装包失败", "err")
		return
	}

	sum := sha256.Sum256(data)
	a.PackagePath = dest
	a.PackageSize = int64(len(data))
	a.PackageSHA = hex.EncodeToString(sum[:])
	a.Version = parsed.Manifest.Version
	if a.Summary == "" {
		a.Summary = parsed.Manifest.Description
	}
	if a.Author == "" {
		a.Author = parsed.Manifest.Author
	}
	if a.Category == "" {
		a.Category = parsed.Manifest.Category
	}
	if err := s.Store.UpsertApp(a); err != nil {
		redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "保存记录失败："+err.Error(), "err")
		return
	}
	// 每个版本单独留档：发布时会把全部历史版本推到商店，客户端可据此更新或降级。
	if err := s.Store.UpsertRelease(a.AppID, parsed.Manifest.Version, dest,
		int64(len(data)), hex.EncodeToString(sum[:]), strings.TrimSpace(r.FormValue("changelog"))); err != nil {
		s.logf("记录版本失败 app=%s version=%s err=%v", a.AppID, parsed.Manifest.Version, err)
	}
	redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "安装包已上传并通过校验（版本 "+parsed.Manifest.Version+"）", "ok")
}

func (s *Server) handleSubmit(w http.ResponseWriter, r *http.Request) {
	if !s.requireCSRF(w, r) {
		return
	}
	id := parseID(r, "id")
	u := s.userOf(r)
	a, err := s.Store.AppByID(id)
	if err != nil || a.OwnerID != u.ID {
		redirectWith(w, r, "/dashboard", "应用不存在或无权操作", "err")
		return
	}
	if a.PackagePath == "" {
		redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "请先上传安装包再提交审核", "err")
		return
	}
	if err := s.Store.SetStatus(id, "pending", ""); err != nil {
		redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "提交失败："+err.Error(), "err")
		return
	}
	redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "已提交审核", "ok")
}

func (s *Server) handleDeleteApp(w http.ResponseWriter, r *http.Request) {
	if !s.requireCSRF(w, r) {
		return
	}
	id := parseID(r, "id")
	u := s.userOf(r)
	a, err := s.Store.AppByID(id)
	if err != nil || a.OwnerID != u.ID {
		redirectWith(w, r, "/dashboard", "应用不存在或无权操作", "err")
		return
	}
	if a.Status == "published" || a.Status == "pending" {
		redirectWith(w, r, fmt.Sprintf("/apps/%d", id), "已提交或已上架的应用不能直接删除", "err")
		return
	}
	if err := s.Store.DeleteApp(id); err != nil {
		redirectWith(w, r, "/dashboard", "删除失败："+err.Error(), "err")
		return
	}
	redirectWith(w, r, "/dashboard", "应用已删除", "ok")
}
