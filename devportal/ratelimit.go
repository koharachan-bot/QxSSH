package main

import (
	"net/http"
	"strings"
	"sync"
	"time"
)

// 限速器：开发者平台对外公开，注册与登录必须防脚本刷。
//
// 采用固定窗口计数（内存态、单机）。平台是单实例部署，不需要分布式限速；
// 重启会清空计数，对刷站者来说重启不是他们能触发的，所以这点损失可以接受。
type rateLimiter struct {
	mu      sync.Mutex
	hits    map[string]*bucket
	window  time.Duration
	limit   int
	lastGC  time.Time
}

type bucket struct {
	count int
	start time.Time
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{hits: map[string]*bucket{}, window: window, limit: limit, lastGC: time.Now()}
}

// allow 记一次访问并判断是否仍在额度内。
func (l *rateLimiter) allow(key string) (ok bool, retryAfter time.Duration) {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	// 顺带清理过期桶，避免长期运行后 map 只增不减。
	if now.Sub(l.lastGC) > 10*time.Minute {
		for k, b := range l.hits {
			if now.Sub(b.start) > l.window {
				delete(l.hits, k)
			}
		}
		l.lastGC = now
	}

	b, exists := l.hits[key]
	if !exists || now.Sub(b.start) >= l.window {
		l.hits[key] = &bucket{count: 1, start: now}
		return true, 0
	}
	if b.count >= l.limit {
		return false, l.window - now.Sub(b.start)
	}
	b.count++
	return true, 0
}

// reset 在成功后清零，避免正常用户被历史失败次数拖累。
func (l *rateLimiter) reset(key string) {
	l.mu.Lock()
	delete(l.hits, key)
	l.mu.Unlock()
}

// clientIP 取真实来源 IP：平台在 nginx 之后，优先读 X-Real-IP / X-Forwarded-For。
func clientIP(r *http.Request) string {
	if v := strings.TrimSpace(r.Header.Get("X-Real-IP")); v != "" {
		return v
	}
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	if i := strings.LastIndexByte(r.RemoteAddr, ':'); i > 0 {
		return r.RemoteAddr[:i]
	}
	return r.RemoteAddr
}
