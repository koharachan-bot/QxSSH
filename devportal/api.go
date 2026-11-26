package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// 面向脚本/CI 的 JSON API，用 API Key 认证（不依赖浏览器会话，也不走 CSRF）。
//
// 认证：Authorization: Bearer qxk_xxx  或  X-API-Key: qxk_xxx
// 所有响应都是 JSON，错误统一 {"error": "..."}。

// apiUser 从请求里解析 API Key 对应的用户；失败时直接写 401 并返回 nil。
func (s *Server) apiUser(w http.ResponseWriter, r *http.Request) *User {
	tok := strings.TrimSpace(r.Header.Get("X-API-Key"))
	if tok == "" {
		auth := strings.TrimSpace(r.Header.Get("Authorization"))
		if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
			tok = strings.TrimSpace(auth[7:])
		}
	}
	if tok == "" {
		apiErr(w, http.StatusUnauthorized, "缺少 API Key（Authorization: Bearer qxk_... 或 X-API-Key）")
		return nil
	}
	u, err := s.Store.UserByAPIKey(tok)
	if err != nil {
		apiErr(w, http.StatusUnauthorized, "API Key 无效或已作废")
		return nil
	}
	return u
}

func apiErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func apiJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

// apiAppView 是应用在 API 里的对外形态。
type apiAppView struct {
	ID        int64  `json:"id"`
	AppID     string `json:"app_id"`
	Name      string `json:"name"`
	Version   string `json:"version"`
	Summary   string `json:"summary"`
	Status    string `json:"status"`
	PackageSHA string `json:"package_sha,omitempty"`
	PackageSize int64 `json:"package_size,omitempty"`
	ReviewNote  string `json:"review_note,omitempty"`
	UpdatedAt   string `json:"updated_at"`
}

func toAPIApp(a *App) apiAppView {
	return apiAppView{
		ID: a.ID, AppID: a.AppID, Name: a.Name, Version: a.Version, Summary: a.Summary,
		Status: a.Status, PackageSHA: a.PackageSHA, PackageSize: a.PackageSize,
		ReviewNote: a.ReviewNote, UpdatedAt: a.UpdatedAt.Format("2006-01-02 15:04:05"),
	}
}

// handleAPIMe 返回当前 Key 对应的身份，供脚本自检。
func (s *Server) handleAPIMe(w http.ResponseWriter, r *http.Request) {
	u := s.apiUser(w, r)
	if u == nil {
		return
	}
	apiJSON(w, map[string]any{
		"email": u.Email, "nickname": u.Nickname, "role": u.Role, "is_admin": u.Role == "admin",
	})
}

// handleAPIListApps 列出当前用户的应用。
func (s *Server) handleAPIListApps(w http.ResponseWriter, r *http.Request) {
	u := s.apiUser(w, r)
	if u == nil {
		return
	}
	list, err := s.Store.AppsByOwner(u.ID)
	if err != nil {
		apiErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]apiAppView, 0, len(list))
	for _, a := range list {
		out = append(out, toAPIApp(a))
	}
	apiJSON(w, map[string]any{"apps": out})
}

type apiCreateAppReq struct {
	AppID   string `json:"app_id"`
	Name    string `json:"name"`
	Summary string `json:"summary"`
	Category string `json:"category"`
	Author  string `json:"author"`
}

// handleAPICreateApp 创建应用（已存在则更新元信息）。
func (s *Server) handleAPICreateApp(w http.ResponseWriter, r *http.Request) {
	u := s.apiUser(w, r)
	if u == nil {
		return
	}
	var req apiCreateAppReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		apiErr(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	req.AppID = strings.TrimSpace(req.AppID)
	if !appIDRe.MatchString(req.AppID) {
		apiErr(w, http.StatusBadRequest, "app_id 非法（字母数字开头，仅含字母数字 - _，最长 64）")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		apiErr(w, http.StatusBadRequest, "name 不能为空")
		return
	}

	// 已存在时必须是自己的应用
	if viewer, err := s.Store.AppByID(0); err == nil && viewer != nil {
		_ = viewer
	}
	existing, err := s.appByAppID(req.AppID)
	if err == nil && existing != nil {
		if existing.OwnerID != u.ID {
			apiErr(w, http.StatusForbidden, "该 app_id 已被其他开发者占用")
			return
		}
		existing.Name = strings.TrimSpace(req.Name)
		if strings.TrimSpace(req.Summary) != "" {
			existing.Summary = strings.TrimSpace(req.Summary)
		}
		if strings.TrimSpace(req.Category) != "" {
			existing.Category = strings.TrimSpace(req.Category)
		}
		if strings.TrimSpace(req.Author) != "" {
			existing.Author = strings.TrimSpace(req.Author)
		}
		if err := s.Store.UpsertApp(existing); err != nil {
			apiErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		apiJSON(w, map[string]any{"ok": true, "created": false, "app": toAPIApp(existing)})
		return
	}

	a := &App{
		OwnerID: u.ID, AppID: req.AppID, Name: strings.TrimSpace(req.Name),
		Summary: strings.TrimSpace(req.Summary), Category: strings.TrimSpace(req.Category),
		Author: strings.TrimSpace(req.Author), Status: "draft",
	}
	if a.Author == "" {
		a.Author = u.Nickname
	}
	if err := s.Store.UpsertApp(a); err != nil {
		apiErr(w, http.StatusBadRequest, err.Error())
		return
	}
	apiJSON(w, map[string]any{"ok": true, "created": true, "app": toAPIApp(a)})
}

// appByAppID 按 manifest id 查应用记录。
func (s *Server) appByAppID(appID string) (*App, error) {
	var id int64
	err := s.Store.db.QueryRow(`SELECT id FROM apps WHERE app_id=?`, appID).Scan(&id)
	if err != nil {
		return nil, err
	}
	return s.Store.AppByID(id)
}

// handleAPIUpload 上传 .qxp（multipart 字段 package），校验后记录版本。
func (s *Server) handleAPIUpload(w http.ResponseWriter, r *http.Request) {
	u := s.apiUser(w, r)
	if u == nil {
		return
	}
	a, err := s.Store.AppByID(parseID(r, "id"))
	if err != nil || a.OwnerID != u.ID {
		apiErr(w, http.StatusNotFound, "应用不存在或不属于你")
		return
	}

	maxBytes := s.Cfg.MaxUploadMB << 20
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+1024)
	file, hdr, err := r.FormFile("package")
	if err != nil {
		apiErr(w, http.StatusBadRequest, "缺少 package 文件字段（multipart）")
		return
	}
	defer file.Close()
	if !strings.HasSuffix(strings.ToLower(hdr.Filename), ".qxp") {
		apiErr(w, http.StatusBadRequest, "文件后缀必须是 .qxp")
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		apiErr(w, http.StatusBadRequest, "读取上传内容失败")
		return
	}
	if int64(len(data)) > maxBytes {
		apiErr(w, http.StatusBadRequest, fmt.Sprintf("安装包超过 %d MB", s.Cfg.MaxUploadMB))
		return
	}
	parsed, perr := parsePackage(data)
	if perr != nil {
		apiErr(w, http.StatusBadRequest, "校验失败："+perr.Error())
		return
	}
	if parsed.Manifest.ID != a.AppID {
		apiErr(w, http.StatusBadRequest, fmt.Sprintf("包内 manifest.id 是 %q，与登记的应用 id %q 不一致", parsed.Manifest.ID, a.AppID))
		return
	}

	pkgDir := filepath.Join(s.Cfg.DataDir, "packages")
	dest := filepath.Join(pkgDir, fmt.Sprintf("%s-%s.qxp", a.AppID, parsed.Manifest.Version))
	if rel, rerr := filepath.Rel(pkgDir, dest); rerr != nil || strings.HasPrefix(rel, "..") {
		apiErr(w, http.StatusBadRequest, "安装包路径非法")
		return
	}
	if err := os.MkdirAll(pkgDir, 0o750); err != nil {
		apiErr(w, http.StatusInternalServerError, "创建目录失败")
		return
	}
	if err := os.WriteFile(dest, data, 0o640); err != nil {
		apiErr(w, http.StatusInternalServerError, "保存安装包失败")
		return
	}
	a.PackagePath = dest
	a.PackageSize = int64(len(data))
	a.PackageSHA = parsed.SHA256
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
		apiErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	changelog := strings.TrimSpace(r.FormValue("changelog"))
	if err := s.Store.UpsertRelease(a.AppID, a.Version, dest, int64(len(data)), parsed.SHA256, changelog); err != nil {
		s.logf("API 记录版本失败 app=%s err=%v", a.AppID, err)
	}
	apiJSON(w, map[string]any{"ok": true, "app": toAPIApp(a), "sha256": parsed.SHA256, "size": len(data)})
}

// handleAPISubmit 提交审核。
func (s *Server) handleAPISubmit(w http.ResponseWriter, r *http.Request) {
	u := s.apiUser(w, r)
	if u == nil {
		return
	}
	a, err := s.Store.AppByID(parseID(r, "id"))
	if err != nil || a.OwnerID != u.ID {
		apiErr(w, http.StatusNotFound, "应用不存在或不属于你")
		return
	}
	if a.PackagePath == "" {
		apiErr(w, http.StatusBadRequest, "请先上传安装包")
		return
	}
	if err := s.Store.SetStatus(a.ID, "pending", ""); err != nil {
		apiErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.Status = "pending"
	apiJSON(w, map[string]any{"ok": true, "app": toAPIApp(a)})
}

type apiReviewReq struct {
	Note string `json:"note"`
}

// handleAPIPublish 上架（需管理员）：置为 published 后整体重发索引。
func (s *Server) handleAPIPublish(w http.ResponseWriter, r *http.Request) {
	u := s.apiUser(w, r)
	if u == nil {
		return
	}
	if u.Role != "admin" {
		apiErr(w, http.StatusForbidden, "上架需要管理员权限")
		return
	}
	a, err := s.Store.AppByID(parseID(r, "id"))
	if err != nil {
		apiErr(w, http.StatusNotFound, "应用不存在")
		return
	}
	if a.PackagePath == "" {
		apiErr(w, http.StatusBadRequest, "该应用没有可发布的安装包")
		return
	}
	if err := s.Store.SetStatus(a.ID, "published", ""); err != nil {
		apiErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	n, perr := s.Pub.PublishAll()
	if perr != nil {
		_ = s.Store.SetStatus(a.ID, "approved", "")
		apiErr(w, http.StatusBadGateway, "上架失败："+perr.Error())
		return
	}
	a.Status = "published"
	apiJSON(w, map[string]any{"ok": true, "app": toAPIApp(a), "catalog_entries": n})
}

// handleAPIReject 驳回（需管理员）。
func (s *Server) handleAPIReject(w http.ResponseWriter, r *http.Request) {
	u := s.apiUser(w, r)
	if u == nil {
		return
	}
	if u.Role != "admin" {
		apiErr(w, http.StatusForbidden, "驳回需要管理员权限")
		return
	}
	var req apiReviewReq
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req)
	a, err := s.Store.AppByID(parseID(r, "id"))
	if err != nil {
		apiErr(w, http.StatusNotFound, "应用不存在")
		return
	}
	if err := s.Store.SetStatus(a.ID, "rejected", strings.TrimSpace(req.Note)); err != nil {
		apiErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.Status = "rejected"
	apiJSON(w, map[string]any{"ok": true, "app": toAPIApp(a)})
}

// handleAPIRebuild 全量重发商店索引（管理员）。
//
// 用于两类场景：批量导入了历史应用之后统一推一次；或者怀疑索引与实际不一致时重建。
func (s *Server) handleAPIRebuild(w http.ResponseWriter, r *http.Request) {
	u := s.apiUser(w, r)
	if u == nil {
		return
	}
	if u.Role != "admin" {
		apiErr(w, http.StatusForbidden, "重建索引需要管理员权限")
		return
	}
	n, err := s.Pub.PublishAll()
	if err != nil {
		apiErr(w, http.StatusBadGateway, "重建失败："+err.Error())
		return
	}
	apiJSON(w, map[string]any{"ok": true, "catalog_entries": n})
}

// handleAPISetStatus 直接改状态（管理员），用于批量导入后的状态对齐。
func (s *Server) handleAPISetStatus(w http.ResponseWriter, r *http.Request) {
	u := s.apiUser(w, r)
	if u == nil {
		return
	}
	if u.Role != "admin" {
		apiErr(w, http.StatusForbidden, "需要管理员权限")
		return
	}
	var req struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		apiErr(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	switch req.Status {
	case "draft", "pending", "approved", "rejected", "published":
	default:
		apiErr(w, http.StatusBadRequest, "status 取值非法")
		return
	}
	a, err := s.Store.AppByID(parseID(r, "id"))
	if err != nil {
		apiErr(w, http.StatusNotFound, "应用不存在")
		return
	}
	if err := s.Store.SetStatus(a.ID, req.Status, ""); err != nil {
		apiErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.Status = req.Status
	apiJSON(w, map[string]any{"ok": true, "app": toAPIApp(a)})
}

// handleAPICatalog 返回当前线上索引，便于脚本发布后自检。
//
// 直接拉商店对外地址（而不是读本地数据库），能同时验证 CDN 上的内容
// 是否已经刷新——这正是发布后最容易出问题的一环。
func (s *Server) handleAPICatalog(w http.ResponseWriter, r *http.Request) {
	u := s.apiUser(w, r)
	if u == nil {
		return
	}
	src := strings.TrimRight(s.Cfg.PublicBase, "/") + "/index.json"
	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, src, nil)
	if err != nil {
		apiErr(w, http.StatusBadGateway, err.Error())
		return
	}
	// 加 no-cache 让 CDN 尽量回源，便于确认刚发布的内容是否可见。
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := client.Do(req)
	if err != nil {
		apiErr(w, http.StatusBadGateway, "拉取商店索引失败："+err.Error())
		return
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		apiErr(w, http.StatusBadGateway, err.Error())
		return
	}
	var cat any
	if err := json.Unmarshal(body, &cat); err != nil {
		apiErr(w, http.StatusBadGateway, "商店索引不是合法 JSON")
		return
	}
	apiJSON(w, map[string]any{"source": src, "status": resp.StatusCode, "catalog": cat, "bytes": len(body)})
}

// parseIDInt 供 API 路径参数转 int64。
func parseIDInt(raw string) int64 {
	v, _ := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	return v
}
