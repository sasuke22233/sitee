# deploy — артефакты развёртывания SITEE

Подробности — в [`docs/deploy.md`](../docs/deploy.md). Здесь только то, что
полезно запустить руками.

## Состав

| Файл | Назначение |
|---|---|
| `Dockerfile.backend` | Go-бэкенд: multi-stage, distroless nonroot, stdlib-only |
| `Dockerfile.crypto-core` | Rust-ядро: `cargo build --release --offline`, distroless nonroot |
| `docker-compose.yml` | dev/stage: postgres 16, redis 7, minio, crypto-core, siteed, worker, sol-scanner, nginx |
| `nginx/sitee.conf` | TLS 1.3, HSTS, зоны `limit_req`, WS-апгрейд, honeypot-пути |
| `nginx/snippets/proxy.conf` | общие proxy-заголовки |
| `.env.example` | переменные окружения (копировать в `deploy/.env`, в git не попадает) |

## Быстрый старт (dev)

```bash
cp .env.example .env          # затем отредактировать
# devnet-ключ и KEK: python3 -c "import secrets;print(secrets.token_hex(32))"
docker compose --env-file .env --profile dev up -d --build
curl -s http://127.0.0.1:8080/healthz
curl -s http://127.0.0.1:8080/api/v1/public/config | head
```

`SITEED_DSN` пустой → siteed работает на memory-store (ровно как прототип в
`tools/preview`), иначе поднимается PostgreSQL.

## Прототип без Docker

В песочнице без Go/Rust тулчейнов прототип запускается Node-зеркалом:

```bash
cd ../tools/preview && npm start     # http://127.0.0.1:8080
```

## Продакшен

Всё, что касается stage/prod (K8s/Vault/cosign/PITR/алерты), описано в
`docs/deploy.md` §1, §5–§9. Здесь нет продовых секретов и kube-манифестов:
образы собираются из этих Dockerfile'ов и публикуются с подписью `cosign`.
