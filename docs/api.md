# Приложение C. API-контракт (REST + WebSocket)

Базовый URL: `https://api.sitee.example/api/v1` · WS: `wss://api.sitee.example/ws`
Форматы: JSON (UTF-8) для REST, JSON-кадры для WS (в проде — protobuf).
Аутентификация: `Authorization: Bearer <access_token>` (JWT EdDSA, TTL 15 мин).
Идемпотентность мутирующих финансовых вызовов: заголовок `Idempotency-Key: <uuid>`.

---

## 1. Общие соглашения

### 1.1 Ошибки
```json
{
  "error": {
    "code": "TOTP_STEP2_REQUIRED",
    "message": "Требуется второй фактор 2FA (операции)",
    "status": 403,
    "details": { "factor": "ops", "operation": "withdraw" },
    "request_id": "req_01J9ZK8M2Q"
  }
}
```

| HTTP | `code` | Когда |
|---|---|---|
| 400 | `VALIDATION` | Ошибка схемы/диапазона |
| 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `SESSION_REVOKED` | Нет/истёк токен |
| 403 | `FORBIDDEN`, `TOTP_STEP2_REQUIRED`, `GEO_BLOCKED`, `ACCOUNT_RESTRICTED`, `2FA_NOT_ENROLLED` | Недостаточно прав/факторов |
| 404 | `NOT_FOUND` | Объект не существует **или** не виден (без раскрытия) |
| 409 | `CONFLICT`, `INVALID_TRANSITION`, `ALREADY_USED`, `IDEMPOTENCY_CONFLICT` | Состояние не позволяет |
| 422 | `INSUFFICIENT_FUNDS`, `STOCK_EMPTY`, `LIMIT_EXCEEDED`, `RENT_REQUIRED` | Бизнес-отказ |
| 423 | `LOCKED` | Лок после брутфорса (`retry_after`) |
| 429 | `RATE_LIMITED` | Превышен лимит (`Retry-After`) |
| 500/503 | `INTERNAL`, `DEPENDENCY_UNAVAILABLE`, `OVERLOADED` | Сервер/деградация |

### 1.2 Заголовки
Ответ всегда: `X-Request-Id`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`,
`Cache-Control`, заголовки безопасности (§9 `docs/security.md`). При 429 — `Retry-After`.

### 1.3 Пагинация
Курсорная: `?limit=20&cursor=<opaque>`. Ответ:
```json
{ "items": [...], "next_cursor": "eyJvZmZzZXQiOjIwfQ", "has_more": true, "total": null }
```

### 1.4 Версионирование
`/api/v1` — стабильная; изменения схемы — аддитивные; несовместимые изменения только в `/api/v2`.
Клиент шлёт `X-Client: tma/1.4.0 (android)`.

---

## 2. Аутентификация, 2FA, гео

### 2.1 `GET /api/v1/auth/config`
Публичная конфигурация входа (без секретов):
```json
{
  "password": { "min_len": 12, "classes": 3, "algo": "argon2id" },
  "captcha": { "provider": "turnstile", "site_key": "0x4AAA...", "required_after_fails": 3 },
  "2fa": { "factors": ["login", "ops"], "period": 30, "digits": 6, "issuer": "SITEE" },
  "telegram": { "bot_username": "sitee_bot", "init_data_required": true },
  "features": { "stars": true, "sol": true, "exchange": true, "gifts": true }
}
```

### 2.2 `GET /api/v1/geo/countries` · `GET /api/v1/geo/cities?country=NO&q=Sand`
```json
{ "items": [ { "code": "NO", "name_ru": "Норвегия", "name_en": "Norway" } ] }
{ "items": [ { "id": 3110, "country": "NO", "name_ru": "Саннефьорд", "name_en": "Sandefjord", "tz": "Europe/Oslo" } ] }
```

### 2.3 `POST /api/v1/auth/register`
```json
// запрос
{ "email": "user@mail.com", "nickname": "user42", "password": "…", "password_confirm": "…",
  "country_code": "NO", "city_id": 3110, "accept_terms": true, "is_18plus": true,
  "referral_code": null, "captcha_token": "…" }
// ответ 201
{ "enrollment_id": "enr_01J9…", "status": "pending_contact_code", "expires_at": "…" }
```

### 2.4 `POST /api/v1/auth/verify-contact`
`{ "enrollment_id": "enr_…", "code": "482913" }` → `{ "status": "pending_2fa_login" }`

### 2.5 `POST /api/v1/auth/2fa/setup` (требует `enrollment_id` или сессию)
```json
// запрос
{ "factor": "login" }
// ответ
{ "factor": "login", "secret_b32": "JBSWY3DPEHPK3PXP",
  "otpauth_url": "otpauth://totp/SITEE%20(вход):user@mail.com?secret=…&issuer=SITEE&algorithm=SHA1&digits=6&period=30",
  "qr_svg": "<svg …/>", "label": "SITEE (вход)", "expires_at": "…" }
```

### 2.6 `POST /api/v1/auth/2fa/activate`
`{ "factor": "login", "code_1": "123456", "code_2": "654321" }` →
`{ "status": "active", "backup_codes": ["4F2A9-8C1D3", …], "enrolled_at": "…" }`
(backup-коды показываются один раз).

### 2.7 `POST /api/v1/auth/login`
```json
// запрос
{ "identifier": "user@mail.com", "password": "…", "captcha_token": null, "device": {"ua":"…","tz":"Europe/Oslo"} }
// ответ 200 (2FA обязателен)
{ "session_id": "ses_…", "challenge": "totp_login", "factor": "login",
  "trusted_device": false, "expires_at": "…" }
// ошибки: 401 UNAUTHENTICATED, 423 LOCKED {retry_after:900}, 403 CAPTCHA_REQUIRED
```

### 2.8 `POST /api/v1/auth/2fa/verify`
`{ "session_id": "ses_…", "factor": "login", "code": "123456" }` →
```json
{ "access_token": "eyJ…", "refresh_token": "rt_…", "expires_in": 900,
  "user": { "id":"usr_…", "nickname":"user42", "role":"buyer", "country":"NO", "city_id":3110,
            "factors": { "login":"active", "ops":"pending" },
            "balances": { "SOL":"12.5", "STARS":1500 } },
  "redirect": "/shops" }          // ★ FR-AUTH-05: автопереход на ленту магазинов
```
`redirect` всегда `/shops` после регистрации/входа обычного пользователя, `/admin` — для админа
(при наличии обоих факторов), иначе `challenge: "totp_ops"` (продолжение аутентификации).

### 2.9 `POST /api/v1/auth/telegram/init-data`
`{ "init_data": "query_id=…&user=…&hash=…" }` → проверка HMAC-SHA256 (ключ = HMAC(bot_token,"WebAppData")),
`auth_date ≤ 300 с` → тот же ответ, что и `2fa/verify` (или `challenge`, если 2FA настроен).

### 2.10 Прочее
| Метод | Путь | Описание |
|---|---|---|
| POST | `/auth/refresh` | ротация refresh-токена (reuse-detection) |
| POST | `/auth/logout` | `{ "scope": "this" \| "all" }` |
| GET | `/auth/me` | профиль + балансы + факторы + флаги |
| GET | `/auth/sessions` | активные сессии/устройства |
| DELETE | `/auth/sessions/{id}` | отозвать сессию |
| POST | `/auth/password/change` | требует фактор `ops` |
| POST | `/auth/password/reset` | заявка (Telegram-код + фактор `ops`) |
| GET | `/auth/events` | журнал входов (последние 50) |

---

## 3. Магазины и лента

### 3.1 `GET /api/v1/shops`
Query: `q`, `country`, `city`, `category`, `min_rating`, `crown_only`, `verified_only`,
`price_min`, `price_max`, `sort=recommended|rating|sales|new|price`, `cursor`, `limit(≤50)`.
```json
{
  "items": [
    {
      "id": "shp_01J9…", "slug": "nordic-keys", "name": "Nordic Keys",
      "cover_url": "https://cdn…/cover.avif", "cover_blur": "data:image/svg+xml;base64,…",
      "avatar_url": "…", "rating": 4.8, "rating_count": 312, "is_crowned": true,
      "is_verified": true, "country": "NO", "city": "Sandefjord", "sales_count": 1840,
      "response_p50_s": 180, "categories": [{"id":7,"slug":"software","name_ru":"ПО"}],
      "price_from_sol": "1.2", "badges": ["top_seller"], "promoted": false,
      "rent_status": "active"
    }
  ],
  "next_cursor": "…", "has_more": true,
  "debug_score": null
}
```
`is_crowned` вычисляется сервером (FR-SHOP-07). `promoted: true` — платный слот (не более 1/8).

### 3.2 `GET /api/v1/shops/{idOrSlug}`
Полная карточка: описание, статистика, `admin` (`{ nickname, is_online, response_p50_s, visible_as }`),
тариф аренды, список категорий, витрина товаров (первые 12), агрегаты отзывов, канал магазина,
кнопки-действия (`can_chat`, `can_order`, `can_gift`).

### 3.3 Управление магазином (владелец)
| Метод | Путь | Тело / примечание |
|---|---|---|
| POST | `/shops` | `{name, slug, description, category_ids, cover_b64?, country, city, tz}` — требует фактор `ops` и активную аренду/триал |
| PATCH | `/shops/{id}` | частичное обновление; смена `admin_user_id` — только `/shops/{id}/transfer` |
| POST | `/shops/{id}/transfer` | `{new_admin_id, totp_ops}` + аппрув супер-админа |
| POST | `/shops/{id}/cover` | multipart ≤ 8 МБ → `{cover_url}` |
| GET/POST/DELETE | `/shops/{id}/operators` | `{user_id, role, can_chat, can_deliver}` |
| GET | `/shops/{id}/stats?period=30d` | выручка, конверсия, споры, время ответа |
| POST | `/shops/{id}/takeover/{chat_id}` | перехват диалога админом (FR-SHOP-03) |

### 3.4 Аренда
```jsonc
GET  /api/v1/rent/plans
{ "items": [ { "id":"pln_crown","code":"crown","name_ru":"Crown","price_sol":"49","price_stars":4900,
              "product_limit":1000,"fee_bps":350,"feed_boost":1.0,"grants_crown":true,
              "support_sla_h":4 } ] }

POST /api/v1/shops/{id}/rent        // требует фактор ops
{ "plan_code":"crown", "asset":"SOL", "months":1, "auto_renew":true, "totp_code":"123456" }
→ { "subscription_id":"sub_…","status":"active","period_start":"…","period_end":"…",
    "charged":{ "asset":"SOL","amount":"49" },"is_crowned":true }

GET  /api/v1/shops/{id}/rent
→ { "plan":"crown","status":"expiring","period_end":"…","grace_end":null,"auto_renew":true,
    "days_left":4,"next_charge":{"asset":"SOL","amount":"49"} }
```
Ошибки: `422 INSUFFICIENT_FUNDS`, `403 TOTP_STEP2_REQUIRED`, `409 RENT_ALREADY_ACTIVE`.

### 3.5 Товары
| Метод | Путь | Примечание |
|---|---|---|
| GET | `/shops/{id}/products?q=&category=&sort=&cursor=` | витрина |
| POST | `/shops/{id}/products` | создание (→ `moderation` для первого товара) |
| PATCH | `/products/{id}` | редактирование (повторная модерация при смене категории/цены) |
| POST | `/products/{id}/stock` | `{items:["KEY-1","KEY-2"]}` или multipart-файлы → шифруется |
| GET | `/products/{id}/stock/count` | `{free:12, total:40}` (без содержимого) |
| DELETE | `/products/{id}` | архивация |

---

## 4. Заказы

### 4.1 `POST /api/v1/orders`
```json
{ "shop_id":"shp_…", "items":[{"product_id":"prd_…","qty":1}], "pay_asset":"SOL",
  "idempotency_key":"9f1c…" }
→ 201
{ "order": { "id":"ord_01J9…","number":"#A7K2-9931","status":"created",
    "shop":{"id":"…","name":"Nordic Keys"},"items":[{ "title":"Windows 11 Pro key","qty":1,
    "unit_price_sol":"2.5" }],
    "totals":{"subtotal_sol":"2.5","fee_sol":"0.09","total_sol":"2.59","asset":"SOL"},
    "pay_deadline":"…","delivery_kind":"auto",
    "actions":["pay","cancel","chat_with_admin"],
    "chat_id":"cht_…" } }
```

### 4.2 `POST /api/v1/orders/{id}/pay`
`{ "asset":"SOL", "totp_code":"123456" }` (фактор `ops` при сумме ≥ порога) →
`{ "status":"paid_escrow", "escrow_tx":"tx_…", "delivery": { "kind":"auto", "available_at":null } }`
Для `delivery_kind=auto` автовыдача происходит в той же транзакции → `delivered` и
`GET /orders/{id}/delivery` сразу доступен.

### 4.3 Прочие операции
| Метод | Путь | Тело | Кто |
|---|---|---|---|
| POST | `/orders/{id}/confirm` | — | покупатель (→ `completed`, раскрытие эскроу) |
| POST | `/orders/{id}/extend` | — | покупатель, 1 раз, +72 ч |
| POST | `/orders/{id}/cancel` | `{reason}` | покупатель до оплаты / админ магазина |
| POST | `/orders/{id}/deliver` | `{payload?:"…", stock_item_ids?:[]}` | админ магазина (ручная выдача) |
| POST | `/orders/{id}/processing` | `{comment}` | админ магазина |
| GET | `/orders/{id}/delivery` | — | покупатель: выданный контент (расшифровка по праву) |
| GET | `/orders?role=buyer\|shop&status=&cursor=` | — | списки |
| GET | `/orders/{id}` | — | детали + `actions[]` + `status_timeline[]` |
| GET | `/orders/{id}/history` | — | история статусов |

`actions[]` — серверный источник истины для UI (кнопки), вычисляется по статусу и роли.
Пример для `delivered`/покупатель: `["confirm","extend","open_dispute","chat_with_admin"]`.

### 4.4 `GET /api/v1/orders/{id}` (фрагмент ответа)
```json
{ "order": { "id":"ord_…","status":"delivered","status_timeline":[
      {"status":"created","ts":"…","actor":"system"},
      {"status":"paid_escrow","ts":"…","actor":"buyer"},
      {"status":"delivered","ts":"…","actor":"shop"} ],
    "confirm_deadline":"2026-10-13T12:00:00Z","extend_used":false,
    "delivery":{"kind":"auto","payload":"<decrypted on demand>","downloads_left":4},
    "dispute":null, "actions":["confirm","extend","open_dispute","chat_with_admin"] } }
```

---

## 5. Споры

```jsonc
POST /api/v1/orders/{id}/dispute            // требует фактор ops
{ "reason_code":"broken", "description":"Ключ не активируется, ошибка 0xC004F074…",
  "evidence":[{"kind":"image","upload_id":"upl_…"}] }
→ 201
{ "dispute": { "id":"dsp_…","status":"open","chat_id":"cht_…",
    "you_are":"buyer","your_alias":"Покупатель #K92","counterparty_alias":"Продавец #A17",
    "reply_deadline":"…","actions":["reply","escalate","attach_evidence"] } }

POST /api/v1/disputes/{id}/escalate         // «Пригласить админа»
→ { "status":"in_arbitration","arbiter":null,"assigned_eta":"≤24h" }

GET  /api/v1/disputes/{id}
→ { "dispute":{ "id":"…","status":"in_arbitration","order_id":"…",
     "participants":[{"id":"usr_…","visible_as":"Покупатель #K92","role":"buyer"},
                     {"id":"usr_…","visible_as":"Продавец #A17","role":"shop_admin"},
                     {"id":"usr_…","visible_as":"Арбитр","role":"arbiter"}],
     "evidence":[{"id":"evd_…","kind":"image","sha256":"…","url":"<signed>"}],
     "timeline":[{"ts":"…","kind":"opened","actor_visible_as":"Покупатель #K92"}],
     "actions":["reply","attach_evidence"] } }

POST /api/v1/disputes/{id}/resolve          // арбитр (фактор ops обязателен)
{ "resolution":"refund_partial","amount":"1.20","reason":"Товар частично нерабоч… (≥100 симв.)",
  "totp_code":"654321" }
→ { "status":"resolved","executed":{"tx_id":"tx_…","refunded":"1.20","released":"1.39"},
    "order_status":"refunded" }

POST /api/v1/disputes/{id}/appeal  { "reason":"…" }
```
**Маскировка (FR-DSP-03)** реализуется на сервере: в ответах не-арбитру поля `id`, `nickname`,
`avatar`, `country`, `city` второй стороны **отсутствуют**; вместо них — `visible_as`.
Арбитр получает `reveal: true` и полные данные + запись в аудит (`dispute.reveal`).

---

## 6. Мессенджер

### 6.1 `GET /api/v1/chats?filter=all|shops|orders|disputes|channels&cursor=`
```json
{ "items":[ { "id":"cht_…","kind":"shop_support","title":"Nordic Keys · поддержка",
  "shop":{"id":"…","name":"Nordic Keys","is_crowned":true},
  "admin":{"nickname":"nordic_admin","is_online":true,"visible_as":"Админ магазина"},
  "last_message":{"preview":"<encrypted>","ts":"…","sender":"shop_admin"},
  "unread":2,"is_muted":false,"e2ee":false,"pinned":true } ],
  "next_cursor":"…" }
```
Для E2EE-чатов `preview` — `<encrypted>` (сервер не может расшифровать).

### 6.2 Открытие диалога с админом (FR-SHOP-01, FR-MSG-01)
`POST /api/v1/chats { "kind":"shop_support", "shop_id":"shp_…" }` →
создаёт или возвращает существующий чат, где вторая сторона — `shops.admin_user_id`.
`POST /api/v1/chats { "kind":"direct", "user_id":"…" }` — приватный (E2EE обязателен).
`POST /api/v1/chats { "kind":"group", "shop_id":"…", "title":"…" }` — только админ магазина.

### 6.3 История и отправка (REST-fallback, основной транспорт — WS)
```jsonc
GET  /api/v1/chats/{id}/messages?before_seq=128&limit=50
{ "items":[ { "id":"msg_…","seq":127,"sender_id":"usr_…","sender_visible_as":"Админ магазина",
   "type":"text","body_ct":"<base64 envelope>","e2ee":true,"sender_key_id":"spk_…",
   "created_at":"…","edited_at":null,"reply_to":null } ], "has_more":true }

POST /api/v1/chats/{id}/messages
{ "client_msg_id":"c_9f1c…","type":"text",
  "body_ct":"<AES-256-GCM ciphertext (E2EE) или plaintext для server-encrypted чатов>",
  "e2ee":true, "aad":"cht_…:128:dev_…" }
→ { "id":"msg_…","seq":128,"created_at":"…" }
```
Для не-E2EE чатов клиент шлёт plaintext по WSS/HTTPS, сервер шифрует его через crypto-core
(домен `msg`) и сохраняет ciphertext (FR-MSG-05).

### 6.4 E2EE-ключи
| Метод | Путь | Тело |
|---|---|---|
| POST | `/e2ee/prekeys` | `{device_id, identity_pub, identity_sig, signed_prekey:{pub,sig}, one_time_keys:[{id,pub}]}` |
| GET | `/e2ee/bundle/{user_id}?device_id=` | `{identity_pub, signed_prekey, one_time_key}` (одноразовый ключ изымается) |
| POST | `/e2ee/sessions` | `{chat_id, to_user, to_device, ephemeral_pub, used_opk_id}` → `{session_id, safety_number}` |
| GET | `/e2ee/sessions/{chat_id}` | список устройств/сессий, safety number |

### 6.5 Каналы и группы
`POST /channels/{id}/subscribe` · `DELETE …` · `POST /channels/{id}/posts` (админ) ·
`GET /chats/{id}/members` · `POST /chats/{id}/members` (invite) · `POST /chats/{id}/leave` ·
`POST /chats/{id}/read {seq}` · `POST /messages/{id}/react {emoji}` (SHOULD).

---

## 7. Кошелёк, обмен, звёзды, подарки

```jsonc
GET /api/v1/wallet
{ "balances":[{"asset":"SOL","available":"12.5","locked":"2.59"},
              {"asset":"STARS","available":1500,"locked":0}],
  "deposit":{"asset":"SOL","address":"7xKXtg2C…","qr":"data:image/png;base64,…",
             "min":"0.01","confirmations_required":32,"memo":null},
  "limits":{"withdraw_daily_sol":"50","withdraw_single_sol":"50","withdraw_whitelist_cooling_h":24},
  "hot":{ "network":"mainnet-beta" } }

GET  /api/v1/wallet/transactions?asset=SOL&kind=&cursor=
{ "items":[{"id":"tx_…","kind":"deposit","amount":"+2.5","asset":"SOL","status":"confirmed",
            "ts":"…","ref":{"type":"solana","signature":"5x…"},"memo":null}] }

POST /api/v1/wallet/withdraw            // фактор ops + whitelist
{ "asset":"SOL","amount":"1.5","dest_address":"…","totp_code":"654321","idempotency_key":"…" }
→ { "id":"wdr_…","status":"pending_approval"|"broadcast","eta_s":120,"fee":"0.000005" }

GET  /api/v1/exchange/quote?from=STARS&to=SOL&amount=1000
{ "quote_id":"qo_…","rate":"0.0051","fee_bps":100,"from_amount":1000,"to_amount":"5.05",
  "valid_until":"…","limits":{"min":100,"max":100000} }

POST /api/v1/exchange  { "quote_id":"qo_…","totp_code":"654321" }
→ { "order_id":"ex_…","status":"filled","from":"1000 STARS","to":"5.05 SOL","tx_id":"tx_…" }

GET  /api/v1/gifts?shop_id=&rarity=&cursor=
{ "items":[{"id":"gft_…","sku":"crown_boost_7","title_ru":"Корона на 7 дней",
   "rarity":"epic","media_url":"…","media_kind":"lottie","price_stars":900,"price_sol":"4.5",
   "boosts_shop":true,"boost_days":7,"per_user_limit":2,"stock_note":"без лимита"}] }

POST /api/v1/gifts/{id}/buy             // фактор ops при сумме >= порога
{ "asset":"STARS","recipient_type":"shop","recipient_id":"shp_…","message":"Спасибо за ключ!",
  "totp_code":"123456","idempotency_key":"…" }
→ { "purchase_id":"gp_…","status":"paid","charged":{"asset":"STARS","amount":900},
    "boost":{"shop_id":"shp_…","until":"…","value":0.35},
    "chat_card":{"chat_id":"cht_…","message_id":"msg_…"} }

GET  /api/v1/gifts/inventory
POST /api/v1/stars/invoice    { "amount_stars":1000, "purpose":"gift" } → { "invoice_url":"…" }  // TMA openInvoice
POST /api/v1/stars/webhook    // Telegram Bot API, HMAC-проверка, идемпотентность
```

---

## 8. Отзывы

```jsonc
POST /api/v1/orders/{id}/review
{ "rating":5,"rating_delivery":5,"rating_description":5,"rating_support":5,
  "body":"Ключ пришёл мгновенно, админ ответил за 2 минуты.","media":[] }
→ 201 { "review_id":"rev_…","shop_rating":4.8 }

GET  /api/v1/shops/{id}/reviews?rating=&sort=new|helpful&cursor=
{ "summary":{"bayes":4.78,"count":312,"distribution":{"5":260,"4":30,"3":12,"2":6,"1":4},
             "positive_pct":93},
  "items":[{"id":"rev_…","author":"k***2","is_verified_purchase":true,"rating":5,"body":"…",
            "shop_reply":"Спасибо!","created_at":"…","helpful_count":3}] }

POST /api/v1/reviews/{id}/reply      // админ магазина, 1 ответ
POST /api/v1/reviews/{id}/report     { "reason":"abuse","comment":"…" }
PATCH /api/v1/reviews/{id}           // автор, ≤ 7 сут
```

---

## 9. Админ-панель `/api/v1/admin/*`

Все вызовы требуют роль `moderator|arbiter|superadmin` + фактор `ops`; каждая операция пишется
в `audit_log`. Деструктивные/финансовые — флаг `require_four_eyes`.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/dashboard` | GMV, комиссии, DAU, активные аренды, споры в очереди, инциденты |
| GET | `/admin/users?q=&status=&cursor=` | поиск пользователей |
| PATCH | `/admin/users/{id}` | `{status, reason}` — ban/restrict/unban |
| POST | `/admin/users/{id}/2fa-reset` | сброс фактора по заявке (4-глаза) |
| GET | `/admin/shops?status=&plan=&cursor=` | список магазинов |
| POST | `/admin/shops/{id}/sanction` | `{level:"warn\|restrict\|suspend\|ban", reason, until}` |
| POST | `/admin/shops/{id}/verified` | `{value:true}` |
| POST | `/admin/shops/{id}/rent/extend` | `{days:30, reason}` — ручное продление |
| GET/POST/PATCH | `/admin/rent/plans` | CRUD тарифов аренды |
| **GET/POST/PATCH/DELETE** | **`/admin/gifts`** | **CRUD подарков (FR-STR-04)** |
| POST | `/admin/gifts/import` | CSV-импорт |
| POST | `/admin/gifts/{id}/media` | загрузка медиа |
| GET | `/admin/moderation/products?status=moderation` | очередь товаров |
| POST | `/admin/moderation/products/{id}/approve\|reject` | `{note}` |
| GET | `/admin/orders?q=&status=` · PATCH `/admin/orders/{id}/status` | поиск и ручная смена статуса (фактор ops + причина) |
| GET | `/admin/disputes?status=&arbiter=` | очередь споров |
| POST | `/admin/disputes/{id}/assign` | `{arbiter_id}` (или авто-назначение) |
| GET | `/admin/finance/ledger?from=&to=` · GET `/admin/finance/reconciliation` | отчёты и сверка |
| GET | `/admin/wallets/hot` · POST `/admin/wallets/sweep` | горячий/холодный, sweep (4-глаза) |
| GET | `/admin/security/events?type=&cursor=` | auth_events, rate-limit, атаки |
| POST | `/admin/security/ip-ban` | `{cidr, until, reason}` |
| GET | `/admin/audit?object_type=&object_id=&cursor=` | неизменяемый аудит-лог |
| GET/PATCH | `/admin/settings/{key}` | пороги, лимиты, курс, фиче-флаги |
| GET | `/admin/categories` | справочник категорий: 18+, чёрный список юрисдикций, число магазинов |
| PATCH | `/admin/categories/{id}` | `{blocked_countries:[...], restricted, totp_code, reason}` — гео-блокировки (FR-GEO-03б) |

### 9.0 Гео-блокировки категорий (FR-GEO-03б)

Чёрный список юрисдикций настраивается на категорию. Запрещённая категория
не отдаётся и не продаётся в стране покупателя или продавца:

```jsonc
// GET /api/v1/admin/categories → элемент items
{ "id": 12, "slug": "vpn-proxy", "name_ru": "VPN и прокси", "restricted": false,
  "blocked_countries": ["CN", "IR"], "shops": 1 }

// PATCH /api/v1/admin/categories/12   (superadmin + фактор ops)
{ "blocked_countries": ["CN"], "totp_code": "123456", "reason": "снятие запрета для IR" }
→ { "id": 12, "slug": "vpn-proxy", "name_ru": "VPN и прокси",
    "restricted": false, "blocked_countries": ["CN"] }
```

Поведение (одинаковое в Go-бэкенде и в Node-прототипе):

| Ситуация | Ответ |
|---|---|
| Все категории магазина запрещены в стране зрителя | магазин скрыт из ленты `GET /shops` |
| Товар запрещённой категории в списке товаров магазина | позиция не отдаётся (кроме владельца) |
| `GET /products/{id}` из запрещённой страны | `403 GEO_BLOCKED` |
| `POST /orders` с товаром запрещённой категории | `403 GEO_BLOCKED` |
| Создание магазина/товара в запрещённой юрисдикции | `403 GEO_BLOCKED` |

Коды стран — ISO 3166-1 alpha-2 из справочника `GET /api/v1/geo/countries`;
неизвестный код отклоняется с `400 VALIDATION`.

### 9.1 CRUD подарков — детально (FR-STR-04)
```jsonc
POST /api/v1/admin/gifts
{ "sku":"crown_boost_7","title_ru":"Корона на 7 дней","title_en":"Crown boost 7d",
  "description":"Повышает позицию магазина в ленте на 7 дней.","rarity":"epic",
  "media_kind":"lottie","media_b64":"…","price_stars":900,"price_sol":"4.5",
  "per_user_limit":2,"boosts_shop":true,"boost_value":0.35,"boost_days":7,
  "collectible":false,"starts_at":null,"ends_at":null,"status":"published","sort":10 }
→ 201 { "id":"gft_…","created_at":"…" }

PATCH /api/v1/admin/gifts/{id}     // частичное обновление + авто-запись diff в аудит
POST  /api/v1/admin/gifts/{id}/duplicate
DELETE /api/v1/admin/gifts/{id}    // архивация (status=archived), продажи останавливаются
GET   /api/v1/admin/gifts/{id}/stats  // продажи, выручка, конверсия
```

---

## 10. WebSocket `/ws`

### 10.1 Подключение
`GET /ws?token=<access>&last_seq=<map>` (или кадр `hello` в первые 10 с).
Ответ сервера: `hello.ok`.

```jsonc
// C→S
{ "v":1,"id":"c1","t":"hello",
  "d":{ "token":"eyJ…","device_id":"dev_…","platform":"tma-android",
        "chats":{ "cht_a":120, "cht_b":0 } } }
// S→C
{ "v":1,"id":"c1","t":"hello.ok",
  "d":{ "server_ts":1760000000123,"session":"ws_…",
        "backfill":{ "cht_a":[ /* msg.new[] */ ] },
        "limits":{ "msg_per_min":60,"frame_bytes":65536,"ping_s":25 } } }
```

### 10.2 Кадры (полный список — `docs/architecture.md` §5)
```jsonc
// отправка сообщения
{ "v":1,"id":"c2","t":"msg.send",
  "d":{ "chat_id":"cht_a","client_msg_id":"c_9f…","type":"text",
        "body_ct":"<base64>","e2ee":true,"aad":"cht_a:121:dev_…","reply_to":null } }
// подтверждение
{ "v":1,"id":"c2","t":"msg.sent","d":{ "client_msg_id":"c_9f…","id":"msg_…","seq":121,"ts":"…" } }
// доставка получателю
{ "v":1,"t":"msg.new","d":{ "chat_id":"cht_a","id":"msg_…","seq":121,
   "sender_id":"usr_…","sender_visible_as":"Админ магазина","type":"text",
   "body_ct":"<base64>","e2ee":true,"ts":"…" } }
// статус заказа
{ "v":1,"t":"order.status","d":{ "order_id":"ord_…","status":"delivered","ts":"…",
   "actions":["confirm","extend","open_dispute","chat_with_admin"] } }
// событие спора
{ "v":1,"t":"dispute.event","d":{ "dispute_id":"dsp_…","kind":"arbiter_assigned",
   "visible_as":"Арбитр","ts":"…" } }
// ошибка
{ "v":1,"id":"c2","t":"error","d":{ "code":"RATE_LIMITED","message":"…","retry_after":7 } }
```

### 10.3 Коды закрытия
| Код | Причина |
|---|---|
| 1000 | штатное закрытие |
| 1008 | нарушение политики (спам/лимиты) |
| 4401 | не аутентифицирован в 10-секундное окно |
| 4403 | недостаточно прав на чат |
| 4408 | heartbeat timeout |
| 4429 | превышен лимит соединений/сообщений |
| 4503 | сервер перегружен (shedding), клиент обязан reconnect с backoff |

---

## 11. Вебхуки и внешние интеграции

| Интеграция | Направление | Проверка |
|---|---|---|
| Telegram Stars (Bot API `sendInvoice`/`answerPreCheckoutQuery`) | входящий вебхук | `X-Telegram-Bot-Api-Secret-Token`, идемпотентность по `telegram_payment_charge_id` |
| Telegram WebApp `init_data` | клиент → API | HMAC-SHA256(key=HMAC(bot_token,"WebAppData")), `auth_date ≤ 300 с` |
| Solana RPC / WebSocket | исходящий | несколько провайдеров, повтор с backoff, подтверждение по слотам |
| SMTP | исходящий | DKIM/SPF/DMARC, лимиты |
| Платёжные уведомления пользователя | исходящий (бот) | dedup_key |

---

## 12. Контрактные тесты

* `docs/openapi.yaml` — источник истины; CI проверяет совместимость (breaking-change gate).
* Для каждого эндпоинта — happy path + ≥ 2 негативных кейса (401/403/409/422/429).
* Сценарии-цепочки (регресс): register→2fa×2→feed→order→pay→deliver→confirm→review;
  order→dispute→escalate→resolve(refund); rent→crown→feed-boost; gift→boost→rating.
