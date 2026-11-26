package main

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

// zipWith 构造一个只含给定文件的内存 zip。
func zipWith(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// 版本号会被拼进落盘文件名，必须挡住目录穿越。
func TestParsePackageRejectsTraversalVersion(t *testing.T) {
	cases := []string{
		"../../../../tmp/pwned",
		"..",
		"a/b",
		"a\\b",
		"v1.0.0/../../x",
		strings.Repeat("9", 40),
	}
	for _, v := range cases {
		data := zipWith(t, map[string]string{
			"manifest.json": `{"id":"evil","name":"E","version":"` + v + `","entry":"index.html"}` ,
			"index.html":    "<h1>x</h1>",
		})
		if _, err := parsePackage(data); err == nil {
			t.Fatalf("version=%q 应被拒绝", v)
		}
	}
}

func TestParsePackageAcceptsSafeVersions(t *testing.T) {
	for _, v := range []string{"1.0.0", "1.2.3-beta.1", "2026.11.26", "v1_0", "1.0.0+build"} {
		data := zipWith(t, map[string]string{
			"manifest.json": `{"id":"okapp","name":"Ok","version":"` + v + `","entry":"index.html"}`,
			"index.html":    "<h1>ok</h1>",
		})
		p, err := parsePackage(data)
		if err != nil {
			t.Fatalf("version=%q 应通过：%v", v, err)
		}
		if p.Manifest.Version != v {
			t.Fatalf("version 被改写：%q", p.Manifest.Version)
		}
	}
}

// 缺少 version 时补 0.0.0，避免空串拼出 "-.qxp"。
func TestParsePackageDefaultsVersion(t *testing.T) {
	data := zipWith(t, map[string]string{
		"manifest.json": `{"id":"nov","name":"NoVer","entry":"index.html"}` ,
		"index.html":    "<h1>x</h1>",
	})
	p, err := parsePackage(data)
	if err != nil {
		t.Fatalf("应通过：%v", err)
	}
	if p.Manifest.Version != "0.0.0" {
		t.Fatalf("默认版本应为 0.0.0，实际 %q", p.Manifest.Version)
	}
}
