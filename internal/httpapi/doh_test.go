package httpapi

import (
	"context"
	"testing"
	"time"
)

// 验证 DoH 兜底能在系统 DNS 之外独立解析出商店域名。
// 该用例需要联网；离线环境下会跳过而不是失败。
func TestResolveViaDoH(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	ips, err := resolveViaDoH(ctx, "cos.meowhead.cn")
	if err != nil {
		t.Skipf("DoH 解析不可用（可能离线）：%v", err)
	}
	if len(ips) == 0 {
		t.Fatal("DoH 返回空地址列表")
	}
	for _, ip := range ips {
		t.Logf("解析到 %s", ip)
	}
}

// DoH 结果应带缓存：第二次调用不应再打网络（用极短超时验证）。
func TestResolveViaDoHCache(t *testing.T) {
	ctx1, c1 := context.WithTimeout(context.Background(), 20*time.Second)
	defer c1()
	if _, err := resolveViaDoH(ctx1, "cos.meowhead.cn"); err != nil {
		t.Skipf("首次解析失败，跳过缓存用例：%v", err)
	}

	ctx2, c2 := context.WithTimeout(context.Background(), time.Millisecond)
	defer c2()
	ips, err := resolveViaDoH(ctx2, "cos.meowhead.cn")
	if err != nil || len(ips) == 0 {
		t.Fatalf("缓存未命中（1ms 超时下应直接返回缓存）：%v", err)
	}
}
