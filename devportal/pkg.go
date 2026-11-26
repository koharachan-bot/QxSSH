package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
)

var appIDRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9\-_]{0,63}$`)

// 应用包的大小上限与包内文件数上限，与 QxSSH 安装端的限制保持一致。
const (
	maxPackageFiles = 500
	maxPackageEntry = 50 << 20
)

// pkgManifest 是从 .qxp 中解析出的清单字段（只取平台需要展示与索引的部分）。
type pkgManifest struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Version     string          `json:"version"`
	Description string          `json:"description"`
	Author      string          `json:"author"`
	Category    string          `json:"category"`
	Icon        json.RawMessage `json:"icon"`
	Keywords    []string        `json:"keywords"`
	Runtime     string          `json:"runtime"`
	Entry       string          `json:"entry"`
	SystemApp   bool            `json:"systemApp"`
}

// iconNames 归一清单里的 icon 写法，返回亮/暗两个文件名。
func (m pkgManifest) iconNames() (string, string) {
	raw := bytes.TrimSpace(m.Icon)
	if len(raw) == 0 || string(raw) == "null" {
		return "", ""
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return strings.TrimSpace(s), ""
		}
		return "", ""
	}
	var obj struct {
		Light string `json:"light"`
		Dark  string `json:"dark"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		return strings.TrimSpace(obj.Light), strings.TrimSpace(obj.Dark)
	}
	return "", ""
}

// parsedPackage 是校验通过的包内容摘要。
type parsedPackage struct {
	Manifest pkgManifest
	Files    map[string][]byte
	Size     int64
	SHA256   string
}

// parsePackage 校验并解析 .qxp：必须是 zip、有合法 manifest、id 合规、不含系统内置声明。
// 规则与 QxSSH 安装端一致，避免平台放行客户端装不上的包。
func parsePackage(data []byte) (*parsedPackage, error) {
	if len(data) == 0 {
		return nil, errors.New("包内容为空")
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, errors.New("不是有效的 zip 文件（.qxp 应为 zip 格式）")
	}
	if len(zr.File) > maxPackageFiles {
		return nil, fmt.Errorf("包内文件过多（上限 %d）", maxPackageFiles)
	}

	files := make(map[string][]byte, len(zr.File))
	var total int64
	for _, f := range zr.File {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		name = strings.TrimPrefix(name, "./")
		if f.FileInfo().IsDir() {
			continue
		}
		if strings.HasPrefix(name, "/") || strings.Contains(name, "..") || name == "" {
			return nil, fmt.Errorf("包内含非法路径：%q", f.Name)
		}
		if strings.HasPrefix(path.Base(name), ".qx-") {
			return nil, fmt.Errorf("包内含保留元数据文件：%q", f.Name)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		b, err := io.ReadAll(io.LimitReader(rc, maxPackageEntry+1))
		rc.Close()
		if err != nil {
			return nil, err
		}
		if int64(len(b)) > maxPackageEntry {
			return nil, fmt.Errorf("文件 %q 过大", name)
		}
		total += int64(len(b))
		if total > 2*maxPackageEntry {
			return nil, errors.New("解压后总大小超出限制")
		}
		files[name] = b
	}

	raw, ok := files["manifest.json"]
	if !ok {
		return nil, errors.New("缺少 manifest.json")
	}
	var m pkgManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("manifest.json 解析失败：%w", err)
	}
	if m.SystemApp {
		return nil, errors.New("应用包不能声明 systemApp（那是内置应用专用字段）")
	}
	m.ID = strings.TrimSpace(m.ID)
	if !appIDRe.MatchString(m.ID) {
		return nil, errors.New("manifest.id 非法（只允许字母、数字、- 与 _，最长 64）")
	}
	if strings.TrimSpace(m.Name) == "" {
		return nil, errors.New("manifest.name 不能为空")
	}
	if m.Runtime == "" {
		entry := strings.TrimSpace(m.Entry)
		if entry == "" {
			entry = "index.html"
		}
		if _, ok := files[entry]; !ok {
			return nil, fmt.Errorf("manifest.entry 指定的文件 %q 不在包内", entry)
		}
	}

	sum := sha256.Sum256(data)
	return &parsedPackage{
		Manifest: m,
		Files:    files,
		Size:     int64(len(data)),
		SHA256:   hex.EncodeToString(sum[:]),
	}, nil
}

// storeIndex 是与 QxSSH 客户端约定的商店索引结构。
type storeIndex struct {
	Schema  int          `json:"schema"`
	Name    string       `json:"name"`
	Updated string       `json:"updated"`
	Apps    []storeEntry `json:"apps"`
}

type storeEntry struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Description string   `json:"description,omitempty"`
	Author      string   `json:"author,omitempty"`
	Category    string   `json:"category,omitempty"`
	Icon        string   `json:"icon,omitempty"`
	File        string   `json:"file"`
	Size        int64    `json:"size,omitempty"`
	SHA256      string   `json:"sha256,omitempty"`
	Runtime     string   `json:"runtime,omitempty"`
	Keywords    []string `json:"keywords,omitempty"`
}

// jsonMarshalIndent 是带缩进的序列化封装，统一索引文件的排版风格。
func jsonMarshalIndent(v any) ([]byte, error) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// licenseOK 校验许可是否允许上架（保留位，后续可接审核策略）。
func licenseOK(string) bool { return true }

// nowUTC 返回秒级时间戳。
func nowUTC() int64 { return time.Now().UTC().Unix() }

// sortEntries 让索引顺序稳定，避免每次发布产生无意义的差异。
func sortEntries(list []storeEntry) {
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
}
