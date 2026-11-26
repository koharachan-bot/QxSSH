package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[portal] ")
	if err := run(); err != nil {
		log.Fatalf("启动失败：%v", err)
	}
}

func run() error {
	cfg, err := LoadConfig()
	if err != nil {
		return err
	}
	if cfg.SessionKey == "" {
		key, err := loadOrCreateSessionKey(cfg.DataDir)
		if err != nil {
			return err
		}
		cfg.SessionKey = key
	}

	st, err := OpenStore(cfg.DataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	if err := bootstrapAdmin(st, cfg); err != nil {
		return err
	}

	srv, err := newServer(cfg, st, NewCOS(cfg))
	if err != nil {
		return err
	}

	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       120 * time.Second,
		WriteTimeout:      180 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		log.Printf("开发者平台已启动，监听 %s", cfg.Addr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("监听失败：%v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return httpSrv.Shutdown(ctx)
}

// loadOrCreateSessionKey 读取（必要时生成）会话签名密钥并落盘，保证重启后登录态不失效。
func loadOrCreateSessionKey(dataDir string) (string, error) {
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		return "", err
	}
	p := filepath.Join(dataDir, "session.key")
	if b, err := os.ReadFile(p); err == nil {
		if len(b) >= 32 {
			return string(b), nil
		}
	}
	key := randomToken(32)
	if err := os.WriteFile(p, []byte(key), 0o600); err != nil {
		return "", err
	}
	return key, nil
}

// bootstrapAdmin 在数据库为空且配置了管理员密码时创建首个管理员。
func bootstrapAdmin(st *Store, cfg *Config) error {
	n, err := st.CountUsers()
	if err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	if cfg.AdminEmail == "" || cfg.AdminPass == "" {
		log.Printf("提示：尚未创建任何账号，首个在页面注册的账号将成为管理员")
		return nil
	}
	u, err := st.CreateUser(cfg.AdminEmail, cfg.AdminPass, "管理员", "admin")
	if err != nil {
		return fmt.Errorf("创建初始管理员失败：%w", err)
	}
	log.Printf("已创建初始管理员：%s（id=%d）", u.Email, u.ID)
	return nil
}
