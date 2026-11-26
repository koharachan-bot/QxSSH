package console

import "testing"

func TestIsLoopbackListen(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1:8800":   true,
		"localhost:8800":   true,
		"[::1]:8800":       true,
		"192.168.1.2:8800": false,
		"0.0.0.0:8800":     false,
		":8800":            false,
		"example.com:80":   false,
	}
	for addr, want := range cases {
		if got := isLoopbackListen(addr); got != want {
			t.Errorf("isLoopbackListen(%q) = %v, want %v", addr, got, want)
		}
	}
}

func TestPrepareWebAllowsLoopbackWithoutToken(t *testing.T) {
	cfg, err := PrepareWeb("127.0.0.1:8800", "", "", "")
	if err != nil {
		t.Fatalf("回环地址无需令牌，却被拒绝: %v", err)
	}
	if cfg != nil {
		t.Fatal("未提供证书时不应返回 TLS 配置")
	}
}

func TestPrepareWebRejectsNonLoopbackWithoutToken(t *testing.T) {
	if _, err := PrepareWeb("0.0.0.0:8800", "", "", ""); err == nil {
		t.Fatal("非回环地址未配置令牌时应拒绝启动")
	}
}

func TestPrepareWebRequiresCertPair(t *testing.T) {
	if _, err := PrepareWeb("127.0.0.1:8800", "cert.pem", "", ""); err == nil {
		t.Fatal("只提供证书、未提供私钥时应拒绝启动")
	}
	if _, err := PrepareWeb("127.0.0.1:8800", "", "key.pem", ""); err == nil {
		t.Fatal("只提供私钥、未提供证书时应拒绝启动")
	}
}
