// Package main 是 QxSSH 开发者平台的服务端实现。
//
// 它是独立于 QxSSH 主程序的一套 Web 应用：开发者在这里注册账号、提交应用包，
// 管理员审核通过后一键上架，平台把 .qxp 推到对象存储并更新商店索引 index.json。
// 商店本身是纯静态站，客户端只读 index.json，因此平台只需保证发布时索引原子可见。
package main

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config 是进程配置，全部来自环境变量，便于 systemd 管理。
type Config struct {
	// Addr 是监听地址，默认只监听回环，由 nginx 反代对外。
	Addr string
	// DataDir 存放 SQLite 数据库与待发布的应用包。
	DataDir string
	// BaseURL 用于生成邮件/回调里的绝对地址，也作为 Cookie 的作用域参考。
	BaseURL string
	// SessionKey 是签名会话 Cookie 的密钥，未配置时自动生成并落盘。
	SessionKey string
	// AdminEmail 是首个管理员账号，仅在数据库为空时创建。
	AdminEmail string
	AdminPass  string
// COS 对象存储：商店静态资源的存放位置。
	COSSecretID  string
	COSSecretKey string
	COSBucket    string
	COSRegion    string
	COSBaseURL   string
	// PublicBase 是商店对外访问地址，用于在索引里生成绝对下载链接。
	PublicBase string
	// MaxUploadMB 限制单次上传的应用包大小。
	MaxUploadMB int64
	// Registration 控制注册开关：open（默认，带限速）/ closed（只有管理员能开号）。
	Registration string
	// 邮箱验证码发信配置。未配置 SMTP 时注册流程跳过邮箱验证。
	SMTPHost     string
	SMTPPort     int
	SMTPUser     string
	SMTPPass     string
	MailFrom     string
	MailFromName string
	// RequireEmailVerify 强制新注册账号完成邮箱验证后才能登录。
	RequireEmailVerify bool
	// 品牌信息：挑战页与页头展示的名称、Logo、站点域名。
	Brand     string
	BrandLogo string
	SiteURL   string
}

func envStr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// LoadConfig 读取环境变量并做基本校验。
func LoadConfig() (*Config, error) {
	c := &Config{
		Addr:         envStr("PORTAL_ADDR", "127.0.0.1:8080"),
		DataDir:      envStr("PORTAL_DATA", "/opt/qxssh-portal/data"),
		BaseURL:      strings.TrimRight(envStr("PORTAL_BASE_URL", "https://app.meowhead.cn"), "/"),
		SessionKey:   envStr("PORTAL_SESSION_KEY", ""),
		AdminEmail:   envStr("PORTAL_ADMIN_EMAIL", ""),
		AdminPass:    envStr("PORTAL_ADMIN_PASS", ""),
		COSSecretID:  envStr("COS_SECRET_ID", ""),
		COSSecretKey: envStr("COS_SECRET_KEY", ""),
		COSBucket:    envStr("COS_BUCKET", ""),
		COSRegion:    envStr("COS_REGION", "ap-guangzhou"),
		COSBaseURL:   strings.TrimRight(envStr("COS_BASE_URL", ""), "/"),
		PublicBase:   strings.TrimRight(envStr("STORE_PUBLIC_BASE", ""), "/"),
		MaxUploadMB:  50,
		Registration: strings.ToLower(envStr("PORTAL_REGISTRATION", "open")),

		SMTPHost:     envStr("PORTAL_SMTP_HOST", ""),
		SMTPUser:     envStr("PORTAL_SMTP_USER", ""),
		SMTPPass:     envStr("PORTAL_SMTP_PASS", ""),
		MailFrom:     envStr("PORTAL_MAIL_FROM", ""),
		MailFromName: envStr("PORTAL_MAIL_FROM_NAME", "QxSSH 开发者平台"),

		Brand:     envStr("PORTAL_BRAND", "QxSSH"),
		BrandLogo: envStr("PORTAL_BRAND_LOGO", ""),
		SiteURL:   strings.TrimRight(envStr("PORTAL_SITE_URL", ""), "/"),
	}
	if c.Registration != "open" && c.Registration != "closed" {
		return nil, errors.New("PORTAL_REGISTRATION 只能是 open 或 closed")
	}
	if v := envStr("PORTAL_MAX_UPLOAD_MB", ""); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 || n > 500 {
			return nil, errors.New("PORTAL_MAX_UPLOAD_MB 需在 1~500 之间")
		}
		c.MaxUploadMB = n
	}
	if v := envStr("PORTAL_SMTP_PORT", ""); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 || n > 65535 {
			return nil, errors.New("PORTAL_SMTP_PORT 需为 1~65535")
		}
		c.SMTPPort = n
	} else {
		c.SMTPPort = 465
	}
	// 只有同时给了服务器与发件地址才启用邮箱验证，否则不影响注册。
	c.RequireEmailVerify = c.SMTPHost != "" && c.MailFrom != ""
	if !c.RequireEmailVerify && envStr("PORTAL_REQUIRE_EMAIL", "") == "1" {
		return nil, errors.New("PORTAL_REQUIRE_EMAIL=1 需要先配置 PORTAL_SMTP_HOST 与 PORTAL_MAIL_FROM")
	}

	if c.COSBucket == "" {
		return nil, errors.New("缺少 COS_BUCKET")
	}
	// SecretKey 留空表示匿名模式：桶开放公有写时可直接 PUT，无需签名。
	// 生产环境应配置密钥并把桶改回私有写——匿名写意味着任何人都能覆盖商店内容。
	// （两者都不填时由 COS 客户端自动走匿名请求）
	if c.COSBaseURL == "" {
		c.COSBaseURL = "https://" + c.COSBucket + ".cos." + c.COSRegion + ".myqcloud.com"
	}
	if c.PublicBase == "" {
		c.PublicBase = c.COSBaseURL
	}
	return c, nil
}

// uploadTTL 是对象存储预签名上传链接的有效期。
const uploadTTL = 15 * time.Minute
