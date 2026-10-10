# Приложение B. Модель данных (PostgreSQL 16)

Ссылки: `TZ.md` FR-SHOP-*, FR-ORD-*, FR-MSG-*, FR-DSP-*, FR-STR-*, FR-EXC-*, FR-REV-*, FR-ADM-*.
Соглашения: PK — `bigint GENERATED ALWAYS AS IDENTITY` или `text` (ULID) для публичных сущностей;
время — `timestamptz`; деньги — `numeric(24,9)` для SOL и `bigint` для Stars (целые);
секреты — `*_ct` (envelope base64/bytea); мягкое удаление — `deleted_at`.

---

## 1. ER-обзор

```
users ─┬─ user_devices ── sessions ── refresh_tokens
       ├─ user_2fa (factor: login|ops) ── user_backup_codes
       ├─ user_geo (country/city)
       ├─ wallet_accounts ─┬─ sol_deposit_addresses
       │                   └─ ledger_entries (двойная запись)
       ├─ shops (admin_user_id) ─┬─ shop_operators
       │                        ├─ shop_rent_subscriptions ── shop_rent_plans
       │                        ├─ products ── product_stock_items
       │                        ├─ reviews
       │                        └─ gifts_received (буст)
       ├─ orders ─┬─ order_items ── products
       │          ├─ order_status_history
       │          ├─ payments ── ledger_entries
       │          └─ disputes ── dispute_events
       ├─ chats ─┬─ chat_members
       │         ├─ messages (body_ct)
       │         └─ e2ee_prekeys / e2ee_sessions
       ├─ gift_purchases ── gifts
       └─ audit_log, auth_events, notifications
countries ── cities
```

---

## 2. DDL (ядро)

```sql
-- ============ ГЕО ============
CREATE TABLE countries (
  code         char(2) PRIMARY KEY,             -- ISO 3166-1 alpha-2
  name_ru      text NOT NULL,
  name_en      text NOT NULL,
  phone_prefix text,
  currency_default text NOT NULL DEFAULT 'SOL',
  is_blocked   boolean NOT NULL DEFAULT false,   -- гео-блок платформы
  blocked_categories bigint[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cities (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  country_code  char(2) NOT NULL REFERENCES countries(code) ON DELETE CASCADE,
  name_ru       text NOT NULL,
  name_en       text NOT NULL,
  tz            text NOT NULL DEFAULT 'UTC',
  population    bigint NOT NULL DEFAULT 0,
  search_vector tsvector GENERATED ALWAYS AS
                (to_tsvector('simple', coalesce(name_ru,'') || ' ' || coalesce(name_en,''))) STORED
);
CREATE INDEX cities_country_idx ON cities(country_code);
CREATE INDEX cities_search_idx  ON cities USING gin(search_vector);

-- ============ ПОЛЬЗОВАТЕЛИ И БЕЗОПАСНОСТЬ ============
CREATE TABLE users (
  id             text PRIMARY KEY,               -- ULID
  email_ct       bytea,                          -- envelope AES-256-GCM (домен pii)
  email_bidx     bytea UNIQUE,                   -- HMAC-SHA256 blind index
  tg_id          bigint UNIQUE,                  -- Telegram user id (если привязан)
  tg_username    text,
  nickname       text NOT NULL UNIQUE,
  password_hash  text NOT NULL,                  -- argon2id$... | pbkdf2$...
  pass_algo      text NOT NULL DEFAULT 'argon2id',
  role           text NOT NULL DEFAULT 'buyer'
                 CHECK (role IN ('guest','buyer','seller','shop_admin','moderator','arbiter','superadmin')),
  country_code   char(2) REFERENCES countries(code),
  city_id        bigint REFERENCES cities(id),
  locale         text NOT NULL DEFAULT 'ru',
  theme          text NOT NULL DEFAULT 'dark',
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('pending','active','restricted','suspended','banned','deleted')),
  warmup_until   timestamptz,                    -- «прогрев»: лимиты для новых аккаунтов
  risk_score     smallint NOT NULL DEFAULT 0,    -- 0..1000, анти-фрод
  is_18plus      boolean NOT NULL DEFAULT false,
  referral_code  text UNIQUE,
  referred_by    text REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  deleted_at     timestamptz
);
CREATE INDEX users_role_status_idx ON users(role, status);
CREATE INDEX users_geo_idx ON users(country_code, city_id);

CREATE TABLE user_2fa (
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  factor      text NOT NULL CHECK (factor IN ('login','ops')),
  secret_ct   bytea NOT NULL,                    -- TOTP-секрет в ciphertext (домен 2fa)
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked')),
  enrolled_at timestamptz,
  last_used_at timestamptz,
  drift_warn  smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, factor)
);

CREATE TABLE user_backup_codes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  factor     text NOT NULL CHECK (factor IN ('login','ops')),
  code_hmac  bytea NOT NULL,                     -- HMAC-SHA256(salt, code)
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, factor, code_hmac)
);

CREATE TABLE user_devices (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint  bytea,                            -- hash(JA4 + UA + screen + tz)
  user_agent   text,
  platform     text,                             -- android|ios|desktop|web|tma
  country_code char(2),
  is_trusted   boolean NOT NULL DEFAULT false,
  trusted_until timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     text REFERENCES user_devices(id),
  family_id     text NOT NULL,                   -- для reuse-detection refresh-токенов
  status        text NOT NULL DEFAULT 'pending_2fa'
                CHECK (status IN ('pending_code','pending_2fa_login','pending_2fa_ops','active','revoked','expired')),
  ip            inet,
  ip_geo        text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  revoke_reason text
);
CREATE INDEX sessions_user_idx ON sessions(user_id, status);

CREATE TABLE refresh_tokens (
  token_hash bytea PRIMARY KEY,                  -- SHA-256(refresh)
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_hash bytea,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  user_id     text,
  event       text NOT NULL,                     -- login_ok|login_fail|2fa_fail|2fa_ok|register|reset|...
  ip          inet,
  asn         bigint,
  country_code char(2),
  fingerprint bytea,
  user_agent  text,
  reason      text,
  risk_score  smallint
);
CREATE INDEX auth_events_user_ts ON auth_events(user_id, ts DESC);
CREATE INDEX auth_events_ip_ts   ON auth_events(ip, ts DESC);

-- ============ КОШЕЛЬКИ И LEDGER ============
CREATE TABLE wallet_accounts (
  id           text PRIMARY KEY,
  owner_type   text NOT NULL CHECK (owner_type IN ('user','shop','platform','escrow','fees')),
  owner_id     text,                             -- user_id | shop_id | order_id | 'platform'
  asset        text NOT NULL CHECK (asset IN ('SOL','USDC','STARS')),
  balance      numeric(24,9) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  locked       numeric(24,9) NOT NULL DEFAULT 0 CHECK (locked >= 0),
  version      bigint NOT NULL DEFAULT 0,        -- optimistic locking
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id, asset)
);

CREATE TABLE ledger_entries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tx_id          text NOT NULL,                  -- одна операция = одна транзакция (группа проводок)
  idempotency_key text UNIQUE NOT NULL,
  ts             timestamptz NOT NULL DEFAULT now(),
  account_id     text NOT NULL REFERENCES wallet_accounts(id),
  direction      text NOT NULL CHECK (direction IN ('debit','credit')),
  amount         numeric(24,9) NOT NULL CHECK (amount > 0),
  asset          text NOT NULL,
  kind           text NOT NULL,                  -- deposit|withdraw|order_hold|order_release|refund|rent|gift|exchange|fee|reward
  ref_type       text,                           -- order|subscription|gift_purchase|exchange|dispute
  ref_id         text,
  meta           jsonb NOT NULL DEFAULT '{}',
  actor_id       text
);
CREATE INDEX ledger_account_ts ON ledger_entries(account_id, ts DESC);
CREATE INDEX ledger_tx_idx     ON ledger_entries(tx_id);
CREATE INDEX ledger_kind_ref   ON ledger_entries(kind, ref_type, ref_id);

CREATE TABLE sol_deposit_addresses (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address      text NOT NULL UNIQUE,             -- base58 pubkey (публичная часть)
  derivation_path text NOT NULL,                 -- m/44'/501'/<idx>'/0'
  key_id       text NOT NULL,                    -- ссылка на wrapped-ключ в crypto-core
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  expected_amount numeric(24,9),                 -- для сопоставления без memo
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sol_transactions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signature     text UNIQUE NOT NULL,
  slot          bigint NOT NULL,
  block_time    timestamptz NOT NULL,
  direction     text NOT NULL CHECK (direction IN ('in','out')),
  address       text NOT NULL,
  user_id       text,
  amount_lamports bigint NOT NULL,
  fee_lamports  bigint NOT NULL DEFAULT 0,
  confirmations int NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'seen'
                CHECK (status IN ('seen','credited','pending','broadcast','confirmed','failed','reverted')),
  tx_id         text,                            -- ссылка на ledger tx
  raw           jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sol_tx_user_ts ON sol_transactions(user_id, block_time DESC);
CREATE INDEX sol_tx_status  ON sol_transactions(status, confirmations);

CREATE TABLE withdrawals (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id),
  asset         text NOT NULL DEFAULT 'SOL',
  amount        numeric(24,9) NOT NULL,
  dest_address  text NOT NULL,
  whitelisted_at timestamptz,
  status        text NOT NULL DEFAULT 'pending_2fa'
                CHECK (status IN ('pending_2fa','pending_approval','approved','broadcast','confirmed','failed','cancelled')),
  approver_id   text,                            -- 4-глаза для сумм >= порога
  signature     text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exchange_quotes (
  id         text PRIMARY KEY,
  from_asset text NOT NULL,
  to_asset   text NOT NULL,
  rate       numeric(24,12) NOT NULL,
  fee_bps    int NOT NULL DEFAULT 0,
  min_amount numeric(24,9) NOT NULL,
  max_amount numeric(24,9) NOT NULL,
  valid_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exchange_orders (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id),
  quote_id    text NOT NULL REFERENCES exchange_quotes(id),
  from_asset  text NOT NULL, to_asset text NOT NULL,
  from_amount numeric(24,9) NOT NULL, to_amount numeric(24,9) NOT NULL,
  fee         numeric(24,9) NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'filled' CHECK (status IN ('filled','failed','cancelled')),
  tx_id       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============ МАГАЗИНЫ И АРЕНДА ============
CREATE TABLE categories (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id     bigint REFERENCES categories(id),
  slug          text NOT NULL UNIQUE,
  name_ru       text NOT NULL, name_en text NOT NULL,
  is_restricted boolean NOT NULL DEFAULT false,
  blocked_in    char(2)[] NOT NULL DEFAULT '{}',  -- юрисдикции, где категория запрещена
  sort          int NOT NULL DEFAULT 0
);

CREATE TABLE shop_rent_plans (
  id             text PRIMARY KEY,
  code           text NOT NULL UNIQUE,            -- starter|pro|crown|enterprise
  name_ru        text NOT NULL,
  price_sol      numeric(24,9) NOT NULL,
  price_stars    bigint NOT NULL,
  product_limit  int NOT NULL,
  operator_limit int NOT NULL DEFAULT 0,
  fee_bps        int NOT NULL,                    -- комиссия площадки, базисные пункты
  feed_boost     numeric(4,3) NOT NULL DEFAULT 0, -- 0 | 0.5 | 1.0
  grants_crown   boolean NOT NULL DEFAULT false,
  support_sla_h  int NOT NULL DEFAULT 24,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shops (
  id             text PRIMARY KEY,
  admin_user_id  text NOT NULL REFERENCES users(id),   -- ★ привязка к админу (FR-SHOP-02)
  slug           text NOT NULL UNIQUE,
  name           text NOT NULL,
  description    text,
  cover_url      text,
  avatar_url     text,
  category_ids   bigint[] NOT NULL DEFAULT '{}',
  country_code   char(2) REFERENCES countries(code),
  city_id        bigint REFERENCES cities(id),
  tz             text NOT NULL DEFAULT 'UTC',
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','moderation','active','frozen','suspended','banned')),
  is_verified    boolean NOT NULL DEFAULT false,
  rating_sum     bigint NOT NULL DEFAULT 0,
  rating_count   int NOT NULL DEFAULT 0,
  rating_bayes   numeric(3,2) NOT NULL DEFAULT 0,
  sales_count    int NOT NULL DEFAULT 0,
  sales_volume_sol numeric(24,9) NOT NULL DEFAULT 0,
  response_p50_s int,
  dispute_rate   numeric(5,4) NOT NULL DEFAULT 0,
  gift_boost     numeric(6,3) NOT NULL DEFAULT 0,
  gift_boost_until timestamptz,
  sanction_level text NOT NULL DEFAULT 'none' CHECK (sanction_level IN ('none','warn','restrict')),
  sanction_until timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX shops_admin_idx ON shops(admin_user_id);
CREATE INDEX shops_status_idx ON shops(status, rating_bayes DESC);
CREATE INDEX shops_geo_idx ON shops(country_code, city_id);
CREATE INDEX shops_name_trgm ON shops USING gin (name gin_trgm_ops);   -- расширение pg_trgm

CREATE TABLE shop_operators (
  shop_id    text NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'operator' CHECK (role IN ('owner','manager','operator')),
  can_chat   boolean NOT NULL DEFAULT true,
  can_deliver boolean NOT NULL DEFAULT true,
  can_refund boolean NOT NULL DEFAULT false,
  invited_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, user_id)
);

CREATE TABLE shop_rent_subscriptions (
  id           text PRIMARY KEY,
  shop_id      text NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  plan_id      text NOT NULL REFERENCES shop_rent_plans(id),
  status       text NOT NULL DEFAULT 'trial'
               CHECK (status IN ('trial','active','expiring','grace','suspended','cancelled','expired')),
  asset        text NOT NULL CHECK (asset IN ('SOL','STARS')),
  price        numeric(24,9) NOT NULL,
  period_start timestamptz NOT NULL,
  period_end   timestamptz NOT NULL,
  grace_end    timestamptz,
  auto_renew   boolean NOT NULL DEFAULT true,
  renew_attempts smallint NOT NULL DEFAULT 0,
  last_payment_id text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rent_shop_active ON shop_rent_subscriptions(shop_id, status, period_end);

CREATE TABLE products (
  id            text PRIMARY KEY,
  shop_id       text NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  category_id   bigint REFERENCES categories(id),
  title         text NOT NULL,
  description   text,
  kind          text NOT NULL CHECK (kind IN ('key','file','account','subscription','service_code','custom')),
  price_sol     numeric(24,9) NOT NULL DEFAULT 0,
  price_stars   bigint NOT NULL DEFAULT 0,
  media_urls    text[] NOT NULL DEFAULT '{}',
  stock_total   int NOT NULL DEFAULT 0,
  stock_free    int NOT NULL DEFAULT 0,
  warranty_days int NOT NULL DEFAULT 0,
  delivery_sla_h int NOT NULL DEFAULT 24,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','moderation','published','rejected','archived')),
  moderation_note text,
  rating_sum    bigint NOT NULL DEFAULT 0,
  rating_count  int NOT NULL DEFAULT 0,
  dek_id        text,                             -- id DEK для стока (домен product_stock)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('russian', title || ' ' || coalesce(description,''))) STORED
);
CREATE INDEX products_shop_status ON products(shop_id, status);
CREATE INDEX products_search ON products USING gin(search_vector);

CREATE TABLE product_stock_items (
  id          text PRIMARY KEY,
  product_id  text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  payload_ct  bytea NOT NULL,                    -- ключ/учётка/ссылка на файл (AES-256-GCM)
  status      text NOT NULL DEFAULT 'free' CHECK (status IN ('free','reserved','sold','void')),
  reserved_by text,                              -- order_id
  reserved_at timestamptz,
  sold_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_product_free ON product_stock_items(product_id, status);

-- ============ ЗАКАЗЫ ============
CREATE TABLE orders (
  id             text PRIMARY KEY,                -- публичный номер заказа
  buyer_id       text NOT NULL REFERENCES users(id),
  shop_id        text NOT NULL REFERENCES shops(id),
  status         text NOT NULL DEFAULT 'created'
                 CHECK (status IN ('created','awaiting_payment','paid_escrow','processing','delivered',
                                   'completed','dispute_opened','in_arbitration','refunded','cancelled','expired')),
  subtotal_sol   numeric(24,9) NOT NULL DEFAULT 0,
  subtotal_stars bigint NOT NULL DEFAULT 0,
  fee_sol        numeric(24,9) NOT NULL DEFAULT 0,
  fee_stars      bigint NOT NULL DEFAULT 0,
  total_sol      numeric(24,9) NOT NULL DEFAULT 0,
  total_stars    bigint NOT NULL DEFAULT 0,
  pay_asset      text CHECK (pay_asset IN ('SOL','STARS','MIXED')),
  delivery_kind  text NOT NULL DEFAULT 'auto' CHECK (delivery_kind IN ('auto','manual','file')),
  escrow_account text,
  pay_deadline   timestamptz,
  delivery_deadline timestamptz,
  confirm_deadline timestamptz,
  extend_used    boolean NOT NULL DEFAULT false,
  paid_at        timestamptz,
  delivered_at   timestamptz,
  completed_at   timestamptz,
  cancelled_at   timestamptz,
  idempotency_key text UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_buyer ON orders(buyer_id, created_at DESC);
CREATE INDEX orders_shop  ON orders(shop_id, status, created_at DESC);
CREATE INDEX orders_deadlines ON orders(status, pay_deadline, delivery_deadline, confirm_deadline);

CREATE TABLE order_items (
  id          text PRIMARY KEY,
  order_id    text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  text NOT NULL REFERENCES products(id),
  title_snap  text NOT NULL,
  qty         int NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_sol numeric(24,9) NOT NULL DEFAULT 0,
  unit_price_stars bigint NOT NULL DEFAULT 0,
  stock_item_ids text[] NOT NULL DEFAULT '{}',
  delivered_payload_ct bytea,                    -- выданный контент (ciphertext)
  delivered_at timestamptz,
  download_count int NOT NULL DEFAULT 0
);

CREATE TABLE order_status_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status text, to_status text NOT NULL,
  actor_id   text, actor_kind text NOT NULL DEFAULT 'system'
             CHECK (actor_kind IN ('system','buyer','shop','arbiter','admin','timer')),
  reason     text,
  ts         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX osh_order ON order_status_history(order_id, ts);

CREATE TABLE payments (
  id          text PRIMARY KEY,
  order_id    text REFERENCES orders(id),
  user_id     text NOT NULL REFERENCES users(id),
  kind        text NOT NULL CHECK (kind IN ('order','rent','gift','exchange','deposit','withdraw','refund')),
  provider    text NOT NULL CHECK (provider IN ('internal_sol','internal_stars','telegram_stars','solana','exchange')),
  asset       text NOT NULL,
  amount      numeric(24,9) NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','processing','succeeded','failed','refunded','cancelled')),
  external_id text,                              -- telegram invoice id / solana signature
  tx_id       text,
  totp_ops_verified boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_user_ts ON payments(user_id, created_at DESC);
CREATE INDEX payments_order   ON payments(order_id);

-- ============ СПОРЫ ============
CREATE TABLE disputes (
  id            text PRIMARY KEY,
  order_id      text NOT NULL REFERENCES orders(id),
  opened_by     text NOT NULL REFERENCES users(id),
  reason_code   text NOT NULL CHECK (reason_code IN
                ('not_delivered','broken','not_as_described','fraud','sla_violation','other')),
  description   text NOT NULL,
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','awaiting_reply','in_arbitration','resolved','dismissed','appeal','closed')),
  buyer_alias   text NOT NULL,                   -- «Покупатель #K92» (маскировка)
  seller_alias  text NOT NULL,                   -- «Продавец #A17»
  arbiter_id    text REFERENCES users(id),
  assigned_at   timestamptz,
  reply_deadline timestamptz NOT NULL,
  resolve_deadline timestamptz,
  resolution    text CHECK (resolution IN ('complete','refund_full','refund_partial','replace','dismiss','escalate_senior','sanction')),
  resolution_amount numeric(24,9),
  resolution_reason text,
  resolved_at   timestamptz,
  appeal_of     text REFERENCES disputes(id),
  chat_id       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX disputes_status ON disputes(status, created_at);
CREATE INDEX disputes_arbiter ON disputes(arbiter_id, status);

CREATE TABLE dispute_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispute_id text NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  ts         timestamptz NOT NULL DEFAULT now(),
  kind       text NOT NULL,                      -- opened|reply|escalated|assigned|evidence|decision|executed|appeal
  actor_id   text, actor_visible_as text,        -- маскированная роль для лога
  payload    jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE dispute_evidence (
  id          text PRIMARY KEY,
  dispute_id  text NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  uploader_id text NOT NULL REFERENCES users(id),
  kind        text NOT NULL CHECK (kind IN ('image','video','file','text','order_meta')),
  s3_key      text,
  sha256      bytea NOT NULL,                    -- неизменяемость доказательства
  size        int NOT NULL,
  meta_stripped boolean NOT NULL DEFAULT true,   -- EXIF/метаданные удалены
  dek_id      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============ МЕССЕНДЖЕР ============
CREATE TABLE chats (
  id          text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('shop_support','order','dispute','group','channel','direct')),
  title       text,
  shop_id     text REFERENCES shops(id) ON DELETE CASCADE,
  order_id    text REFERENCES orders(id) ON DELETE CASCADE,
  dispute_id  text REFERENCES disputes(id) ON DELETE CASCADE,
  admin_user_id text,                            -- ★ админ, с которым открыт диалог
  e2ee        boolean NOT NULL DEFAULT false,
  dek_id      text,                              -- DEK домена msg (для server-encrypted)
  last_seq    bigint NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  is_muted    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);
CREATE INDEX chats_shop ON chats(shop_id, kind);
CREATE INDEX chats_order ON chats(order_id);
CREATE INDEX chats_dispute ON chats(dispute_id);

CREATE TABLE chat_members (
  chat_id    text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','operator','member','arbiter','subscriber')),
  visible_as text,                               -- маскированный псевдоним (для споров)
  joined_at  timestamptz NOT NULL DEFAULT now(),
  left_at    timestamptz,
  last_read_seq bigint NOT NULL DEFAULT 0,
  is_muted   boolean NOT NULL DEFAULT false,
  is_blocked boolean NOT NULL DEFAULT false,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX chat_members_user ON chat_members(user_id, last_read_seq);

CREATE TABLE messages (
  id            text PRIMARY KEY,
  chat_id       text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq           bigint NOT NULL,
  sender_id     text NOT NULL REFERENCES users(id),
  sender_key_id text,                            -- E2EE: identity/prekey, которым зашифровано
  type          text NOT NULL DEFAULT 'text'
                CHECK (type IN ('text','attachment','product_card','order_card','gift_card','system','reply')),
  body_ct       bytea NOT NULL,                  -- ★ AES-256-GCM ciphertext (всегда)
  body_size     int NOT NULL DEFAULT 0,
  aad           bytea,                           -- chat_id||seq||device_id
  attachment_meta_ct bytea,
  reply_to      text REFERENCES messages(id),
  client_msg_id text,
  edited_at     timestamptz,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_id, seq),
  UNIQUE (chat_id, client_msg_id, sender_id)     -- идемпотентность отправки
);
CREATE INDEX messages_chat_seq ON messages(chat_id, seq DESC);

CREATE TABLE e2ee_prekeys (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     text NOT NULL,
  identity_pub  bytea NOT NULL,                  -- X25519 pub
  identity_sig  bytea NOT NULL,                  -- Ed25519 подпись пакета
  signed_prekey_pub bytea NOT NULL,
  signed_prekey_sig bytea NOT NULL,
  signed_prekey_at  timestamptz NOT NULL DEFAULT now(),
  one_time_keys jsonb NOT NULL DEFAULT '[]',     -- [{id, pub}], израсходованные удаляются
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);

CREATE TABLE e2ee_sessions (
  id            text PRIMARY KEY,
  chat_id       text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  from_user     text NOT NULL, from_device text NOT NULL,
  to_user       text NOT NULL,   to_device   text NOT NULL,
  root_key_fingerprint bytea NOT NULL,          -- SHA-256(RK)[:8], не сам ключ
  safety_number text NOT NULL,                   -- для сверки в UI
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  UNIQUE (chat_id, from_user, from_device, to_user, to_device)
);

-- ============ ЗВЁЗДЫ, ПОДАРКИ ============
CREATE TABLE gifts (
  id           text PRIMARY KEY,
  sku          text NOT NULL UNIQUE,
  title_ru     text NOT NULL, title_en text,
  description  text,
  rarity       text NOT NULL DEFAULT 'common'
               CHECK (rarity IN ('common','rare','epic','legendary')),
  media_url    text, media_kind text CHECK (media_kind IN ('image','video','lottie','sticker')),
  price_stars  bigint NOT NULL DEFAULT 0,
  price_sol    numeric(24,9) NOT NULL DEFAULT 0,
  per_user_limit int,
  boosts_shop  boolean NOT NULL DEFAULT false,
  boost_value  numeric(6,3) NOT NULL DEFAULT 0,
  boost_days   int NOT NULL DEFAULT 7,
  collectible  boolean NOT NULL DEFAULT false,
  starts_at    timestamptz, ends_at timestamptz,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  sort         int NOT NULL DEFAULT 0,
  created_by   text NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gift_purchases (
  id           text PRIMARY KEY,
  gift_id      text NOT NULL REFERENCES gifts(id),
  buyer_id     text NOT NULL REFERENCES users(id),
  recipient_type text NOT NULL CHECK (recipient_type IN ('self','user','shop')),
  recipient_id text,
  asset        text NOT NULL CHECK (asset IN ('STARS','SOL')),
  amount       numeric(24,9) NOT NULL,
  message_ct   bytea,                            -- поздравление (ciphertext)
  payment_id   text REFERENCES payments(id),
  tx_id        text,
  status       text NOT NULL DEFAULT 'paid' CHECK (status IN ('pending','paid','refunded','revoked')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gift_purch_user ON gift_purchases(buyer_id, created_at DESC);
CREATE INDEX gift_purch_recipient ON gift_purchases(recipient_type, recipient_id);

-- ============ ОТЗЫВЫ ============
CREATE TABLE reviews (
  id           text PRIMARY KEY,
  order_id     text NOT NULL UNIQUE REFERENCES orders(id),   -- ★ 1 отзыв на заказ
  shop_id      text NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id   text REFERENCES products(id),
  author_id    text NOT NULL REFERENCES users(id),
  rating       smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  rating_delivery smallint CHECK (rating_delivery BETWEEN 1 AND 5),
  rating_description smallint CHECK (rating_description BETWEEN 1 AND 5),
  rating_support smallint CHECK (rating_support BETWEEN 1 AND 5),
  body         text,
  media_urls   text[] NOT NULL DEFAULT '{}',
  is_verified_purchase boolean NOT NULL DEFAULT true,
  shop_reply   text, shop_reply_at timestamptz,
  status       text NOT NULL DEFAULT 'published'
               CHECK (status IN ('published','hidden','removed','pending_moderation')),
  helpful_count int NOT NULL DEFAULT 0,
  edited_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_shop ON reviews(shop_id, status, created_at DESC);
CREATE INDEX reviews_product ON reviews(product_id, status);

CREATE TABLE review_reports (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  review_id   text NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  reporter_id text NOT NULL REFERENCES users(id),
  reason      text NOT NULL CHECK (reason IN ('spam','abuse','pii','fake','other')),
  comment     text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  moderator_id text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (review_id, reporter_id)
);

-- ============ АДМИНКА, СОБЫТИЯ, АУДИТ ============
CREATE TABLE events (                                   -- outbox
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id    text NOT NULL UNIQUE,
  type        text NOT NULL,
  aggregate   text NOT NULL, aggregate_id text NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts    smallint NOT NULL DEFAULT 0
);
CREATE INDEX events_unpublished ON events(published_at) WHERE published_at IS NULL;

CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  actor_id     text, actor_role text,
  action       text NOT NULL,
  object_type  text, object_id text,
  before_json  jsonb, after_json jsonb,
  reason       text,
  ip           inet, ip_geo text, user_agent text,
  totp_factor  text,
  prev_hash    bytea NOT NULL,
  record_hash  bytea NOT NULL
);
CREATE INDEX audit_object ON audit_log(object_type, object_id, ts DESC);
CREATE INDEX audit_actor  ON audit_log(actor_id, ts DESC);
-- INSERT-only: роль приложения не имеет UPDATE/DELETE на audit_log (REVOKE), плюс триггер-защита

CREATE TABLE notifications (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('inapp','tg_bot','email','push')),
  kind        text NOT NULL,
  title       text NOT NULL, body text,
  dedup_key   text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  read_at     timestamptz,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedup_key)
);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_limit_state (                          -- горячее — в Redis, здесь только аудит
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts         timestamptz NOT NULL DEFAULT now(),
  bucket     text NOT NULL,
  subject    text NOT NULL,                              -- ip|user|device
  action     text NOT NULL,                              -- allow|throttle|block
  detail     jsonb
);
```

---

## 3. Индексы и производительность

* Лента: частичный индекс `shops(status='active')` + `rating_bayes DESC`, материализованное
  представление `mv_feed_score` (обновление раз в 5 мин или по событию) с готовым `score`
  из FR-FEED-05 — чтение ленты не считает скоринг на лету.
* Поиск: `pg_trgm` по названию + FTS по описанию/товарам; для прода — Meilisearch с индексацией
  из outbox-событий.
* Сообщения: `UNIQUE (chat_id, seq)` + индекс `(chat_id, seq DESC)` — пагинация «вверх».
* Ledger: партиционирование `ledger_entries` по месяцам (декларативное) при > 50 млн строк.
* Пул соединений: PgBouncer (transaction mode), `max_connections` app ≤ 200.

---

## 4. Что НЕ хранится в БД

* Приватные ключи Solana (только wrapped в crypto-core/HSM);
* TOTP-секреты в открытом виде;
* E2EE-ключи пользователей (только публичные части);
* Plaintext сообщений приватных чатов;
* Пароли (только Argon2id-хэш);
* Полные адреса/PII без необходимости (blind index + ciphertext).
