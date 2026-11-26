package wallpaper

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSafeNameCleansAndKeepsExt(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"photo.png", "photo.png"},
		{"C:\\Users\\me\\photo.JPG", "photo.jpg"},
		{"../evil.png", "evil.png"},
		{"my/paper.webp", "paper.webp"},
		{"what?*.png", "what__.png"},
		{"  spaced.png  ", "spaced.png"},
	}
	for _, c := range cases {
		got, err := SafeName(c.in)
		if err != nil {
			t.Fatalf("SafeName(%q) 报错: %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("SafeName(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
	for _, bad := range []string{"", "   ", "..", ".hidden.png"} {
		if _, err := SafeName(bad); err == nil {
			t.Errorf("SafeName(%q) 应当报错", bad)
		}
	}
}

func TestSafeNameTruncatesToByteLimit(t *testing.T) {
	long := strings.Repeat("壁", 80) + ".webm"
	got, err := SafeName(long)
	if err != nil {
		t.Fatalf("长名清洗失败: %v", err)
	}
	if len(got) > maxNameBytes {
		t.Fatalf("清洗后长度 %d 超过上限 %d", len(got), maxNameBytes)
	}
	if !strings.HasSuffix(got, ".webm") {
		t.Fatalf("截断后丢了扩展名: %q", got)
	}
}

func TestSaveListDelete(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)

	if _, err := s.Save("clip.mp4", strings.NewReader("fake-video"), 1<<20); err != nil {
		t.Fatalf("保存视频失败: %v", err)
	}
	if _, err := s.Save("pic.png", strings.NewReader("fake-image"), 1<<20); err != nil {
		t.Fatalf("保存图片失败: %v", err)
	}
	if _, err := s.Save("music.mp3", strings.NewReader("x"), 1<<20); err == nil {
		t.Fatal("不支持的扩展名应当报错")
	}

	ents, err := s.List()
	if err != nil {
		t.Fatalf("列表失败: %v", err)
	}
	if len(ents) != 2 {
		t.Fatalf("期望 2 个条目，实际 %d: %+v", len(ents), ents)
	}
	// 视频排在图片之前（kindRank 越靠前越先出），同类型按名称。
	if ents[0].Kind != KindVideo || ents[1].Kind != KindImage {
		t.Fatalf("排序不符预期: %+v", ents)
	}
	for _, e := range ents {
		if e.Size <= 0 {
			t.Errorf("条目 %q 尺寸为 0", e.Name)
		}
	}

	// 重名不覆盖，改为追加 -2。
	if _, err := s.Save("pic.png", strings.NewReader("second"), 1<<20); err != nil {
		t.Fatalf("重名保存失败: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "pic-2.png")); err != nil {
		t.Fatalf("重名应生成 pic-2.png: %v", err)
	}

	if err := s.Delete("clip.mp4"); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "clip.mp4")); !os.IsNotExist(err) {
		t.Fatal("删除后文件仍存在")
	}
	if err := s.Delete("../outside"); err == nil {
		t.Fatal("越权删除应当报错")
	}
}

func TestImportPack(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, body string) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("构造 zip 失败: %v", err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatalf("写 zip 失败: %v", err)
		}
	}
	add("index.html", "<html><body>cat</body></html>")
	add("assets/app.js", "console.log('meow')")
	add("wallpaper.json", `{"name":"猫猫星尘","audio":true,"entry":"index.html"}`)
	if err := zw.Close(); err != nil {
		t.Fatalf("关闭 zip 失败: %v", err)
	}

	entry, err := s.ImportPack("cat-wallpaper.zip", &buf, 1<<20)
	if err != nil {
		t.Fatalf("导入交互包失败: %v", err)
	}
	if entry.Kind != KindWeb {
		t.Fatalf("期望 web 类型，实际 %q", entry.Kind)
	}
	if entry.Title != "猫猫星尘" || !entry.Audio || entry.Problem != "" {
		t.Fatalf("包元数据不符: %+v", entry)
	}
	if _, err := os.Stat(filepath.Join(dir, "cat-wallpaper", "assets", "app.js")); err != nil {
		t.Fatalf("包内资源未解出: %v", err)
	}

	// 缺入口文件必须失败且不留半个包。
	var bad bytes.Buffer
	zb := zip.NewWriter(&bad)
	w, _ := zb.Create("readme.txt")
	_, _ = w.Write([]byte("no entry"))
	_ = zb.Close()
	if _, err := s.ImportPack("broken.zip", &bad, 1<<20); err == nil {
		t.Fatal("缺入口的包应当报错")
	}
	if _, err := os.Stat(filepath.Join(dir, "broken")); !os.IsNotExist(err) {
		t.Fatal("失败的导入不应留下目录")
	}
}

func TestImportPackRejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("../escape.txt")
	_, _ = w.Write([]byte("nope"))
	_ = zw.Close()
	if _, err := s.ImportPack("evil.zip", &buf, 1<<20); err == nil {
		t.Fatal("含 .. 的包应当报错")
	}
}

func TestOpenRejectsEscape(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	if _, err := s.Save("ok.png", strings.NewReader("x"), 1<<20); err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	f, fi, err := s.Open("ok.png", "")
	if err != nil {
		t.Fatalf("打开失败: %v", err)
	}
	if fi.Name() != "ok.png" {
		t.Fatalf("文件名不符: %q", fi.Name())
	}
	_ = f.Close()

	for _, rel := range []string{"../secret", "/etc/passwd", ".."} {
		if _, _, err := s.Open("ok.png", rel); err == nil {
			t.Errorf("Open(rel=%q) 应当被拒绝", rel)
		}
	}
	if _, _, err := s.Open("../x.png", ""); err == nil {
		t.Error("Open 越权条目名应当被拒绝")
	}
}
