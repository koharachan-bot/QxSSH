package httpapi

import (
	"net/url"
	"testing"
)

func TestStoreCatalogSourcesDefaults(t *testing.T) {
	t.Setenv("QXSSH_STORE_URL", "")
	got := storeCatalogSources()
	if len(got) != 1 || got[0] != defaultStoreCatalog {
		t.Fatalf("未配置环境变量时应只有官方源，实际 %v", got)
	}
}

func TestStoreCatalogSourcesCommaList(t *testing.T) {
	t.Setenv("QXSSH_STORE_URL", " https://mirror.example.com/index.json , https://backup.example.com/index.json ")
	got := storeCatalogSources()
	if len(got) != 3 {
		t.Fatalf("应得到 2 个自建源 + 1 个官方源，实际 %v", got)
	}
	if got[0] != "https://mirror.example.com/index.json" || got[1] != "https://backup.example.com/index.json" {
		t.Fatalf("自建源顺序或去空白有误：%v", got)
	}
	if got[2] != defaultStoreCatalog {
		t.Fatalf("官方源应在最后兜底，实际 %v", got[2])
	}
}

func TestStoreCatalogSourcesDedup(t *testing.T) {
	t.Setenv("QXSSH_STORE_URL", defaultStoreCatalog)
	got := storeCatalogSources()
	if len(got) != 1 {
		t.Fatalf("与官方源重复时应去重，实际 %v", got)
	}
}

func TestResolveStoreURL(t *testing.T) {
	base, err := url.Parse("https://app.example.com/store/index.json")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct { in, want string }{
		{"apps/a.qxp", "https://app.example.com/store/apps/a.qxp"},
		{"/root/a.qxp", "https://app.example.com/root/a.qxp"},
		{"https://cdn.example.com/a.qxp", "https://cdn.example.com/a.qxp"},
		{"", ""},
}
	for _, c := range cases {
		if got := resolveStoreURL(base, c.in); got != c.want {
			t.Fatalf("resolveStoreURL(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
}

// 明文 http 与空主机必须被拒绝：否则中间人可以替换索引指向恶意 .qxp。
func TestFetchStoreCatalogRejectsInsecure(t *testing.T) {
	for _, raw := range []string{"http://app.example.com/index.json", "https://", ""} {
		if _, err := fetchStoreCatalog(t.Context(), raw); err == nil {
			t.Fatalf("%q 应被拒绝", raw)
		}
	}
}
