package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// 应用商店目录：内置一个默认源（app.meowhead.cn），索引是静态 JSON，应用包是同域下的
// .qxp。目录接口由宿主拉取并缓存后下发给应用管理器，前端只负责展示与点击安装
// （安装复用 apps/install 的 URL 安装路径）。
const (
	// defaultStoreCatalog 是开箱自带的官方商店索引地址；自建镜像可用 QXSSH_STORE_URL 覆盖。
	defaultStoreCatalog = "https://app.meowhead.cn/index.json"

	storeCatalogMaxBytes = 1 << 20
	storeCatalogTTL      = 5 * time.Minute
	storeCatalogTimeout  = 15 * time.Second
)

// storeCatalog 是索引文件结构。相对路径的 icon/file 会按索引地址补全为绝对 URL。
type storeCatalog struct {
	Schema  int        `json:"schema"`
	Name    string     `json:"name"`
	Updated string     `json:"updated,omitempty"`
	Base    string     `json:"base,omitempty"`
	Apps    []storeApp `json:"apps"`
}

// storeApp 是商店里的一个应用条目。
type storeApp struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Version     string   `json:"version,omitempty"`
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

// storeCatalogSource 返回当前生效的索引地址（默认内置，可用环境变量覆盖）。
func storeCatalogSource() string {
	if v := strings.TrimSpace(os.Getenv("QXSSH_STORE_URL")); v != "" {
		return v
	}
	return defaultStoreCatalog
}

type storeCatalogResp struct {
	Catalog *storeCatalog `json:"catalog"`
	Source  string        `json:"source"`
	Cached  bool          `json:"cached,omitempty"`
	Warning string        `json:"warning,omitempty"`
}

// storeCatalogSources 返回候选商店索引地址，按优先级排列：
//  1. QXSSH_STORE_URL —— 自建镜像，部署方自行指定；
//  2. 官方商店（defaultStoreCatalog）。
//
// 兜底地址一律由环境变量提供，源码里不写任何对象存储源站：存储桶的直连地址
// 一旦进仓库就等于公开了后端的存储结构，容易被滥用。部署方需要容灾时，
// 把备用索引填进 QXSSH_STORE_URL 即可（多个地址用逗号分隔）。
func storeCatalogSources() []string {
	var out []string
	seen := map[string]bool{}
	add := func(u string) {
		u = strings.TrimSpace(u)
		if u == "" || seen[u] {
			return
		}
		seen[u] = true
		out = append(out, u)
	}
	for _, u := range strings.Split(os.Getenv("QXSSH_STORE_URL"), ",") {
		add(u)
	}
	add(defaultStoreCatalog)
	return out
}

// fetchStoreCatalogAny 依次尝试候选源，返回第一个成功的目录与它的地址。
func fetchStoreCatalogAny(ctx context.Context, sources []string) (*storeCatalog, string, error) {
	var lastErr error
	for _, src := range sources {
		cat, err := fetchStoreCatalog(ctx, src)
		if err == nil {
			return cat, src, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("没有可用的商店索引地址")
	}
	return nil, "", lastErr
}
// handleStoreCatalog 返回商店目录。结果在进程内缓存 5 分钟，避免每次打开应用管理器
// 都回源；拉取失败时回退到上一次成功结果（如果有）。
func (a *Gateway) handleStoreCatalog(w http.ResponseWriter, r *http.Request) {
	sources := storeCatalogSources()
	src := ""
	if len(sources) > 0 {
		src = sources[0]
	}

	a.storeCatMu.Lock()
	cached, cachedAt, cachedSrc := a.storeCat, a.storeCatAt, a.storeCatSrc
	a.storeCatMu.Unlock()

	if cached != nil && time.Since(cachedAt) < storeCatalogTTL {
		writeJSON(w, storeCatalogResp{Catalog: cached, Source: cachedSrc, Cached: true})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), storeCatalogTimeout)
	defer cancel()
	cat, usedSrc, err := fetchStoreCatalogAny(ctx, sources)
	if err != nil {
		if cached != nil {
			writeJSON(w, storeCatalogResp{Catalog: cached, Source: cachedSrc, Cached: true, Warning: err.Error()})
			return
		}
		writeErr(w, http.StatusBadGateway, err)
		return
	}

	a.storeCatMu.Lock()
	a.storeCat, a.storeCatAt, a.storeCatSrc = cat, time.Now(), usedSrc
	a.storeCatMu.Unlock()
	a.log.Info("store catalog refreshed", "source", usedSrc, "apps", len(cat.Apps))
	warn := ""
	if usedSrc != src {
		warn = "主商店地址不可用，已切换到备用源：" + usedSrc
	}
	writeJSON(w, storeCatalogResp{Catalog: cat, Source: usedSrc, Warning: warn})
}

// fetchStoreCatalog 拉取并校验索引。只接受 https（明文 http 会被中间人替换成恶意 .qxp），
// 响应限 1MB，相对路径按索引地址补全。
func fetchStoreCatalog(ctx context.Context, raw string) (*storeCatalog, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("商店索引地址无效：%q", raw)
	}
	if u.Scheme != "https" {
		return nil, errors.New("商店索引必须是 https 地址")
	}

	client := &http.Client{Timeout: storeCatalogTimeout}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("拉取商店索引失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("拉取商店索引失败：HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, storeCatalogMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > storeCatalogMaxBytes {
		return nil, errors.New("商店索引过大（上限 1MB）")
	}

	var cat storeCatalog
	if err := json.Unmarshal(body, &cat); err != nil {
		return nil, fmt.Errorf("商店索引不是合法 JSON：%w", err)
	}
	if len(cat.Apps) == 0 {
		return nil, errors.New("商店索引里没有任何应用")
	}
	if len(cat.Apps) > 500 {
		return nil, errors.New("商店索引应用过多（上限 500）")
	}
	if cat.Base != "" {
		base, perr := u.Parse(strings.TrimSpace(cat.Base))
		if perr != nil {
			return nil, fmt.Errorf("商店索引 base 无效：%w", perr)
		}
		u = base
	}

	for i := range cat.Apps {
		app := &cat.Apps[i]
		app.ID = strings.TrimSpace(app.ID)
		app.Name = strings.TrimSpace(app.Name)
		if app.ID == "" || app.Name == "" {
			return nil, fmt.Errorf("商店索引第 %d 项缺少 id 或 name", i+1)
		}
		app.File = resolveStoreURL(u, app.File)
		if app.File == "" {
			return nil, fmt.Errorf("商店应用 %s 的 file 无效", app.ID)
		}
		app.Icon = resolveStoreURL(u, app.Icon)
	}
	return &cat, nil
}

// resolveStoreURL 把相对地址按索引地址补全成绝对 https 地址；空值返回空串。
func resolveStoreURL(base *url.URL, raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	ref, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	abs := base.ResolveReference(ref)
	if abs.Scheme != "https" || abs.Host == "" {
		return ""
	}
	abs.Fragment = ""
	return abs.String()
}
