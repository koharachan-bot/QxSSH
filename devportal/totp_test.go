package main

import (
	"testing"
)

// RFC 6238 附录 B 的 SHA-1 测试向量，密钥为 ASCII "12345678901234567890"，
// base32 编码是 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ。算法正确性以此为准。
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

func TestTOTPStandardVectors(t *testing.T) {
	cases := []struct {
		step int64
		want string
	}{
		// 标准向量给的是 8 位；取模后与本实现的 6 位一致。
		{59 / 30, "287082"},
		{1111111109 / 30, "081804"},
		{1111111111 / 30, "050471"},
		{1234567890 / 30, "005924"},
		{2000000000 / 30, "279037"},
	}
	for _, c := range cases {
		got, err := totpCode(rfcSecret, c.step)
		if err != nil {
			t.Fatalf("计算失败：%v", err)
		}
		if got != c.want {
			t.Fatalf("step=%d 得到 %s，期望 %s", c.step, got, c.want)
		}
	}
}

func TestTOTPRejectsWrongCode(t *testing.T) {
	if verifyTOTP(rfcSecret, "000000") {
		t.Fatal("不应通过错误的验证码")
	}
	if verifyTOTP(rfcSecret, "abc") {
		t.Fatal("长度不足不应通过")
	}
	if verifyTOTP("not-base32!!!", "123456") {
		t.Fatal("非法密钥不应通过")
	}
}

func TestTOTPURIContainsParams(t *testing.T) {
	u := totpURI("QxSSH", "a@b.c", "ABC234")
	for _, want := range []string{"otpauth://totp/", "secret=ABC234", "issuer=QxSSH", "digits=6", "period=30"} {
		if !contains(u, want) {
			t.Fatalf("URI 缺少 %q：%s", want, u)
		}
	}
}

func TestRecoveryCodesRoundTrip(t *testing.T) {
	plain, hashed, err := newRecoveryCodes()
	if err != nil {
		t.Fatal(err)
	}
	if len(plain) != recoveryCount {
		t.Fatalf("恢复码数量 %d，期望 %d", len(plain), recoveryCount)
	}
	// 每个码只能用一次
	rest, ok := consumeRecoveryCode(hashed, plain[0])
	if !ok {
		t.Fatal("有效恢复码应通过")
	}
	if _, again := consumeRecoveryCode(rest, plain[0]); again {
		t.Fatal("同一恢复码不应重复使用")
	}
	// 大小写与连字符不敏感
	if _, ok2 := consumeRecoveryCode(hashed, stringsUpperNoDash(plain[1])); !ok2 {
		t.Fatal("大写且去连字符的恢复码也应通过")
	}
	// 未知码必须拒绝
	if _, bad := consumeRecoveryCode(hashed, "zzzzz-zzzzz"); bad {
		t.Fatal("未知恢复码不应通过")
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func stringsUpperNoDash(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '-' {
			continue
		}
		if c >= 'a' && c <= 'z' {
			c -= 32
		}
		out = append(out, c)
	}
	return string(out)
}
