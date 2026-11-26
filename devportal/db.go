package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// User 是一个平台账号。角色只有两种：developer（提交应用）与 admin（审核与上架）。
type User struct {
	ID        int64
	Email     string
	PassHash  string
	Nickname  string
	Role      string
	CreatedAt time.Time
}

// App 是一个应用条目：开发者提交、管理员审核、通过后上架。
//
// Status 取值：draft（草稿）→ pending（待审）→ approved（通过）→ published（已上架）；
// 驳回回到 rejected，开发者修改后可重新提交为 pending。
type App struct {
	ID          int64
	OwnerID     int64
	AppID       string // manifest 里的 id，同时是商店目录名
	Name        string
	Summary     string
	Description string
	Category    string
	Author      string
	Homepage    string
	RepoURL     string
	Version     string
	PackagePath string // 待发布 .qxp 的本地绝对路径
	PackageSize int64
	PackageSHA  string
	IconPath    string
	Status      string
	ReviewNote  string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	ReviewedAt  sql.NullTime
	PublishedAt sql.NullTime
}

// Store 封装数据库访问。
type Store struct {
	db *sql.DB
}

// OpenStore 打开（必要时初始化）数据库。
func OpenStore(dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "packages"), 0o750); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", filepath.Join(dataDir, "portal.db")+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL UNIQUE,
			pass_hash TEXT NOT NULL,
			nickname TEXT NOT NULL DEFAULT '',
			role TEXT NOT NULL DEFAULT 'developer',
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS apps (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			owner_id INTEGER NOT NULL,
			app_id TEXT NOT NULL,
			name TEXT NOT NULL,
			summary TEXT NOT NULL DEFAULT '',
			description TEXT NOT NULL DEFAULT '',
			category TEXT NOT NULL DEFAULT '',
			author TEXT NOT NULL DEFAULT '',
			homepage TEXT NOT NULL DEFAULT '',
			repo_url TEXT NOT NULL DEFAULT '',
			version TEXT NOT NULL DEFAULT '',
			package_path TEXT NOT NULL DEFAULT '',
			package_size INTEGER NOT NULL DEFAULT 0,
			package_sha TEXT NOT NULL DEFAULT '',
			icon_path TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'draft',
			review_note TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			reviewed_at INTEGER,
			published_at INTEGER,
			UNIQUE(app_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status)`,
		`CREATE INDEX IF NOT EXISTS idx_apps_owner ON apps(owner_id)`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return fmt.Errorf("迁移数据库失败：%w", err)
		}
	}
	return nil
}

// Close 关闭数据库。
func (s *Store) Close() error { return s.db.Close() }

func toTime(v int64) time.Time { return time.Unix(v, 0) }
