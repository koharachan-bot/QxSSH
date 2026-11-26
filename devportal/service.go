package main

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrNotFound   = errors.New("记录不存在")
	ErrForbidden  = errors.New("没有权限执行该操作")
	ErrBadState   = errors.New("当前状态不允许该操作")
	ErrEmailTaken = errors.New("该邮箱已注册")
)

/* ------------------------------ 用户 ------------------------------ */

// CreateUser 注册账号；首个账号自动成为管理员。
func (s *Store) CreateUser(email, pw, nickname, role string) (*User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || !strings.Contains(email, "@") {
		return nil, errors.New("邮箱格式不正确")
	}
	if len(pw) < 8 {
		return nil, errors.New("密码至少 8 位")
	}
	hash, err := hashPassword(pw)
	if err != nil {
		return nil, err
	}
	if role != "admin" {
		role = "developer"
	}
	res, err := s.db.Exec(
		`INSERT INTO users(email, pass_hash, nickname, role, created_at) VALUES(?,?,?,?,?)`,
		email, hash, strings.TrimSpace(nickname), role, nowUTC())
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return nil, ErrEmailTaken
		}
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.UserByID(id)
}

// UserByID 按 ID 取用户。
const userCols = `id, email, pass_hash, nickname, role, created_at, totp_secret, totp_enabled, recovery_hashes, email_verified`

func scanUser(sc interface{ Scan(...any) error }) (*User, error) {
	var u User
	var ts int64
	var enabled, verified int
	if err := sc.Scan(&u.ID, &u.Email, &u.PassHash, &u.Nickname, &u.Role, &ts,
		&u.TOTPSecret, &enabled, &u.RecoveryHashes, &verified); err != nil {
		return nil, err
	}
	u.CreatedAt = toTime(ts)
	u.TOTPEnabled = enabled != 0
	u.EmailVerified = verified != 0
	return &u, nil
}

// SetTOTP 保存 2FA 状态。enabled 为真时要求 secret 非空。
func (s *Store) SetTOTP(id int64, secret string, enabled bool, recovery string) error {
	e := 0
	if enabled {
		e = 1
	}
	_, err := s.db.Exec(`UPDATE users SET totp_secret=?, totp_enabled=?, recovery_hashes=? WHERE id=?`,
		secret, e, recovery, id)
	return err
}

func (s *Store) UserByID(id int64) (*User, error) {
	u, err := scanUser(s.db.QueryRow(`SELECT `+userCols+` FROM users WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}


// UserByEmail 按邮箱取用户。
func (s *Store) UserByEmail(email string) (*User, error) {
	u, err := scanUser(s.db.QueryRow(`SELECT `+userCols+` FROM users WHERE email=?`,
		strings.ToLower(strings.TrimSpace(email))))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

// CountUsers 返回账号总数（用于判断是否需要创建首个管理员）。
func (s *Store) CountUsers() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

/* ------------------------------ 应用 ------------------------------ */

const appCols = `id, owner_id, app_id, name, summary, description, category, author, homepage, repo_url,
	version, package_path, package_size, package_sha, icon_path, status, review_note,
	created_at, updated_at, reviewed_at, published_at`

func scanApp(sc interface{ Scan(...any) error }) (*App, error) {
	var a App
	var created, updated int64
	var reviewed, published sql.NullInt64
	err := sc.Scan(&a.ID, &a.OwnerID, &a.AppID, &a.Name, &a.Summary, &a.Description, &a.Category,
		&a.Author, &a.Homepage, &a.RepoURL, &a.Version, &a.PackagePath, &a.PackageSize, &a.PackageSHA,
		&a.IconPath, &a.Status, &a.ReviewNote, &created, &updated, &reviewed, &published)
	if err != nil {
		return nil, err
	}
	a.CreatedAt = toTime(created)
	a.UpdatedAt = toTime(updated)
	if reviewed.Valid {
		a.ReviewedAt = sql.NullTime{Time: toTime(reviewed.Int64), Valid: true}
	}
	if published.Valid {
		a.PublishedAt = sql.NullTime{Time: toTime(published.Int64), Valid: true}
	}
	return &a, nil
}

// AppByID 取单个应用。
func (s *Store) AppByID(id int64) (*App, error) {
	a, err := scanApp(s.db.QueryRow(`SELECT `+appCols+` FROM apps WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return a, err
}

// AppsByOwner 列出某开发者的应用。
func (s *Store) AppsByOwner(ownerID int64) ([]*App, error) {
	return s.queryApps(`SELECT `+appCols+` FROM apps WHERE owner_id=? ORDER BY updated_at DESC`, ownerID)
}

// AppsByStatus 列出某状态的应用；status 为空时返回全部。
func (s *Store) AppsByStatus(status string) ([]*App, error) {
	if status == "" {
		return s.queryApps(`SELECT ` + appCols + ` FROM apps ORDER BY updated_at DESC`)
	}
	return s.queryApps(`SELECT `+appCols+` FROM apps WHERE status=? ORDER BY updated_at DESC`, status)
}

// PublishedApps 返回已上架的应用，用于生成商店索引。
func (s *Store) PublishedApps() ([]*App, error) {
	return s.queryApps(`SELECT ` + appCols + ` FROM apps WHERE status='published' ORDER BY app_id`)
}

func (s *Store) queryApps(q string, args ...any) ([]*App, error) {
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*App
	for rows.Next() {
		a, err := scanApp(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// UpsertApp 由开发者创建或更新草稿。提交包时写入包路径与摘要。
func (s *Store) UpsertApp(a *App) error {
	now := nowUTC()
	if a.ID == 0 {
		res, err := s.db.Exec(`INSERT INTO apps(owner_id, app_id, name, summary, description, category,
			author, homepage, repo_url, version, package_path, package_size, package_sha, icon_path,
			status, review_note, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			a.OwnerID, a.AppID, a.Name, a.Summary, a.Description, a.Category, a.Author, a.Homepage,
			a.RepoURL, a.Version, a.PackagePath, a.PackageSize, a.PackageSHA, a.IconPath, a.Status, "", now, now)
		if err != nil {
			if strings.Contains(err.Error(), "UNIQUE") {
				return fmt.Errorf("应用 id「%s」已被占用", a.AppID)
			}
			return err
		}
		a.ID, _ = res.LastInsertId()
		return nil
	}
	_, err := s.db.Exec(`UPDATE apps SET name=?, summary=?, description=?, category=?, author=?,
		homepage=?, repo_url=?, version=?, package_path=?, package_size=?, package_sha=?, icon_path=?,
		status=?, updated_at=? WHERE id=?`,
		a.Name, a.Summary, a.Description, a.Category, a.Author, a.Homepage, a.RepoURL, a.Version,
		a.PackagePath, a.PackageSize, a.PackageSHA, a.IconPath, a.Status, now, a.ID)
	return err
}

// SetStatus 更新应用状态并记录审核时间。
func (s *Store) SetStatus(id int64, status, note string) error {
	now := nowUTC()
	var err error
	switch status {
	case "approved", "rejected", "pending":
		_, err = s.db.Exec(`UPDATE apps SET status=?, review_note=?, reviewed_at=?, updated_at=? WHERE id=?`,
			status, note, now, now, id)
	case "published":
		_, err = s.db.Exec(`UPDATE apps SET status=?, review_note=?, published_at=?, updated_at=? WHERE id=?`,
			status, note, now, now, id)
	default:
		return ErrBadState
	}
	return err
}

// DeleteApp 删除应用（仅草稿或被驳回时允许）。
func (s *Store) DeleteApp(id int64) error {
	_, err := s.db.Exec(`DELETE FROM apps WHERE id=?`, id)
	return err
}

// ageString 把时间转成“x 分钟前”这类易读文本。
func ageString(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "刚刚"
	case d < time.Hour:
		return fmt.Sprintf("%d 分钟前", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%d 小时前", int(d.Hours()))
	default:
		return fmt.Sprintf("%d 天前", int(d.Hours()/24))
	}
}
