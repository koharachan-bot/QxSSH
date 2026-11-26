// Command packgui 把 Linux 图形应用打包成 QxSSH 插件（.qxp）。
//
// 两种用法：
//
//	packgui -dir ./wechat -out dist/wechat.qxp           # 打包现成的插件目录
//	packgui -desktop /usr/share/applications/wechat.desktop -id wechat //	        -out dist/wechat.qxp                          # 从 .desktop 现场生成再打包
//
// 插件包与普通 .qxp 完全一致（zip + manifest.json），只是 manifest 里声明
// runtime=linux-gui 并给出 gui 启动参数；窗口内容、画面编码与输入注入由宿主完成。
package main

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"qxssh/internal/gui"
)

// guiManifest 是生成清单的最小结构，字段与宿主 appManifest 对齐。
type guiManifest struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Description string   `json:"description,omitempty"`
	Author      string   `json:"author,omitempty"`
	Icon        string   `json:"icon,omitempty"`
	Category    string   `json:"category,omitempty"`
	Runtime     string   `json:"runtime"`
	GUI         gui.Spec `json:"gui"`
}

var appIDRe = regexp.MustCompile("^[a-zA-Z0-9][a-zA-Z0-9\\-_]{0,63}$")

func main() {
	var (
		dir        = flag.String("dir", "", "插件目录（含 manifest.json）")
		out        = flag.String("out", "", "输出 .qxp 路径（默认 <id>.qxp）")
		desktop    = flag.String("desktop", "", "从 .desktop 文件生成插件")
		id         = flag.String("id", "", "应用 id（字母数字与 -_，最长 64）")
		name       = flag.String("name", "", "应用显示名")
		execCmd    = flag.String("exec", "", "启动命令（默认取 .desktop 的 Exec）")
		iconPath   = flag.String("icon", "", "图标文件路径（默认取 .desktop 的 Icon）")
		version    = flag.String("version", "1.0.0", "插件版本")
		desc       = flag.String("desc", "", "插件描述")
		width      = flag.Int("width", 1440, "虚拟画面宽度")
		height     = flag.Int("height", 900, "虚拟画面高度")
		softwareGL = flag.Bool("software-gl", true, "强制 Mesa 软件渲染（无 GPU 主机需要）")
	)
	flag.Parse()

	workDir := strings.TrimSpace(*dir)
	var cleanup func()

	if workDir == "" {
		if *desktop == "" && (*id == "" || *execCmd == "") {
			fmt.Fprintln(os.Stderr, "用法：packgui -dir <插件目录> [-out 输出.qxp]")
			fmt.Fprintln(os.Stderr, "      packgui -desktop <文件.desktop> -id <id> [-out 输出.qxp]")
			os.Exit(2)
		}
		tmp, genErr := generateFromDesktop(*desktop, *id, *name, *execCmd, *iconPath, *version, *desc, *width, *height, *softwareGL)
		if genErr != nil {
			fmt.Fprintln(os.Stderr, "生成插件失败："+genErr.Error())
			os.Exit(1)
		}
		workDir = tmp
		cleanup = func() { _ = os.RemoveAll(tmp) }
	}
	if cleanup != nil {
		defer cleanup()
	}

	target := strings.TrimSpace(*out)
	if target == "" {
		target = "app.qxp"
	}
	if err := packDir(workDir, target); err != nil {
		fmt.Fprintln(os.Stderr, "打包失败："+err.Error())
		os.Exit(1)
	}
	abs, _ := filepath.Abs(target)
	fmt.Println("已生成：" + abs)
}

// generateFromDesktop 按 .desktop 描述生成一个临时插件目录。
func generateFromDesktop(desktop, id, name, execCmd, iconPath, version, desc string, width, height int, softwareGL bool) (string, error) {
	var dname, dexec, dicon string
	var err error
	if desktop != "" {
		dname, dexec, dicon, err = parseDesktop(desktop)
		if err != nil {
			return "", err
		}
	}
	if name == "" {
		name = dname
	}
	if execCmd == "" {
		execCmd = dexec
	}
	if iconPath == "" {
		iconPath = dicon
	}
	if execCmd == "" {
		return "", errors.New("缺少启动命令：请提供 -exec 或可解析的 .desktop")
	}
	if id == "" {
		id = strings.ToLower(strings.NewReplacer(" ", "-", ".", "-").Replace(filepath.Base(execCmd)))
	}
	if !appIDRe.MatchString(id) {
		return "", fmt.Errorf("应用 id %q 非法（只允许字母、数字、- 与 _）", id)
	}

	dir, err := os.MkdirTemp("", "qxgui-"+id+"-")
	if err != nil {
		return "", err
	}

	argv := strings.Fields(execCmd)
	spec := gui.Spec{
		Command:       argv,
		Screen:        gui.Screen{Width: width, Height: height, Depth: 24},
		DPI:           96,
		SoftwareGL:    softwareGL,
		WindowManager: "auto",
		Clipboard:     true,
	}
	if err := spec.Validate(); err != nil {
		return "", err
	}

	m := guiManifest{
		ID:          id,
		Name:        name,
		Version:     version,
		Description: desc,
		Author:      "QxSSH",
		Category:    "图形应用",
		Runtime:     "linux-gui",
		GUI:         spec.Normalize(),
	}

	// 图标：优先复制 .desktop 指向的文件，找不到就画一个带首字母的占位图。
	if iconPath != "" {
		if src, found := resolveIcon(iconPath); found == true {
			if data, rerr := os.ReadFile(src); rerr == nil {
				ext := strings.ToLower(filepath.Ext(src))
				dst := filepath.Join(dir, "icon"+ext)
				if werr := os.WriteFile(dst, data, 0o644); werr == nil {
					m.Icon = "icon" + ext
				}
			}
		} else if strings.HasPrefix(iconPath, "/") {
			if data, rerr := os.ReadFile(iconPath); rerr == nil {
				ext := strings.ToLower(filepath.Ext(iconPath))
				dst := filepath.Join(dir, "icon"+ext)
				if werr := os.WriteFile(dst, data, 0o644); werr == nil {
					m.Icon = "icon" + ext
				}
			}
		}
	}
	if m.Icon == "" {
		letter := "A"
		for _, r := range name {
			letter = strings.ToUpper(string(r))
			break
		}
		svg := fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2b6de5"/><text x="32" y="42" font-family="sans-serif" font-size="30" fill="#fff" text-anchor="middle">%s</text></svg>`, letter)
		if werr := os.WriteFile(filepath.Join(dir, "icon.svg"), []byte(svg), 0o644); werr == nil {
			m.Icon = "icon.svg"
		}
	}

	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return "", err
	}
	if werr := os.WriteFile(filepath.Join(dir, "manifest.json"), append(b, '\n'), 0o644); werr != nil {
		return "", werr
	}
	return dir, nil
}

// parseDesktop 提取 .desktop 的显示名、Exec 与 Icon。只读 [Desktop Entry] 段。
func parseDesktop(path string) (name, execCmd, icon string, err error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", "", "", err
	}
	inSection := false
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			inSection = line == "[Desktop Entry]"
			continue
		}
		if !inSection {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		switch k {
		case "Name":
			if name == "" {
				name = v
			}
		case "Name[zh_CN]":
			name = v
		case "Exec":
			execCmd = stripDesktopPlaceholders(v)
		case "Icon":
			icon = v
		}
	}
	if execCmd == "" {
		return name, "", icon, errors.New(".desktop 缺少 Exec 字段")
	}
	return name, execCmd, icon, nil
}

// stripDesktopPlaceholders 去掉 Exec 里的 %f/%U 等占位符。
func stripDesktopPlaceholders(s string) string {
	fields := strings.Fields(s)
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		if strings.HasPrefix(f, "%") && len(f) <= 2 {
			continue
		}
		out = append(out, f)
	}
	return strings.Join(out, " ")
}

// resolveIcon 在常见图标目录里找图标文件，返回路径与是否找到。
func resolveIcon(name string) (string, bool) {
	if name == "" {
		return "", false
	}
	if filepath.IsAbs(name) {
		if _, err := os.Stat(name); err == nil {
			return name, true
		}
		return "", false
	}
	exts := []string{".svg", ".png", ".xpm", ".ico", ".webp"}
	roots := []string{"/usr/share/pixmaps", "/usr/share/icons/hicolor/256x256/apps", "/usr/share/icons/hicolor/scalable/apps", "/usr/share/icons/hicolor/128x128/apps"}
	for _, root := range roots {
		for _, ext := range exts {
			p := filepath.Join(root, name+ext)
			if _, err := os.Stat(p); err == nil {
				return p, true
			}
		}
	}
	return "", false
}

// packDir 校验清单并把目录打成 .qxp。
func packDir(dir, out string) error {
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return fmt.Errorf("读取 manifest.json 失败：%w", err)
	}
	var m struct {
		ID      string    `json:"id"`
		Runtime string    `json:"runtime"`
		GUI     *gui.Spec `json:"gui"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return fmt.Errorf("manifest.json 解析失败：%w", err)
	}
	if !appIDRe.MatchString(m.ID) {
		return errors.New("manifest.id 非法（只允许字母、数字、- 与 _）")
	}
	if m.Runtime != "linux-gui" {
		return fmt.Errorf("manifest.runtime 应为 linux-gui，实际 %q", m.Runtime)
	}
	if m.GUI == nil {
		return errors.New("manifest.gui 不能为空")
	}
	if err := m.GUI.Validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil && filepath.Dir(out) != "." {
		return err
	}

	f, err := os.Create(out)
	if err != nil {
		return err
	}
	defer f.Close()
	zw := zip.NewWriter(f)

	walkErr := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, rerr := filepath.Rel(dir, path)
		if rerr != nil {
			return rerr
		}
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}
		if d.IsDir() {
			switch filepath.Base(rel) {
			case ".git", "dist", "node_modules":
				return fs.SkipDir
			}
			return nil
		}
		base := filepath.Base(rel)
		if strings.HasPrefix(base, ".qx-") || strings.HasSuffix(base, ".qxp") || base == ".DS_Store" {
			return nil
		}
		w, werr := zw.Create(rel)
		if werr != nil {
			return werr
		}
		src, oerr := os.Open(path)
		if oerr != nil {
			return oerr
		}
		defer src.Close()
		_, cerr := io.Copy(w, src)
		return cerr
	})
	if walkErr != nil {
		zw.Close()
		return walkErr
	}
	return zw.Close()
}
