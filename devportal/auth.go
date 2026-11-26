package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	sessionCookie = "qxportal_sid"
	sessionTTL    = 7 * 24 * time.Hour
)

// hashPassword 生成 bcrypt 哈希。
func hashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// checkPassword 校验明文口令。
func checkPassword(hash, pw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

// randomToken 生成指定字节数的随机串（十六进制）。
func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand 不可用：" + err.Error())
	}
	return hex.EncodeToString(b)
}

// signValue 用会话密钥对用户 ID 与过期时间做 HMAC 签名。
func signValue(key string, uid int64, exp int64) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(strconv.FormatInt(uid, 10) + "|" + strconv.FormatInt(exp, 10)))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// issueSession 写入签名会话 Cookie。
func issueSession(w http.ResponseWriter, c *Config, uid int64) {
	exp := time.Now().Add(sessionTTL).Unix()
	sig := signValue(c.SessionKey, uid, exp)
	val := strconv.FormatInt(uid, 10) + "." + strconv.FormatInt(exp, 10) + "." + sig
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    val,
		Path:     "/",
		HttpOnly: true,
		Secure:   strings.HasPrefix(c.BaseURL, "https://"),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
}

// clearSession 清除会话 Cookie。
func clearSession(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, MaxAge: -1,
	})
}

// currentUID 解析并校验会话，返回用户 ID；无效时返回 0。
func currentUID(r *http.Request, c *Config) int64 {
	ck, err := r.Cookie(sessionCookie)
	if err != nil {
		return 0
	}
	parts := strings.Split(ck.Value, ".")
	if len(parts) != 3 {
		return 0
	}
	uid, err1 := strconv.ParseInt(parts[0], 10, 64)
	exp, err2 := strconv.ParseInt(parts[1], 10, 64)
	if err1 != nil || err2 != nil || time.Now().Unix() > exp {
		return 0
	}
	want := signValue(c.SessionKey, uid, exp)
	if !hmac.Equal([]byte(want), []byte(parts[2])) {
		return 0
	}
	return uid
}
