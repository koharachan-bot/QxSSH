package main

import (
	"fmt"
	"net/http"
)

type adminData struct {
	Pending   []*App
	Published []*App
	Others    []*App
	StoreURL  string
}

func (s *Server) handleAdmin(w http.ResponseWriter, r *http.Request) {
	pending, err := s.Store.AppsByStatus("pending")
	if err != nil {
		s.render(w, r, "error.html", pageData{Title: "出错了", Error: err.Error()})
		return
	}
	published, _ := s.Store.AppsByStatus("published")
	approved, _ := s.Store.AppsByStatus("approved")
	rejected, _ := s.Store.AppsByStatus("rejected")
	others := append(append([]*App{}, approved...), rejected...)
	s.render(w, r, "admin.html", pageData{
		Title: "审核与上架",
		Flash: r.URL.Query().Get("ok"),
		Error: r.URL.Query().Get("err"),
		Data: adminData{
			Pending:   pending,
			Published: published,
			Others:    others,
			StoreURL:  s.Cfg.PublicBase + "/index.json",
		},
	})
}

// loadForReview 取应用并校验当前状态是否允许审核。
func (s *Server) loadForReview(w http.ResponseWriter, r *http.Request) (*App, bool) {
	a, err := s.Store.AppByID(parseID(r, "id"))
	if err != nil {
		redirectWith(w, r, "/admin", "应用不存在", "err")
		return nil, false
	}
	return a, true
}

func (s *Server) handleApprove(w http.ResponseWriter, r *http.Request) {
	a, ok := s.loadForReview(w, r)
	if !ok {
		return
	}
	if err := s.Store.SetStatus(a.ID, "approved", ""); err != nil {
		redirectWith(w, r, "/admin", "操作失败："+err.Error(), "err")
		return
	}
	redirectWith(w, r, "/admin", fmt.Sprintf("「%s」已通过审核，可以上架", a.Name), "ok")
}

func (s *Server) handleReject(w http.ResponseWriter, r *http.Request) {
	a, ok := s.loadForReview(w, r)
	if !ok {
		return
	}
	note := r.FormValue("note")
	if err := s.Store.SetStatus(a.ID, "rejected", note); err != nil {
		redirectWith(w, r, "/admin", "操作失败："+err.Error(), "err")
		return
	}
	redirectWith(w, r, "/admin", fmt.Sprintf("「%s」已驳回", a.Name), "ok")
}

// handlePublish 上架单个应用：先置为 published，再整体重发索引。
func (s *Server) handlePublish(w http.ResponseWriter, r *http.Request) {
	a, ok := s.loadForReview(w, r)
	if !ok {
		return
	}
	if a.PackagePath == "" {
		redirectWith(w, r, "/admin", "该应用没有可发布的安装包", "err")
		return
	}
	if err := s.Store.SetStatus(a.ID, "published", ""); err != nil {
		redirectWith(w, r, "/admin", "更新状态失败："+err.Error(), "err")
		return
	}
	n, err := s.Pub.PublishAll()
	if err != nil {
		// 发布失败要把状态回滚，避免数据库显示已上架但商店里没有。
		_ = s.Store.SetStatus(a.ID, "approved", "")
		redirectWith(w, r, "/admin", "上架失败："+err.Error(), "err")
		return
	}
	redirectWith(w, r, "/admin", fmt.Sprintf("「%s」已上架，商店当前共 %d 款应用", a.Name, n), "ok")
}

// handlePublishAll 重发整个商店索引（改了包内容或需要修复索引时使用）。
func (s *Server) handlePublishAll(w http.ResponseWriter, r *http.Request) {
	n, err := s.Pub.PublishAll()
	if err != nil {
		redirectWith(w, r, "/admin", "全量发布失败："+err.Error(), "err")
		return
	}
	redirectWith(w, r, "/admin", fmt.Sprintf("商店已重新发布，共 %d 款应用", n), "ok")
}
