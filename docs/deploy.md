# Приложение H. Развёртывание и эксплуатация

Ссылки: `TZ.md` FR-DEP-01…09, NFR-03, NFR-08, NFR-10.

---

## 1. Топология окружений

| Окружение | Назначение | Состав | Домен |
|---|---|---|---|
| `dev` | локальная разработка | docker-compose: siteed, crypto-core, postgres, redis, minio, nginx | `localhost:8080` |
| `stage` | предпрод, e2e и нагрузочные | K8s (1 нода) или 2 VPS, копия топологии prod | `stage.sitee.example` |
| `prod` | бой | 2× app, PG primary+replica, Redis, S3/MinIO, Vault, nginx×2 + Cloudflare | `sitee.example`, `admin.sitee.example`, `api.sitee.example` |

---

## 2. Контейнеры

### 2.1 Go-бэкенд (`deploy/Dockerfile.backend`)
```dockerfile
FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY backend/go.mod ./
# внешних зависимостей нет: только stdlib
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/siteed ./cmd/siteed

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/siteed /siteed
COPY frontend/ /app/frontend/
EXPOSE 8080
USER 65534:65534
ENTRYPOINT ["/siteed"]
```

### 2.2 Rust crypto-core (`deploy/Dockerfile.crypto-core`)
```dockerfile
FROM rust:1.78-bookworm AS build
WORKDIR /src
COPY crypto-core/ ./
RUN cargo build --release --offline || cargo build --release
RUN strip target/release/crypto-core

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /src/target/release/crypto-core /crypto-core
EXPOSE 8091
USER 65534:65534
ENTRYPOINT ["/crypto-core", "--listen", "0.0.0.0:8091"]
```

### 2.3 Принципы образов
multi-stage, статическая линковка, `nonroot`, никаких shell в рантайме, подпись `cosign sign`,
SBOM (`syft` → CycloneDX) как артефакт релиза, тег = git SHA + semver.

---

## 3. docker-compose (dev/stage)

`deploy/docker-compose.yml` поднимает: `postgres:16-alpine`, `redis:7-alpine`, `minio`,
`crypto-core` (Rust), `siteed` (Go), `worker`, `sol-scanner`, `nginx`. Профили:
`COMPOSE_PROFILES=dev|stage`. Секреты — из `.env` (в gitignore) или Vault-агента.

Переменные окружения siteed:

| Переменная | Пример | Назначение |
|---|---|---|
| `SITEED_ADDR` | `0.0.0.0:8080` | адрес HTTP/WS |
| `SITEED_ENV` | `dev\|stage\|prod` | окружение |
| `SITEED_DSN` | `postgres://…` | БД (пусто → memory-store для MVP) |
| `CRYPTO_CORE_URL` | `http://crypto-core:8091` | Rust-ядро (пусто → Go-fallback) |
| `CRYPTO_CORE_TOKEN` | `…` | service-token |
| `KEK_STORE_PATH` / `VAULT_ADDR` | `/run/secrets/kek` | хранилище KEK (dev/prod) |
| `REDIS_ADDR` | `redis:6379` | кэш, rate-limit, pub/sub |
| `JWT_PRIVATE_KEY` / `JWT_KID` | secret | подпись access-токенов (Ed25519) |
| `TG_BOT_TOKEN` | secret | Telegram Bot/Stars |
| `SOLANA_RPC_URLS` | `https://…,https://…` | список RPC |
| `SOL_HOT_WALLET_ID` | `wlt_hot` | hot-кошелёк |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_KEYS` | … | медиа |
| `LIMITS_*`, `THRESHOLDS_*` | … | лимиты и пороги (§8 economy.md) |
| `FEATURE_FLAGS` | `stars=on,e2ee=on,exchange=on` | флаги |

---

## 4. nginx / edge

`deploy/nginx/sitee.conf`:
* TLS 1.3 (1.2 с ECDHE), HSTS 1 год + preload, OCSP stapling, session tickets off;
* `limit_req_zone $binary_remote_addr zone=api:20m rate=60r/m;` + отдельные зоны `auth` (10r/m),
  `admin`, `ws`;
* `limit_conn perip 20;`, `client_max_body_size 8m;`, таймауты 10 s;
* проксирование WS: `Upgrade`/`Connection`, `proxy_read_timeout 75s` (heartbeat 25 s),
  `proxy_buffering off`;
* статика фронта — `root /app/frontend` + `add_header Cache-Control "public, max-age=300"` и
  `immutable` для версионированных ассетов;
* geo-блок и deny для honeypot-путей (`/wp-login.php`, `/admin.php`, `/.env`);
* заголовки безопасности (§9 security.md);
* upstream с health-check (`max_fails=3 fail_timeout=10s`).

Cloudflare (перед nginx): WAF managed rules + custom (rate-limit по `login`, `2fa`, `withdraw`),
Bot Fight Mode, TLS 1.3 only, Always-Use-HTTPS, кэш статики, Under Attack Mode по кнопке.

---

## 5. База данных и миграции

* PostgreSQL 16: `shared_buffers 25 %`, `work_mem 16 MB`, `max_wal_size 4 GB`,
  `wal_level=replica`, `synchronous_commit=on` для ledger-таблиц;
* PgBouncer (transaction pooling), отдельные пулы для API и worker'ов;
* роли: `siteed_app` (CRUD, без DDL и без UPDATE/DELETE на `audit_log`), `siteed_migrator` (DDL),
  `siteed_readonly` (отчёты);
* расширения: `pg_trgm`, `pgcrypto`, `btree_gin`;
* миграции: `goose`/`atlas`, файлы `db/migrations/NNNN_*.sql`, только expand→migrate→contract
  в prod, прогон в CI на копии дампа, автоматический бэкап перед применением;
* PITR: непрерывный WAL в S3 (WAL-G), полный бэкап раз в сутки, retention 7/30 дней.

---

## 6. Секреты и KMS

* dev: `KEK_STORE_PATH` (файл 0400, владелец — пользователь сервиса) + `.env` (gitignore);
* prod: Vault (Transit для KEK, KV для секретов) или cloud KMS/HSM; доступ приложения —
  через AppRole/K8s-auth с короткоживущими токенами;
* ротация: KEK 90 дней, секреты 90 дней, JWT-ключи 180 дней (двойной `kid` для плавности),
  мастер-ключ Solana 180 дней;
* 4-глаза: любые операции с `wallet`-доменом и `admin/finance` требуют второго админа;
* запрет секретов в логах, в git (gitleaks в CI + pre-commit), в клиентском бандле.

---

## 7. CI/CD (GitHub Actions)

```
push/PR → lint (golangci-lint, clippy -- -D warnings, eslint) 
        → unit + integration (go test -race, cargo test, vitest)
        → SAST (semgrep), секреты (gitleaks), уязвимости (govulncheck, cargo-audit, npm audit)
        → контракт OpenAPI (breaking-change gate)
        → build images (multi-arch) → cosign sign + SBOM
        → deploy stage (auto) → e2e Playwright + k6 smoke
        → deploy prod (manual approval) → canary 10 % → 100 %
        → post-deploy checks (health, метрики 15 мин) → auto-rollback при регрессии
```
Ветки: `main` (защита: 2 ревью, зелёный CI), релизные теги `v*`, hotfix — из `main`.

---

## 8. Наблюдаемость и алерты

**Метрики** (Prometheus, RED+USE): список в `docs/architecture.md` §9 + бизнес-метрики
(GMV, комиссии, активные аренды, споры, конверсия).

**Алерты:**
| Алерт | Условие | Приоритет | Действие |
|---|---|---|---|
| Высокая доля 5xx | > 1 % за 5 мин | P1 | дежурный, откат последнего деплоя |
| Латентность | P95 > 1 с за 10 мин | P2 | профилирование, масштабирование |
| WS-разрывы | > 20 % за 5 мин | P2 | проверка нод/edge |
| Рассинхрон ledger | инвариант нарушен | **P1** | остановка выводов, разбор |
| Solana scanner lag | > 60 слотов | P2 | смена RPC |
| crypto-core down | fallback > 60 с | P2 | перезапуск, проверка mTLS |
| Аномалия auth | 401/429 всплеск ×5 | P2 | challenge-режим, geo-блок |
| Диск | > 80 % | P2 | очистка/расширение |
| Сертификаты | < 14 дней | P3 | перевыпуск |
| Очередь worker | > 10 000 задач | P2 | масштабирование |

**Логи**: JSON → Loki/ClickHouse, retention 30 дней (горячие) / 1 год (холодные), аудит-лог —
5 лет WORM. **Трейсинг**: OpenTelemetry → Tempo/Jaeger. **Ошибки клиента**: Sentry (DSN в TMA).

---

## 9. Бэкапы и восстановление

| Объект | Частота | Хранение | RPO | RTO |
|---|---|---|---|---|
| PostgreSQL | full 1×/сутки + WAL непрерывно | S3 (другой регион), шифрование `backup`-ключом | 5 мин | 30 мин |
| S3/MinIO | версионирование + cross-region replication | — | 0 | 15 мин |
| KEK/Vault | Raft-снапшот 1×/сутки + оффлайн-копия | сейф/HSM | 24 ч | 2 ч (ceremony) |
| Конфиги/IaC | git | — | 0 | 10 мин |

Учения по восстановлению — ежеквартально, с отчётом и замером фактического RTO.

---

## 10. Ресурсы и стоимость (MVP, ~1 000 DAU)

| Компонент | Спека | Шт | $/мес |
|---|---|---|---|
| App-нода (siteed + worker + scanner) | 4 vCPU / 8 GB / 80 GB NVMe | 2 | 80 |
| PostgreSQL (primary + replica) | 4 vCPU / 16 GB / 200 GB | 1+1 | 70 |
| Redis | 2 vCPU / 4 GB | 1 | 15 |
| S3/MinIO (медиа) | 200 GB + трафик | — | 15 |
| Cloudflare Pro + WAF | — | 1 | 25 |
| Мониторинг (Grafana Cloud / self-host) | — | — | 20 |
| Vault/KMS (self-host) | 1 vCPU / 2 GB | 1 | 10 |
| **Итого** | | | **≈ $235/мес** (NFR-14 ≤ $250) |

---

## 11. Чек-лист запуска (Go-Live)

1. ☐ Все MUST-требования `TZ.md` закрыты и покрыты тестами (`docs/acceptance.md`);
2. ☐ Внешний пентест: 0 Critical/High, Medium — с планом устранения;
3. ☐ Нагрузочное: 500 RPS API + 10 000 WS, P95 ≤ 400 мс, ошибок < 0.1 %;
4. ☐ DDoS-учение: L7 10 000 RPS «мусора» без деградации авторизованных;
5. ☐ Сверка ledger 7 суток без расхождений; сверка Solana — 0 diff;
6. ☐ Бэкап-учение: восстановление stage из прод-бэкапа, RTO ≤ 30 мин;
7. ☐ Runbook'и отработаны (DDoS, утечка KEK, рассинхрон, падение RPC, компрометация админа);
8. ☐ Мониторинг и алерты проверены учебными инцидентами;
9. ☐ Юридический контур: правила сервиса, политика, оферта, гео-блокировки категорий, 18+;
10. ☐ Поддержка: каналы, SLA, шаблоны ответов, очередь спорных заявок, арбитражный пул ≥ 3;
11. ☐ Документация админа и продавца (гайды), обучающее видео;
12. ☐ Soft-launch: закрытая группа 50–100 пользователей, лимиты снижены, ежедневный отчёт.

---

## 12. Runbook: быстрые команды

```bash
# старт dev-стенда
cd deploy && docker compose --profile dev up -d --build

# здоровье
curl -fsS localhost:8080/healthz && curl -fsS localhost:8091/healthz

# прогон миграций
docker compose exec siteed /siteed migrate up

# сверка ledger
curl -sH "Authorization: Bearer $ADMIN_TOKEN" localhost:8080/api/v1/admin/finance/reconciliation

# аварийная остановка выводов
curl -sX POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"key":"withdraw_enabled","value":false,"reason":"P1 reconcile diff"}' \
  localhost:8080/api/v1/admin/settings/withdraw_enabled

# включение challenge-режима (DDoS)
curl -sX POST -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"mode":"under_attack"}' \
  localhost:8080/api/v1/admin/security/ddos-mode
```
