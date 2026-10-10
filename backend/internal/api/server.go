// Package api — HTTP/WS-слой SITEE: маршрутизация, middleware и обработчики
// доменных операций (auth/2FA, магазины и аренда, товары, заказы и эскроу,
// мессенджер и E2EE, споры и арбитраж, кошелёк/обмен/звёзды/подарки, отзывы,
// админ-панель).
//
// В целевой архитектуре (docs/architecture.md §3) доменная логика разнесена по
// модулям internal/auth, internal/shop, …; в MVP она укрупнена в один пакет api
// ради компактности, при сохранении тех же границ ответственности и контрактов
// (docs/api.md, docs/openapi.yaml).
package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sasuke22233/sitee/backend/internal/antifraud"
	"github.com/sasuke22233/sitee/backend/internal/config"
	"github.com/sasuke22233/sitee/backend/internal/cryptod"
	"github.com/sasuke22233/sitee/backend/internal/platform/httpx"
	"github.com/sasuke22233/sitee/backend/internal/platform/ids"
	"github.com/sasuke22233/sitee/backend/internal/platform/wsx"
	"github.com/sasuke22233/sitee/backend/internal/store"
)

// Server — композиционный корень HTTP-слоя.
type Server struct {
	Cfg     *config.Config
	Log     *slog.Logger
	Store   *store.Store
	Crypto  *cryptod.Core
	JWT     *cryptod.JWTSigner
	Limiter *antifraud.Limiter
	Guard   *antifraud.LoginGuard
	Hub     *wsx.Hub

	Started time.Time
	mux     *http.ServeMux

	wsIPMu sync.Mutex
	wsIP   map[string]int
}

// New создаёт сервер.
func New(cfg *config.Config, log *slog.Logger, st *store.Store, cr *cryptod.Core,
	jwtSigner *cryptod.JWTSigner, lim *antifraud.Limiter, guard *antifraud.LoginGuard,
	hub *wsx.Hub) *Server {
	return &Server{
		Cfg: cfg, Log: log, Store: st, Crypto: cr, JWT: jwtSigner,
		Limiter: lim, Guard: guard, Hub: hub,
		Started: time.Now(), wsIP: map[string]int{},
	}
}

// Handler возвращает корневой http.Handler со всеми middleware и маршрутами.
func (s *Server) Handler() http.Handler {
	if s.mux != nil {
		return s.mux
	}
	mux := http.NewServeMux()
	s.registerRoutes(mux)
	s.mux = mux

	var h http.Handler = mux
	h = httpx.Chain(h,
		httpx.RequestID,
		httpx.Recover(s.Log),
		httpx.LoggerMiddleware(s.Log),
		httpx.SecurityHeaders(""),
		httpx.CORS(s.Cfg.AllowedOrigins),
		s.rateLimitMiddleware,
		s.authMiddleware,
	)
	return h
}

// ---------------------------------------------------------------------------
// Маршруты (docs/api.md)
// ---------------------------------------------------------------------------

func (s *Server) registerRoutes(mux *http.ServeMux) {
	// Служебные
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /readyz", s.handleReady)
	mux.HandleFunc("GET /metrics", s.handleMetrics)

	// Конфигурация и гео
	mux.HandleFunc("GET /api/v1/auth/config", s.handleAuthConfig)
	mux.HandleFunc("GET /api/v1/geo/countries", s.handleCountries)
	mux.HandleFunc("GET /api/v1/geo/cities", s.handleCities)

	// Аутентификация и 2FA
	mux.HandleFunc("POST /api/v1/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/v1/auth/verify-contact", s.handleVerifyContact)
	mux.HandleFunc("POST /api/v1/auth/2fa/setup", s.handle2FASetup)
	mux.HandleFunc("POST /api/v1/auth/2fa/activate", s.handle2FAActivate)
	mux.HandleFunc("POST /api/v1/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/v1/auth/2fa/verify", s.handle2FAVerify)
	mux.HandleFunc("POST /api/v1/auth/telegram/init-data", s.handleTelegramInitData)
	mux.HandleFunc("POST /api/v1/auth/refresh", s.handleRefresh)
	mux.HandleFunc("POST /api/v1/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/v1/auth/me", s.handleMe)
	mux.HandleFunc("GET /api/v1/auth/sessions", s.handleSessions)
	mux.HandleFunc("DELETE /api/v1/auth/sessions/{id}", s.handleRevokeSession)
	mux.HandleFunc("POST /api/v1/auth/password/change", s.handleChangePassword)
	mux.HandleFunc("GET /api/v1/auth/events", s.handleAuthEvents)
	mux.HandleFunc("GET /api/v1/notifications", s.handleNotifications)
	mux.HandleFunc("POST /api/v1/notifications/{id}/read", s.handleNotificationRead)

	// Магазины и лента
	mux.HandleFunc("GET /api/v1/shops", s.handleListShops)
	mux.HandleFunc("POST /api/v1/shops", s.handleCreateShop)
	mux.HandleFunc("GET /api/v1/shops/{id}", s.handleGetShop)
	mux.HandleFunc("PATCH /api/v1/shops/{id}", s.handleUpdateShop)
	mux.HandleFunc("GET /api/v1/shops/{id}/stats", s.handleShopStats)
	mux.HandleFunc("GET /api/v1/categories", s.handleCategories)

	// Аренда
	mux.HandleFunc("GET /api/v1/rent/plans", s.handleRentPlans)
	mux.HandleFunc("GET /api/v1/shops/{id}/rent", s.handleGetRent)
	mux.HandleFunc("POST /api/v1/shops/{id}/rent", s.handleSubscribeRent)

	// Товары
	mux.HandleFunc("GET /api/v1/shops/{id}/products", s.handleListProducts)
	mux.HandleFunc("POST /api/v1/shops/{id}/products", s.handleCreateProduct)
	mux.HandleFunc("GET /api/v1/products/{id}", s.handleGetProduct)
	mux.HandleFunc("PATCH /api/v1/products/{id}", s.handleUpdateProduct)
	mux.HandleFunc("POST /api/v1/products/{id}/stock", s.handleAddStock)

	// Заказы
	mux.HandleFunc("GET /api/v1/orders", s.handleListOrders)
	mux.HandleFunc("POST /api/v1/orders", s.handleCreateOrder)
	mux.HandleFunc("GET /api/v1/orders/{id}", s.handleGetOrder)
	mux.HandleFunc("POST /api/v1/orders/{id}/pay", s.handlePayOrder)
	mux.HandleFunc("POST /api/v1/orders/{id}/confirm", s.handleConfirmOrder)
	mux.HandleFunc("POST /api/v1/orders/{id}/extend", s.handleExtendOrder)
	mux.HandleFunc("POST /api/v1/orders/{id}/cancel", s.handleCancelOrder)
	mux.HandleFunc("POST /api/v1/orders/{id}/deliver", s.handleDeliverOrder)
	mux.HandleFunc("POST /api/v1/orders/{id}/processing", s.handleProcessingOrder)
	mux.HandleFunc("GET /api/v1/orders/{id}/delivery", s.handleOrderDelivery)
	mux.HandleFunc("GET /api/v1/orders/{id}/history", s.handleOrderHistory)
	mux.HandleFunc("POST /api/v1/orders/{id}/review", s.handleCreateReview)

	// Споры
	mux.HandleFunc("POST /api/v1/orders/{id}/dispute", s.handleOpenDispute)
	mux.HandleFunc("GET /api/v1/disputes", s.handleListDisputes)
	mux.HandleFunc("GET /api/v1/disputes/{id}", s.handleGetDispute)
	mux.HandleFunc("POST /api/v1/disputes/{id}/escalate", s.handleEscalateDispute)
	mux.HandleFunc("POST /api/v1/disputes/{id}/resolve", s.handleResolveDispute)
	mux.HandleFunc("POST /api/v1/disputes/{id}/evidence", s.handleAddEvidence)

	// Мессенджер
	mux.HandleFunc("GET /api/v1/chats", s.handleListChats)
	mux.HandleFunc("POST /api/v1/chats", s.handleOpenChat)
	mux.HandleFunc("GET /api/v1/chats/{id}", s.handleGetChat)
	mux.HandleFunc("GET /api/v1/chats/{id}/messages", s.handleListMessages)
	mux.HandleFunc("POST /api/v1/chats/{id}/messages", s.handleSendMessage)
	mux.HandleFunc("POST /api/v1/chats/{id}/read", s.handleMarkRead)
	mux.HandleFunc("POST /api/v1/e2ee/prekeys", s.handleUploadPrekeys)
	mux.HandleFunc("GET /api/v1/e2ee/bundle/{userId}", s.handleGetBundle)
	mux.HandleFunc("POST /api/v1/e2ee/sessions", s.handleCreateSession)

	// Кошелёк, обмен, звёзды, подарки
	mux.HandleFunc("GET /api/v1/wallet", s.handleWallet)
	mux.HandleFunc("GET /api/v1/wallet/transactions", s.handleWalletTx)
	mux.HandleFunc("POST /api/v1/wallet/withdraw", s.handleWithdraw)
	mux.HandleFunc("GET /api/v1/exchange/quote", s.handleExchangeQuote)
	mux.HandleFunc("POST /api/v1/exchange", s.handleExchangeExecute)
	mux.HandleFunc("GET /api/v1/gifts", s.handleListGifts)
	mux.HandleFunc("POST /api/v1/gifts/{id}/buy", s.handleBuyGift)
	mux.HandleFunc("GET /api/v1/gifts/inventory", s.handleGiftInventory)
	mux.HandleFunc("POST /api/v1/stars/invoice", s.handleStarsInvoice)

	// Отзывы
	mux.HandleFunc("GET /api/v1/shops/{id}/reviews", s.handleListReviews)
	mux.HandleFunc("POST /api/v1/reviews/{id}/reply", s.handleReplyReview)
	mux.HandleFunc("POST /api/v1/reviews/{id}/report", s.handleReportReview)

	// WebSocket
	mux.HandleFunc("GET /ws", s.handleWS)

	// Админ-панель
	mux.HandleFunc("GET /api/v1/admin/dashboard", s.handleAdminDashboard)
	mux.HandleFunc("GET /api/v1/admin/gifts", s.handleAdminListGifts)
	mux.HandleFunc("POST /api/v1/admin/gifts", s.handleAdminCreateGift)
	mux.HandleFunc("PATCH /api/v1/admin/gifts/{id}", s.handleAdminUpdateGift)
	mux.HandleFunc("DELETE /api/v1/admin/gifts/{id}", s.handleAdminArchiveGift)
	mux.HandleFunc("GET /api/v1/admin/shops", s.handleAdminListShops)
	mux.HandleFunc("POST /api/v1/admin/shops/{id}/sanction", s.handleAdminSanction)
	mux.HandleFunc("POST /api/v1/admin/shops/{id}/verified", s.handleAdminVerified)
	mux.HandleFunc("POST /api/v1/admin/shops/{id}/rent/extend", s.handleAdminRentExtend)
	mux.HandleFunc("GET /api/v1/admin/rent/plans", s.handleAdminRentPlans)
	mux.HandleFunc("PATCH /api/v1/admin/rent/plans/{id}", s.handleAdminUpdateRentPlan)
	mux.HandleFunc("GET /api/v1/admin/disputes", s.handleAdminListDisputes)
	mux.HandleFunc("POST /api/v1/admin/disputes/{id}/assign", s.handleAdminAssignDispute)
	mux.HandleFunc("GET /api/v1/admin/orders", s.handleAdminListOrders)
	mux.HandleFunc("PATCH /api/v1/admin/orders/{id}/status", s.handleAdminSetOrderStatus)
	mux.HandleFunc("GET /api/v1/admin/moderation/products", s.handleAdminModerationQueue)
	mux.HandleFunc("POST /api/v1/admin/moderation/products/{id}/approve", s.handleAdminApproveProduct)
	mux.HandleFunc("POST /api/v1/admin/moderation/products/{id}/reject", s.handleAdminRejectProduct)
	mux.HandleFunc("GET /api/v1/admin/users", s.handleAdminListUsers)
	mux.HandleFunc("PATCH /api/v1/admin/users/{id}", s.handleAdminUpdateUser)
	mux.HandleFunc("GET /api/v1/admin/finance/reconciliation", s.handleAdminReconciliation)
	mux.HandleFunc("GET /api/v1/admin/audit", s.handleAdminAudit)
	mux.HandleFunc("GET /api/v1/admin/security/events", s.handleAdminSecurityEvents)
	mux.HandleFunc("POST /api/v1/admin/security/ip-ban", s.handleAdminIPBan)
	mux.HandleFunc("GET /api/v1/admin/settings", s.handleAdminListSettings)
	mux.HandleFunc("PATCH /api/v1/admin/settings/{key}", s.handleAdminSetSetting)

	// Dev-only: симуляция внешнего депозита SOL (в prod отключено)
	mux.HandleFunc("POST /api/v1/dev/simulate-deposit", s.handleDevSimulateDeposit)

	// Статика фронтенда (TMA)
	s.mountFrontend(mux)
}

func (s *Server) mountFrontend(mux *http.ServeMux) {
	dir := s.Cfg.FrontendDir
	if dir == "" {
		return
	}
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		s.Log.Warn("frontend: каталог не найден, статика не подключена", "dir", dir)
		return
	}
	fs := http.FileServer(http.Dir(dir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		// SPA: неизвестные пути без расширения отдаём как index.html
		if p != "/" && !strings.Contains(p, ".") {
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			fs.ServeHTTP(w, r2)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		fs.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// profileFor выбирает профиль rate-limit по пути и методу (docs/security.md §8).
func (s *Server) profileFor(r *http.Request) (antifraud.Profile, string) {
	p := r.URL.Path
	switch {
	case strings.HasPrefix(p, "/api/v1/auth/2fa"):
		return antifraud.Profile2FA, "2fa:" + r.Method + ":" + p
	case strings.HasPrefix(p, "/api/v1/auth/"):
		return antifraud.ProfileAuth, "auth:" + r.Method + ":" + p
	case strings.HasPrefix(p, "/api/v1/admin/"):
		return antifraud.ProfileAdmin, "admin:" + principalKey(r)
	case strings.HasPrefix(p, "/api/v1/wallet"), strings.HasPrefix(p, "/api/v1/exchange"),
		strings.HasPrefix(p, "/api/v1/stars"):
		return antifraud.ProfilePayment, "payment:" + principalKey(r)
	case r.Method == http.MethodPost || r.Method == http.MethodPatch || r.Method == http.MethodDelete:
		return antifraud.ProfileWrite, "write:" + principalKey(r)
	default:
		return antifraud.ProfilePublic, "public:" + httpx.ClientIP(r)
	}
}

func principalKey(r *http.Request) string {
	if p := httpx.PrincipalFrom(r.Context()); p != nil && p.UserID != "" {
		return p.UserID
	}
	return httpx.ClientIP(r)
}

func (s *Server) rateLimitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if p == "/healthz" || p == "/readyz" || p == "/metrics" || p == "/ws" {
			next.ServeHTTP(w, r)
			return
		}
		profile, key := s.profileFor(r)
		d := s.Limiter.Allow(key, profile)
		w.Header().Set("X-RateLimit-Limit", strconv.Itoa(d.Limit))
		w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(d.Remaining))
		w.Header().Set("X-RateLimit-Reset", strconv.Itoa(int(d.ResetIn.Seconds())+1))
		if !d.Allowed {
			if d.Blocked {
				httpx.Fail(w, r, httpx.Locked("источник временно заблокирован (анти-брутфорс)", d.RetryAfter))
				return
			}
			httpx.Fail(w, r, httpx.TooManyRequests("слишком много запросов", d.RetryAfter))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r)
		if token == "" {
			next.ServeHTTP(w, r)
			return
		}
		claims, err := s.JWT.Verify(token)
		if err != nil {
			if errors.Is(err, cryptod.ErrTokenExpired) {
				httpx.Fail(w, r, httpx.Unauthorized("токен истёк"))
				return
			}
			next.ServeHTTP(w, r) // невалидный токен трактуем как анонимный доступ
			return
		}
		userID, _ := claims["sub"].(string)
		sessionID, _ := claims["sid"].(string)
		var (
			user    *store.User
			session *store.Session
		)
		s.Store.Read(func() {
			user = s.Store.Users[userID]
			session = s.Store.Sessions[sessionID]
		})
		if user == nil || user.Status != store.UserActive {
			httpx.Fail(w, r, httpx.Unauthorized("сессия недействительна"))
			return
		}
		if session == nil || !session.Active(time.Now()) {
			httpx.Fail(w, r, httpx.Unauthorized("сессия истекла или отозвана"))
			return
		}
		p := &httpx.Principal{
			UserID: user.ID, SessionID: session.ID, Role: user.Role, Nickname: user.Nickname,
			FactorOps: session.FactorOpsOK, Authorized: true, DeviceID: session.DeviceID,
			IP: httpx.ClientIP(r), IsAdmin: isAdminRole(user.Role),
		}
		s.Store.Read(func() {
			for _, sh := range s.Store.Shops {
				if sh.AdminUserID == user.ID {
					p.ShopID = sh.ID
					break
				}
			}
		})
		next.ServeHTTP(w, r.WithContext(httpx.WithPrincipal(r.Context(), p)))
	})
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(h[len("Bearer "):])
	}
	if t := r.URL.Query().Get("token"); t != "" {
		return t // для WebSocket-подключения
	}
	return ""
}

func isAdminRole(role string) bool {
	switch role {
	case store.RoleModerator, store.RoleArbiter, store.RoleSuperAdmin:
		return true
	}
	return false
}

// ---------------------------------------------------------------------------
// Помощники обработчиков
// ---------------------------------------------------------------------------

func (s *Server) principal(r *http.Request) *httpx.Principal {
	return httpx.PrincipalFrom(r.Context())
}

// requireAuth возвращает аутентифицированного пользователя или пишет ошибку.
func (s *Server) requireAuth(w http.ResponseWriter, r *http.Request) (*store.User, bool) {
	p := s.principal(r)
	if p == nil || !p.Authorized {
		httpx.Fail(w, r, httpx.Unauthorized("требуется авторизация"))
		return nil, false
	}
	var u *store.User
	s.Store.Read(func() { u = s.Store.Users[p.UserID] })
	if u == nil || u.Status != store.UserActive {
		httpx.Fail(w, r, httpx.Forbidden("ACCOUNT_RESTRICTED", "аккаунт ограничен"))
		return nil, false
	}
	return u, true
}

// requireRole проверяет роль.
func (s *Server) requireRole(w http.ResponseWriter, r *http.Request, u *store.User, roles ...string) bool {
	for _, role := range roles {
		if u.Role == role {
			return true
		}
	}
	httpx.Fail(w, r, httpx.Forbidden("FORBIDDEN", "недостаточно прав"))
	return false
}

// requireOps проверяет подтверждение фактора «операции» (FR-2FA-04).
// Для сумм ниже порога допускается отсутствие фактора, если он не настроен.
func (s *Server) requireOps(w http.ResponseWriter, r *http.Request, u *store.User, operation string,
	amountLamports, amountStars int64, totpCode string) bool {

	needsOps := u.IsPrivileged() ||
		amountLamports >= s.Cfg.OpsTotThresholdLamports ||
		amountStars >= s.Cfg.OpsTotThresholdStars ||
		operationRequiresOps(operation)

	p := s.principal(r)
	sessionOK := p != nil && p.FactorOps

	if !u.HasFactor(store.FactorOps) {
		if needsOps {
			httpx.Fail(w, r, httpx.Forbidden("2FA_NOT_ENROLLED",
				"для операции «"+operation+"» требуется настроить второй фактор 2FA"))
			return false
		}
		return true
	}
	if totpCode != "" {
		ok, factorErr := s.verifyFactor(u, store.FactorOps, totpCode)
		if factorErr != nil {
			httpx.Fail(w, r, factorErr)
			return false
		}
		if !ok {
			httpx.Fail(w, r, httpx.Forbidden("TOTP_INVALID", "неверный код второго фактора"))
			return false
		}
		if p != nil {
			s.markOpsVerified(p.SessionID)
		}
		return true
	}
	if sessionOK {
		return true
	}
	if needsOps {
		httpx.Fail(w, r, httpx.Forbidden("TOTP_STEP2_REQUIRED",
			"требуется второй фактор 2FA (операции)"))
		return false
	}
	return true
}

func operationRequiresOps(op string) bool {
	switch op {
	case "withdraw", "exchange", "rent", "create_shop", "transfer_shop", "dispute_open",
		"dispute_resolve", "gift_buy", "password_change", "admin_write", "sanction":
		return true
	}
	return false
}

func (s *Server) markOpsVerified(sessionID string) {
	if sessionID == "" {
		return
	}
	s.Store.Write(func() {
		if ses, ok := s.Store.Sessions[sessionID]; ok {
			ses.FactorOpsOK = true
			ses.FactorOpsAt = time.Now().UTC()
		}
	})
}

// verifyFactor проверяет TOTP-код фактора с защитой от replay и лока.
func (s *Server) verifyFactor(u *store.User, factorName, code string) (bool, error) {
	key := "2fa:" + u.ID + ":" + factorName
	if st := s.Guard.State(key); st.Locked {
		return false, httpx.Locked("фактор 2FA временно заблокирован", st.RetryAfter)
	}
	code = strings.TrimSpace(code)
	if code == "" {
		return false, nil
	}

	var (
		ok       bool
		drift    int
		usedBk   int
	)
	s.Store.Read(func() {
		f := u.Factors[factorName]
		if f == nil || f.Status != "active" {
			return
		}
		secret, err := s.Crypto.Decrypt(store.Domain2FA, u.ID+":"+factorName, f.SecretCT)
		if err != nil {
			s.Log.Error("2fa: не удалось расшифровать секрет", "user", u.ID, "factor", factorName, "err", err)
			return
		}
		if strings.Contains(code, "-") || len(code) != 6 {
			if idx, found := s.Crypto.VerifyBackupCode(code, f.BackupHashes); found {
				if !f.BackupUsed[idx] {
					usedBk = idx
					ok = true
				}
				return
			}
		}
		if len(code) == 6 {
			ok, drift = cryptod.ValidateTOTP(secret, code, time.Now(), 1)
		}
	})
	if !ok {
		s.Guard.RegisterFail(key)
		s.recordAuthEvent(u.ID, "2fa_fail", "", "неверный код фактора "+factorName, 0)
		return false, nil
	}
	s.Store.Write(func() {
		f := u.Factors[factorName]
		if f == nil {
			return
		}
		if usedBk >= 0 {
			if f.BackupUsed == nil {
				f.BackupUsed = map[int]bool{}
			}
			f.BackupUsed[usedBk] = true
		} else {
			if f.UsedCodes == nil {
				f.UsedCodes = map[string]int64{}
			}
			f.UsedCodes[code] = time.Now().Add(2 * time.Minute).Unix()
		}
		f.Fails = 0
		f.LastUsedAt = time.Now().UTC()
	})
	s.Guard.RegisterSuccess(key)
	if drift != 0 {
		s.Log.Warn("2fa: рассинхрон часов", "user", u.ID, "factor", factorName, "drift", drift)
	}
	s.recordAuthEvent(u.ID, "2fa_ok", "", factorName, 0)
	return true, nil
}

// usedCodeLocked проверяет анти-replay журнал кодов.
func (s *Server) usedCodeLocked(f *store.Factor, code string) bool {
	if f == nil || f.UsedCodes == nil {
		return false
	}
	exp, ok := f.UsedCodes[code]
	if !ok {
		return false
	}
	if exp < time.Now().Unix() {
		delete(f.UsedCodes, code)
		return false
	}
	return true
}

// ---------------------------------------------------------------------------
// Аудит, уведомления, события WS
// ---------------------------------------------------------------------------

// audit пишет запись в неизменяемый аудит-лог с хэш-цепочкой (docs/security.md §10).
func (s *Server) audit(r *http.Request, actorID, actorRole, action, objType, objID, reason string,
	totpFactor string, before, after map[string]any) {
	ip, ua := "", ""
	if r != nil {
		ip = httpx.ClientIP(r)
		ua = r.UserAgent()
	}
	rec := &store.AuditRecord{
		ID: ids.New("aud"), TS: time.Now().UTC(), ActorID: actorID, ActorRole: actorRole,
		Action: action, ObjectType: objType, ObjectID: objID, Reason: reason, IP: ip, UA: ua,
		TotpFactor: totpFactor, Before: before, After: after,
	}
	s.Store.Write(func() {
		rec.PrevHash = s.Store.AuditHead
		rec.RecordHash = auditHash(rec)
		s.Store.AuditHead = rec.RecordHash
		s.Store.Audit = append(s.Store.Audit, rec)
	})
}

func auditHash(rec *store.AuditRecord) string {
	payload := map[string]any{
		"id": rec.ID, "ts": rec.TS.UnixNano(), "actor_id": rec.ActorID, "actor_role": rec.ActorRole,
		"action": rec.Action, "object_type": rec.ObjectType, "object_id": rec.ObjectID,
		"reason": rec.Reason, "ip": rec.IP, "totp_factor": rec.TotpFactor,
		"before": rec.Before, "after": rec.After, "prev_hash": rec.PrevHash,
	}
	b, err := json.Marshal(payload)
	if err != nil {
		b = []byte(rec.ID)
	}
	return base64.StdEncoding.EncodeToString(cryptod.HMACSHA256([]byte("sitee-audit-v1"), b))
}

// notify создаёт уведомление (идемпотентно по dedupKey) и шлёт его по WS.
func (s *Server) notify(userID, kind, title, body, dedupKey string, data map[string]any) {
	if userID == "" {
		return
	}
	n := &store.Notification{
		ID: ids.New("ntf"), UserID: userID, Channel: "inapp", Kind: kind,
		Title: title, Body: body, DedupKey: dedupKey, Data: data, CreatedAt: time.Now().UTC(),
	}
	created := false
	s.Store.Write(func() {
		list := s.Store.Notifications[userID]
		for _, ex := range list {
			if ex.DedupKey == dedupKey {
				return
			}
		}
		s.Store.Notifications[userID] = append([]*store.Notification{n}, list...)
		if u, ok := s.Store.Users[userID]; ok {
			u.UnreadChats++
		}
		created = true
	})
	if created {
		s.push(userID, "notify", map[string]any{
			"id": n.ID, "kind": kind, "title": title, "body": body, "ts": n.CreatedAt,
		})
	}
}

// push отправляет WS-событие пользователю.
func (s *Server) push(userID, t string, d any) {
	if userID == "" {
		return
	}
	frame := map[string]any{"v": 1, "t": t, "ts": time.Now().UnixMilli(), "d": d}
	b, err := json.Marshal(frame)
	if err != nil {
		return
	}
	if _, kicked := s.Hub.Send(userID, b); kicked > 0 {
		s.Log.Warn("ws: отключены медленные клиенты", "user", antifraud.MaskPII("email", userID), "kicked", kicked)
	}
}

// pushMany отправляет WS-событие нескольким пользователям.
func (s *Server) pushMany(userIDs []string, t string, d any) {
	frame := map[string]any{"v": 1, "t": t, "ts": time.Now().UnixMilli(), "d": d}
	b, err := json.Marshal(frame)
	if err != nil {
		return
	}
	s.Hub.SendMany(userIDs, b)
}

func (s *Server) recordAuthEvent(userID, event, ip, reason string, risk int) {
	ev := &store.AuthEvent{TS: time.Now().UTC(), UserID: userID, Event: event, IP: ip, Reason: reason, RiskScore: risk}
	s.Store.Write(func() {
		s.Store.AuthEvents = append(s.Store.AuthEvents, ev)
		if len(s.Store.AuthEvents) > 5000 {
			s.Store.AuthEvents = s.Store.AuthEvents[len(s.Store.AuthEvents)-5000:]
		}
	})
}

// ---------------------------------------------------------------------------
// Курсоры пагинации
// ---------------------------------------------------------------------------

func encodeCursor(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(raw string, v any) error {
	if raw == "" {
		return errors.New("пустой курсор")
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// paginate применяет курсор и лимит к срезу (курсор — индекс).
func paginate(total, limit int, cursor string) (start int, next string, hasMore bool) {
	start = 0
	if cursor != "" {
		var c struct {
			Offset int `json:"o"`
		}
		if err := decodeCursor(cursor, &c); err == nil && c.Offset > 0 {
			start = c.Offset
		}
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}
	if start > total {
		start = total
	}
	end := start + limit
	hasMore = end < total
	if hasMore {
		next = encodeCursor(map[string]int{"o": end})
	}
	if end > total {
		end = total
	}
	return start, next, hasMore
}

// endIdx возвращает фактический конец страницы (для среза).
func (s *Server) page(total, limit int, cursor string) (start, end int, next string, hasMore bool) {
	start, next, hasMore = paginate(total, limit, cursor)
	end = start + limit
	if end > total {
		end = total
	}
	return start, end, next, hasMore
}

// ---------------------------------------------------------------------------
// Служебные эндпоинты
// ---------------------------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"env":     s.Cfg.Env,
		"uptime_s": int(time.Since(s.Started).Seconds()),
		"crypto": map[string]any{
			"remote": s.Crypto.RemoteEnabled(),
			"kek_fp": s.Crypto.KEKFingerprint(),
			"ops":    s.Crypto.Ops.Load(),
			"fallbacks": s.Crypto.Fallbacks.Load(),
		},
		"ws_connections": s.Hub.Count(),
	})
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	problems := []string{}
	s.Store.Read(func() { problems = s.Store.CheckInvariantsLocked() })
	if len(problems) > 0 {
		httpx.JSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "degraded", "ledger_problems": problems,
		})
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "ready"})
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	var (
		users, shops, orders, chats, messages, disputes, gifts int
		escrowLamports, feesLamports                            int64
		stars                                                   int64
	)
	s.Store.Read(func() {
		users = len(s.Store.Users)
		shops = len(s.Store.Shops)
		orders = len(s.Store.Orders)
		chats = len(s.Store.Chats)
		for _, m := range s.Store.Messages {
			messages += len(m)
		}
		disputes = len(s.Store.Disputes)
		gifts = len(s.Store.Gifts)
		for id, a := range s.Store.Accounts {
			switch {
			case strings.HasPrefix(id, "escrow:") && a.Asset == store.AssetSOL:
				escrowLamports += a.Balance
			case strings.HasPrefix(id, "platform:fees") && a.Asset == store.AssetSOL:
				feesLamports += a.Balance
			case a.Asset == store.AssetStars && strings.HasPrefix(id, "user:"):
				stars += a.Balance
			}
		}
	})

	var b strings.Builder
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	writeMetric := func(name, help, mtype string, samples ...any) {
		b.WriteString("# HELP " + name + " " + help + "\n")
		b.WriteString("# TYPE " + name + " " + mtype + "\n")
		for i := 0; i+1 < len(samples); i += 2 {
			labels, _ := samples[i].(string)
			value, _ := samples[i+1].(float64)
			if labels == "" {
				b.WriteString(name + " " + strconv.FormatFloat(value, 'g', -1, 64) + "\n")
			} else {
				b.WriteString(name + "{" + labels + "} " + strconv.FormatFloat(value, 'g', -1, 64) + "\n")
			}
		}
	}
	writeMetric("sitee_users", "число пользователей", "gauge", "", float64(users))
	writeMetric("sitee_shops", "число магазинов", "gauge", "", float64(shops))
	writeMetric("sitee_orders", "число заказов", "gauge", "", float64(orders))
	writeMetric("sitee_chats", "число чатов", "gauge", "", float64(chats))
	writeMetric("sitee_messages", "число сообщений", "gauge", "", float64(messages))
	writeMetric("sitee_disputes", "число споров", "gauge", "", float64(disputes))
	writeMetric("sitee_gifts", "число подарков в каталоге", "gauge", "", float64(gifts))
	writeMetric("sitee_escrow_lamports", "средства в эскроу", "gauge", "", float64(escrowLamports))
	writeMetric("sitee_fees_lamports", "комиссия площадки", "counter", "", float64(feesLamports))
	writeMetric("sitee_stars_balance", "звёзды на балансах пользователей", "gauge", "", float64(stars))
	writeMetric("sitee_ws_connections", "активные WS-соединения", "gauge", "", float64(s.Hub.Count()))
	writeMetric("crypto_ops_total", "криптоопераций выполнено", "counter", "", float64(s.Crypto.Ops.Load()))
	writeMetric("crypto_fallback_total", "операций через Go-fallback", "counter", "", float64(s.Crypto.Fallbacks.Load()))
	for profile, st := range s.Limiter.Stats() {
		writeMetric("ratelimit_hits_total", "запросов по профилю", "counter",
			`profile="`+profile+`"`, float64(st["hits"]),
			`profile="`+profile+`",blocked="true"`, float64(st["blocked"]))
	}
	writeMetric("sitee_uptime_seconds", "время работы процесса", "counter", "", time.Since(s.Started).Seconds())
	_, _ = w.Write([]byte(b.String()))
}
