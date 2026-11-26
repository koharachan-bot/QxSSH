package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// DoH 兜底解析。
//
// 用户的机器上系统 DNS 可能因为 hosts 污染、运营商劫持、公司 DNS 策略等原因
// 解析不了商店域名，而浏览器往往自带 DoH 所以能打开。把「请你自己去浏览器确认」
// 丢给用户不是解法——这里在系统解析失败时自动改用 DoH，流程对用户完全透明。
//
// 只用 IP 形式的 DoH 端点：用域名端点会陷入"要解析 DoH 域名先得能解析域名"的死循环。
var dohEndpoints = []struct {
	url  string
	host string
}{
	{"https://223.5.5.5/resolve", "dns.alidns.com"},   // 阿里（国内快）
	{"https://120.53.53.53/resolve", "doh.pub"},        // 腾讯
	{"https://1.1.1.1/dns-query", "cloudflare-dns.com"}, // Cloudflare
}

// dohCache 缓存解析结果，避免每次请求都打 DNS。
var dohCache = struct {
	sync.Mutex
	m map[string]dohEntry
}{m: map[string]dohEntry{}}

type dohEntry struct {
	ips []string
	exp time.Time
}

const dohCacheTTL = 5 * time.Minute

// dohHTTPClient 用于向 DoH 端点发起查询。它不能再依赖系统 DNS，
// 但端点本身是 IP，所以直连即可。
var dohHTTPClient = &http.Client{Timeout: 6 * time.Second}

// resolveViaDoH 用 DoH 解析 A 记录（带缓存）。
func resolveViaDoH(ctx context.Context, host string) ([]string, error) {
	host = strings.TrimSpace(strings.ToLower(host))
	if host == "" {
		return nil, errors.New("空主机名")
	}
	// 已经是 IP 就不用解析
	if ip := net.ParseIP(host); ip != nil {
		return []string{host}, nil
	}

	dohCache.Lock()
	if e, ok := dohCache.m[host]; ok && time.Now().Before(e.exp) {
		ips := e.ips
		dohCache.Unlock()
		return ips, nil
	}
	dohCache.Unlock()

	var lastErr error
	for _, ep := range dohEndpoints {
		ips, err := queryDoH(ctx, ep.url, ep.host, host)
		if err == nil && len(ips) > 0 {
			dohCache.Lock()
			dohCache.m[host] = dohEntry{ips: ips, exp: time.Now().Add(dohCacheTTL)}
			dohCache.Unlock()
			return ips, nil
		}
		if err != nil {
			lastErr = err
		}
	}
	if lastErr == nil {
		lastErr = errors.New("DoH 未返回可用地址")
	}
	return nil, lastErr
}

// queryDoH 向单个端点查 A 记录，兼容 RFC 8484 的 JSON 形式与常见厂商的 resolve 接口。
func queryDoH(ctx context.Context, endpoint, sni, host string) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		endpoint+"?name="+host+"&type=A", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/dns-json")
	if sni != "" {
		req.Host = sni
	}
	resp, err := dohHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("DoH 端点返回 HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Status int `json:"Status"`
		Answer []struct {
			Type int    `json:"type"`
			Data string `json:"data"`
		} `json:"Answer"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("DoH 响应解析失败：%w", err)
	}
	var out []string
	for _, a := range parsed.Answer {
		if a.Type != 1 {
			continue
		}
		if ip := net.ParseIP(strings.TrimSpace(a.Data)); ip != nil && ip.To4() != nil {
			out = append(out, ip.String())
		}
	}
	return out, nil
}

// dialWithDoH 返回优先走系统解析、失败自动回落 DoH 的拨号函数。
//
// 只有建连阶段换成 IP，TLS 的 SNI 与 Host 头仍然是原始域名，
// 所以证书校验与虚拟主机路由都不受影响。
func dialWithDoH(dialer *net.Dialer) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := dialer.DialContext(ctx, network, addr)
		if err == nil {
			return conn, nil
		}
		host, port, splitErr := net.SplitHostPort(addr)
		if splitErr != nil {
			return nil, err
		}
		if ip := net.ParseIP(host); ip != nil {
			return nil, err
		}
		ips, dohErr := resolveViaDoH(ctx, host)
		if dohErr != nil || len(ips) == 0 {
			return nil, fmt.Errorf("系统 DNS 解析 %s 失败（%v），DoH 兜底也失败（%v）", host, err, dohErr)
		}
		for _, ip := range ips {
			c, e := dialer.DialContext(ctx, network, net.JoinHostPort(ip, port))
			if e == nil {
				return c, nil
			}
		}
		return nil, fmt.Errorf("系统 DNS 与 DoH 均无法连接 %s", host)
	}
}
