package main

import (
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"net"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

func base64Std(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

// Mailer 通过 SMTP 发送验证码邮件。
//
// 配置全走环境变量，凭据不落仓库。支持两种常见部署：465 隐式 TLS 与 587 STARTTLS。
type Mailer struct {
	Host     string
	Port     int
	User     string
	Pass     string
	From     string
	FromName string
	Enabled  bool
}

func newMailer(c *Config) *Mailer {
	m := &Mailer{
		Host:     c.SMTPHost,
		Port:     c.SMTPPort,
		User:     c.SMTPUser,
		Pass:     c.SMTPPass,
		From:     c.MailFrom,
		FromName: c.MailFromName,
	}
	m.Enabled = m.Host != "" && m.From != ""
	return m
}

// Send 发送一封纯文本邮件。
func (m *Mailer) Send(to, subject, body string) error {
	if !m.Enabled {
		return fmt.Errorf("邮件服务未配置")
	}
	if m.Port == 0 {
		m.Port = 465
	}
	addr := net.JoinHostPort(m.Host, strconv.Itoa(m.Port))

	// 头部统一用 CRLF；主题做 RFC 2047 编码，避免中文乱码。
	var b strings.Builder
	b.WriteString("From: " + formatAddress(m.FromName, m.From) + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + encodeHeader(subject) + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	b.WriteString("Date: " + time.Now().Format(time.RFC1123Z) + "\r\n")
	b.WriteString("\r\n")
	b.WriteString(body)
	msg := []byte(b.String())

	var auth smtp.Auth
	if m.User != "" {
		auth = smtp.PlainAuth("", m.User, m.Pass, m.Host)
	}

	// 465 走隐式 TLS；其他端口按 STARTTLS 处理。
	if m.Port == 465 {
		conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: m.Host, MinVersion: tls.VersionTLS12})
		if err != nil {
			return fmt.Errorf("连接邮件服务器失败：%w", err)
		}
		defer conn.Close()
		c, err := smtp.NewClient(conn, m.Host)
		if err != nil {
			return err
		}
		defer c.Close()
		if auth != nil {
			if err := c.Auth(auth); err != nil {
				return fmt.Errorf("邮件服务器认证失败：%w", err)
			}
		}
		if err := c.Mail(m.From); err != nil {
			return err
		}
		if err := c.Rcpt(to); err != nil {
			return err
		}
		w, err := c.Data()
		if err != nil {
			return err
		}
		if _, err := w.Write(msg); err != nil {
			return err
		}
		if err := w.Close(); err != nil {
			return err
		}
		return c.Quit()
	}

	c, err := smtp.Dial(addr)
	if err != nil {
		return fmt.Errorf("连接邮件服务器失败：%w", err)
	}
	defer c.Close()
	if ok, _ := c.Extension("STARTTLS"); ok {
		if err := c.StartTLS(&tls.Config{ServerName: m.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return err
		}
	}
	if auth != nil {
		if err := c.Auth(auth); err != nil {
			return fmt.Errorf("邮件服务器认证失败：%w", err)
		}
	}
	if err := c.Mail(m.From); err != nil {
		return err
	}
	if err := c.Rcpt(to); err != nil {
		return err
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(msg); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}

func formatAddress(name, addr string) string {
	if strings.TrimSpace(name) == "" {
		return "<" + addr + ">"
	}
	return encodeHeader(name) + " <" + addr + ">"
}

// encodeHeader 对含非 ASCII 的头部做 RFC 2047 Base64 编码。
func encodeHeader(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] > 127 {
			ascii = false
			break
		}
	}
	if ascii {
		return s
	}
	return "=?UTF-8?B?" + base64Std(s) + "?="
}
