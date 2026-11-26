package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// COS 是对象存储的最小客户端：只做商店需要的事——写对象、读对象、删对象。
// 请求按腾讯云 COS 的签名规范（q-sign-algorithm=sha1）逐条计算，不引第三方 SDK。
type COS struct {
	SecretID  string
	SecretKey string
	Bucket    string
	Region    string
	BaseURL   string
	Client    *http.Client
}

// NewCOS 构造客户端。
func NewCOS(c *Config) *COS {
	return &COS{
		SecretID:  c.COSSecretID,
		SecretKey: c.COSSecretKey,
		Bucket:    c.COSBucket,
		Region:    c.COSRegion,
		BaseURL:   c.COSBaseURL,
		Client:    &http.Client{Timeout: 120 * time.Second},
	}
}

func (c *COS) host() string {
	u, err := url.Parse(c.BaseURL)
	if err != nil || u.Host == "" {
		return c.Bucket + ".cos." + c.Region + ".myqcloud.com"
	}
	return u.Host
}

// signing 判断是否走签名模式。SecretKey 为空时退化为匿名请求（桶公有写）。
func (c *COS) signing() bool {
	return strings.TrimSpace(c.SecretKey) != "" && strings.TrimSpace(c.SecretID) != ""
}

// sign 计算 COS 请求签名。query 与 headers 都要求已按 key 升序、值做 URL 编码。
func (c *COS) sign(method, pathname string, query map[string]string, headers map[string]string) (string, string) {
	now := time.Now().Unix()
	keyTime := fmt.Sprintf("%d;%d", now-60, now+uploadTTLSeconds())


	mac := hmac.New(sha1.New, []byte(c.SecretKey))
	mac.Write([]byte(keyTime))
	signKey := hex.EncodeToString(mac.Sum(nil))


	qKeys := sortedKeys(query)
	hKeys := sortedKeys(headers)
	var qParts, hParts, sigParts []string
	for _, k := range qKeys {
		qParts = append(qParts, k+"="+query[k])
		sigParts = append(sigParts, k+"="+query[k])
	}
	for _, k := range hKeys {
		hParts = append(hParts, k+"="+headers[k])
		sigParts = append(sigParts, k+"="+headers[k])
	}


	httpString := method + "\n" + pathname + "\n" + strings.Join(qParts, "&") + "\n" + strings.Join(hParts, "&") + "\n"
	sha := sha1.Sum([]byte(httpString))
	stringToSign := "sha1\n" + keyTime + "\n" + hex.EncodeToString(sha[:]) + "\n"


	sm := hmac.New(sha1.New, []byte(signKey))
	sm.Write([]byte(stringToSign))
	signature := hex.EncodeToString(sm.Sum(nil))


	auth := "q-sign-algorithm=sha1" +
		"&q-ak=" + c.SecretID +
		"&q-sign-time=" + keyTime +
		"&q-key-time=" + keyTime +
		"&q-header-list=" + strings.Join(hKeys, ";") +
		"&q-url-param-list=" + strings.Join(qKeys, ";") +
		"&q-signature=" + signature
	return auth, keyTime
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func uploadTTLSeconds() int64 { return int64(uploadTTL / time.Second) }

// Put 上传对象。key 形如 apps/packages/foo-1.0.0.qxp。
func (c *COS) Put(key string, body io.Reader, size int64, contentType string) error {
	pathname := "/" + strings.TrimPrefix(key, "/")
	headers := map[string]string{"host": c.host()}
	auth, _ := c.sign("put", pathname, map[string]string{}, headers)


	req, err := http.NewRequest(http.MethodPut, c.BaseURL+pathname, body)
	if err != nil {
		return err
	}
	if size > 0 {
		req.ContentLength = size
	}
	if ct := strings.TrimSpace(contentType); ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	if c.signing() {
		req.Header.Set("Authorization", auth)
	}


	resp, err := c.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		hint := ""
		if !c.signing() {
			hint = "（当前为匿名模式：请确认存储桶开放公有写，或配置 COS_SECRET_KEY 走签名）"
		}
		return fmt.Errorf("COS PUT %s 失败：HTTP %d %s%s", key, resp.StatusCode, strings.TrimSpace(string(b)), hint)
	}
	return nil
}

// Delete 删除对象；对象不存在视为成功。
func (c *COS) Delete(key string) error {
	pathname := "/" + strings.TrimPrefix(key, "/")
	headers := map[string]string{"host": c.host()}
	auth, _ := c.sign("delete", pathname, map[string]string{}, headers)


	req, err := http.NewRequest(http.MethodDelete, c.BaseURL+pathname, nil)
	if err != nil {
		return err
	}
	if c.signing() {
		req.Header.Set("Authorization", auth)
	}
	resp, err := c.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 && resp.StatusCode != http.StatusNotFound {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("COS DELETE %s 失败：HTTP %d %s", key, resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return nil
}

// PublicURL 返回对象的对外访问地址。
func (c *COS) PublicURL(key string) string {
	return c.BaseURL + "/" + strings.TrimPrefix(key, "/")
}

// 供模板里显示大小。
func humanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return strconv.FormatInt(n, 10) + " B"
	}
	div, exp := int64(unit), 0
	for n/div >= unit && exp < 3 {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGT"[exp])
}
