// Package antifraud — защита от брутфорса и DDoS (TZ FR-ABF-01…09).
//
// В целевой архитектуре этот движок работает на Rust (crypto-core,
// /v1/ratelimit/check и /v1/fraud/score, см. docs/architecture.md §2.2).
// Здесь — идентичная по семантике реализация на Go: она используется как
// fallback и как референс для портирования.
package antifraud

import (
	"strings"
	"sync"
	"time"
)

// Profile — профиль лимитов (docs/security.md §8).
type Profile struct {
	Name       string
	LimitPerMin float64 // устойчивая скорость (токенов в минуту)
	Burst      float64   // размер ведра
	BlockAfter int       // сколько отказов подряд приводят к временному бану
	BlockFor   time.Duration
}

// Стандартные профили.
var (
	ProfilePublic   = Profile{Name: "public", LimitPerMin: 60, Burst: 20}
	ProfileAuth     = Profile{Name: "auth", LimitPerMin: 10, Burst: 5, BlockAfter: 20, BlockFor: 15 * time.Minute}
	Profile2FA      = Profile{Name: "2fa", LimitPerMin: 12, Burst: 2, BlockAfter: 10, BlockFor: 30 * time.Minute}
	ProfilePayment  = Profile{Name: "payment", LimitPerMin: 10, Burst: 4}
	ProfileWrite    = Profile{Name: "write", LimitPerMin: 120, Burst: 40}
	ProfileAdmin    = Profile{Name: "admin", LimitPerMin: 120, Burst: 40}
	ProfileWSConn   = Profile{Name: "ws-connect", LimitPerMin: 5, Burst: 3, BlockAfter: 10, BlockFor: 10 * time.Minute}
	ProfileWSMsg    = Profile{Name: "ws-msg", LimitPerMin: 60, Burst: 20}
	// ProfileChatMsg — отправка сообщений в чат (FR-MSG-10): 100/мин,
	// после 3 отказов подряд — мут на 30 минут.
	ProfileChatMsg = Profile{Name: "chat-msg", LimitPerMin: 100, Burst: 30,
		BlockAfter: 3, BlockFor: 30 * time.Minute}
	ProfileRegister = Profile{Name: "register", LimitPerMin: 3, Burst: 3, BlockAfter: 3, BlockFor: 24 * time.Hour}
	ProfileSearch   = Profile{Name: "search", LimitPerMin: 30, Burst: 10}
)

type bucket struct {
	tokens     float64
	updated    time.Time
	rejects    int
	blockedTil time.Time
}

// Limiter — распределённый token bucket (в MVP — в памяти процесса;
// в проде — Redis-счётчики, см. docs/security.md §8).
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	hits    map[string]int
	blocks  map[string]int
}

// NewLimiter создаёт лимитер.
func NewLimiter() *Limiter {
	return &Limiter{buckets: map[string]*bucket{}, hits: map[string]int{}, blocks: map[string]int{}}
}

// Decision — результат проверки.
type Decision struct {
	Allowed    bool
	Remaining  int
	Limit      int
	ResetIn    time.Duration
	RetryAfter time.Duration
	Profile    string
	Blocked    bool
}

// Allow проверяет ключ (например "auth:ip:1.2.3.4") по профилю.
func (l *Limiter) Allow(key string, p Profile) Decision {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: p.Burst, updated: now}
		l.buckets[key] = b
	}
	// Пополнение ведра.
	elapsed := now.Sub(b.updated).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * (p.LimitPerMin / 60.0)
		if b.tokens > p.Burst {
			b.tokens = p.Burst
		}
		b.updated = now
	}

	l.hits[p.Name]++
	d := Decision{Limit: int(p.Burst), Profile: p.Name}

	if !b.blockedTil.IsZero() && now.Before(b.blockedTil) {
		l.blocks[p.Name]++
		d.Blocked = true
		d.RetryAfter = b.blockedTil.Sub(now).Round(time.Second)
		return d
	}
	if b.tokens < 1 {
		b.rejects++
		l.blocks[p.Name]++
		need := 1 - b.tokens
		d.RetryAfter = time.Duration(need/(p.LimitPerMin/60.0)*float64(time.Second)).Round(time.Second)
		if d.RetryAfter < time.Second {
			d.RetryAfter = time.Second
		}
		if p.BlockAfter > 0 && b.rejects >= p.BlockAfter {
			b.blockedTil = now.Add(p.BlockFor)
			b.rejects = 0
			d.Blocked = true
			d.RetryAfter = p.BlockFor
		}
		return d
	}

	b.tokens--
	b.rejects = 0
	d.Allowed = true
	d.Remaining = int(b.tokens)
	if p.LimitPerMin > 0 {
		d.ResetIn = time.Duration(float64(time.Minute)/p.LimitPerMin).Round(time.Millisecond)
	}
	return d
}

// Block блокирует ключ вручную (например, IP по решению админа).
func (l *Limiter) Block(key string, d time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{updated: time.Now()}
		l.buckets[key] = b
	}
	b.blockedTil = time.Now().Add(d)
}

// Unblock снимает блокировку.
func (l *Limiter) Unblock(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if b, ok := l.buckets[key]; ok {
		b.blockedTil = time.Time{}
		b.rejects = 0
	}
}

// IsBlocked сообщает, заблокирован ли ключ.
func (l *Limiter) IsBlocked(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok || b.blockedTil.IsZero() {
		return false, 0
	}
	rest := time.Until(b.blockedTil)
	if rest <= 0 {
		return false, 0
	}
	return true, rest.Round(time.Second)
}

// Stats возвращает счётчики для метрик и админ-дашборда.
func (l *Limiter) Stats() map[string]map[string]int {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := map[string]map[string]int{}
	for name, v := range l.hits {
		m := out[name]
		if m == nil {
			m = map[string]int{}
			out[name] = m
		}
		m["hits"] = v
		m["blocked"] = l.blocks[name]
	}
	return out
}

// GC удаляет неактивные ведра (вызывается периодически).
func (l *Limiter) GC(olderThan time.Duration) int {
	cutoff := time.Now().Add(-olderThan)
	l.mu.Lock()
	defer l.mu.Unlock()
	removed := 0
	for k, b := range l.buckets {
		if b.updated.Before(cutoff) && b.blockedTil.Before(cutoff) {
			delete(l.buckets, k)
			removed++
		}
	}
	return removed
}

// ---------------------------------------------------------------------------
// Анти-брутфорс входов (docs/security.md §7.1)
// ---------------------------------------------------------------------------

// LoginThresholds — политика лока.
type LoginThresholds struct {
	CaptchaAfter   int
	LockAfter      int
	LockFor        time.Duration
	HardLockAfter  int
	HardLockFor    time.Duration
	Window         time.Duration
}

// DefaultLoginThresholds — значения по умолчанию (FR-ABF-01).
func DefaultLoginThresholds() LoginThresholds {
	return LoginThresholds{
		CaptchaAfter:  3,
		LockAfter:     5,
		LockFor:       15 * time.Minute,
		HardLockAfter: 15,
		HardLockFor:   24 * time.Hour,
		Window:        15 * time.Minute,
	}
}

type attemptState struct {
	fails      []time.Time
	lockedTil  time.Time
	totalFails int
}

// LoginGuard — учёт неудачных попыток входа/2FA.
type LoginGuard struct {
	mu     sync.Mutex
	states map[string]*attemptState
	th     LoginThresholds
}

// NewLoginGuard создаёт стража с заданными порогами.
func NewLoginGuard(th LoginThresholds) *LoginGuard {
	return &LoginGuard{states: map[string]*attemptState{}, th: th}
}

// GuardState — состояние проверки.
type GuardState struct {
	Locked      bool
	RetryAfter  time.Duration
	Captcha     bool
	Fails       int
	TotalFails  int
}

// RegisterFail фиксирует неудачу и возвращает состояние.
func (g *LoginGuard) RegisterFail(key string) GuardState {
	now := time.Now()
	g.mu.Lock()
	defer g.mu.Unlock()
	st, ok := g.states[key]
	if !ok {
		st = &attemptState{}
		g.states[key] = st
	}
	st.fails = append(st.fails, now)
	st.totalFails++
	// Оставляем только попытки в пределах окна.
	cutoff := now.Add(-g.th.Window)
	kept := st.fails[:0]
	for _, t := range st.fails {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	st.fails = kept

	res := GuardState{Fails: len(st.fails), TotalFails: st.totalFails}
	switch {
	case st.totalFails >= g.th.HardLockAfter:
		st.lockedTil = now.Add(g.th.HardLockFor)
	case len(st.fails) >= g.th.LockAfter:
		st.lockedTil = now.Add(g.th.LockFor)
	}
	if !st.lockedTil.IsZero() && st.lockedTil.After(now) {
		res.Locked = true
		res.RetryAfter = st.lockedTil.Sub(now).Round(time.Second)
	}
	res.Captcha = len(st.fails) >= g.th.CaptchaAfter
	return res
}

// RegisterSuccess сбрасывает счётчики ключа.
func (g *LoginGuard) RegisterSuccess(key string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.states, key)
}

// State возвращает текущее состояние без фиксации неудачи.
func (g *LoginGuard) State(key string) GuardState {
	now := time.Now()
	g.mu.Lock()
	defer g.mu.Unlock()
	st, ok := g.states[key]
	if !ok {
		return GuardState{}
	}
	res := GuardState{Fails: len(st.fails), TotalFails: st.totalFails}
	if !st.lockedTil.IsZero() && st.lockedTil.After(now) {
		res.Locked = true
		res.RetryAfter = st.lockedTil.Sub(now).Round(time.Second)
	}
	res.Captcha = len(st.fails) >= g.th.CaptchaAfter
	return res
}

// Reset снимает лок (действие поддержки).
func (g *LoginGuard) Reset(key string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.states, key)
}

// ---------------------------------------------------------------------------
// Скоринг риска (docs/security.md §7.2)
// ---------------------------------------------------------------------------

// Signals — признаки для скоринга.
type Signals struct {
	LoginFails        int
	AccountAgeHours   int
	IPReputation      string // clean|vpn|tor|hosting|banned
	GeoMismatch       bool
	NewDevice         bool
	WeakPassword      bool
	DisputeRatePct    float64
	RegistrationBurst int
	MessageRatePerMin int
}

// ScoreResult — результат скоринга.
type ScoreResult struct {
	Score   int      `json:"score"`
	Action  string   `json:"action"` // allow|captcha|delay|deny|manual_review
	Reasons []string `json:"reasons"`
}

// Score считает риск-балл 0…1000 и рекомендуемое действие.
func Score(s Signals) ScoreResult {
	score := 0
	var reasons []string
	add := func(v int, why string) {
		score += v
		reasons = append(reasons, why)
	}

	if s.LoginFails > 0 {
		add(min(s.LoginFails*40, 240), "неудачные попытки входа")
	}
	switch strings.ToLower(s.IPReputation) {
	case "tor":
		add(300, "вход из Tor")
	case "hosting":
		add(200, "вход из хостинг-ASN")
	case "vpn":
		add(80, "вход из VPN")
	case "banned":
		add(500, "IP в бан-листе")
	}
	if s.GeoMismatch {
		add(120, "несовпадение IP-гео и профиля")
	}
	if s.NewDevice {
		add(60, "новое устройство")
	}
	if s.AccountAgeHours < 24 {
		add(100, "аккаунт младше 24 ч (прогрев)")
	}
	if s.WeakPassword {
		add(120, "пароль из списка утечек")
	}
	if s.DisputeRatePct > 30 {
		add(150, "высокая доля споров")
	}
	if s.RegistrationBurst > 3 {
		add(200, "всплеск регистраций с источника")
	}
	if s.MessageRatePerMin > 60 {
		add(120, "аномальная частота сообщений")
	}
	if score > 1000 {
		score = 1000
	}

	action := "allow"
	switch {
	case score >= 700:
		action = "deny"
	case score >= 450:
		action = "manual_review"
	case score >= 250:
		action = "delay"
	case score >= 100:
		action = "captcha"
	}
	return ScoreResult{Score: score, Action: action, Reasons: reasons}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// MaskPII маскирует чувствительные значения для логов (docs/security.md §9).
func MaskPII(kind, value string) string {
	switch kind {
	case "email":
		at := strings.IndexByte(value, '@')
		if at <= 1 {
			return "***"
		}
		return value[:1] + "***" + value[at:]
	case "address":
		if len(value) <= 8 {
			return "***"
		}
		return value[:4] + "…" + value[len(value)-4:]
	case "phone":
		if len(value) <= 4 {
			return "***"
		}
		return value[:2] + "…" + value[len(value)-2:]
	case "ip":
		parts := strings.Split(value, ".")
		if len(parts) == 4 {
			return parts[0] + "." + parts[1] + ".*.*"
		}
		return value
	}
	return "***"
}
