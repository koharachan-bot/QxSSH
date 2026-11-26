package main

import (
	"bytes"
	"fmt"
	"os"
	"path"
	"strings"
	"time"
)

// Publisher 负责把已上架的应用推到对象存储，并重写商店索引。
type Publisher struct {
	Store *Store
	COS   *COS
	Cfg   *Config
}

// 商店里各类对象的前缀，与 QxSSH 客户端 store 应用约定的路径一致。
const (
	keyIndex   = "index.json"
	keyPkgDir  = "apps/packages/"
	keyIconDir = "apps/icons/"
)

// PublishAll 重新发布整个商店：先传所有包与图标，最后写索引。
//
// 顺序很重要：索引一旦更新，客户端就会去下载它指向的包；若先写索引再传包，
// 中间会存在客户端拿到 404 的窗口。因此索引永远最后写。
//
// 同一应用的全部历史版本都会上传并在索引里各占一条，最新版带 latest 标记。
// 客户端据此判断"有没有新版本"，用户也能指定安装旧版本实现降级。
func (p *Publisher) PublishAll() (int, error) {
	apps, err := p.Store.PublishedApps()
	if err != nil {
		return 0, err
	}
	allReleases, err := p.Store.AllReleases()
	if err != nil {
		return 0, err
	}

	entries := make([]storeEntry, 0, len(apps))
	for _, a := range apps {
		releases := allReleases[a.AppID]
		if len(releases) == 0 {
			// 兼容早期数据：老应用可能没有 releases 记录，用当前包补一条。
			if strings.TrimSpace(a.PackagePath) == "" {
				return 0, fmt.Errorf("应用「%s」没有可发布的包文件", a.AppID)
			}
			releases = []Release{{
				AppID: a.AppID, Version: a.Version, PackagePath: a.PackagePath,
				PackageSize: a.PackageSize, PackageSHA: a.PackageSHA,
			}}
		}

		latest, _ := LatestOf(releases)
		// 图标取最新版本包里的，保证索引指向的图与最新版一致。
		iconKey := ""
		if blob, ext, ok := extractIcon(latest.PackagePath); ok {
			iconKey = keyIconDir + a.AppID + ext
			if err := p.COS.Put(iconKey, bytes.NewReader(blob), int64(len(blob)), iconContentType(ext)); err != nil {
				return 0, err
			}
		}

		for _, rel := range releases {
			data, err := os.ReadFile(rel.PackagePath)
			if err != nil {
				return 0, fmt.Errorf("读取 %s@%s 的包失败：%w", rel.AppID, rel.Version, err)
			}
			parsed, err := parsePackage(data)
			if err != nil {
				return 0, fmt.Errorf("应用「%s」的包校验失败：%w", rel.AppID, err)
			}

			pkgKey := keyPkgDir + a.AppID + "-" + rel.Version + ".qxp"
			if err := p.COS.Put(pkgKey, bytes.NewReader(data), int64(len(data)), "application/octet-stream"); err != nil {
				return 0, err
			}

			e := storeEntry{
				ID:          a.AppID,
				Name:        a.Name,
				Version:     rel.Version,
				Description: a.Summary,
				Author:      a.Author,
				Category:    a.Category,
				File:        p.publicURL(pkgKey),
				Size:        int64(len(data)),
				SHA256:      parsed.SHA256,
				Runtime:     parsed.Manifest.Runtime,
				Keywords:    parsed.Manifest.Keywords,
				Changelog:   rel.Changelog,
				Released:    time.Unix(rel.CreatedAt, 0).Format("2006-01-02"),
				Latest:      rel.Version == latest.Version,
			}
			if e.Description == "" {
				e.Description = parsed.Manifest.Description
			}
			if iconKey != "" {
				e.Icon = p.publicURL(iconKey)
			}
			entries = append(entries, e)
		}
	}

	sortEntries(entries)
	idx := storeIndex{
		Schema:  2,
		Name:    "QxSSH 应用商店",
		Updated: time.Now().Format("2006-01-02"),
		Apps:    entries,
	}
	body, err := jsonMarshalIndent(idx)
	if err != nil {
		return 0, err
	}
	if err := p.COS.Put(keyIndex, bytes.NewReader(body), int64(len(body)), "application/json; charset=utf-8"); err != nil {
		return 0, err
	}
	return len(entries), nil
}

// extractIcon 从 .qxp 里取出图标文件内容与扩展名。
func extractIcon(pkgPath string) ([]byte, string, bool) {
	if strings.TrimSpace(pkgPath) == "" {
		return nil, "", false
	}
	data, err := os.ReadFile(pkgPath)
	if err != nil {
		return nil, "", false
	}
	parsed, err := parsePackage(data)
	if err != nil {
		return nil, "", false
	}
	light, _ := parsed.Manifest.iconNames()
	if light == "" {
		return nil, "", false
	}
	key := strings.TrimPrefix(strings.ReplaceAll(light, "\\", "/"), "./")
	blob, ok := parsed.Files[key]
	if !ok {
		return nil, "", false
	}
	return blob, strings.ToLower(path.Ext(light)), true
}

// publicURL 生成对象的对外地址：优先用配置的商店公开域名。
func (p *Publisher) publicURL(key string) string {
	base := strings.TrimRight(p.Cfg.PublicBase, "/")
	if base == "" {
		base = strings.TrimRight(p.Cfg.COSBaseURL, "/")
	}
	return base + "/" + strings.TrimPrefix(key, "/")
}

func iconContentType(ext string) string {
	switch strings.ToLower(ext) {
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	default:
		return "application/octet-stream"
	}
}
