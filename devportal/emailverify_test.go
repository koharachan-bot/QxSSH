package main

import (
	"path/filepath"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	st, err := OpenStore(filepath.Join(dir, "data"))
	if err != nil {
		t.Fatalf("打开数据库失败：%v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func TestEmailCodeRoundTrip(t *testing.T) {
	st := newTestStore(t)
	u, err := st.CreateUser("a@b.c", "Test123456", "n", "developer")
	if err != nil {
		t.Fatal(err)
	}
	if !u.EmailVerified {
		t.Fatal("新建账号默认应为已验证（迁移兼容），注册流程再显式置 0")
	}
	if err := st.SetEmailVerified(u.ID, false); err != nil {
		t.Fatal(err)
	}
	code, _ := newEmailCode()
	if err := st.setEmailCode(u.ID, code, time.Now().Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	// 错误验证码失败并累计次数
	if err := st.verifyEmailCode(u.ID, "000000"); err == nil {
		t.Fatal("错误验证码不应通过")
	}
	// 正确验证码通过
	if err := st.verifyEmailCode(u.ID, code); err != nil {
		t.Fatalf("正确验证码应通过：%v", err)
	}
	// 再次读取应为已验证
	u2, _ := st.UserByID(u.ID)
	if !u2.EmailVerified {
		t.Fatal("验证后应为已验证状态")
	}
}

func TestEmailCodeExpires(t *testing.T) {
	st := newTestStore(t)
	u, _ := st.CreateUser("x@y.z", "Test123456", "", "developer")
	if err := st.setEmailCode(u.ID, "123456", time.Now().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := st.verifyEmailCode(u.ID, "123456"); err == nil {
		t.Fatal("过期验证码不应通过")
	}
}

func TestEmailCodeMaxTries(t *testing.T) {
	st := newTestStore(t)
	u, _ := st.CreateUser("m@n.o", "Test123456", "", "developer")
	if err := st.setEmailCode(u.ID, "654321", time.Now().Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < emailCodeMaxTry; i++ {
		_ = st.verifyEmailCode(u.ID, "111111")
	}
	if err := st.verifyEmailCode(u.ID, "654321"); err == nil {
		t.Fatal("超过最大尝试次数后即使验证码正确也不应通过")
	}
}
