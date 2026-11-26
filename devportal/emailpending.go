package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// 注册待验证票据：注册成功后、邮箱验证完成前，用一张短期 Cookie 记住是谁。
const (
	pendingEmailCookie = "qxportal_email"
	pendingEmailTTL    = 30 * time.Minute
)

func pendingEmailToken(cfg *Config, uid int64) string {
	exp := time.Now().Add(pendingEmailTTL).Unix()
	mac := hmac.New(sha256.New, []byte(cfg.SessionKey))
	mac.Write([]byte("email|" + strconv.FormatInt(uid, 10) + "|" + strconv.FormatInt(exp, 10)))
	return strconv.FormatInt(uid, 10) + "." + strconv.FormatInt(exp, 10) + "." + hex.EncodeToString(mac.Sum(nil))
}

func readPendingEmail(cfg *Config, r *http.Request) int64 {
	ck, err := r.Cookie(pendingEmailCookie)
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
	mac.Write([]byte("email|" + parts[0] + "|" + parts[1]))
	if !hmac.Equal([]byte(hex.EncodeToString(mac.Sum(nil))), []byte(parts[2])) {
		return 0
	}
	return uid
}

func setPendingEmail(w http.ResponseWriter, r *http.Request, cfg *Config, uid int64) {
	http.SetCookie(w, &http.Cookie{
		Name: pendingEmailCookie, Value: pendingEmailToken(cfg, uid), Path: "/",
		HttpOnly: true, Secure: isHTTPSRequest(r), SameSite: http.SameSiteLaxMode,
		MaxAge: int(pendingEmailTTL.Seconds()),
	})
}

func clearPendingEmail(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: pendingEmailCookie, Value: "", Path: "/", HttpOnly: true, MaxAge: -1})
}
