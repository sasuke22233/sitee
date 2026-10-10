// Package httpx — платформенные помощники HTTP-слоя: JSON, ошибки, middleware.
package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/sasuke22233/sitee/backend/internal/platform/ids"
)

// Максимальный размер тела запроса (анти-DDoS L7, см. docs/security.md §8).
const (
	MaxBodyBytes      = 8 << 20  // 8 MiB
	MaxJSONBodyBytes  = 1 << 20  // 1 MiB для JSON
	MaxMessageBytes   = 64 << 10 // 64 KiB для WS-кадра
	DefaultWriteLimit = 4 << 20
)

// APIError — доменная ошибка HTTP-слоя с машинным кодом.
type APIError struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	Status    int            `json:"status"`
	Details   map[string]any `json:"details,omitempty"`
	RequestID string         `json:"request_id,omitempty"`
	RetryAfter int           `json:"retry_after,omitempty"`
}

func (e *APIError) Error() string { return e.Code + ": " + e.Message }

// Конструкторы ошибок (коды соответствуют docs/api.md §1.1).
func NewError(status int, code, message string) *APIError {
	return &APIError{Code: code, Message: message, Status: status}
}

func BadRequest(msg string, details map[string]any) *APIError {
	return &APIError{Code: "VALIDATION", Message: msg, Status: http.StatusBadRequest, Details: details}
}

func Unauthorized(msg string) *APIError {
	return &APIError{Code: "UNAUTHENTICATED", Message: msg, Status: http.StatusUnauthorized}
}

func Forbidden(code, msg string) *APIError {
	return &APIError{Code: code, Message: msg, Status: http.StatusForbidden}
}

func NotFound(msg string) *APIError {
	return &APIError{Code: "NOT_FOUND", Message: msg, Status: http.StatusNotFound}
}

func Conflict(code, msg string) *APIError {
	return &APIError{Code: code, Message: msg, Status: http.StatusConflict}
}

func Unprocessable(code, msg string) *APIError {
	return &APIError{Code: code, Message: msg, Status: http.StatusUnprocessableEntity}
}

func Locked(msg string, retryAfter time.Duration) *APIError {
	return &APIError{Code: "LOCKED", Message: msg, Status: http.StatusLocked,
		RetryAfter: int(retryAfter.Seconds())}
}

func TooManyRequests(msg string, retryAfter time.Duration) *APIError {
	return &APIError{Code: "RATE_LIMITED", Message: msg, Status: http.StatusTooManyRequests,
		RetryAfter: int(retryAfter.Seconds())}
}

func Internal(msg string) *APIError {
	return &APIError{Code: "INTERNAL", Message: msg, Status: http.StatusInternalServerError}
}

// AsAPIError приводит произвольную ошибку к APIError.
func AsAPIError(err error) *APIError {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae
	}
	return Internal("внутренняя ошибка")
}

// envelope — внешний формат ответа с ошибкой: {"error": {...}}.
type envelope struct {
	Error *APIError `json:"error"`
}

// JSON сериализует ответ.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(true)
	_ = enc.Encode(v)
}

// Fail записывает ошибку в стандартном формате.
func Fail(w http.ResponseWriter, r *http.Request, err error) {
	ae := AsAPIError(err)
	if ae.RequestID == "" && r != nil {
		ae.RequestID = RequestIDFrom(r.Context())
	}
	if ae.Status >= 500 {
		if lg := LoggerFrom(r.Context()); lg != nil {
			lg.Error("http: внутренняя ошибка", "code", ae.Code, "path", r.URL.Path,
				"request_id", ae.RequestID, "err", err)
		}
		ae.Message = "внутренняя ошибка сервера"
	}
	if ae.RetryAfter > 0 {
		w.Header().Set("Retry-After", itoa(ae.RetryAfter))
	}
	JSON(w, ae.Status, envelope{Error: ae})
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	neg := v < 0
	if neg {
		v = -v
	}
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// Decode читает и разбирает JSON-тело с ограничением размера.
func Decode(r *http.Request, v any) error {
	if r.Body == nil {
		return BadRequest("пустое тело запроса", nil)
	}
	body := http.MaxBytesReader(nil, r.Body, MaxJSONBodyBytes)
	defer func() { _ = body.Close() }()
	dec := json.NewDecoder(body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		if errors.Is(err, io.EOF) {
			return BadRequest("пустое тело запроса", nil)
		}
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return BadRequest("тело запроса слишком большое", nil)
		}
		return BadRequest("некорректный JSON: "+err.Error(), nil)
	}
	if dec.More() {
		return BadRequest("лишние данные после JSON-объекта", nil)
	}
	return nil
}

// Page — универсальная курсорная страница ответа.
type Page[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"next_cursor,omitempty"`
	HasMore    bool   `json:"has_more"`
}

// ---------------------------------------------------------------------------
// Контекст
// ---------------------------------------------------------------------------

type ctxKey int

const (
	ctxRequestID ctxKey = iota + 1
	ctxLogger
	ctxPrincipal
	ctxStarted
)

// Principal — аутентифицированный субъект запроса.
type Principal struct {
	UserID     string
	SessionID  string
	Role       string
	Nickname   string
	ShopID     string // магазин, которым владеет пользователь (если есть)
	FactorOps  bool   // подтверждён ли фактор «операции» в этой сессии
	IsAdmin    bool
	DeviceID   string
	IP         string
	Authorized bool
}

// WithPrincipal сохраняет субъект в контексте.
func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, ctxPrincipal, p)
}

// PrincipalFrom возвращает субъект из контекста (nil для анонимных запросов).
func PrincipalFrom(ctx context.Context) *Principal {
	p, _ := ctx.Value(ctxPrincipal).(*Principal)
	return p
}

// WithRequestID сохраняет ID запроса.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxRequestID, id)
}

// RequestIDFrom возвращает ID запроса.
func RequestIDFrom(ctx context.Context) string {
	v, _ := ctx.Value(ctxRequestID).(string)
	return v
}

// WithLogger сохраняет логгер с полями запроса.
func WithLogger(ctx context.Context, lg *slog.Logger) context.Context {
	return context.WithValue(ctx, ctxLogger, lg)
}

// LoggerFrom возвращает логгер из контекста.
func LoggerFrom(ctx context.Context) *slog.Logger {
	lg, _ := ctx.Value(ctxLogger).(*slog.Logger)
	return lg
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Chain применяет middleware в порядке перечисления (первый — внешний).
func Chain(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

// RequestID добавляет X-Request-Id (или принимает входящий).
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rid := r.Header.Get("X-Request-Id")
		if rid == "" || len(rid) > 64 {
			rid = "req_" + ids.New("")
		}
		w.Header().Set("X-Request-Id", rid)
		next.ServeHTTP(w, r.WithContext(WithRequestID(r.Context(), rid)))
	})
}

// LoggerMiddleware логирует каждый запрос в structured-виде.
func LoggerMiddleware(log *slog.Logger) func(http.Handler) http.Handler {
	var counter atomic.Int64
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rid := RequestIDFrom(r.Context())
			lg := log.With("request_id", rid, "route", r.URL.Path, "n", counter.Add(1))
			w = &statusRecorder{ResponseWriter: w, status: 200}
			next.ServeHTTP(w, r.WithContext(WithLogger(r.Context(), lg)))
			rec, _ := w.(*statusRecorder)
			status := http.StatusOK
			written := 0
			if rec != nil {
				status = rec.status
				written = rec.written
			}
			level := slog.LevelInfo
			switch {
			case status >= 500:
				level = slog.LevelError
			case status >= 400:
				level = slog.LevelWarn
			}
			lg.Log(r.Context(), level, "http",
				"method", r.Method, "status", status, "bytes", written,
				"dur_ms", time.Since(start).Milliseconds(), "ip", clientIP(r))
		})
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	written     int
	wroteHeader bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status = code
		s.wroteHeader = true
		s.ResponseWriter.WriteHeader(code)
	}
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if !s.wroteHeader {
		s.wroteHeader = true
	}
	n, err := s.ResponseWriter.Write(b)
	s.written += n
	return n, err
}

// Flush поддерживает streaming/hijack-сценарии.
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// SecurityHeaders добавляет обязательные заголовки (docs/security.md §9).
func SecurityHeaders(frameAncestors string) func(http.Handler) http.Handler {
	if frameAncestors == "" {
		frameAncestors = "'self' https://web.telegram.org https://t.me"
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("X-Frame-Options", "DENY")
			h.Set("Referrer-Policy", "no-referrer")
			h.Set("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=(self)")
			h.Set("Cross-Origin-Opener-Policy", "same-origin")
			h.Set("Cross-Origin-Resource-Policy", "same-site")
			h.Set("Content-Security-Policy", strings.Join([]string{
				"default-src 'self'",
				"script-src 'self' 'unsafe-inline' https://telegram.org https://cdn.jsdelivr.net",
				"style-src 'self' 'unsafe-inline'",
				"img-src 'self' data: blob: https:",
				"font-src 'self' data:",
				"connect-src 'self' wss: https:",
				"frame-ancestors " + frameAncestors,
				"base-uri 'none'",
				"object-src 'none'",
				"form-action 'self'",
			}, "; "))
			if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
				h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")
			}
			next.ServeHTTP(w, r)
		})
	}
}

// CORS для локальной разработки и встраивания TMA.
func CORS(allowedOrigins []string) func(http.Handler) http.Handler {
	allow := map[string]bool{}
	for _, o := range allowedOrigins {
		allow[strings.TrimRight(o, "/")] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && (allow["*"] || allow[strings.TrimRight(origin, "/")]) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Access-Control-Allow-Headers",
					"Authorization, Content-Type, Idempotency-Key, X-Client, X-Request-Id")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Max-Age", "600")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// Recover перехватывает паники и возвращает 500 без раскрытия стека клиенту.
func Recover(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					log.Error("panic в обработчике", "err", rec, "path", r.URL.Path,
						"request_id", RequestIDFrom(r.Context()))
					Fail(w, r, Internal("внутренняя ошибка сервера"))
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// ClientIP извлекает IP клиента с учётом доверенного прокси.
func ClientIP(r *http.Request) string { return clientIP(r) }

func clientIP(r *http.Request) string {
	if v := r.Header.Get("CF-Connecting-IP"); v != "" {
		return strings.TrimSpace(v)
	}
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	if i := strings.LastIndex(r.RemoteAddr, ":"); i > 0 {
		return r.RemoteAddr[:i]
	}
	return r.RemoteAddr
}
