package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// 登录第二步与账号安全设置（TOTP 双因素）。
const (
	pendingCookie = "qxportal_2fa"
	pendingTTL    = 5 * time.Minute
)

func pendingToken(cfg *Config, uid int64) string {
	exp := time.Now().Add(pendingTTL).Unix()
	mac := hmac.New(sha256.New, []byte(cfg.SessionKey))
	mac.Write([]byte("2fa|" + strconv.FormatInt(uid, 10) + "|" + strconv.FormatInt(exp, 10)))
	return strconv.FormatInt(uid, 10) + "." + strconv.FormatInt(exp, 10) + "." + hex.EncodeToString(mac.Sum(nil))
}

func readPending(cfg *Config, r *http.Request) int64 {
	ck, err := r.Cookie(pendingCookie)
	if err != nil || ck == nil {
		return 0
	}
	parts := strings.Split(ck.Value, ".")
	if len(parts) != 3 {
		return 0
	}
	uid, e1 := strconv.ParseInt(parts[0], 10, 64)
	exp, e2 := strconv.ParseInt(parts[1], 10, 64)
	if e1 != nil || e2 != nil || time.Now().Unix() > exp {
		return 0
	}
	mac := hmac.New(sha256.New, []byte(cfg.SessionKey))
	mac.Write([]byte("2fa|" + parts[0] + "|" + parts[1]))
	if !hmac.Equal([]byte(hex.EncodeToString(mac.Sum(nil))), []byte(parts[2])) {
		return 0
	}
	return uid
}

func setPending(w http.ResponseWriter, r *http.Request, cfg *Config, uid int64) {
	http.SetCookie(w, &http.Cookie{
		Name: pendingCookie, Value: pendingToken(cfg, uid), Path: "/",
		HttpOnly: true, Secure: isHTTPSRequest(r), SameSite: http.SameSiteLaxMode,
		MaxAge: int(pendingTTL.Seconds()),
	})
}

func clearPending(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: pendingCookie, Value: "", Path: "/", HttpOnly: true, MaxAge: -1})
}

// handleTOTPPage 显示第二步验证页。
func (s *Server) handleTOTPPage(w http.ResponseWriter, r *http.Request) {
	if readPending(s.Cfg, r) == 0 {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	s.render(w, r, "totp.html", pageData{
		Title: "两步验证",
		Error: r.URL.Query().Get("err"),
		Flash: r.URL.Query().Get("ok"),
	})
}

// handleTOTPVerify 校验验证码或恢复码，通过后签发正式会话。
func (s *Server) handleTOTPVerify(w http.ResponseWriter, r *http.Request) {
	if ok, wait := s.loginLimiter.allow(clientIP(r)); !ok {
		redirectWith(w, r, "/login/2fa", fmt.Sprintf("尝试过于频繁，请 %d 秒后再试", int(wait.Seconds())+1), "err")
		return
	}
	uid := readPending(s.Cfg, r)
	if uid == 0 {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	u, err := s.Store.UserByID(uid)
	if err != nil || !u.TOTPEnabled {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}

	code := strings.TrimSpace(r.FormValue("code"))
	recovery := strings.TrimSpace(r.FormValue("recovery"))

	if recovery != "" {
		rest, ok := consumeRecoveryCode(u.RecoveryHashes, recovery)
		if !ok {
			redirectWith(w, r, "/login/2fa", "恢复码无效或已使用", "err")
			return
		}
		if err := s.Store.SetTOTP(u.ID, u.TOTPSecret, true, rest); err != nil {
			redirectWith(w, r, "/login/2fa", "保存恢复码状态失败", "err")
			return
		}
	} else if !verifyTOTP(u.TOTPSecret, code) {
		redirectWith(w, r, "/login/2fa", "验证码不正确", "err")
		return
	}

	clearPending(w)
	s.loginLimiter.reset(clientIP(r))
	issueSession(w, r, s.Cfg, u.ID)
	http.Redirect(w, r, "/dashboard", http.StatusSeeOther)
}

// handleAccount 账号安全页。
func (s *Server) handleAccount(w http.ResponseWriter, r *http.Request) {
	u := s.userOf(r)
	s.render(w, r, "account.html", pageData{
		Title: "账号安全",
		Flash: r.URL.Query().Get("ok"),
		Error: r.URL.Query().Get("err"),
		Data:  u,
	})
}

// handleTOTPSetup 生成待绑定的密钥并展示。
func (s *Server) handleTOTPSetup(w http.ResponseWriter, r *http.Request) {
	u := s.userOf(r)
	if u.TOTPEnabled {
		redirectWith(w, r, "/account", "两步验证已启用", "err")
		return
	}
	secret := r.FormValue("secret")
	if secret == "" {
		var err error
		secret, err = newTOTPSecret()
		if err != nil {
			redirectWith(w, r, "/account", "生成密钥失败", "err")
			return
		}
	}
	s.render(w, r, "totp_setup.html", pageData{
		Title: "启用两步验证",
		Error: r.URL.Query().Get("err"),
		Data: map[string]string{
			"Secret": secret,
			"URI":    totpURI("QxSSH", u.Email, secret),
		},
	})
}

// handleTOTPEnable 校验一次验证码后正式启用，并展示恢复码。
func (s *Server) handleTOTPEnable(w http.ResponseWriter, r *http.Request) {
	u := s.userOf(r)
	secret := strings.TrimSpace(r.FormValue("secret"))
	code := strings.TrimSpace(r.FormValue("code"))
	if secret == "" || code == "" {
		redirectWith(w, r, "/account/2fa/setup", "请先扫码并输入验证码", "err")
		return
	}
	if !verifyTOTP(secret, code) {
		redirectWith(w, r, "/account/2fa/setup", "验证码不正确，请确认手机时间准确", "err")
		return
	}
	plain, hashed, err := newRecoveryCodes()
	if err != nil {
		redirectWith(w, r, "/account/2fa/setup", "生成恢复码失败", "err")
		return
	}
	if err := s.Store.SetTOTP(u.ID, secret, true, hashed); err != nil {
		redirectWith(w, r, "/account/2fa/setup", "保存失败", "err")
		return
	}
	s.render(w, r, "totp_codes.html", pageData{Title: "保存恢复码", Data: plain})
}

// handleTOTPDisable 关闭两步验证，要求当前验证码或口令以确认身份。
func (s *Server) handleTOTPDisable(w http.ResponseWriter, r *http.Request) {
	u := s.userOf(r)
	if !u.TOTPEnabled {
		redirectWith(w, r, "/account", "两步验证未启用", "err")
		return
	}
	code := strings.TrimSpace(r.FormValue("code"))
	pass := r.FormValue("password")
	ok := verifyTOTP(u.TOTPSecret, code)
	if !ok && pass != "" {
		ok = checkPassword(u.PassHash, pass)
	}
	if !ok {
		redirectWith(w, r, "/account", "验证码或口令不正确", "err")
		return
	}
	if err := s.Store.SetTOTP(u.ID, "", false, ""); err != nil {
		redirectWith(w, r, "/account", "关闭失败", "err")
		return
	}
	redirectWith(w, r, "/account", "两步验证已关闭", "ok")
}
