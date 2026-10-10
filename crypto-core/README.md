# crypto-core — криптографическое ядро SITEE (Rust, std-only)

Вся чувствительная к правильности криптография SITEE живёт здесь: шифрование
диалогов и персональных данных, двойная 2FA, слепые индексы для поиска по
шифротексту, подпись Solana-транзакций, скоринг антифрода и token-bucket
лимитер. Go-бэкенд (`backend/internal/cryptod`) держит тот же набор алгоритмов
на `crypto/*`, а `tools/preview/crypto.mjs` — зеркало для прототипа. Форматы
**идентичны побайтово**, это зафиксировано в `tests/interop.rs`.

## Почему вручную

Внешних крейтов нет намеренно: ядро собирается одним `rustc`, не тянет сеть в
сборке и не имеет supply-chain рисков. SHA-256/512, HMAC, HKDF, PBKDF2,
AES-256-GCM, ed25519 и base58 написаны с нуля и проверены на RFC/NIST векторах.

```
cargo test          # все векторы + межоперабельность
cargo run --release --bin crypto-core 0.0.0.0:8091
```

`SITEED_KEK_HEX` — 64 hex-символа (32 байта) KEK. Без него сервис не стартует.

## Модули

| Файл | Что внутри |
|---|---|
| `base64.rs` | base64 std/URL, кодирование для хранения |
| `rand.rs` | CSPRNG на `RandomState` + `/dev/urandom` + время |
| `sha1.rs`, `sha256.rs`, `sha512.rs` | хеши (векторы FIPS 180-4) |
| `hmac.rs`, `hkdf.rs`, `pbkdf2.rs` | KDF (RFC 2104, 5869, 8018) |
| `aes256.rs`, `gcm.rs` | AES-256-GCM (NIST SP 800-38D), AAD, тег 16 байт |
| `envelope.rs` | конверт `0x01‖key_id(8)‖nonce(12)‖ct+tag`, DEK через HKDF, AAD `<domain>:<object_id>` |
| `blind.rs` | слепой индекс `HMAC(HKDF(KEK,"sitee-idx-v1","blind-index"), lower(trim(v)))` |
| `totp.rs` | RFC 6238 SHA-1/30 с/6 цифр, base32-секреты, 10 резервных кодов |
| `ed25519.rs` | RFC 8032: ключи, подпись, проверка, расширенные координаты |
| `solana.rs` | base58, compact-u16, System-трансфер, BIP44-пути, политика подписи |
| `safety.rs` | номера безопасности диалога (8×5 цифр) |
| `audit.rs` | канонический JSON + HMAC-цепочка аудита, `verify_chain` |
| `dispute.rs` | маскирующие псевдонимы участников спора |
| `fraud.rs` | скоринг 0–1000 → allow/captcha/delay/manual_review/deny |
| `ratelimit.rs` | 10 профилей, token bucket, автобан, `gc`, статистика |
| `json.rs` | минимальный JSON для сервиса (std-only) |
| `main.rs` | HTTP-сервис ядра (см. ниже) |

## Форматы (общие для Go / Rust / preview)

```
конверт   : 0x01 ‖ key_id(8) ‖ nonce(12) ‖ ct ‖ tag(16)      → base64
AAD       : "<domain>:<object_id>"
DEK       : HKDF-SHA256(KEK, salt="sitee-dek-v1", info="domain:"+domain, 32)
key_id    : sha256("sitee-keyid-v1:"+domain+":"+kekFP)[:8]
blind idx : HMAC(HKDF(KEK,"sitee-idx-v1","blind-index",32), lower(trim(v))) hex
пароль    : pbkdf2-sha256$210000$<salt_b64raw>$<hash_b64raw>
Solana    : ключ = ed25519(HKDF(KEK,"sitee-solana-v1","path:m/44'/501'/<n>'/0'",32))
            адрес = base58(публичный ключ), подпись = base58
safety №  : HMAC-SHA256("sitee-safety-v1:<fp>", min(uid)|max(uid)) → 8×5 цифр
audit     : base64(HMAC-SHA256("sitee-audit-v1", JSON включая prev_hash))
домены    : pii, 2fa, msg, product_stock, dispute, wallet, audit
```

## HTTP-сервис (бинарник `crypto-core`)

Go обращается сюда при `CRYPTO_CORE_URL=http://crypto-core:8091`
(`docs/architecture.md` §2.2). Все ответы — JSON, тело ≤ 1 МиБ.

| Метод | Путь | Тело → ответ |
|---|---|---|
| GET | `/healthz` | `{"status":"ok"}` |
| POST | `/v1/fraud/score` | сигналы → `{score, action, reasons[]}` |
| POST | `/v1/ratelimit/check` | `{key, profile}` → `{allowed, remaining, retry_after_secs, blocked, limit, profile}` |
| POST | `/v1/crypto/encrypt` | `{domain, object_id, plaintext_b64}` → `{blob}` |
| POST | `/v1/crypto/decrypt` | `{domain, object_id, blob}` → `{plaintext_b64}` |
| POST | `/v1/crypto/blind-index` | `{value}` → `{index}` |
| POST | `/v1/crypto/password/hash` | `{password, policy?}` → `{encoded}` |
| POST | `/v1/crypto/password/verify` | `{password, encoded}` → `{ok}` |
| POST | `/v1/solana/address` | `{path}` → `{address}` |
| POST | `/v1/solana/sign` | `{path, message_b64, purpose}` → `{signature}` |
| POST | `/v1/totp/validate` | `{secret_b32, code, at}` → `{ok, step}` |
| POST | `/v1/totp/generate` | `{secret_b32, at}` → `{code}` |

Если ядро недоступно, Go переключается на встроенный `cryptod` — поэтому
контракт и форматы обязаны совпадать, иначе расшифровка старых данных сломается.

## Тесты

`cargo test` прогоняет ~120 проверок: RFC/NIST векторы, round-trip каждого
примитива, tamper-detection GCM, RFC 6238 (TOTP), RFC 8032 (ed25519, тесты 1 и
2), детерминизм Solana-адресов, форматы safety/audit/alias и сквозная проверка
«Rust ⇄ Node» для конверта и слепого индекса.
