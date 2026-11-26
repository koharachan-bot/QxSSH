// Package wallpaper 管理 QxSSH 的壁纸库。
//
// 壁纸库固定落在配置目录下的 wallpapers/，与通用本地文件接口（localfs/*）刻意分开：
// 后者对配置目录整体拒绝访问（凭据库、签名密钥、应用代码与审计日志都在其中），
// 而壁纸又必须落在用户自己的配置目录里，所以壁纸的读写由本包与 httpapi 的
// wallpapers/* 端点专管——它们支持 Range（视频拖动播放）、扩展名白名单与
// 交互壁纸包的原子解包。
//
// 库内条目分两类：
//   - 单文件：图片与视频，平铺在库根；
//   - 交互壁纸包：一个子目录，含入口 HTML 与可选的 wallpaper.json 描述。
//
// 本包只管磁盘布局与校验，不关心权限与会话；鉴权由 httpapi 完成。
package wallpaper

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// 条目类型：单文件图片、单文件视频、交互壁纸包（HTML + 资源目录）。
const (
	KindImage = "image"
	KindVideo = "video"
	KindWeb   = "web"
)

// defaultPackEntry 是交互壁纸包未声明入口时使用的文件名。
const defaultPackEntry = "index.html"

// packManifestName 是交互壁纸包的描述文件，可选；缺失时按纯 HTML 包处理。
const packManifestName = "wallpaper.json"

const (
	// maxNameBytes 限制条目名长度（含扩展名），避免 Windows 路径超限与超长文件名。
	maxNameBytes = 96
	// maxPackFiles 限制单个交互包的文件数，防止「几十万个小文件」把库拖垮。
	maxPackFiles = 512
	// maxPackBytes 限制单个交互包解包后的总字节数。
	maxPackBytes = 512 << 20
	// maxManifestBytes 限制 wallpaper.json 的读取长度。
	maxManifestBytes = 64 << 10
)

// imageExts 与 videoExts 是壁纸库接受的单文件扩展名。
// 只收浏览器原生就能渲染的容器：是否带音频、能否交互由播放端决定，与扩展名无关。
var (
	imageExts = map[string]bool{
		".png": true, ".jpg": true, ".jpeg": true, ".webp": true,
		".gif": true, ".avif": true, ".bmp": true,
	}
	videoExts = map[string]bool{
		".mp4": true, ".webm": true, ".ogv": true, ".ogg": true, ".m4v": true, ".mov": true,
	}
)

// errBadName 表示条目名非法（空、越权、含路径分隔符或扩展名不支持）。
var errBadName = errors.New("壁纸名称非法")

// Entry 是壁纸库中的一个条目，直接作为 API 响应载荷。
type Entry struct {
	// Name 是条目名：单文件为文件名，交互包为目录名。
	Name string `json:"name"`
	// Kind 取 image / video / web。
	Kind string `json:"kind"`
	// Size 是单文件字节数或交互包目录总字节数。
	Size int64 `json:"size"`
	// ModTime 是条目最后修改时间（毫秒时间戳）。
	ModTime int64 `json:"modTime"`
	// Title 是交互包声明的显示名，缺省时前端回退到目录名。
	Title string `json:"title,omitempty"`
	// Author 是交互包声明的作者。
	Author string `json:"author,omitempty"`
	// Theme 是交互包建议的主题档（light / dark / any），仅作筛选提示。
	Theme string `json:"theme,omitempty"`
	// Entry 是交互包入口 HTML 的相对路径。
	Entry string `json:"entry,omitempty"`
	// Audio 表示交互包声明会发声，播放端据此决定是否默认静音。
	Audio bool `json:"audio,omitempty"`
	// Problem 非空表示条目存在但不可用（例如缺入口文件），前端据此提示而不是静默隐藏。
	Problem string `json:"problem,omitempty"`
}

// packManifest 是交互壁纸包的 wallpaper.json 结构。
// 字段刻意全部可选：一个只含 index.html 的压缩包也应当能直接用。
type packManifest struct {
	Name   string `json:"name,omitempty"`
	Author string `json:"author,omitempty"`
	Theme  string `json:"theme,omitempty"`
	Entry  string `json:"entry,omitempty"`
	Audio  bool   `json:"audio,omitempty"`
}

// Store 是壁纸库的磁盘视图。
type Store struct {
	dir string
}

// New 以 dir 为库根创建 Store；dir 不必已存在。
func New(dir string) *Store {
	return &Store{dir: filepath.Clean(dir)}
}

// Dir 返回库根的绝对或规范路径。
func (s *Store) Dir() string { return s.dir }

// ensure 创建库根目录；权限收紧到 0700 与配置目录保持一致。
func (s *Store) ensure() error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return fmt.Errorf("创建壁纸目录失败: %w", err)
	}
	return nil
}

// List 扫描库根并返回全部可用条目，按类型（交互包优先）与名称排序。
// 未知扩展名的文件与隐藏文件被忽略，避免把临时文件、系统垃圾文件列成壁纸。
func (s *Store) List() ([]Entry, error) {
	if err := s.ensure(); err != nil {
		return nil, err
	}
	ents, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(ents))
	for _, de := range ents {
		name := de.Name()
		if name == "" || strings.HasPrefix(name, ".") {
			continue
		}
		info, ierr := de.Info()
		if ierr != nil {
			continue
		}
		if de.IsDir() {
			out = append(out, s.packEntry(name, info))
			continue
		}
		ext := strings.ToLower(filepath.Ext(name))
		var kind string
		switch {
		case imageExts[ext]:
			kind = KindImage
		case videoExts[ext]:
			kind = KindVideo
		default:
			continue
		}
		out = append(out, Entry{Name: name, Kind: kind, Size: info.Size(), ModTime: info.ModTime().UnixMilli()})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return kindRank(out[i].Kind) < kindRank(out[j].Kind)
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

func kindRank(kind string) int {
	switch kind {
	case KindWeb:
		return 0
	case KindVideo:
		return 1
	default:
		return 2
	}
}

// packEntry 汇总一个交互壁纸包的元数据；入口文件缺失时写入 Problem 而不是报错，
// 这样损坏的包仍能在列表里被看到并删除，而不是永远占着目录却不显示。
func (s *Store) packEntry(name string, info os.FileInfo) Entry {
	dir := filepath.Join(s.dir, name)
	e := Entry{Name: name, Kind: KindWeb, Size: dirSize(dir, 0), ModTime: info.ModTime().UnixMilli()}
	if m, err := readPackManifest(dir); err == nil {
		e.Title, e.Author, e.Theme, e.Audio = strings.TrimSpace(m.Name), strings.TrimSpace(m.Author), strings.TrimSpace(m.Theme), m.Audio
		e.Entry = cleanRelEntry(m.Entry)
	}
	if e.Entry == "" {
		e.Entry = defaultPackEntry
	}
	if st, err := os.Stat(filepath.Join(dir, filepath.FromSlash(e.Entry))); err != nil || st.IsDir() {
		e.Problem = "缺少入口文件 " + e.Entry
	}
	return e
}

// readPackManifest 读取交互包的 wallpaper.json；文件缺失时返回空清单而非错误。
func readPackManifest(dir string) (packManifest, error) {
	var m packManifest
	f, err := os.Open(filepath.Join(dir, packManifestName))
	if err != nil {
		return m, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxManifestBytes))
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return packManifest{}, fmt.Errorf("wallpaper.json 解析失败: %w", err)
	}
	return m, nil
}

// cleanRelEntry 归一交互包入口的相对路径：去掉 ./ 前缀，拒绝绝对路径与 .. 段。
func cleanRelEntry(rel string) string {
	rel = strings.TrimSpace(strings.ReplaceAll(rel, "\\", "/"))
	rel = strings.TrimPrefix(rel, "./")
	if rel == "" {
		return ""
	}
	clean := path.Clean(rel)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") {
		return ""
	}
	return clean
}

// dirSize 递归统计目录内的普通文件总字节数；depth 用于限制遍历深度。
func dirSize(dir string, depth int) int64 {
	if depth > 8 {
		return 0
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	var total int64
	for _, de := range ents {
		info, ierr := de.Info()
		if ierr != nil {
			continue
		}
		if de.IsDir() {
			total += dirSize(filepath.Join(dir, de.Name()), depth+1)
			continue
		}
		if info.Mode().IsRegular() {
			total += info.Size()
		}
	}
	return total
}

// SafeName 把用户提供的文件名清洗成库内条目名：只保留基名、剔除控制字符、
// 替换 Windows 保留字符，并按字节截断到上限（保留扩展名）。
func SafeName(raw string) (string, error) {
	base := filepath.Base(strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/"))
	if base == "" || base == "." || base == ".." {
		return "", errBadName
	}
	var b strings.Builder
	for _, r := range base {
		if r < 0x20 || r == 0x7f {
			continue
		}
		if strings.ContainsRune(`<>:"/\\|?*`, r) {
			b.WriteByte('_')
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	if out == "" || out == "." || out == ".." || strings.HasPrefix(out, ".") {
		return "", errBadName
	}
	ext := strings.ToLower(filepath.Ext(out))
	stem := out[:len(out)-len(ext)]
	limit := maxNameBytes - len(ext)
	for len(stem) > limit {
		stem = stem[:len(stem)-1]
	}
	stem = strings.TrimSpace(stem)
	if stem == "" {
		return "", errBadName
	}
	return stem + ext, nil
}

// Save 把 r 的内容保存为新壁纸条目，返回落盘后的条目。
// 调用方负责限制 r 的字节数；这里再兜一层硬上限，避免误用把磁盘写满。
func (s *Store) Save(rawName string, r io.Reader, limit int64) (Entry, error) {
	name, err := SafeName(rawName)
	if err != nil {
		return Entry{}, err
	}
	ext := strings.ToLower(filepath.Ext(name))
	var kind string
	switch {
	case imageExts[ext]:
		kind = KindImage
	case videoExts[ext]:
		kind = KindVideo
	default:
		return Entry{}, fmt.Errorf("不支持的壁纸类型：%q", ext)
	}
	if err := s.ensure(); err != nil {
		return Entry{}, err
	}
	if limit <= 0 {
		limit = 512 << 20
	}
	final, err := s.uniqueName(name)
	if err != nil {
		return Entry{}, err
	}
	tmp, err := os.CreateTemp(s.dir, ".upload-*")
	if err != nil {
		return Entry{}, err
	}
	tmpName := tmp.Name()
	n, cerr := io.Copy(tmp, io.LimitReader(r, limit+1))
	if cerr == nil {
		cerr = tmp.Close()
	} else {
		_ = tmp.Close()
	}
	if cerr != nil {
		_ = os.Remove(tmpName)
		return Entry{}, cerr
	}
	if n > limit {
		_ = os.Remove(tmpName)
		return Entry{}, fmt.Errorf("壁纸文件过大（上限 %d MB）", limit>>20)
	}
	if n == 0 {
		_ = os.Remove(tmpName)
		return Entry{}, errors.New("壁纸内容为空")
	}
	_ = os.Chmod(tmpName, 0o644)
	dest := filepath.Join(s.dir, final)
	if err := os.Rename(tmpName, dest); err != nil {
		_ = os.Remove(tmpName)
		return Entry{}, err
	}
	info, err := os.Stat(dest)
	if err != nil {
		return Entry{}, err
	}
	return Entry{Name: final, Kind: kind, Size: info.Size(), ModTime: info.ModTime().UnixMilli()}, nil
}

// ImportPack 解包一个交互壁纸压缩包到独立子目录。
// 先解到库内的临时目录，全部校验通过后再整体改名，因此解包失败不会留下半个包。
func (s *Store) ImportPack(rawName string, r io.Reader, limit int64) (Entry, error) {
	stem, err := packName(rawName)
	if err != nil {
		return Entry{}, err
	}
	if err := s.ensure(); err != nil {
		return Entry{}, err
	}
	if limit <= 0 {
		limit = 512 << 20
	}
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return Entry{}, err
	}
	if int64(len(data)) > limit {
		return Entry{}, fmt.Errorf("壁纸包过大（上限 %d MB）", limit>>20)
	}
	if len(data) == 0 {
		return Entry{}, errors.New("壁纸包内容为空")
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return Entry{}, fmt.Errorf("不是有效的 zip 包：%w", err)
	}
	if len(zr.File) > maxPackFiles {
		return Entry{}, fmt.Errorf("壁纸包文件数过多（上限 %d）", maxPackFiles)
	}
	tmpDir, err := os.MkdirTemp(s.dir, ".import-*")
	if err != nil {
		return Entry{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(tmpDir)
		}
	}()

	var total int64
	for _, f := range zr.File {
		rel, perr := safePackPath(f.Name)
		if perr != nil {
			return Entry{}, perr
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(filepath.Join(tmpDir, filepath.FromSlash(rel)), 0o755); err != nil {
				return Entry{}, err
			}
			continue
		}
		if !f.Mode().IsRegular() {
			// 符号链接、设备节点等一律跳过：壁纸包只需要普通文件。
			continue
		}
		total += int64(f.UncompressedSize64)
		if total > maxPackBytes {
			return Entry{}, fmt.Errorf("壁纸包解包后过大（上限 %d MB）", maxPackBytes>>20)
		}
		dst := filepath.Join(tmpDir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return Entry{}, err
		}
		if err := writeZipFile(dst, f); err != nil {
			return Entry{}, err
		}
	}

	// 入口校验：wallpaper.json 声明的入口优先，否则要求 index.html。
	entry := defaultPackEntry
	if m, merr := readPackManifest(tmpDir); merr == nil {
		if e := cleanRelEntry(m.Entry); e != "" {
			entry = e
		}
	}
	if st, serr := os.Stat(filepath.Join(tmpDir, filepath.FromSlash(entry))); serr != nil || st.IsDir() {
		return Entry{}, fmt.Errorf("壁纸包缺少入口文件 %s", entry)
	}

	final, err := s.uniqueName(stem)
	if err != nil {
		return Entry{}, err
	}
	if err := os.Rename(tmpDir, filepath.Join(s.dir, final)); err != nil {
		return Entry{}, err
	}
	committed = true
	info, err := os.Stat(filepath.Join(s.dir, final))
	if err != nil {
		return Entry{}, err
	}
	return s.packEntry(final, info), nil
}

// writeZipFile 把 zip 内的一个文件写到 dst，读取量以声明尺寸为上限兜底。
func writeZipFile(dst string, f *zip.File) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	limit := int64(f.UncompressedSize64)
	if limit <= 0 {
		limit = maxPackBytes
	}
	if _, err := io.CopyN(out, rc, limit); err != nil && !errors.Is(err, io.EOF) {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// safePackPath 校验并归一压缩包内的相对路径：拒绝绝对路径、.. 越权与空段。
func safePackPath(name string) (string, error) {
	rel := strings.TrimSpace(strings.ReplaceAll(name, "\\", "/"))
	rel = strings.TrimPrefix(rel, "./")
	if rel == "" {
		return "", errors.New("壁纸包内含空路径")
	}
	clean := path.Clean(rel)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") {
		return "", fmt.Errorf("壁纸包内含非法路径：%s", name)
	}
	for _, seg := range strings.Split(clean, "/") {
		if seg == ".." {
			return "", fmt.Errorf("壁纸包内含非法路径：%s", name)
		}
	}
	return clean, nil
}

// packName 从压缩包文件名推导包目录名：去掉 .zip/.qxp 扩展名后按单文件规则清洗。
func packName(raw string) (string, error) {
	base := filepath.Base(strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/"))
	low := strings.ToLower(base)
	switch {
	case strings.HasSuffix(low, ".zip"):
		base = base[:len(base)-4]
	case strings.HasSuffix(low, ".qxp"):
		base = base[:len(base)-4]
	}
	name, err := SafeName(base)
	if err != nil {
		return "", err
	}
	// 包目录名不带扩展名更清爽：去掉清洗后可能残留的扩展名。
	if ext := filepath.Ext(name); ext != "" {
		name = strings.TrimSuffix(name, ext)
	}
	if name == "" {
		return "", errBadName
	}
	return name, nil
}

// uniqueName 在库根下为新条目取一个不冲突的名字，冲突时追加 -2、-3……
func (s *Store) uniqueName(name string) (string, error) {
	if _, err := os.Lstat(filepath.Join(s.dir, name)); errors.Is(err, fs.ErrNotExist) {
		return name, nil
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 2; i < 1000; i++ {
		cand := fmt.Sprintf("%s-%d%s", stem, i, ext)
		if _, err := os.Lstat(filepath.Join(s.dir, cand)); errors.Is(err, fs.ErrNotExist) {
			return cand, nil
		}
	}
	return "", errors.New("同名壁纸过多，请先清理")
}

// Delete 删除库根下的一个条目（文件或交互包目录）。
func (s *Store) Delete(name string) error {
	name = strings.TrimSpace(strings.ReplaceAll(name, "\\", "/"))
	if name == "" || name != path.Base(name) || name == "." || name == ".." || strings.HasPrefix(name, ".") {
		return errBadName
	}
	// 直接删路径本身：name 已限定为库根下的单段名字，符号链接只会删链接不会跟进。
	return os.RemoveAll(filepath.Join(s.dir, name))
}

// Open 打开库内文件供 HTTP 投递。name 是库根下的条目名，rel 是交互包内的相对路径
// （单文件壁纸传空串）。返回值经 os.Root 约束，任何越权路径都会被拒绝。
func (s *Store) Open(name, rel string) (*os.File, os.FileInfo, error) {
	name = strings.TrimSpace(name)
	if name == "" || name != path.Base(name) || name == "." || name == ".." {
		return nil, nil, errBadName
	}
	p := name
	if rel != "" {
		clean := cleanRelEntry(rel)
		if clean == "" {
			return nil, nil, errBadName
		}
		p = name + "/" + clean
	}
	root, err := os.OpenRoot(s.dir)
	if err != nil {
		return nil, nil, err
	}
	defer root.Close()
	f, err := root.Open(filepath.FromSlash(p))
	if err != nil {
		return nil, nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, nil, err
	}
	if fi.IsDir() {
		_ = f.Close()
		sub := path.Join(p, defaultPackEntry)
		f2, err := root.Open(filepath.FromSlash(sub))
		if err != nil {
			return nil, nil, err
		}
		fi2, err := f2.Stat()
		if err != nil || fi2.IsDir() {
			_ = f2.Close()
			return nil, nil, errors.New("壁纸包缺少入口文件")
		}
		return f2, fi2, nil
	}
	return f, fi, nil
}

// IsImageExt 报告扩展名是否属于图片类壁纸。
func IsImageExt(ext string) bool { return imageExts[strings.ToLower(ext)] }

// IsVideoExt 报告扩展名是否属于视频类壁纸。
func IsVideoExt(ext string) bool { return videoExts[strings.ToLower(ext)] }

// ImageExts 返回库接受的图片扩展名（含点，字典序）。
func ImageExts() []string { return sortedExts(imageExts) }

// VideoExts 返回库接受的视频扩展名（含点，字典序）。
func VideoExts() []string { return sortedExts(videoExts) }

func sortedExts(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
