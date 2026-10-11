// Package config — конфигурация сервиса из переменных окружения (12-factor).
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config — настройки siteed.
type Config struct {
	Env  string // dev | stage | prod
	Addr string

	// Хранилище
	DataDir          string
	SnapshotInterval time.Duration
	SeedDemo         bool

	// Криптография
	KEK             string // hex, 32 байта (пусто → случайный, только dev)
	CryptoCoreURL   string // Rust crypto-core (пусто → Go-fallback)
	CryptoCoreToken string
	JWTSeed         string // hex, 32 байта (пусто → случайный)
	JWTIssuer       string
	AccessTTL       time.Duration
	RefreshTTL      time.Duration

	// Telegram / Stars
	TGBotToken    string
	TGBotUsername string

	// Solana
	SolanaRPC        []string
	SolanaNetwork    string
	HotWalletPath    string
	HotWalletLimit   int64 // lamports
	MinDeposit       int64 // lamports
	Confirmations    int
	ConfirmationsBig int

	// Лимиты и пороги (docs/economy.md §8)
	WithdrawDailyLamports   int64
	FourEyesLamports        int64
	OpsTotThresholdLamports int64
	OpsTotThresholdStars    int64
	ExchangeFeeBPS          int
	SOLStarsRate            float64 // SOL за 1 звезду
	AutoConfirmHours        int
	PayTimeoutMinutes       int
	ReviewWindowDays        int
	DisputeReplyHours       int
	DisputeWindowDays       int
	WarmupHours             int

	// HTTP
	FrontendDir    string
	AllowedOrigins []string
	TrustProxy     bool
	ReadTimeout    time.Duration
	WriteTimeout   time.Duration
	IdleTimeout    time.Duration

	// WS
	WSMaxFrame   int
	WSSendQueue  int
	WSPingEvery  time.Duration
	WSAuthWindow time.Duration
	WSMaxPerIP   int
	WSMaxPerUser int

	LogLevel  string
	LogFormat string // json | text
}

// Load читает конфигурацию из окружения.
func Load() (*Config, error) {
	c := &Config{
		Env:              envStr("SITEED_ENV", "dev"),
		Addr:             envStr("SITEED_ADDR", "0.0.0.0:8080"),
		DataDir:          envStr("SITEED_DATA_DIR", ""),
		SnapshotInterval: envDur("SITEED_SNAPSHOT_INTERVAL", 30*time.Second),
		SeedDemo:         envBool("SITEED_SEED_DEMO", true),

		KEK:             envStr("SITEED_KEK_HEX", ""),
		CryptoCoreURL:   envStr("CRYPTO_CORE_URL", ""),
		CryptoCoreToken: envStr("CRYPTO_CORE_TOKEN", ""),
		JWTSeed:         envStr("SITEED_JWT_SEED_HEX", ""),
		JWTIssuer:       envStr("SITEED_JWT_ISSUER", "sitee"),
		AccessTTL:       envDur("SITEED_ACCESS_TTL", 15*time.Minute),
		RefreshTTL:      envDur("SITEED_REFRESH_TTL", 30*24*time.Hour),

		TGBotToken:    envStr("TG_BOT_TOKEN", ""),
		TGBotUsername: envStr("TG_BOT_USERNAME", "sitee_bot"),

		SolanaRPC:        envList("SOLANA_RPC_URLS", ""),
		SolanaNetwork:    envStr("SOLANA_NETWORK", "devnet"),
		HotWalletPath:    envStr("SOL_HOT_WALLET_PATH", "m/44'/501'/0'/0'"),
		HotWalletLimit:   envLamports("SOL_HOT_WALLET_LIMIT_SOL", "500"),
		MinDeposit:       envLamports("SOL_MIN_DEPOSIT", "0.01"),
		Confirmations:    envInt("SOL_CONFIRMATIONS", 32),
		ConfirmationsBig: envInt("SOL_CONFIRMATIONS_BIG", 64),

		WithdrawDailyLamports:   envLamports("LIMIT_WITHDRAW_DAILY_SOL", "50"),
		FourEyesLamports:        envLamports("LIMIT_FOUR_EYES_SOL", "100"),
		OpsTotThresholdLamports: envLamports("THRESHOLD_OPS_TOTP_SOL", "5"),
		OpsTotThresholdStars:    int64(envInt("THRESHOLD_OPS_TOTP_STARS", 1000)),
		ExchangeFeeBPS:          envInt("EXCHANGE_FEE_BPS", 100),
		SOLStarsRate:            envFloat("SOL_STARS_RATE", 0.005),
		AutoConfirmHours:        envInt("ORDER_AUTO_CONFIRM_HOURS", 72),
		PayTimeoutMinutes:       envInt("ORDER_PAY_TIMEOUT_MINUTES", 30),
		ReviewWindowDays:        envInt("REVIEW_WINDOW_DAYS", 30),
		DisputeReplyHours:       envInt("DISPUTE_REPLY_HOURS", 72),
		DisputeWindowDays:       envInt("DISPUTE_WINDOW_DAYS", 7),
		WarmupHours:             envInt("ACCOUNT_WARMUP_HOURS", 24),

		FrontendDir:    envStr("SITEED_FRONTEND_DIR", "frontend"),
		AllowedOrigins: envList("SITEED_ALLOWED_ORIGINS", "*"),
		TrustProxy:     envBool("SITEED_TRUST_PROXY", true),
		ReadTimeout:    envDur("SITEED_READ_TIMEOUT", 15*time.Second),
		WriteTimeout:   envDur("SITEED_WRITE_TIMEOUT", 30*time.Second),
		IdleTimeout:    envDur("SITEED_IDLE_TIMEOUT", 120*time.Second),

		WSMaxFrame:   envInt("WS_MAX_FRAME_BYTES", 64<<10),
		WSSendQueue:  envInt("WS_SEND_QUEUE", 256),
		WSPingEvery:  envDur("WS_PING_INTERVAL", 25*time.Second),
		WSAuthWindow: envDur("WS_AUTH_WINDOW", 10*time.Second),
		WSMaxPerIP:   envInt("WS_MAX_CONN_PER_IP", 5),
		WSMaxPerUser: envInt("WS_MAX_CONN_PER_USER", 10),

		LogLevel:  envStr("SITEED_LOG_LEVEL", "info"),
		LogFormat: envStr("SITEED_LOG_FORMAT", "json"),
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return c, nil
}

// Validate проверяет конфигурацию; в prod запрещает dev-послабления.
func (c *Config) Validate() error {
	if c.Addr == "" {
		return errors.New("config: SITEED_ADDR обязателен")
	}
	if c.KEK != "" && len(c.KEK) != 64 {
		return errors.New("config: SITEED_KEK_HEX должен быть 64 hex-символа (32 байта)")
	}
	if c.JWTSeed != "" && len(c.JWTSeed) != 64 {
		return errors.New("config: SITEED_JWT_SEED_HEX должен быть 64 hex-символа")
	}
	if c.Env == "prod" {
		var errs []string
		if c.KEK == "" {
			errs = append(errs, "SITEED_KEK_HEX обязателен в prod")
		}
		if c.JWTSeed == "" {
			errs = append(errs, "SITEED_JWT_SEED_HEX обязателен в prod")
		}
		if c.CryptoCoreURL == "" {
			errs = append(errs, "CRYPTO_CORE_URL обязателен в prod (Rust crypto-core)")
		}
		if len(c.SolanaRPC) == 0 {
			errs = append(errs, "SOLANA_RPC_URLS обязателен в prod")
		}
		if c.LogLevel == "debug" {
			errs = append(errs, "SITEED_LOG_LEVEL=debug запрещён в prod")
		}
		if len(errs) > 0 {
			return fmt.Errorf("config: %s", strings.Join(errs, "; "))
		}
	}
	if c.SOLStarsRate <= 0 {
		return errors.New("config: SOL_STARS_RATE должен быть > 0")
	}
	if c.ExchangeFeeBPS < 0 || c.ExchangeFeeBPS > 5000 {
		return errors.New("config: EXCHANGE_FEE_BPS вне диапазона 0…5000")
	}
	return nil
}

// IsProd сообщает, что окружение продуктовое.
func (c *Config) IsProd() bool { return c.Env == "prod" }

// PublicConfig — публичная часть конфигурации для GET /auth/config.
func (c *Config) PublicConfig() map[string]any {
	return map[string]any{
		"env":      c.Env,
		"password": map[string]any{"min_len": 12, "classes": 3, "algo": "argon2id", "mvp_algo": "pbkdf2-sha256"},
		"captcha": map[string]any{
			"provider": "turnstile", "site_key": envStr("CAPTCHA_SITE_KEY", ""),
			"required_after_fails": 3,
		},
		"2fa": map[string]any{
			"factors": []string{"login", "ops"}, "period": 30, "digits": 6, "issuer": "SITEE",
			"backup_codes": 10,
		},
		"telegram": map[string]any{"bot_username": c.TGBotUsername, "init_data_required": c.TGBotToken != ""},
		"solana": map[string]any{
			"network": c.SolanaNetwork, "min_deposit_sol": lamportsToFloat(c.MinDeposit),
			"confirmations": c.Confirmations, "confirmations_big": c.ConfirmationsBig,
		},
		"limits": map[string]any{
			"withdraw_daily_sol":       lamportsToFloat(c.WithdrawDailyLamports),
			"withdraw_four_eyes_sol":   lamportsToFloat(c.FourEyesLamports),
			"ops_totp_threshold_sol":   lamportsToFloat(c.OpsTotThresholdLamports),
			"ops_totp_threshold_stars": c.OpsTotThresholdStars,
			"exchange_fee_bps":         c.ExchangeFeeBPS,
			"order_auto_confirm_hours": c.AutoConfirmHours,
			"review_window_days":       c.ReviewWindowDays,
			"warmup_hours":             c.WarmupHours,
		},
		"features": map[string]any{
			"stars": true, "sol": true, "exchange": true, "gifts": true,
			"e2ee": true, "crypto_core_remote": c.CryptoCoreURL != "",
		},
		"ws": map[string]any{
			"max_frame_bytes": c.WSMaxFrame, "ping_interval_s": int(c.WSPingEvery.Seconds()),
			"auth_window_s":   int(c.WSAuthWindow.Seconds()),
			"max_conn_per_ip": c.WSMaxPerIP, "max_conn_per_user": c.WSMaxPerUser,
		},
	}
}

func lamportsToFloat(v int64) float64 { return float64(v) / 1e9 }

// ---------------------------------------------------------------------------
// env-хелперы
// ---------------------------------------------------------------------------

func envStr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func envInt(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func envFloat(key string, def float64) float64 {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return def
	}
	return f
}

func envDur(key string, def time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}

func envList(key, def string) []string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		v = def
	}
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// envLamports принимает значение в SOL ("1.5") и возвращает lamports.
func envLamports(key, def string) int64 {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		v = def
	}
	neg := strings.HasPrefix(v, "-")
	v = strings.TrimPrefix(v, "-")
	intPart, fracPart := v, ""
	if i := strings.IndexByte(v, '.'); i >= 0 {
		intPart, fracPart = v[:i], v[i+1:]
	}
	if intPart == "" {
		intPart = "0"
	}
	ip, err := strconv.ParseInt(intPart, 10, 63)
	if err != nil {
		return 0
	}
	for len(fracPart) < 9 {
		fracPart += "0"
	}
	if len(fracPart) > 9 {
		fracPart = fracPart[:9]
	}
	fp, err := strconv.ParseInt(fracPart, 10, 63)
	if err != nil {
		return 0
	}
	res := ip*1_000_000_000 + fp
	if neg {
		return -res
	}
	return res
}
