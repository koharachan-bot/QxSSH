package httpapi

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"path/filepath"
	"strings"

	"qxssh/internal/wallpaper"
)

// 壁纸库的上传上限。视频壁纸常有好几百 MB，但本服务走的是本机回环/局域网，
// 512 MB 已经能覆盖 4K 短片；再大就劝用户压一下再传。
const (
	wallpaperMaxFileBytes = int64(512) << 20
	wallpaperMaxPackBytes = int64(512) << 20
)

// wallpaperContentTypes 是壁纸库投递时的扩展名白名单与对应 Content-Type。
// 不在表内一律 404：交互壁纸包里可以出现任意文件，不能让意外文件
// （数据库、私钥、无扩展名脚本）借文件端点被当作文档投递。
var wallpaperContentTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif":  "image/gif",
	".avif": "image/avif",
	".bmp":  "image/bmp",
	".svg":  "image/svg+xml",

	".mp4":  "video/mp4",
	".m4v":  "video/mp4",
	".webm": "video/webm",
	".ogv":  "video/ogg",
	".ogg":  "application/ogg",
	".mov":  "video/quicktime",

	".mp3":  "audio/mpeg",
	".wav":  "audio/wav",
	".oga":  "audio/ogg",
	".flac": "audio/flac",

	".html": "text/html; charset=utf-8",
	".htm":  "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".txt":  "text/plain; charset=utf-8",
	".wasm": "application/wasm",

	".woff":  "font/woff",
	".woff2": "font/woff2",
	".ttf":   "font/ttf",
	".otf":   "font/otf",
}

// interactiveWallCSP 给交互壁纸包里的 HTML 文档附加沙箱。
//
// 包文档被放在不含 allow-same-origin 的 iframe 里（客户端同样只给 allow-scripts），
// 因此它本来就在不透明源里跑，拿不到宿主令牌，也读不到同源存储；这里再叠加一层
// CSP sandbox，防止用户被诱导把该地址当顶层文档打开。因为源已不透明，
// 'self' 在这里没有意义，子资源用 * / data: / blob: 放行，让包能加载自己的素材。
const interactiveWallCSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads; " +
	"default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
	"script-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
	"style-src * data: blob: 'unsafe-inline'; " +
	"img-src * data: blob:; media-src * data: blob:; font-src * data: blob:; connect-src * data: blob:"

// scriptableWallCSP 给 SVG 等可脚本化图片附加的最小沙箱。
const scriptableWallCSP = "sandbox; default-src * data: blob:; style-src * 'unsafe-inline'; img-src * data: blob:"

// handleWallpaperList 列出壁纸库，并把文件端点的能力令牌发给调用方。
//
// 令牌只在持有 wallpaper:read 时可见：拿到令牌就能读用户自己的壁纸文件，
// 但壁纸是本机数据，读取本身不构成越权——写入与删除仍要 wallpaper:write。
func (a *Gateway) handleWallpaperList(w http.ResponseWriter, r *http.Request) {
	entries, err := a.wall.List()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, wallpaperListResp{
		Token:        a.wallTok,
		Dir:          a.wall.Dir(),
		Entries:      entries,
		MaxFileBytes: wallpaperMaxFileBytes,
		MaxPackBytes: wallpaperMaxPackBytes,
		ImageExts:    wallpaper.ImageExts(),
		VideoExts:    wallpaper.VideoExts(),
		PackExts:     []string{".zip", ".qxp"},
	})
}

// handleWallpaperUpload 接收原始字节并保存为图片或视频壁纸。
// 走 sysNoBody 注册：请求体是几百 MB 的媒体，审计只记长度不落正文。
func (a *Gateway) handleWallpaperUpload(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		writeErr(w, http.StatusBadRequest, errors.New("缺少 name 参数"))
		return
	}
	entry, err := a.wall.Save(name, http.MaxBytesReader(w, r.Body, wallpaperMaxFileBytes), wallpaperMaxFileBytes)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	a.log.Info("wallpaper uploaded", "name", entry.Name, "kind", entry.Kind, "bytes", entry.Size)
	writeJSON(w, wallpaperSavedResp{Wallpaper: entry})
}

// handleWallpaperImport 接收一个 zip 压缩包并解包成交互壁纸包。
func (a *Gateway) handleWallpaperImport(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		writeErr(w, http.StatusBadRequest, errors.New("缺少 name 参数"))
		return
	}
	entry, err := a.wall.ImportPack(name, http.MaxBytesReader(w, r.Body, wallpaperMaxPackBytes), wallpaperMaxPackBytes)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	a.log.Info("wallpaper pack imported", "name", entry.Name, "bytes", entry.Size)
	writeJSON(w, wallpaperSavedResp{Wallpaper: entry})
}

// handleWallpaperDelete 删除一个壁纸条目（文件或交互包目录）。
func (a *Gateway) handleWallpaperDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if err := a.wall.Delete(req.Name); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	a.log.Info("wallpaper deleted", "name", req.Name)
	writeJSON(w, okResp{OK: true})
}

// handleWallpaperFile 投递壁纸库里的文件（单文件壁纸或交互包内的任意资源）。
//
// 鉴权用的是启动时随机生成的能力令牌，与 apps/file 同一套思路：宿主页面与内置应用
// 经 wallpapers/list 拿到令牌后才能拼出可用的 <video>/<iframe> 地址，未鉴权的
// 跨站请求直接 404。
//
// 这里不逐条写审计：视频播放会产生大量 Range 请求，逐条入账会把审计表写满，
// 反而淹没上传/删除/导入这些真正需要留痕的操作。
func (a *Gateway) handleWallpaperFile(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.PathValue("tok")), []byte(a.wallTok)) != 1 {
		writeErr(w, http.StatusNotFound, errors.New("壁纸文件不存在"))
		return
	}
	name := r.PathValue("name")
	rel := r.PathValue("rel")
	f, fi, err := a.wall.Open(name, rel)
	if err != nil {
		writeErr(w, http.StatusNotFound, errors.New("壁纸文件不存在"))
		return
	}
	defer f.Close()

	ct := wallpaperContentTypes[strings.ToLower(filepath.Ext(fi.Name()))]
	if ct == "" {
		a.log.Warn("wallpaper file type not allowed", "name", name, "rel", rel)
		writeErr(w, http.StatusNotFound, errors.New("壁纸文件不存在"))
		return
	}

	h := w.Header()
	h.Set("Content-Type", ct)
	// 壁纸是本地大文件：允许浏览器缓存一段时间，拖动进度条与循环播放才不重复拉流。
	h.Set("Cache-Control", "private, max-age=3600")
	switch {
	case strings.HasPrefix(ct, "text/html"):
		h.Set("Content-Security-Policy", interactiveWallCSP)
	case ct == "image/svg+xml":
		h.Set("Content-Security-Policy", scriptableWallCSP)
	}
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
}

// wallpaperListResp 是 wallpapers/list 的响应载荷。
type wallpaperListResp struct {
	// Token 是文件端点的能力令牌，拼地址形如 /api/v1/wallpapers/file/<token>/<name>。
	Token string `json:"token"`
	// Dir 是壁纸库的绝对路径，便于界面把「我的壁纸」指给用户。
	Dir string `json:"dir"`
	// Entries 是库内全部条目。
	Entries []wallpaper.Entry `json:"entries"`
	// MaxFileBytes / MaxPackBytes 是上传上限，界面据此提前拦截过大的文件。
	MaxFileBytes int64 `json:"maxFileBytes"`
	MaxPackBytes int64 `json:"maxPackBytes"`
	// ImageExts / VideoExts / PackExts 是服务端接受的扩展名，避免前后端两套白名单。
	ImageExts []string `json:"imageExts"`
	VideoExts []string `json:"videoExts"`
	PackExts  []string `json:"packExts"`
}

// wallpaperSavedResp 是上传与导入成功后的响应载荷。
type wallpaperSavedResp struct {
	Wallpaper wallpaper.Entry `json:"wallpaper"`
}
