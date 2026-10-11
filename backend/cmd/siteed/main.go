// Command siteed — API/WS-сервер SITEE (Go).
//
// Запуск:
//
//	SITEED_ENV=dev SITEED_ADDR=0.0.0.0:8080 go run ./cmd/siteed
//
// В dev-режиме сервер поднимает in-memory хранилище с демо-данными
// (SITEED_SEED_DEMO=true по умолчанию) и печатает тестовые учётные записи
// вместе с TOTP-секретами обоих факторов 2FA.
package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/sasuke22233/sitee/backend/internal/antifraud"
	"github.com/sasuke22233/sitee/backend/internal/api"
	"github.com/sasuke22233/sitee/backend/internal/config"
	"github.com/sasuke22233/sitee/backend/internal/cryptod"
	"github.com/sasuke22233/sitee/backend/internal/platform/wsx"
	"github.com/sasuke22233/sitee/backend/internal/seed"
	"github.com/sasuke22233/sitee/backend/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "siteed: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("конфигурация: %w", err)
	}
	log := newLogger(cfg)
	if err := cfg.Validate(); err != nil {
		return err
	}
	log.Info("siteed: конфигурация загружена",
		"env", cfg.Env, "addr", cfg.Addr, "data_dir", orNone(cfg.DataDir),
		"crypto_core", orNone(cfg.CryptoCoreURL), "solana", cfg.SolanaNetwork,
		"seed_demo", cfg.SeedDemo, "log_level", cfg.LogLevel)

	st := store.New(cfg.DataDir)
	if loaded, lerr := st.LoadSnapshot(); lerr != nil {
		log.Warn("siteed: снимок состояния не загружен, начинаем с чистого хранилища", "err", lerr)
	} else if loaded {
		log.Info("siteed: состояние восстановлено из снимка", "path", cfg.DataDir)
	}

	core, err := cryptod.New(cfg.KEK, cfg.CryptoCoreURL, cfg.CryptoCoreToken)
	if err != nil {
		return fmt.Errorf("криптоядро: %w", err)
	}
	var jwtSeed []byte
	if cfg.JWTSeed != "" {
		jwtSeed, err = hex.DecodeString(cfg.JWTSeed)
		if err != nil {
			return fmt.Errorf("SITEED_JWT_SEED_HEX должен быть hex: %w", err)
		}
	}
	signer, err := cryptod.NewJWTSigner(jwtSeed, cfg.JWTIssuer)
	if err != nil {
		return fmt.Errorf("подписант JWT: %w", err)
	}
	log.Info("siteed: ключи готовы",
		"kek_fingerprint", core.KEKFingerprint(), "jwt_kid", signer.Kid(),
		"crypto_core_remote", core.RemoteEnabled(),
		"note", "KEK никогда не логируется и не покидает процесс (docs/security.md §3)")

	srv := api.New(cfg, log, st, core, signer,
		antifraud.NewLimiter(),
		antifraud.NewLoginGuard(antifraud.DefaultLoginThresholds()),
		wsx.NewHub())

	if cfg.SeedDemo {
		res, serr := seed.Demo(st, core, cfg, log)
		if serr != nil {
			return fmt.Errorf("демо-данные: %w", serr)
		}
		if res != nil && !cfg.IsProd() {
			printDemoCredentials(log, res)
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go srv.RunBackground(ctx)

	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadTimeout:       cfg.ReadTimeout,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      cfg.WriteTimeout,
		IdleTimeout:       cfg.IdleTimeout,
		MaxHeaderBytes:    1 << 20,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelError),
	}

	serverErr := make(chan error, 1)
	go func() {
		log.Info("siteed: HTTP/WS-сервер запущен",
			"addr", cfg.Addr, "health", "http://"+listenHost(cfg.Addr)+"/healthz",
			"api", "http://"+listenHost(cfg.Addr)+"/api/v1/shops",
			"ws", "ws://"+listenHost(cfg.Addr)+"/ws?token=<access>")
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	select {
	case err := <-serverErr:
		stop()
		return fmt.Errorf("сервер: %w", err)
	case <-ctx.Done():
		log.Info("siteed: получен сигнал остановки, завершаем gracefully")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		log.Error("siteed: завершение с ошибкой", "err", err)
		_ = httpSrv.Close()
	}
	if err := st.SaveSnapshot(); err != nil && cfg.DataDir != "" {
		log.Error("siteed: финальный снимок не сохранён", "err", err)
	}
	log.Info("siteed: остановлен", "uptime_s", int(time.Since(srv.Started).Seconds()))
	return nil
}

func newLogger(cfg *config.Config) *slog.Logger {
	level := slog.LevelInfo
	switch strings.ToLower(cfg.LogLevel) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	opts := &slog.HandlerOptions{Level: level}
	var handler slog.Handler
	if cfg.LogFormat == "json" {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	} else {
		handler = slog.NewTextHandler(os.Stdout, opts)
	}
	return slog.New(handler).With("service", "siteed", "env", cfg.Env)
}

func listenHost(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return "0.0.0.0" + addr
	}
	return addr
}

func orNone(v string) string {
	if strings.TrimSpace(v) == "" {
		return "—"
	}
	return v
}

// printDemoCredentials печатает тестовые учётные записи (только dev/stage).
func printDemoCredentials(log *slog.Logger, res *seed.Result) {
	log.Info("════════════════════════════════════════════════════════════════")
	log.Info("SITEE — демо-доступы (не использовать в prod)")
	log.Info("════════════════════════════════════════════════════════════════")
	for _, u := range res.Users {
		log.Info("демо-пользователь",
			"role", u.Role,
			"email", u.Email,
			"password", u.Password,
			"nickname", u.Nickname,
			"country", u.Country,
			"balance_sol", u.BalanceSOL,
			"balance_stars", u.BalanceStars,
			"2fa_login_secret", u.LoginSecret,
			"2fa_ops_secret", u.OpsSecret,
			"2fa_login_backup", strings.Join(first3(u.LoginBackup), ","),
			"2fa_ops_backup", strings.Join(first3(u.OpsBackup), ","),
			"shops", strings.Join(u.ShopIDs, ","))
	}
	log.Info("демо-данные",
		"shops", res.Counters["shops"], "products", res.Counters["products"],
		"orders", res.Counters["orders"], "disputes", res.Counters["disputes"],
		"gifts", res.Counters["gifts"], "chats", res.Counters["chats"],
		"messages", res.Counters["messages"], "reviews", res.Counters["reviews"])
	log.Info("подсказка: TOTP-секреты можно добавить в Google Authenticator",
		"login_label", "SITEE (вход)", "ops_label", "SITEE (операции)",
		"otpauth_example", res.Users[0].LoginOTPURL)
	log.Info("════════════════════════════════════════════════════════════════")
}

func first3(list []string) []string {
	if len(list) > 3 {
		return list[:3]
	}
	return list
}
