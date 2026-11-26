package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// TOTP 双因素认证（Google Authenticator / Microsoft Authenticator 等通用）。
//
// 实现按 RFC 6238：HMAC-SHA1、30 秒步长、6 位数字，允许前后各一个步长的时钟漂移。
// 恢复码用于手机丢失时登录，一次性使用，只存哈希。
const (
	totpDigits = 6
	totpPeriod = 30
	// totpSkew 允许前后各 1 个时间窗，容忍客户端与服务器的时钟差。
	totpSkew = 1
	// 恢复码数量与长度。
	recoveryCount  = 10
	recoveryLength = 10
)

// newTOTPSecret 生成 base32 密钥（20 字节，160 bit，符合 Google 建议）。
func newTOTPSecret() (string, error) {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b), nil
}

// totpCode 计算指定时间步的验证码。
func totpCode(secret string, step int64) (string, error) {
	norm := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(secret), " ", ""))
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(norm)
	if err != nil {
		return "", fmt.Errorf("密钥格式无效")
	}
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(step))
	mac := hmac.New(sha1.New, key)
	mac.Write(buf[:])
	sum := mac.Sum(nil)
	// 动态截断（RFC 4226 第 5.4 节）。
	offset := sum[len(sum)-1] & 0x0f
	code := (uint32(sum[offset]&0x7f) << 24) |
		(uint32(sum[offset+1]) << 16) |
		(uint32(sum[offset+2]) << 8) |
		uint32(sum[offset+3])
	return fmt.Sprintf("%0*d", totpDigits, code%1000000), nil
}

// verifyTOTP 校验用户输入的验证码，允许时钟漂移。
func verifyTOTP(secret, input string) bool {
	input = strings.TrimSpace(input)
	if len(input) != totpDigits {
		return false
	}
	now := time.Now().Unix() / totpPeriod
	for d := int64(-totpSkew); d <= totpSkew; d++ {
		want, err := totpCode(secret, now+d)
		if err != nil {
			return false
		}
		// 定长比较，避免时序侧信道。
		if subtle.ConstantTimeCompare([]byte(want), []byte(input)) == 1 {
			return true
		}
	}
	return false
}

// totpURI 生成 otpauth:// 链接，供二维码或手动录入使用。
func totpURI(issuer, account, secret string) string {
	label := url.PathEscape(issuer + ":" + account)
	q := url.Values{}
	q.Set("secret", secret)
	q.Set("issuer", issuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprint(totpDigits))
	q.Set("period", fmt.Sprint(totpPeriod))
	return "otpauth://totp/" + label + "?" + q.Encode()
}

// newRecoveryCodes 生成一批恢复码，返回明文与对应的哈希串。
//
// 明文只在生成时展示一次；库里只留 SHA-256 哈希（恢复码本身是高熵随机串，
// 不需要 bcrypt 那样的慢哈希）。
func newRecoveryCodes() (plain []string, hashed string, err error) {
	const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"
	parts := make([]string, 0, recoveryCount)
	hashes := make([]string, 0, recoveryCount)
	for i := 0; i < recoveryCount; i++ {
		buf := make([]byte, recoveryLength)
		if _, err := rand.Read(buf); err != nil {
			return nil, "", err
		}
		var sb strings.Builder
		for j, b := range buf {
			if j > 0 && j%5 == 0 {
				sb.WriteByte('-')
			}
			sb.WriteByte(alphabet[int(b)%len(alphabet)])
		}
		code := sb.String()
		parts = append(parts, code)
		hashes = append(hashes, hashRecoveryCode(code))
	}
	return parts, strings.Join(hashes, ","), nil
}

func hashRecoveryCode(code string) string {
	norm := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(code), "-", ""))
	sum := sha256.Sum256([]byte(norm))
	return hex.EncodeToString(sum[:])
}

// consumeRecoveryCode 校验并移除一个恢复码，返回剩余哈希串。
func consumeRecoveryCode(stored, input string) (rest string, ok bool) {
	if strings.TrimSpace(stored) == "" || strings.TrimSpace(input) == "" {
		return stored, false
}
	want := hashRecoveryCode(input)
	keep := make([]string, 0, recoveryCount)
	hit := false
	for _, h := range strings.Split(stored, ",") {
		h = strings.TrimSpace(h)
		if h == "" {
			continue
		}
		if !hit && subtle.ConstantTimeCompare([]byte(h), []byte(want)) == 1 {
			hit = true
			continue // 用过即作废
		}
		keep = append(keep, h)
	}
	return strings.Join(keep, ","), hit
}
