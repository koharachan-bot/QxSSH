package main

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Release 是某个应用某一次发布的记录。
type Release struct {
	ID          int64
	AppID       string
	Version     string
	PackagePath string
	PackageSize int64
	PackageSHA  string
	Changelog   string
	CreatedAt   int64
}

// UpsertRelease 记录一次发布（同版本覆盖），返回是否新增。
func (s *Store) UpsertRelease(appID, version, path string, size int64, sha, changelog string) error {
	_, err := s.db.Exec(`INSERT INTO releases(app_id, version, package_path, package_size, package_sha, changelog, created_at)
		VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(app_id, version) DO UPDATE SET
			package_path=excluded.package_path,
			package_size=excluded.package_size,
			package_sha=excluded.package_sha,
			changelog=excluded.changelog,
			created_at=excluded.created_at`,
		appID, version, path, size, sha, changelog, nowUTC())
	return err
}

// ReleasesOf 返回某应用的全部版本，最新的排最前。
func (s *Store) ReleasesOf(appID string) ([]Release, error) {
	rows, err := s.db.Query(`SELECT id, app_id, version, package_path, package_size, package_sha, changelog, created_at
		FROM releases WHERE app_id=?`, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Release
	for rows.Next() {
		var r Release
		if err := rows.Scan(&r.ID, &r.AppID, &r.Version, &r.PackagePath, &r.PackageSize, &r.PackageSHA, &r.Changelog, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return CompareVersions(out[i].Version, out[j].Version) > 0 })
	return out, rows.Err()
}

// AllReleases 返回所有发布记录，按应用 id 分组后使用。
func (s *Store) AllReleases() (map[string][]Release, error) {
	rows, err := s.db.Query(`SELECT id, app_id, version, package_path, package_size, package_sha, changelog, created_at FROM releases`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]Release{}
	for rows.Next() {
		var r Release
		if err := rows.Scan(&r.ID, &r.AppID, &r.Version, &r.PackagePath, &r.PackageSize, &r.PackageSHA, &r.Changelog, &r.CreatedAt); err != nil {
			return nil, err
		}
		out[r.AppID] = append(out[r.AppID], r)
	}
	for id := range out {
		list := out[id]
		sort.Slice(list, func(i, j int) bool { return CompareVersions(list[i].Version, list[j].Version) > 0 })
		out[id] = list
	}
	return out, rows.Err()
}

// DeleteRelease 删除某个版本记录（下架时用）。
func (s *Store) DeleteRelease(appID, version string) error {
	_, err := s.db.Exec(`DELETE FROM releases WHERE app_id=? AND version=?`, appID, version)
	return err
}

// CompareVersions 比较两个版本号，返回 >0 表示 a 比 b 新。
//
// 支持 1.2.3、1.2.3-beta.1、v1.2 这类常见写法：按 . 与 - 切段，
// 数字段按数值比，非数字段按字典序，段数不齐时短的视为更旧。
func CompareVersions(a, b string) int {
	pa := splitVersion(a)
	pb := splitVersion(b)
	n := len(pa)
	if len(pb) > n {
		n = len(pb)
	}
	for i := 0; i < n; i++ {
		var x, y string
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x == y {
			continue
		}
		// 缺段视为 0，让 1.0 与 1.0.0 等价。
		if x == "" {
			x = "0"
		}
		if y == "" {
			y = "0"
		}
		nx, ex := strconv.Atoi(x)
		ny, ey := strconv.Atoi(y)
		if ex == nil && ey == nil {
			if nx != ny {
				if nx > ny {
					return 1
				}
				return -1
			}
			continue
		}
		// 数字段优先于非数字段（1.0.0 > 1.0.0-beta）。
		if ex == nil {
			return 1
		}
		if ey == nil {
			return -1
		}
		if x > y {
			return 1
		}
		return -1
	}
	return 0
}

func splitVersion(v string) []string {
	v = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(v), "v"))
	if v == "" {
		return nil
	}
	// 同时按 . 与 - 切分，让 1.0.0-beta.1 变成 [1 0 0 beta 1]。
	f := strings.FieldsFunc(v, func(r rune) bool { return r == '.' || r == '-' || r == '+' })
	return f
}

// LatestOf 返回一组版本里的最新版。
func LatestOf(releases []Release) (Release, bool) {
	if len(releases) == 0 {
		return Release{}, false
	}
	best := releases[0]
	for _, r := range releases[1:] {
		if CompareVersions(r.Version, best.Version) > 0 {
			best = r
		}
	}
	return best, true
}

// describeRelease 给日志用。
func describeRelease(r Release) string {
	return fmt.Sprintf("%s@%s", r.AppID, r.Version)
}
