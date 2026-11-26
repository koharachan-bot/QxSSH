package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

// APIKey 是供脚本/CI 使用的长期凭据，代表某个用户身份。
type APIKey struct {
	ID         int64
	UserID     int64
	Name       string
	Prefix     string
	CreatedAt  time.Time
	LastUsedAt time.Time
	Revoked    bool
}

// apiKeyPrefix 是明文前缀，便于用户在日志/列表里辨认是哪一把。
const apiKeyPrefix = "qxk_"

func hashAPIKey(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}

// CreateAPIKey 生成一把新 Key，返回明文与记录。明文只在这里返回一次。
func (s *Store) CreateAPIKey(userID int64, name string) (string, *APIKey, error) {
	plain := apiKeyPrefix + randomToken(24)
	prefix := plain[:12]
	now := nowUTC()
	res, err := s.db.Exec(`INSERT INTO api_keys(user_id, name, key_hash, prefix, created_at) VALUES(?,?,?,?,?)`,
		userID, strings.TrimSpace(name), hashAPIKey(plain), prefix, now)
	if err != nil {
		return "", nil, err
	}
	id, _ := res.LastInsertId()
	return plain, &APIKey{
		ID: id, UserID: userID, Name: strings.TrimSpace(name), Prefix: prefix,
		CreatedAt: toTime(now),
	}, nil
}

// ListAPIKeys 列出某用户的 Key（不含明文）。
func (s *Store) ListAPIKeys(userID int64) ([]APIKey, error) {
	rows, err := s.db.Query(`SELECT id, user_id, name, prefix, created_at, last_used_at, revoked
		FROM api_keys WHERE user_id=? ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []APIKey
	for rows.Next() {
		var k APIKey
		var created, used int64
		var revoked int
		if err := rows.Scan(&k.ID, &k.UserID, &k.Name, &k.Prefix, &created, &used, &revoked); err != nil {
			return nil, err
		}
		k.CreatedAt = toTime(created)
		if used > 0 {
			k.LastUsedAt = toTime(used)
		}
		k.Revoked = revoked != 0
		out = append(out, k)
	}
	return out, rows.Err()
}

// RevokeAPIKey 作废一把 Key，只能操作自己的。
func (s *Store) RevokeAPIKey(userID, id int64) error {
	res, err := s.db.Exec(`UPDATE api_keys SET revoked=1 WHERE id=? AND user_id=?`, id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// UserByAPIKey 用明文 Key 换用户；同时刷新 last_used_at。
func (s *Store) UserByAPIKey(plain string) (*User, error) {
	plain = strings.TrimSpace(plain)
	if !strings.HasPrefix(plain, apiKeyPrefix) {
		return nil, ErrNotFound
	}
	h := hashAPIKey(plain)
	var id, userID int64
	var revoked int
	err := s.db.QueryRow(`SELECT id, user_id, revoked FROM api_keys WHERE key_hash=?`, h).
		Scan(&id, &userID, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if revoked != 0 {
		return nil, ErrNotFound
	}
	// 定长比较再确认一次，避免哈希比较被时序侧信道利用。
	if subtle.ConstantTimeCompare([]byte(h), []byte(hashAPIKey(plain))) != 1 {
		return nil, ErrNotFound
	}
	_, _ = s.db.Exec(`UPDATE api_keys SET last_used_at=? WHERE id=?`, nowUTC(), id)
	return s.UserByID(userID)
}
