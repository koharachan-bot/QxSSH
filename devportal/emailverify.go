package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// 注册邮箱验证码：新账号必须收到并输入 6 位码才能激活。
const (
	emailCodeTTL    = 15 * time.Minute
	emailCodeMaxTry = 5
)

// newEmailCode 生成 6 位数字验证码。
func newEmailCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

func hashEmailCode(code string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(code)))
	return hex.EncodeToString(sum[:])
}

// setEmailCode 写入验证码（只存哈希）与过期时间，并清零尝试次数。
func (s *Store) setEmailCode(uid int64, code string, exp time.Time) error {
	_, err := s.db.Exec(
		`UPDATE users SET email_code=?, email_code_exp=?, email_code_tries=0 WHERE id=?`,
		hashEmailCode(code), exp.Unix(), uid)
	return err
}

// verifyEmailCode 校验验证码。返回错误时附上可直接展示的中文说明。
func (s *Store) verifyEmailCode(uid int64, code string) error {
	var stored string
	var exp int64
	var tries int
	err := s.db.QueryRow(`SELECT email_code, email_code_exp, email_code_tries FROM users WHERE id=?`, uid).
		Scan(&stored, &exp, &tries)
	if err != nil {
		return fmt.Errorf("账号不存在")
	}
	if stored == "" {
		return fmt.Errorf("请先获取验证码")
	}
	if time.Now().Unix() > exp {
		return fmt.Errorf("验证码已过期，请重新获取")
	}
	if tries >= emailCodeMaxTry {
		return fmt.Errorf("尝试次数过多，请重新获取验证码")
	}
	if subtle.ConstantTimeCompare([]byte(stored), []byte(hashEmailCode(code))) != 1 {
		_, _ = s.db.Exec(`UPDATE users SET email_code_tries=email_code_tries+1 WHERE id=?`, uid)
		return fmt.Errorf("验证码不正确")
	}
	_, err = s.db.Exec(`UPDATE users SET email_verified=1, email_code='', email_code_exp=0, email_code_tries=0 WHERE id=?`, uid)
	return err
}

// SetEmailVerified 设置账号的邮箱验证状态。
func (s *Store) SetEmailVerified(uid int64, verified bool) error {
	v := 0
	if verified {
		v = 1
	}
	_, err := s.db.Exec(`UPDATE users SET email_verified=? WHERE id=?`, v, uid)
	return err
}

// markEmailVerified 直接把账号标记为已验证（管理员创建账号时用）。
func (s *Store) markEmailVerified(uid int64) error {
	_, err := s.db.Exec(`UPDATE users SET email_verified=1 WHERE id=?`, uid)
	return err
}

// emailCodeBody 生成邮件正文。
func emailCodeBody(nickname, code string) string {
	name := nickname
	if strings.TrimSpace(name) == "" {
		name = "开发者"
	}
	return "你好 " + name + "：\n\n" +
		"你正在注册 QxSSH 开发者平台。本次验证码为：\n\n" +
		"    " + code + "\n\n" +
		"验证码 " + fmt.Sprint(int(emailCodeTTL.Minutes())) + " 分钟内有效，请勿转发给他人。\n" +
		"如果这不是你本人的操作，请忽略本邮件。\n\n" +
		"—— QxSSH 开发者平台\n"
}

// sendEmailCode 生成并发送验证码。
func (s *Server) sendEmailCode(w http.ResponseWriter, r *http.Request, u *User) error {
	if s.Mail == nil || !s.Mail.Enabled {
		return fmt.Errorf("邮件服务未配置，请联系管理员")
	}
	code, err := newEmailCode()
	if err != nil {
		return err
	}
	if err := s.Store.setEmailCode(u.ID, code, time.Now().Add(emailCodeTTL)); err != nil {
		return err
	}
	if err := s.Mail.Send(u.Email, "QxSSH 开发者平台 · 邮箱验证码", emailCodeBody(u.Nickname, code)); err != nil {
		return fmt.Errorf("发送邮件失败：%w", err)
	}
	return nil
}

// handleVerifyEmailPage 显示验证码输入页。
func (s *Server) handleVerifyEmailPage(w http.ResponseWriter, r *http.Request) {
	uid := readPendingEmail(s.Cfg, r)
	if uid == 0 {
		http.Redirect(w, r, "/register", http.StatusSeeOther)
		return
	}
	u, err := s.Store.UserByID(uid)
	if err != nil {
		http.Redirect(w, r, "/register", http.StatusSeeOther)
		return
	}
	s.render(w, r, "verify_email.html", pageData{
		Title: "验证邮箱",
		Error: r.URL.Query().Get("err"),
		Flash: r.URL.Query().Get("ok"),
		Data:  u.Email,
	})
}

// handleVerifyEmailSubmit 校验验证码并激活账号。
func (s *Server) handleVerifyEmailSubmit(w http.ResponseWriter, r *http.Request) {
	if ok, wait := s.regLimiter.allow(clientIP(r)); !ok {
		redirectWith(w, r, "/verify-email", fmt.Sprintf("尝试过于频繁，请 %d 分钟后再试", int(wait.Minutes())+1), "err")
		return
	}
	uid := readPendingEmail(s.Cfg, r)
	if uid == 0 {
		http.Redirect(w, r, "/register", http.StatusSeeOther)
		return
	}
	if err := s.Store.verifyEmailCode(uid, r.FormValue("code")); err != nil {
		redirectWith(w, r, "/verify-email", err.Error(), "err")
		return
	}
	clearPendingEmail(w)
	issueSession(w, r, s.Cfg, uid)
	http.Redirect(w, r, "/dashboard", http.StatusSeeOther)
}

// handleResendCode 重新发送验证码。
func (s *Server) handleResendCode(w http.ResponseWriter, r *http.Request) {
	if ok, wait := s.regLimiter.allow(clientIP(r)); !ok {
		redirectWith(w, r, "/verify-email", fmt.Sprintf("操作过于频繁，请 %d 分钟后再试", int(wait.Minutes())+1), "err")
		return
	}
	uid := readPendingEmail(s.Cfg, r)
	if uid == 0 {
		http.Redirect(w, r, "/register", http.StatusSeeOther)
		return
	}
	u, err := s.Store.UserByID(uid)
	if err != nil {
		http.Redirect(w, r, "/register", http.StatusSeeOther)
		return
	}
	if err := s.sendEmailCode(w, r, u); err != nil {
		redirectWith(w, r, "/verify-email", err.Error(), "err")
		return
	}
	redirectWith(w, r, "/verify-email", "验证码已重新发送", "ok")
}
