package main

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// handleCreateAPIKey 生成一把新的 API Key 并展示一次明文。
func (s *Server) handleCreateAPIKey(w http.ResponseWriter, r *http.Request) {
	if !s.requireCSRF(w, r) {
		return
	}
	u := s.userOf(r)
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		name = "未命名密钥"
	}
	plain, _, err := s.Store.CreateAPIKey(u.ID, name)
	if err != nil {
		redirectWith(w, r, "/account", "生成失败："+err.Error(), "err")
		return
	}
	// 明文只在这里显示一次，不落库。
	s.render(w, r, "apikey_created.html", pageData{
		Title: "API Key 已生成",
		Data:  plain,
	})
}

// handleRevokeAPIKey 作废一把 Key。
func (s *Server) handleRevokeAPIKey(w http.ResponseWriter, r *http.Request) {
	if !s.requireCSRF(w, r) {
		return
	}
	u := s.userOf(r)
	id, _ := strconv.ParseInt(strings.TrimSpace(r.FormValue("id")), 10, 64)
	if err := s.Store.RevokeAPIKey(u.ID, id); err != nil {
		redirectWith(w, r, "/account", "作废失败："+err.Error(), "err")
		return
	}
	redirectWith(w, r, "/account", fmt.Sprintf("密钥 #%d 已作废", id), "ok")
}
