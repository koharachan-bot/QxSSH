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
func (p *Publisher) PublishAll() (int, error) {
	apps, err := p.Store.PublishedApps()
	if err != nil {
		return 0, err
	}

	entries := make([]storeEntry, 0, len(apps))
	for _, a := range apps {
		if strings.TrimSpace(a.PackagePath) == "" {
			return 0, fmt.Errorf("应用「%s」没有可发布的包文件", a.AppID)
		}
		data, err := os.ReadFile(a.PackagePath)
		if err != nil {
			return 0, fmt.Errorf("读取 %s 的包失败：%w", a.AppID, err)
		}
		parsed, err := parsePackage(data)
		if err != nil {
			return 0, fmt.Errorf("应用「%s」的包校验失败：%w", a.AppID, err)
		}

		pkgKey := keyPkgDir + a.AppID + "-" + a.Version + ".qxp"
		if err := p.COS.Put(pkgKey, bytes.NewReader(data), int64(len(data)), "application/octet-stream"); err != nil {
			return 0, err
		}

		// 图标从包里取，保证索引指向的图标与包内一致。
		iconKey := ""
		if light, _ := parsed.Manifest.iconNames(); light != "" {
			if blob, ok := parsed.Files[strings.TrimPrefix(strings.ReplaceAll(light, "\\", "/"), "./")]; ok {
				ext := strings.ToLower(path.Ext(light))
				iconKey = keyIconDir + a.AppID + ext
				if err := p.COS.Put(iconKey, bytes.NewReader(blob), int64(len(blob)), iconContentType(ext)); err != nil {
					return 0, err
				}
			}
		}

		e := storeEntry{
			ID:          a.AppID,
			Name:        a.Name,
			Version:     a.Version,
			Description: a.Summary,
			Author:      a.Author,
			Category:    a.Category,
			File:        p.publicURL(pkgKey),
			Size:        int64(len(data)),
			SHA256:      parsed.SHA256,
			Runtime:     parsed.Manifest.Runtime,
			Keywords:    parsed.Manifest.Keywords,
		}
		if e.Description == "" {
			e.Description = parsed.Manifest.Description
		}
		if iconKey != "" {
			e.Icon = p.publicURL(iconKey)
		}
		entries = append(entries, e)
	}

	sortEntries(entries)
	idx := storeIndex{
		Schema:  1,
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

// Unpublish 从商店移除一个对象（下架应用时调用）。
func (p *Publisher) Unpublish(appID, version string) error {
	if appID == "" {
		return nil
	}
	if version != "" {
		if err := p.COS.Delete(keyPkgDir + appID + "-" + version + ".qxp"); err != nil {
			return err
		}
	}
	return nil
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
