// Package cryptod — криптографическое ядро Go-бэкенда.
//
// Реализует тот же формат ciphertext, что и Rust-сервис crypto-core
// (см. docs/architecture.md §4 и docs/security.md §2–§3), поэтому данные,
// зашифрованные одной реализацией, читаются другой.
//
// Если задан CRYPTO_CORE_URL, операции шифрования/подписи делегируются
// Rust-ядру по внутреннему HTTP; при недоступности включается встроенный
// Go-fallback (тот же формат) и растёт счётчик crypto_fallback_total.
package cryptod

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Envelope-формат (v1):
//
//	[0]      version = 0x01
//	[1:9]    key_id  (8 байт, версия DEK домена)
//	[9:21]   nonce   (12 байт, GCM)
//	[21:]    ciphertext || tag(16)
//
// AAD = "<domain>:<object_id>". В БД хранится base64 всей структуры.
const (
	envelopeVersion byte = 0x01
	envelopeHeader       = 1 + 8 + 12
	keyIDLen             = 8
	nonceLen             = 12
)

// Ошибки.
var (
	ErrBadEnvelope     = errors.New("cryptod: повреждённый envelope")
	ErrBadKeyID        = errors.New("cryptod: неизвестный key_id (нужна ротация/миграция)")
	ErrAuthFailed      = errors.New("cryptod: проверка подлинности не пройдена")
	ErrBadSecret       = errors.New("cryptod: некорректный секрет")
	ErrWeakPassword    = errors.New("cryptod: пароль не соответствует политике")
	ErrTokenExpired    = errors.New("cryptod: токен истёк")
	ErrTokenInvalid    = errors.New("cryptod: подпись токена недействительна")
	ErrCoreUnreachable = errors.New("cryptod: crypto-core недоступен, применён Go-fallback")
)

// Core — точка входа в криптографию приложения.
type Core struct {
	kek     []byte // главный ключ окружения (KEK), 32 байта
	idxKey  []byte // ключ blind-индексов
	signKey []byte // ключ подписи служебных данных (HMAC)

	mu     sync.RWMutex
	aeads  map[string]cipher.AEAD
	keyIDs map[string][keyIDLen]byte
	kekFP  string

	remoteURL   string
	remoteToken string
	client      *http.Client
	breaker     breaker

	Fallbacks atomic.Int64
	Ops       atomic.Int64
}

type breaker struct {
	mu         sync.Mutex
	failures   int
	openedAt   time.Time
	threshold  int
	coolDown   time.Duration
	halfOpened bool
}

func (b *breaker) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failures < b.threshold {
		return true
	}
	if time.Since(b.openedAt) > b.coolDown {
		b.halfOpened = true
		return true
	}
	return false
}

func (b *breaker) success() {
	b.mu.Lock()
	b.failures = 0
	b.halfOpened = false
	b.mu.Unlock()
}

func (b *breaker) fail() {
	b.mu.Lock()
	b.failures++
	if b.failures == b.threshold {
		b.openedAt = time.Now()
	}
	b.mu.Unlock()
}

// New создаёт ядро. kekHex — 64 hex-символа (32 байта); если пустой — генерируется
// случайный KEK (только для dev, с предупреждением в логе вызывающей стороны).
func New(kekHex, remoteURL, remoteToken string) (*Core, error) {
	var kek []byte
	if strings.TrimSpace(kekHex) == "" {
		kek = make([]byte, 32)
		if _, err := rand.Read(kek); err != nil {
			return nil, err
		}
	} else {
		var err error
		kek, err = hex.DecodeString(strings.TrimSpace(kekHex))
		if err != nil {
			return nil, fmt.Errorf("cryptod: KEK должен быть hex: %w", err)
		}
		if len(kek) != 32 {
			return nil, errors.New("cryptod: KEK должен быть 32 байта (AES-256)")
		}
	}
	c := &Core{
		kek:         kek,
		idxKey:      HKDF(kek, []byte("sitee-idx-v1"), []byte("blind-index"), 32),
		signKey:     HKDF(kek, []byte("sitee-sign-v1"), []byte("service-hmac"), 32),
		aeads:       map[string]cipher.AEAD{},
		keyIDs:      map[string][keyIDLen]byte{},
		remoteURL:   strings.TrimRight(strings.TrimSpace(remoteURL), "/"),
		remoteToken: remoteToken,
		client:      &http.Client{Timeout: 200 * time.Millisecond},
	}
	c.breaker.threshold = 5
	c.breaker.coolDown = 30 * time.Second
	sum := sha256.Sum256(kek)
	c.kekFP = hex.EncodeToString(sum[:])[:16]
	return c, nil
}

// KEKFingerprint — короткий отпечаток KEK для логов и метрик (не раскрывает ключ).
func (c *Core) KEKFingerprint() string { return c.kekFP }

// RemoteEnabled сообщает, подключено ли внешнее Rust-ядро.
func (c *Core) RemoteEnabled() bool { return c.remoteURL != "" }

// ---------------------------------------------------------------------------
// KDF: HKDF (RFC 5869) и PBKDF2-HMAC-SHA256 (RFC 8018)
// ---------------------------------------------------------------------------

// HKDF извлекает и расширяет ключ до length байт.
func HKDF(secret, salt, info []byte, length int) []byte {
	if len(salt) == 0 {
		salt = make([]byte, sha256.Size)
	}
	extractor := hmac.New(sha256.New, salt)
	extractor.Write(secret)
	prk := extractor.Sum(nil)

	out := make([]byte, 0, length)
	var prev []byte
	counter := byte(1)
	for len(out) < length {
		expander := hmac.New(sha256.New, prk)
		expander.Write(prev)
		expander.Write(info)
		expander.Write([]byte{counter})
		prev = expander.Sum(nil)
		out = append(out, prev...)
		counter++
	}
	return out[:length]
}

// PBKDF2SHA256 — RFC 8018, HMAC-SHA256.
func PBKDF2SHA256(password, salt []byte, iter, keyLen int) []byte {
	prf := hmac.New(sha256.New, password)
	buf := make([]byte, 4)
	dk := make([]byte, 0, keyLen+sha256.Size)
	for block := 1; len(dk) < keyLen; block++ {
		prf.Reset()
		prf.Write(salt)
		binary.BigEndian.PutUint32(buf, uint32(block))
		prf.Write(buf)
		u := prf.Sum(nil)
		t := make([]byte, len(u))
		copy(t, u)
		for i := 1; i < iter; i++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(nil)
			for j := range t {
				t[j] ^= u[j]
			}
		}
		dk = append(dk, t...)
	}
	return dk[:keyLen]
}

// HMACSHA256 возвращает MAC от msg на ключе key.
func HMACSHA256(key, msg []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(msg)
	return m.Sum(nil)
}

// ---------------------------------------------------------------------------
// Пароли
// ---------------------------------------------------------------------------

const (
	pbkdf2Iter   = 210_000 // OWASP 2023 минимум для PBKDF2-HMAC-SHA256
	passwordAlgo = "pbkdf2-sha256"
)

// PasswordPolicy проверяет пароль (FR-AUTH-03).
func PasswordPolicy(pw string) error {
	if len(pw) < 12 {
		return fmt.Errorf("%w: минимум 12 символов", ErrWeakPassword)
	}
	if len(pw) > 128 {
		return fmt.Errorf("%w: максимум 128 символов", ErrWeakPassword)
	}
	classes := 0
	for _, set := range []func(rune) bool{
		func(r rune) bool { return r >= 'a' && r <= 'z' },
		func(r rune) bool { return r >= 'A' && r <= 'Z' },
		func(r rune) bool { return r >= '0' && r <= '9' },
		func(r rune) bool { return strings.ContainsRune("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ ", r) },
	} {
		for _, r := range pw {
			if set(r) {
				classes++
				break
			}
		}
	}
	if classes < 3 {
		return fmt.Errorf("%w: требуется минимум 3 класса символов", ErrWeakPassword)
	}
	lower := strings.ToLower(pw)
	for _, bad := range []string{"password", "qwerty", "123456", "sitee", "solana", "admin"} {
		if strings.Contains(lower, bad) {
			return fmt.Errorf("%w: пароль содержит словарное слово", ErrWeakPassword)
		}
	}
	return nil
}

// HashPassword формирует строку "pbkdf2-sha256$iter$salt_b64$hash_b64".
// В проде — Argon2id (см. TZ FR-AUTH-03 и docs/security.md); миграция выполняется
// при первом успешном входе (NeedsRehash → пересохранение).
func HashPassword(pw string) (string, error) {
	if err := PasswordPolicy(pw); err != nil {
		return "", err
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	dk := PBKDF2SHA256([]byte(pw), salt, pbkdf2Iter, 32)
	return fmt.Sprintf("%s$%d$%s$%s", passwordAlgo, pbkdf2Iter,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(dk)), nil
}

// VerifyPassword проверяет пароль в constant-time.
func VerifyPassword(pw, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 {
		return false, ErrBadSecret
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter <= 0 {
		return false, ErrBadSecret
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil {
		return false, ErrBadSecret
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return false, ErrBadSecret
	}
	got := PBKDF2SHA256([]byte(pw), salt, iter, len(want))
	return hmac.Equal(got, want), nil
}

// NeedsRehash сообщает, нужно ли пересчитать хэш (смена алгоритма/итераций).
func NeedsRehash(encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != passwordAlgo {
		return true
	}
	iter, err := strconv.Atoi(parts[1])
	return err != nil || iter < pbkdf2Iter
}

// ---------------------------------------------------------------------------
// Blind index (поиск по зашифрованным полям)
// ---------------------------------------------------------------------------

// BlindIndex — детерминированный HMAC-индекс нормализованного значения.
func (c *Core) BlindIndex(value string) string {
	norm := strings.ToLower(strings.TrimSpace(value))
	return hex.EncodeToString(HMACSHA256(c.idxKey, []byte(norm)))
}

// ServiceHMAC — подпись служебных payload (вебхуки, init_data Telegram).
func (c *Core) ServiceHMAC(msg []byte) []byte { return HMACSHA256(c.signKey, msg) }

// ---------------------------------------------------------------------------
// Envelope encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

func (c *Core) domainKey(domain string) (cipher.AEAD, [keyIDLen]byte, error) {
	c.mu.RLock()
	a, ok := c.aeads[domain]
	id := c.keyIDs[domain]
	c.mu.RUnlock()
	if ok {
		return a, id, nil
	}

	dek := HKDF(c.kek, []byte("sitee-dek-v1"), []byte("domain:"+domain), 32)
	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, id, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, id, err
	}
	sum := sha256.Sum256(append([]byte("sitee-keyid-v1:"+domain+":"), c.kekFP...))
	copy(id[:], sum[:keyIDLen])

	c.mu.Lock()
	c.aeads[domain] = aead
	c.keyIDs[domain] = id
	c.mu.Unlock()
	return aead, id, nil
}

// Encrypt шифрует plaintext в домене domain с AAD "<domain>:<objectID>".
func (c *Core) Encrypt(domain, objectID string, plaintext []byte) (string, error) {
	c.Ops.Add(1)
	if c.remoteURL != "" && c.breaker.allow() {
		out, err := c.remoteEncrypt(domain, objectID, plaintext)
		if err == nil {
			c.breaker.success()
			return out, nil
		}
		c.breaker.fail()
		c.Fallbacks.Add(1)
	}
	aead, keyID, err := c.domainKey(domain)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, nonceLen)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	buf := make([]byte, 0, envelopeHeader+len(plaintext)+aead.Overhead())
	buf = append(buf, envelopeVersion)
	buf = append(buf, keyID[:]...)
	buf = append(buf, nonce...)
	buf = aead.Seal(buf, nonce, plaintext, []byte(domain+":"+objectID))
	return base64.StdEncoding.EncodeToString(buf), nil
}

// Decrypt расшифровывает envelope, проверяя версию, key_id и GCM-тег.
func (c *Core) Decrypt(domain, objectID, blob string) ([]byte, error) {
	c.Ops.Add(1)
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(blob))
	if err != nil {
		return nil, fmt.Errorf("%w: base64: %v", ErrBadEnvelope, err)
	}
	if len(raw) < envelopeHeader+16 {
		return nil, ErrBadEnvelope
	}
	if raw[0] != envelopeVersion {
		return nil, fmt.Errorf("%w: версия %d", ErrBadEnvelope, raw[0])
	}
	aead, keyID, err := c.domainKey(domain)
	if err != nil {
		return nil, err
	}
	var got [keyIDLen]byte
	copy(got[:], raw[1:1+keyIDLen])
	if !bytes.Equal(got[:], keyID[:]) {
		return nil, ErrBadKeyID
	}
	nonce := raw[1+keyIDLen : envelopeHeader]
	ct := raw[envelopeHeader:]
	pt, err := aead.Open(nil, nonce, ct, []byte(domain+":"+objectID))
	if err != nil {
		return nil, ErrAuthFailed
	}
	return pt, nil
}

// EncryptString / DecryptString — удобные обёртки для текстов.
func (c *Core) EncryptString(domain, objectID, plaintext string) (string, error) {
	return c.Encrypt(domain, objectID, []byte(plaintext))
}

func (c *Core) DecryptString(domain, objectID, blob string) (string, error) {
	b, err := c.Decrypt(domain, objectID, blob)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// remoteEncrypt вызывает Rust crypto-core (POST /v1/encrypt).
func (c *Core) remoteEncrypt(domain, objectID string, plaintext []byte) (string, error) {
	payload, err := json.Marshal(map[string]any{
		"domain":    domain,
		"object_id": objectID,
		"plaintext": base64.StdEncoding.EncodeToString(plaintext),
		"aad":       domain + ":" + objectID,
		"kek_fp":    c.kekFP,
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest(http.MethodPost, c.remoteURL+"/v1/encrypt", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.remoteToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.remoteToken)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _, _ = io.Copy(io.Discard, resp.Body); _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("crypto-core: статус %d", resp.StatusCode)
	}
	var out struct {
		Ciphertext string `json:"ciphertext"`
		KeyID      string `json:"key_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.Ciphertext == "" {
		return "", errors.New("crypto-core: пустой ответ")
	}
	return out.Ciphertext, nil
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) — Google Authenticator совместимый
// ---------------------------------------------------------------------------

const (
	TOTPPeriod = 30
	TOTPDigits = 6
)

// NewTOTPSecret возвращает 20-байтный (160 бит) секрет.
func NewTOTPSecret() ([]byte, error) {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}

// SecretBase32 — представление секрета для ручного ввода (RFC 4648, без паддинга).
func SecretBase32(secret []byte) string {
	return strings.TrimRight(base32.StdEncoding.EncodeToString(secret), "=")
}

// DecodeSecretBase32 принимает секрет с паддингом и без.
func DecodeSecretBase32(s string) ([]byte, error) {
	v := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(s), " ", ""))
	switch len(v) % 8 {
	case 0:
	case 2, 4, 5, 7:
		v += strings.Repeat("=", (8-len(v)%8)%8)
	default:
		return nil, ErrBadSecret
	}
	b, err := base32.StdEncoding.DecodeString(v)
	if err != nil {
		return nil, fmt.Errorf("%w: base32: %v", ErrBadSecret, err)
	}
	if len(b) < 10 {
		return nil, ErrBadSecret
	}
	return b, nil
}

// OTPAuthURL формирует provisioning URI для Google Authenticator.
func OTPAuthURL(issuer, account, secretB32, label string) string {
	return fmt.Sprintf("otpauth://totp/%s%%20(%s):%s?secret=%s&issuer=%s&algorithm=SHA1&digits=%d&period=%d",
		issuer, urlPart(label), urlPart(account), secretB32, issuer, TOTPDigits, TOTPPeriod)
}

func urlPart(s string) string {
	r := strings.NewReplacer(" ", "%20", "@", "%40", ":", "%3A", "/", "%2F", "#", "%23", "?", "%3F")
	return r.Replace(s)
}

// GenerateTOTP вычисляет код для момента at.
func GenerateTOTP(secret []byte, at time.Time) string {
	counter := uint64(at.Unix()) / TOTPPeriod
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], counter)
	mac := hmac.New(sha1.New, secret)
	mac.Write(buf[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0F
	truncated := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7FFFFFFF
	mod := uint32(1)
	for i := 0; i < TOTPDigits; i++ {
		mod *= 10
	}
	out := strconv.FormatUint(uint64(truncated%mod), 10)
	for len(out) < TOTPDigits {
		out = "0" + out
	}
	return out
}

// ValidateTOTP проверяет код в окне ±window шагов и возвращает смещение (drift).
func ValidateTOTP(secret []byte, code string, at time.Time, window int) (bool, int) {
	code = strings.TrimSpace(code)
	if len(code) != TOTPDigits {
		return false, 0
	}
	for i := -window; i <= window; i++ {
		if hmac.Equal([]byte(GenerateTOTP(secret, at.Add(time.Duration(i*TOTPPeriod)*time.Second))), []byte(code)) {
			return true, i
		}
	}
	return false, 0
}

// ---------------------------------------------------------------------------
// Backup-коды (FR-2FA-03)
// ---------------------------------------------------------------------------

// BackupCodes генерирует n кодов формата XXXXX-XXXXX и их HMAC-хэши.
func (c *Core) BackupCodes(n int) (codes []string, hashes []string, err error) {
	codes = make([]string, 0, n)
	hashes = make([]string, 0, n)
	const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789" // без 0/O/1/I/L
	for i := 0; i < n; i++ {
		b := make([]byte, 10)
		if _, err = rand.Read(b); err != nil {
			return nil, nil, err
		}
		var sb strings.Builder
		for j, v := range b {
			if j == 5 {
				sb.WriteByte('-')
			}
			sb.WriteByte(alphabet[int(v)%len(alphabet)])
		}
		code := sb.String()
		codes = append(codes, code)
		hashes = append(hashes, c.backupHash(code))
	}
	return codes, hashes, nil
}

func (c *Core) backupHash(code string) string {
	norm := strings.ToUpper(strings.ReplaceAll(code, "-", ""))
	return hex.EncodeToString(HMACSHA256(c.idxKey, []byte("backup:"+norm)))
}

// VerifyBackupCode возвращает индекс совпавшего кода (для пометки использованным).
func (c *Core) VerifyBackupCode(code string, hashes []string) (int, bool) {
	h := c.backupHash(code)
	for i, v := range hashes {
		if hmac.Equal([]byte(h), []byte(v)) {
			return i, true
		}
	}
	return -1, false
}

// ---------------------------------------------------------------------------
// JWT (EdDSA / Ed25519)
// ---------------------------------------------------------------------------

// JWTSigner подписывает и проверяет access-токены.
type JWTSigner struct {
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
	kid  string
	iss  string
}

// NewJWTSigner создаёт подписанта из seed (32 байта) или генерирует новый.
func NewJWTSigner(seed []byte, issuer string) (*JWTSigner, error) {
	var priv ed25519.PrivateKey
	var err error
	if len(seed) == ed25519.SeedSize {
		priv = ed25519.NewKeyFromSeed(seed)
	} else if len(seed) == 0 {
		_, priv, err = ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, err
		}
	} else {
		return nil, errors.New("cryptod: seed JWT должен быть 32 байта или пустым")
	}
	sum := sha256.Sum256(priv.Public().(ed25519.PublicKey))
	return &JWTSigner{
		priv: priv,
		pub:  priv.Public().(ed25519.PublicKey),
		kid:  hex.EncodeToString(sum[:])[:16],
		iss:  issuer,
	}, nil
}

// Kid — идентификатор ключа (заголовок JWT).
func (s *JWTSigner) Kid() string { return s.kid }

// PublicKey — публичная часть для проверяющих сервисов.
func (s *JWTSigner) PublicKey() ed25519.PublicKey { return s.pub }

// Sign создаёт токен с claims и временем жизни ttl.
func (s *JWTSigner) Sign(claims map[string]any, ttl time.Duration) (string, error) {
	now := time.Now()
	body := map[string]any{}
	for k, v := range claims {
		body[k] = v
	}
	body["iss"] = s.iss
	body["iat"] = now.Unix()
	body["nbf"] = now.Add(-5 * time.Second).Unix()
	body["exp"] = now.Add(ttl).Unix()
	if _, ok := body["jti"]; !ok {
		body["jti"] = hex.EncodeToString(mustRand(8))
	}

	header := map[string]string{"alg": "EdDSA", "typ": "JWT", "kid": s.kid}
	hb, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	pb, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	signingInput := b64url(hb) + "." + b64url(pb)
	sig := ed25519.Sign(s.priv, []byte(signingInput))
	return signingInput + "." + b64url(sig), nil
}

// Verify проверяет подпись и сроки действия токена.
func (s *JWTSigner) Verify(token string) (map[string]any, error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 {
		return nil, ErrTokenInvalid
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, ErrTokenInvalid
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(hb, &header); err != nil {
		return nil, ErrTokenInvalid
	}
	if header.Alg != "EdDSA" {
		return nil, fmt.Errorf("%w: alg=%s", ErrTokenInvalid, header.Alg)
	}
	if header.Kid != "" && header.Kid != s.kid {
		return nil, fmt.Errorf("%w: kid=%s", ErrTokenInvalid, header.Kid)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, ErrTokenInvalid
	}
	if !ed25519.Verify(s.pub, []byte(parts[0]+"."+parts[1]), sig) {
		return nil, ErrTokenInvalid
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrTokenInvalid
	}
	var claims map[string]any
	if err := json.Unmarshal(pb, &claims); err != nil {
		return nil, ErrTokenInvalid
	}
	if iss, _ := claims["iss"].(string); iss != "" && iss != s.iss {
		return nil, ErrTokenInvalid
	}
	now := time.Now().Unix()
	if exp, ok := numClaim(claims, "exp"); ok && now > int64(exp) {
		return nil, ErrTokenExpired
	}
	if nbf, ok := numClaim(claims, "nbf"); ok && now+5 < int64(nbf) {
		return nil, ErrTokenInvalid
	}
	return claims, nil
}

func numClaim(claims map[string]any, key string) (float64, bool) {
	switch v := claims[key].(type) {
	case float64:
		return v, true
	case int64:
		return float64(v), true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	}
	return 0, false
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func mustRand(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("cryptod: crypto/rand недоступен")
	}
	return b
}

// ---------------------------------------------------------------------------
// Solana: HD-деривация адреса, подпись транзакции, base58
// ---------------------------------------------------------------------------

const b58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// Base58Encode кодирует байты в base58 (биткоин/Solana-алфавит).
func Base58Encode(b []byte) string {
	x := new(big.Int).SetBytes(b)
	base := big.NewInt(58)
	zero := big.NewInt(0)
	mod := new(big.Int)
	var out []byte
	for x.Cmp(zero) > 0 {
		x.DivMod(x, base, mod)
		out = append(out, b58Alphabet[mod.Int64()])
	}
	for _, v := range b {
		if v != 0 {
			break
		}
		out = append(out, b58Alphabet[0])
	}
	// reverse
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

// Base58Decode — обратная операция (валидация адреса вывода).
func Base58Decode(s string) ([]byte, error) {
	x := new(big.Int)
	base := big.NewInt(58)
	for _, r := range s {
		idx := strings.IndexRune(b58Alphabet, r)
		if idx < 0 {
			return nil, fmt.Errorf("cryptod: недопустимый символ base58 %q", r)
		}
		x.Mul(x, base)
		x.Add(x, big.NewInt(int64(idx)))
	}
	out := x.Bytes()
	for _, r := range s {
		if r != rune(b58Alphabet[0]) {
			break
		}
		out = append([]byte{0}, out...)
	}
	if len(out) != 32 {
		return nil, fmt.Errorf("cryptod: адрес Solana должен быть 32 байта, получено %d", len(out))
	}
	return out, nil
}

// SolanaAccount — ключевая пара депозитного/горячего аккаунта.
type SolanaAccount struct {
	Path       string
	PrivateKey ed25519.PrivateKey
	PublicKey  ed25519.PublicKey
	Address    string
}

// DeriveSolanaAccount выводит аккаунт по пути (SLIP-0010-подобный, HKDF вместо
// полноценного ed25519-HD — см. docs/solana.md §3; приватная часть не покидает ядро).
func (c *Core) DeriveSolanaAccount(path string) (*SolanaAccount, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("cryptod: пустой путь деривации")
	}
	seed := HKDF(c.kek, []byte("sitee-solana-v1"), []byte("path:"+path), ed25519.SeedSize)
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	return &SolanaAccount{Path: path, PrivateKey: priv, PublicKey: pub, Address: Base58Encode(pub)}, nil
}

// DepositPath — путь депозитного адреса пользователя (m/44'/501'/<idx>'/0').
func DepositPath(index uint64) string {
	return fmt.Sprintf("m/44'/501'/%d'/0'", index)
}

// SignTransaction подписывает байты транзакции Solana, возвращая base58-подпись.
// В проде вызов идёт в Rust crypto-core с проверкой лимитов и whitelist
// (docs/solana.md §5, §7); здесь — та же криптография на ed25519.
func (c *Core) SignTransaction(path string, tx []byte) (string, error) {
	acc, err := c.DeriveSolanaAccount(path)
	if err != nil {
		return "", err
	}
	if len(tx) == 0 {
		return "", errors.New("cryptod: пустая транзакция")
	}
	return Base58Encode(ed25519.Sign(acc.PrivateKey, tx)), nil
}

// AddressOf возвращает только публичный адрес (приватный ключ не отдаётся).
func (c *Core) AddressOf(path string) (string, error) {
	acc, err := c.DeriveSolanaAccount(path)
	if err != nil {
		return "", err
	}
	return acc.Address, nil
}

// ---------------------------------------------------------------------------
// Служебное
// ---------------------------------------------------------------------------

// RandomString — случайная строка в алфавите base32 (для токенов, кодов).
func RandomString(n int) string {
	const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	b := mustRand(n)
	out := make([]byte, n)
	for i, v := range b {
		out[i] = alphabet[int(v)%len(alphabet)]
	}
	return string(out)
}

// Digits — случайная цифровая строка (коды подтверждения).
func Digits(n int) string {
	b := mustRand(n)
	out := make([]byte, n)
	for i, v := range b {
		out[i] = '0' + byte(int(v)%10)
	}
	return string(out)
}
