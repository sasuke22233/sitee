package api

import (
	"crypto/hmac"
	"encoding/json"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/sasuke22233/sitee/backend/internal/antifraud"
	"github.com/sasuke22233/sitee/backend/internal/cryptod"
	"github.com/sasuke22233/sitee/backend/internal/platform/httpx"
	"github.com/sasuke22233/sitee/backend/internal/platform/ids"
	"github.com/sasuke22233/sitee/backend/internal/store"
)

// ---------------------------------------------------------------------------
// Конфигурация и гео (FR-GEO-*, FR-AUTH-01)
// ---------------------------------------------------------------------------

func (s *Server) handleAuthConfig(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, s.Cfg.PublicConfig())
}

func (s *Server) handleCountries(w http.ResponseWriter, r *http.Request) {
	items := []store.Country{}
	s.Store.Read(func() {
		for _, c := range s.Store.Countries {
			if !c.Blocked {
				items = append(items, *c)
			}
		}
	})
	sort.Slice(items, func(i, j int) bool { return items[i].NameRU < items[j].NameRU })
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleCities(w http.ResponseWriter, r *http.Request) {
	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	items := []store.City{}
	s.Store.Read(func() {
		for _, c := range s.Store.Cities {
			if country != "" && c.Country != country {
				continue
			}
			if q != "" && !strings.Contains(strings.ToLower(c.NameRU), q) &&
				!strings.Contains(strings.ToLower(c.NameEN), q) {
				continue
			}
			items = append(items, *c)
			if len(items) >= 50 {
				break
			}
		}
	})
	sort.Slice(items, func(i, j int) bool { return items[i].Population > items[j].Population })
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleCategories(w http.ResponseWriter, r *http.Request) {
	items := []store.Category{}
	s.Store.Read(func() {
		for _, c := range s.Store.Categories {
			items = append(items, *c)
		}
	})
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// ---------------------------------------------------------------------------
// Регистрация (FR-AUTH-02…05)
// ---------------------------------------------------------------------------

type registerRequest struct {
	Email          string `json:"email"`
	Nickname       string `json:"nickname"`
	Password       string `json:"password"`
	PasswordConfirm string `json:"password_confirm"`
	CountryCode    string `json:"country_code"`
	CityID         int64  `json:"city_id"`
	AcceptTerms    bool   `json:"accept_terms"`
	Is18Plus       bool   `json:"is_18plus"`
	ReferralCode   string `json:"referral_code"`
	CaptchaToken   string `json:"captcha_token"`
	Locale         string `json:"locale"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	ip := httpx.ClientIP(r)

	// Анти-брутфорс регистраций (FR-ABF-07).
	if d := s.Limiter.Allow("register:"+ip, antifraud.ProfileRegister); !d.Allowed {
		httpx.Fail(w, r, httpx.TooManyRequests("слишком много регистраций с этого адреса", d.RetryAfter))
		return
	}
	if st := s.Guard.State("register:" + ip); st.Locked {
		httpx.Fail(w, r, httpx.Locked("регистрация временно заблокирована", st.RetryAfter))
		return
	}

	var req registerRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.Nickname = strings.ToLower(strings.TrimSpace(req.Nickname))

	if !req.AcceptTerms {
		httpx.Fail(w, r, httpx.BadRequest("необходимо принять условия сервиса", nil))
		return
	}
	if !req.Is18Plus {
		httpx.Fail(w, r, httpx.BadRequest("регистрация доступна с 18 лет", nil))
		return
	}
	if req.Email == "" && req.Nickname == "" {
		httpx.Fail(w, r, httpx.BadRequest("укажите email или nickname", nil))
		return
	}
	if len(req.Nickname) < 3 || len(req.Nickname) > 24 {
		httpx.Fail(w, r, httpx.BadRequest("nickname: 3–24 символа", nil))
		return
	}
	for _, ch := range req.Nickname {
		if !((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_') {
			httpx.Fail(w, r, httpx.BadRequest("nickname: только a-z, 0-9, _", nil))
			return
		}
	}
	if req.Password != req.PasswordConfirm {
		httpx.Fail(w, r, httpx.BadRequest("пароли не совпадают", nil))
		return
	}
	if err := cryptod.PasswordPolicy(req.Password); err != nil {
		httpx.Fail(w, r, httpx.BadRequest(err.Error(), nil))
		return
	}
	country := strings.ToUpper(strings.TrimSpace(req.CountryCode))
	if country == "" {
		httpx.Fail(w, r, httpx.BadRequest("выберите страну (FR-GEO-01)", nil))
		return
	}
	var countryOK bool
	s.Store.Read(func() {
		if c, ok := s.Store.Countries[country]; ok && !c.Blocked {
			countryOK = true
		}
	})
	if !countryOK {
		httpx.Fail(w, r, httpx.BadRequest("страна не найдена или недоступна", nil))
		return
	}
	if req.CityID != 0 {
		var cityOK bool
		s.Store.Read(func() {
			if c, ok := s.Store.Cities[req.CityID]; ok && c.Country == country {
				cityOK = true
			}
		})
		if !cityOK {
			httpx.Fail(w, r, httpx.BadRequest("город не найден для выбранной страны", nil))
			return
		}
	}

	hash, err := cryptod.HashPassword(req.Password)
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest(err.Error(), nil))
		return
	}

	userID := ids.New("usr")
	emailCT, emailIdx := "", ""
	if req.Email != "" {
		emailCT, err = s.Crypto.EncryptString(store.DomainPII, userID, req.Email)
		if err != nil {
			httpx.Fail(w, r, httpx.Internal("не удалось защитить контактные данные"))
			return
		}
		emailIdx = s.Crypto.BlindIndex(req.Email)
	}

	code := cryptod.Digits(6)
	enr := &store.Enrollment{
		ID: ids.New("enr"), UserID: userID, ContactCode: code,
		SentAt: time.Now().UTC(), Step: "pending_contact_code",
		ExpiresAt: time.Now().UTC().Add(10 * time.Minute),
	}
	locale := req.Locale
	if locale == "" {
		locale = "ru"
	}

	dupErr := error(nil)
	s.Store.Write(func() {
		if _, ok := s.Store.UsersByNick[req.Nickname]; ok {
			dupErr = httpx.Conflict("ALREADY_USED", "nickname занят")
			return
		}
		if emailIdx != "" {
			if _, ok := s.Store.UsersByMail[emailIdx]; ok {
				dupErr = httpx.Conflict("ALREADY_USED", "email уже зарегистрирован")
				return
			}
		}
		s.Store.UserSeq++
		u := &store.User{
			ID: userID, EmailCT: emailCT, EmailIdx: emailIdx, Nickname: req.Nickname,
			PasswordHash: hash, Role: store.RoleBuyer, Country: country, CityID: req.CityID,
			Locale: locale, Theme: "dark", Status: store.UserPending,
			Factors: map[string]*store.Factor{}, Seq: s.Store.UserSeq,
			Is18Plus: true, ReferredBy: req.ReferralCode,
			WarmupUntil: time.Now().UTC().Add(time.Duration(s.Cfg.WarmupHours) * time.Hour),
			CreatedAt: time.Now().UTC(),
		}
		s.Store.Users[u.ID] = u
		s.Store.UsersByNick[u.Nickname] = u.ID
		if emailIdx != "" {
			s.Store.UsersByMail[emailIdx] = u.ID
		}
		s.Store.Enrollments[enr.ID] = enr
		s.Store.EnsureAccountLocked(store.OwnerUser, u.ID, store.AssetSOL)
		s.Store.EnsureAccountLocked(store.OwnerUser, u.ID, store.AssetStars)
	})
	if dupErr != nil {
		httpx.Fail(w, r, dupErr)
		return
	}

	s.recordAuthEvent(userID, "register", ip, "country="+country, 0)
	s.audit(r, userID, store.RoleBuyer, "user.register", "user", userID, "", "",
		nil, map[string]any{"nickname": req.Nickname, "country": country, "city_id": req.CityID})

	resp := map[string]any{
		"enrollment_id": enr.ID,
		"status":        enr.Step,
		"expires_at":    enr.ExpiresAt,
		"delivery":      map[string]any{"channel": "telegram_bot", "ttl_min": 10, "attempts_left": 3},
	}
	if !s.Cfg.IsProd() {
		// Только для dev/stage: код показывается, чтобы сценарий можно было пройти
		// без реального Telegram-бота. В prod это поле отсутствует.
		resp["dev_code"] = code
	}
	s.notify(userID, "security.register", "Регистрация SITEE",
		"Подтвердите контактные данные кодом из сообщения. Код действителен 10 минут.",
		"register:"+enr.ID, map[string]any{"enrollment_id": enr.ID})

	httpx.JSON(w, http.StatusCreated, resp)
}

type verifyContactRequest struct {
	EnrollmentID string `json:"enrollment_id"`
	Code         string `json:"code"`
}

func (s *Server) handleVerifyContact(w http.ResponseWriter, r *http.Request) {
	var req verifyContactRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var (
		enr  *store.Enrollment
		fail *httpx.APIError
	)
	s.Store.Write(func() {
		e, ok := s.Store.Enrollments[req.EnrollmentID]
		if !ok {
			fail = httpx.NotFound("заявка на регистрацию не найдена")
			return
		}
		enr = e
		if time.Now().UTC().After(e.ExpiresAt) {
			fail = httpx.BadRequest("код истёк, запросите новый", nil)
			return
		}
		if e.Attempts >= 3 {
			fail = httpx.Locked("превышено число попыток ввода кода", 15*time.Minute)
			return
		}
		if !hmac.Equal([]byte(strings.TrimSpace(req.Code)), []byte(e.ContactCode)) {
			e.Attempts++
			fail = httpx.BadRequest("неверный код подтверждения", map[string]any{"attempts_left": 3 - e.Attempts})
			return
		}
		e.Step = "pending_2fa_login"
		if u, ok := s.Store.Users[e.UserID]; ok {
			u.Status = store.UserActive
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.recordAuthEvent(enr.UserID, "contact_verified", httpx.ClientIP(r), "", 0)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"enrollment_id": enr.ID, "status": enr.Step, "next": "2fa_setup",
		"factor": store.FactorLogin,
	})
}

// ---------------------------------------------------------------------------
// Двойной 2FA (FR-2FA-01…07)
// ---------------------------------------------------------------------------

type setupRequest struct {
	Factor       string `json:"factor"`
	EnrollmentID string `json:"enrollment_id"`
}

func (s *Server) handle2FASetup(w http.ResponseWriter, r *http.Request) {
	var req setupRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if req.Factor != store.FactorLogin && req.Factor != store.FactorOps {
		httpx.Fail(w, r, httpx.BadRequest("factor должен быть login или ops", nil))
		return
	}

	u, ok := s.resolveEnrollmentUser(r, w, req.EnrollmentID)
	if !ok {
		return
	}

	secret, err := cryptod.NewTOTPSecret()
	if err != nil {
		httpx.Fail(w, r, httpx.Internal("не удалось сгенерировать секрет"))
		return
	}
	ct, err := s.Crypto.Encrypt(store.Domain2FA, u.ID+":"+req.Factor, secret)
	if err != nil {
		httpx.Fail(w, r, httpx.Internal("не удалось защитить секрет 2FA"))
		return
	}
	secretB32 := cryptod.SecretBase32(secret)
	label := "вход"
	if req.Factor == store.FactorOps {
		label = "операции"
	}
	account := u.Nickname
	if account == "" {
		account = u.ID
	}
	otpURL := cryptod.OTPAuthURL("SITEE", account, secretB32, label)

	s.Store.Write(func() {
		if u.Factors == nil {
			u.Factors = map[string]*store.Factor{}
		}
		u.Factors[req.Factor] = &store.Factor{
			Name: req.Factor, SecretCT: ct, Status: "pending",
			UsedCodes: map[string]int64{}, PendingCodes: []string{},
		}
	})
	s.audit(r, u.ID, u.Role, "2fa.setup", "user", u.ID, "factor="+req.Factor, "",
		nil, map[string]any{"factor": req.Factor})

	httpx.JSON(w, http.StatusOK, map[string]any{
		"factor":      req.Factor,
		"secret_b32":  secretB32,
		"otpauth_url": otpURL,
		"label":       "SITEE (" + label + ")",
		"issuer":      "SITEE",
		"algorithm":   "SHA1",
		"digits":      cryptod.TOTPDigits,
		"period":      cryptod.TOTPPeriod,
		"expires_at":  time.Now().UTC().Add(15 * time.Minute),
		"hint":        "Отсканируйте QR в Google Authenticator или введите секрет вручную. " +
			"Для активации потребуется два верных кода подряд.",
	})
}

// resolveEnrollmentUser возвращает пользователя по enrollment_id или по текущей сессии.
func (s *Server) resolveEnrollmentUser(r *http.Request, w http.ResponseWriter, enrollmentID string) (*store.User, bool) {
	var u *store.User
	if enrollmentID != "" {
		s.Store.Read(func() {
			if e, ok := s.Store.Enrollments[enrollmentID]; ok {
				u = s.Store.Users[e.UserID]
			}
		})
		if u == nil {
			httpx.Fail(w, r, httpx.NotFound("заявка на регистрацию не найдена"))
			return nil, false
		}
		return u, true
	}
	return s.requireAuth(w, r)
}

type activateRequest struct {
	Factor       string `json:"factor"`
	EnrollmentID string `json:"enrollment_id"`
	Code1        string `json:"code_1"`
	Code2        string `json:"code_2"`
}

func (s *Server) handle2FAActivate(w http.ResponseWriter, r *http.Request) {
	var req activateRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if req.Factor != store.FactorLogin && req.Factor != store.FactorOps {
		httpx.Fail(w, r, httpx.BadRequest("factor должен быть login или ops", nil))
		return
	}
	u, ok := s.resolveEnrollmentUser(r, w, req.EnrollmentID)
	if !ok {
		return
	}

	secret, err := s.factorSecret(u, req.Factor)
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("сначала запросите секрет: POST /auth/2fa/setup", nil))
		return
	}
	now := time.Now()
	ok1, drift1 := cryptod.ValidateTOTP(secret, req.Code1, now, 1)
	ok2, drift2 := cryptod.ValidateTOTP(secret, req.Code2, now.Add(time.Duration(cryptod.TOTPPeriod)*time.Second), 1)
	if !ok1 {
		st := s.Guard.RegisterFail("2fa-enroll:" + u.ID + ":" + req.Factor)
		if st.Locked {
			httpx.Fail(w, r, httpx.Locked("слишком много неудачных попыток активации", st.RetryAfter))
			return
		}
		httpx.Fail(w, r, httpx.BadRequest("первый код неверен", nil))
		return
	}
	if !ok2 && req.Code1 == req.Code2 {
		// Разрешаем активацию по одному коду, если клиент отправил его дважды
		// в пределах одного 30-секундного окна (частый случай в UX).
		ok2 = true
		drift2 = drift1
	}
	if !ok2 {
		httpx.Fail(w, r, httpx.BadRequest("второй код неверен (дождитесь следующего периода)", nil))
		return
	}

	codes, hashes, err := s.Crypto.BackupCodes(10)
	if err != nil {
		httpx.Fail(w, r, httpx.Internal("не удалось сгенерировать backup-коды"))
		return
	}

	s.Store.Write(func() {
		f := u.Factors[req.Factor]
		if f == nil {
			return
		}
		f.Status = "active"
		f.EnrolledAt = now.UTC()
		f.BackupHashes = hashes
		f.BackupUsed = map[int]bool{}
		f.PendingCodes = nil
		if drift1 != 0 || drift2 != 0 {
			s.Store.Settings["totp_drift_"+u.ID] = drift1
		}
		if e, ok := s.Store.Enrollments[enrollmentOf(s.Store, u.ID)]; ok {
			if req.Factor == store.FactorLogin {
				e.Step = "complete"
			}
		}
	})
	s.Guard.RegisterSuccess("2fa-enroll:" + u.ID + ":" + req.Factor)
	s.recordAuthEvent(u.ID, "2fa_enrolled", httpx.ClientIP(r), "factor="+req.Factor, 0)
	s.audit(r, u.ID, u.Role, "2fa.activate", "user", u.ID, "factor="+req.Factor, "",
		nil, map[string]any{"factor": req.Factor, "backup_codes": len(codes)})

	resp := map[string]any{
		"status":       "active",
		"factor":       req.Factor,
		"backup_codes": codes,
		"warning":      "Сохраните backup-коды: они показываются один раз.",
	}

	// После активации фактора «вход» выдаём сессию — автоматический переход
	// на главную страницу с магазинами (FR-AUTH-05).
	if req.Factor == store.FactorLogin && u.Status == store.UserActive {
		sess, err := s.issueSession(r, u)
		if err == nil {
			resp["access_token"] = sess.AccessToken
			resp["refresh_token"] = sess.RefreshToken
			resp["expires_in"] = int(s.Cfg.AccessTTL.Seconds())
			resp["user"] = s.userDTO(u)
			resp["redirect"] = "/shops"
			resp["next_step"] = "enroll_ops"
			if u.HasFactor(store.FactorOps) {
				resp["next_step"] = "complete"
			}
		}
	}
	s.notify(u.ID, "security.2fa_enrolled", "2FA настроен",
		"Фактор «"+factorLabel(req.Factor)+"» активирован. Если это были не вы — немедленно смените пароль.",
		"2fa:"+req.Factor+":"+u.ID, map[string]any{"factor": req.Factor})

	httpx.JSON(w, http.StatusOK, resp)
}

func enrollmentOf(st *store.Store, userID string) string {
	for id, e := range st.Enrollments {
		if e.UserID == userID {
			return id
		}
	}
	return ""
}

func factorLabel(f string) string {
	if f == store.FactorOps {
		return "операции"
	}
	return "вход"
}

func (s *Server) factorSecret(u *store.User, factor string) ([]byte, error) {
	var ct string
	s.Store.Read(func() {
		if f, ok := u.Factors[factor]; ok {
			ct = f.SecretCT
		}
	})
	if ct == "" {
		return nil, errors.New("секрет не найден")
	}
	return s.Crypto.Decrypt(store.Domain2FA, u.ID+":"+factor, ct)
}

// ---------------------------------------------------------------------------
// Вход и сессии
// ---------------------------------------------------------------------------

type loginRequest struct {
	Identifier   string `json:"identifier"`
	Password     string `json:"password"`
	CaptchaToken string `json:"captcha_token"`
	Device       struct {
		UA          string `json:"ua"`
		TZ          string `json:"tz"`
		Fingerprint string `json:"fingerprint"`
		Platform    string `json:"platform"`
		DeviceID    string `json:"device_id"`
	} `json:"device"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ip := httpx.ClientIP(r)
	ident := strings.ToLower(strings.TrimSpace(req.Identifier))
	if ident == "" || req.Password == "" {
		httpx.Fail(w, r, httpx.BadRequest("укажите идентификатор и пароль", nil))
		return
	}

	// Защита от брутфорса: ключи по идентификатору и по IP (FR-ABF-01).
	for _, key := range []string{"login:" + ident, "login:ip:" + ip} {
		if st := s.Guard.State(key); st.Locked {
			httpx.Fail(w, r, httpx.Locked("вход временно заблокирован (анти-брутфорс)", st.RetryAfter))
			return
		}
	}

	var u *store.User
	s.Store.Read(func() {
		if id, ok := s.Store.UsersByNick[ident]; ok {
			u = s.Store.Users[id]
		} else if id, ok := s.Store.UsersByMail[s.Crypto.BlindIndex(ident)]; ok {
			u = s.Store.Users[id]
		}
	})

	// Constant-time: даже при отсутствии пользователя выполняем проверку хэша.
	dummy := "$pbkdf2-sha256$210000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	hash := dummy
	if u != nil {
		hash = u.PasswordHash
	}
	ok, err := cryptod.VerifyPassword(req.Password, hash)
	if err != nil || !ok || u == nil {
		st1 := s.Guard.RegisterFail("login:" + ident)
		s.Guard.RegisterFail("login:ip:" + ip)
		s.recordAuthEvent("", "login_fail", ip, "identifier="+antifraud.MaskPII("email", ident), 0)
		if st1.Locked {
			httpx.Fail(w, r, httpx.Locked("слишком много неудачных попыток, вход заблокирован", st1.RetryAfter))
			return
		}
		resp := httpx.NewError(http.StatusUnauthorized, "UNAUTHENTICATED", "неверный идентификатор или пароль")
		resp.Details = map[string]any{
			"fails":          st1.Fails,
			"captcha":        st1.Captcha,
			"lock_after":     5,
			"remaining":      maxInt(0, 5-st1.Fails),
			"retry_after_ms": int64(st1.RetryAfter / time.Millisecond),
		}
		httpx.Fail(w, r, resp)
		return
	}
	if u.Status != store.UserActive {
		httpx.Fail(w, r, httpx.Forbidden("ACCOUNT_RESTRICTED", "аккаунт не активен: "+u.Status))
		return
	}

	s.Guard.RegisterSuccess("login:" + ident)
	s.Guard.RegisterSuccess("login:ip:" + ip)

	// Создаём сессию в статусе ожидания 2FA.
	sessionID := ids.New("ses")
	needFactor := store.FactorLogin
	trusted := false
	s.Store.Write(func() {
		s.Store.Sessions[sessionID] = &store.Session{
			ID: sessionID, UserID: u.ID, DeviceID: req.Device.DeviceID,
			Status: "pending_2fa_login", IP: ip, Geo: u.Country, UA: r.UserAgent(),
			CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().UTC().Add(10 * time.Minute),
		}
	})
	s.recordAuthEvent(u.ID, "login_challenge", ip, "factor="+needFactor, 0)

	httpx.JSON(w, http.StatusOK, map[string]any{
		"session_id":      sessionID,
		"challenge":       "totp_login",
		"factor":          needFactor,
		"trusted_device":  trusted,
		"expires_at":      time.Now().UTC().Add(10 * time.Minute),
		"enrollment_hint": u.HasFactor(needFactor),
	})
}

type verify2FARequest struct {
	SessionID  string `json:"session_id"`
	Factor     string `json:"factor"`
	Code       string `json:"code"`
	BackupCode string `json:"backup_code"`
}

func (s *Server) handle2FAVerify(w http.ResponseWriter, r *http.Request) {
	var req verify2FARequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	code := strings.TrimSpace(req.Code)
	if code == "" {
		code = strings.TrimSpace(req.BackupCode)
	}
	if req.SessionID == "" || code == "" {
		httpx.Fail(w, r, httpx.BadRequest("укажите session_id и код", nil))
		return
	}

	var (
		ses *store.Session
		u   *store.User
	)
	s.Store.Read(func() {
		ses = s.Store.Sessions[req.SessionID]
		if ses != nil {
			u = s.Store.Users[ses.UserID]
		}
	})
	if ses == nil || u == nil {
		httpx.Fail(w, r, httpx.NotFound("сессия не найдена"))
		return
	}
	if ses.Status != "pending_2fa_login" && ses.Status != "pending_2fa_ops" {
		httpx.Fail(w, r, httpx.Conflict("INVALID_STATE", "сессия не ожидает подтверждения 2FA"))
		return
	}
	if time.Now().UTC().After(ses.ExpiresAt) {
		httpx.Fail(w, r, httpx.Unauthorized("сессия истекла, войдите заново"))
		return
	}
	factor := req.Factor
	if factor == "" {
		factor = store.FactorLogin
	}

	ok, err := s.verifyFactor(u, factor, code)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if !ok {
		st := s.Guard.State("2fa:" + u.ID + ":" + factor)
		details := map[string]any{"factor": factor, "fails": st.Fails}
		if st.Captcha {
			details["captcha"] = true
		}
		totpErr := httpx.NewError(http.StatusUnauthorized, "TOTP_INVALID", "неверный код 2FA")
		totpErr.Details = details
		httpx.Fail(w, r, totpErr)
		return
	}

	now := time.Now().UTC()
	s.Store.Write(func() {
		ses.Status = "active"
		ses.ExpiresAt = now.Add(s.Cfg.RefreshTTL)
		if factor == store.FactorOps {
			ses.FactorOpsOK = true
			ses.FactorOpsAt = now
		}
		u.LastLoginAt = now
	})

	issued, err := s.tokensForSession(ses, u)
	if err != nil {
		httpx.Fail(w, r, httpx.Internal("не удалось выпустить токены"))
		return
	}
	s.recordAuthEvent(u.ID, "login_ok", httpx.ClientIP(r), "factor="+factor, 0)
	s.audit(r, u.ID, u.Role, "auth.login", "session", ses.ID, "", factor, nil,
		map[string]any{"factor": factor, "ip": httpx.ClientIP(r)})

	httpx.JSON(w, http.StatusOK, map[string]any{
		"access_token":  issued.AccessToken,
		"refresh_token": issued.RefreshToken,
		"expires_in":    int(s.Cfg.AccessTTL.Seconds()),
		"user":          s.userDTO(u),
		"redirect":      redirectFor(u),
		"session_id":    ses.ID,
	})
}

// redirectFor — куда переходит клиент после входа (FR-AUTH-05).
func redirectFor(u *store.User) string {
	switch u.Role {
	case store.RoleSuperAdmin:
		return "/admin"
	case store.RoleArbiter, store.RoleModerator:
		return "/admin"
	}
	return "/shops"
}

// issuedTokens — пара токенов.
type issuedTokens struct {
	AccessToken  string
	RefreshToken string
	SessionID    string
}

func (s *Server) tokensForSession(ses *store.Session, u *store.User) (*issuedTokens, error) {
	access, err := s.JWT.Sign(map[string]any{
		"sub":  u.ID,
		"sid":  ses.ID,
		"role": u.Role,
		"nick": u.Nickname,
		"ops":  ses.FactorOpsOK,
		"dev":  ses.DeviceID,
	}, s.Cfg.AccessTTL)
	if err != nil {
		return nil, err
	}
	refresh := "rt_" + ids.Hex(24)
	hash := sha256.Sum256([]byte(refresh))
	s.Store.Write(func() {
		s.Store.Refresh[hex.EncodeToString(hash[:])] = &store.RefreshToken{
			TokenHash: hex.EncodeToString(hash[:]), SessionID: ses.ID, FamilyID: ses.ID,
			ExpiresAt: time.Now().UTC().Add(s.Cfg.RefreshTTL), CreatedAt: time.Now().UTC(),
		}
	})
	return &issuedTokens{AccessToken: access, RefreshToken: refresh, SessionID: ses.ID}, nil
}

// issueSession создаёт активную сессию и возвращает токены.
func (s *Server) issueSession(r *http.Request, u *store.User) (*issuedTokens, error) {
	sessionID := ids.New("ses")
	now := time.Now().UTC()
	ses := &store.Session{
		ID: sessionID, UserID: u.ID, Status: "active",
		IP: httpx.ClientIP(r), Geo: u.Country, UA: r.UserAgent(),
		CreatedAt: now, ExpiresAt: now.Add(s.Cfg.RefreshTTL),
	}
	s.Store.Write(func() {
		s.Store.Sessions[sessionID] = ses
		u.LastLoginAt = now
	})
	return s.tokensForSession(ses, u)
}

func (s *Server) handleTelegramInitData(w http.ResponseWriter, r *http.Request) {
	var req struct {
		InitData string `json:"init_data"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if s.Cfg.TGBotToken == "" {
		httpx.Fail(w, r, httpx.NewError(http.StatusNotImplemented, "NOT_CONFIGURED",
			"Telegram Bot API не настроен (TG_BOT_TOKEN)"))
		return
	}
	values, err := url.ParseQuery(req.InitData)
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("некорректный init_data", nil))
		return
	}
	hash := values.Get("hash")
	if hash == "" {
		httpx.Fail(w, r, httpx.BadRequest("init_data без hash", nil))
		return
	}
	pairs := []string{}
	for k, vs := range values {
		if k == "hash" || len(vs) == 0 {
			continue
		}
		pairs = append(pairs, k+"="+vs[0])
	}
	sort.Strings(pairs)
	dataCheck := strings.Join(pairs, "\n")

	secret := hmac.New(sha256.New, []byte("WebAppData"))
	secret.Write([]byte(s.Cfg.TGBotToken))
	mac := hmac.New(sha256.New, secret.Sum(nil))
	mac.Write([]byte(dataCheck))
	want := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(strings.ToLower(hash))) {
		s.recordAuthEvent("", "tg_init_data_fail", httpx.ClientIP(r), "bad signature", 300)
		httpx.Fail(w, r, httpx.Forbidden("SIGNATURE_INVALID", "подпись init_data недействительна"))
		return
	}
	if ad := values.Get("auth_date"); ad != "" {
		ts, convErr := strconv.ParseInt(ad, 10, 64)
		if convErr != nil || time.Since(time.Unix(ts, 0)) > 5*time.Minute {
			httpx.Fail(w, r, httpx.Forbidden("AUTH_DATE_STALE", "init_data устарел (> 5 минут)"))
			return
		}
	}

	var u *store.User
	if userRaw := values.Get("user"); userRaw != "" {
		userJSON, jerr := url.QueryUnescape(userRaw)
		if jerr == nil {
			var tgUser struct {
				ID       int64  `json:"id"`
				Username string `json:"username"`
			}
			if err := json.Unmarshal([]byte(userJSON), &tgUser); err == nil && tgUser.ID != 0 {
				s.Store.Read(func() {
					for _, cand := range s.Store.Users {
						if cand.TGID == tgUser.ID {
							u = cand
							break
						}
					}
				})
				if u == nil {
					httpx.Fail(w, r, httpx.NotFound("аккаунт Telegram не привязан; пройдите регистрацию"))
					return
				}
			}
		}
	}
	if u == nil {
		httpx.Fail(w, r, httpx.BadRequest("в init_data отсутствует user.id", nil))
		return
	}
	if !u.HasFactor(store.FactorLogin) {
		httpx.Fail(w, r, httpx.Forbidden("2FA_NOT_ENROLLED", "требуется настроить фактор «вход»"))
		return
	}

	sessionID := ids.New("ses")
	s.Store.Write(func() {
		s.Store.Sessions[sessionID] = &store.Session{
			ID: sessionID, UserID: u.ID, Status: "pending_2fa_login",
			IP: httpx.ClientIP(r), Geo: u.Country, UA: r.UserAgent(),
			CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().UTC().Add(10 * time.Minute),
		}
	})
	s.recordAuthEvent(u.ID, "login_challenge", httpx.ClientIP(r), "telegram init_data", 0)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"session_id": sessionID, "challenge": "totp_login", "factor": store.FactorLogin,
		"user": map[string]any{"id": u.ID, "nickname": u.Nickname},
	})
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	hash := sha256.Sum256([]byte(strings.TrimSpace(req.RefreshToken)))
	key := hex.EncodeToString(hash[:])

	var (
		ses *store.Session
		u   *store.User
		reused bool
	)
	s.Store.Write(func() {
		rt, ok := s.Store.Refresh[key]
		if !ok {
			return
		}
		if !rt.UsedAt.IsZero() {
			// Reuse-detection: отзываем всю семью токенов (FR-AUTH-07).
			reused = true
			for k, v := range s.Store.Refresh {
				if v.FamilyID == rt.FamilyID {
					delete(s.Store.Refresh, k)
				}
			}
			if s, ok2 := s.Store.Sessions[rt.SessionID]; ok2 {
				s.Status = "revoked"
				s.RevokedAt = time.Now().UTC()
				s.RevokeReason = "refresh token reuse"
			}
			return
		}
		if time.Now().UTC().After(rt.ExpiresAt) {
			delete(s.Store.Refresh, key)
			return
		}
		rt.UsedAt = time.Now().UTC()
		ses = s.Store.Sessions[rt.SessionID]
		if ses != nil {
			u = s.Store.Users[ses.UserID]
		}
	})
	if reused {
		s.recordAuthEvent("", "refresh_reuse", httpx.ClientIP(r), "семья токенов отозвана", 500)
		httpx.Fail(w, r, httpx.Unauthorized("refresh-токен уже использован; сессии отозваны"))
		return
	}
	if ses == nil || u == nil || ses.Status != "active" {
		httpx.Fail(w, r, httpx.Unauthorized("refresh-токен недействителен"))
		return
	}
	issued, err := s.tokensForSession(ses, u)
	if err != nil {
		httpx.Fail(w, r, httpx.Internal("не удалось выпустить токены"))
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"access_token": issued.AccessToken, "refresh_token": issued.RefreshToken,
		"expires_in": int(s.Cfg.AccessTTL.Seconds()), "user": s.userDTO(u),
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Scope string `json:"scope"`
	}
	_ = httpx.Decode(r, &req)
	p := s.principal(r)
	if p == nil || !p.Authorized {
		httpx.JSON(w, http.StatusOK, map[string]any{"status": "ok"})
		return
	}
	revoked := 0
	s.Store.Write(func() {
		for id, ses := range s.Store.Sessions {
			if ses.UserID != p.UserID || ses.Status != "active" {
				continue
			}
			if req.Scope == "all" || id == p.SessionID {
				ses.Status = "revoked"
				ses.RevokedAt = time.Now().UTC()
				ses.RevokeReason = "logout"
				revoked++
			}
		}
		for k, rt := range s.Store.Refresh {
			if ses, ok := s.Store.Sessions[rt.SessionID]; ok && ses.UserID == p.UserID && ses.Status == "revoked" {
				delete(s.Store.Refresh, k)
			}
		}
	})
	s.recordAuthEvent(p.UserID, "logout", httpx.ClientIP(r), "scope="+req.Scope, 0)
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "ok", "revoked": revoked})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, s.userDTO(u))
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	items := []map[string]any{}
	now := time.Now()
	s.Store.Read(func() {
		for _, ses := range s.Store.Sessions {
			if ses.UserID != u.ID {
				continue
			}
			items = append(items, map[string]any{
				"id": ses.ID, "status": ses.Status, "ip": antifraud.MaskPII("ip", ses.IP),
				"geo": ses.Geo, "ua": ses.UA, "device_id": ses.DeviceID,
				"created_at": ses.CreatedAt, "expires_at": ses.ExpiresAt,
				"current": ses.ID == s.principal(r).SessionID,
				"active": ses.Active(now),
			})
		}
	})
	sort.Slice(items, func(i, j int) bool {
		a, _ := items[i]["created_at"].(time.Time)
		b, _ := items[j]["created_at"].(time.Time)
		return a.After(b)
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleRevokeSession(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	found := false
	s.Store.Write(func() {
		if ses, ok := s.Store.Sessions[id]; ok && ses.UserID == u.ID {
			ses.Status = "revoked"
			ses.RevokedAt = time.Now().UTC()
			ses.RevokeReason = "revoked by user"
			found = true
		}
	})
	if !found {
		httpx.Fail(w, r, httpx.NotFound("сессия не найдена"))
		return
	}
	s.audit(r, u.ID, u.Role, "auth.session_revoke", "session", id, "", "", nil, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "revoked", "id": id})
}

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
	TotpCode        string `json:"totp_code"`
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req changePasswordRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	valid, err := cryptod.VerifyPassword(req.CurrentPassword, u.PasswordHash)
	if err != nil || !valid {
		httpx.Fail(w, r, httpx.Forbidden("PASSWORD_INVALID", "текущий пароль неверен"))
		return
	}
	if !s.requireOps(w, r, u, "password_change", 0, 0, req.TotpCode) {
		return
	}
	hash, err := cryptod.HashPassword(req.NewPassword)
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest(err.Error(), nil))
		return
	}
	s.Store.Write(func() { u.PasswordHash = hash })
	// Все остальные сессии отзываем (FR-AUTH-08).
	revoked := 0
	s.Store.Write(func() {
		for id, ses := range s.Store.Sessions {
			if ses.UserID == u.ID && ses.Status == "active" && id != s.principal(r).SessionID {
				ses.Status = "revoked"
				ses.RevokeReason = "password changed"
				revoked++
			}
		}
	})
	s.audit(r, u.ID, u.Role, "auth.password_change", "user", u.ID, "", store.FactorOps,
		nil, map[string]any{"revoked_sessions": revoked})
	s.notify(u.ID, "security.password_changed", "Пароль изменён",
		fmt.Sprintf("Отозвано сессий: %d. Если это были не вы — обратитесь в поддержку.", revoked),
		"pwd:"+time.Now().Format("20060102150405"), nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "ok", "revoked_sessions": revoked})
}

func (s *Server) handleAuthEvents(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	items := []map[string]any{}
	s.Store.Read(func() {
		for i := len(s.Store.AuthEvents) - 1; i >= 0 && len(items) < 50; i-- {
			ev := s.Store.AuthEvents[i]
			if ev.UserID != "" && ev.UserID != u.ID {
				continue
			}
			if ev.UserID == "" && !u.IsPrivileged() {
				continue
			}
			items = append(items, map[string]any{
				"ts": ev.TS, "event": ev.Event, "ip": antifraud.MaskPII("ip", ev.IP),
				"reason": ev.Reason, "risk_score": ev.RiskScore,
			})
		}
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleNotifications(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	items := []*store.Notification{}
	s.Store.Read(func() {
		list := s.Store.Notifications[u.ID]
		if len(list) > 50 {
			list = list[:50]
		}
		items = append(items, list...)
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleNotificationRead(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	done := false
	s.Store.Write(func() {
		for _, n := range s.Store.Notifications[u.ID] {
			if n.ID == id {
				n.Read = true
				done = true
				if u.UnreadChats > 0 {
					u.UnreadChats--
				}
			}
		}
	})
	if !done {
		httpx.Fail(w, r, httpx.NotFound("уведомление не найдено"))
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
