#!/usr/bin/env node
// SITEE preview-сервер: HTTP API + WebSocket (WSS) + статика Telegram Mini App.
// Зеркалит поведение Go-бэкенда (backend/) на Node без внешних зависимостей,
// чтобы интерфейс можно было посмотреть вживую без компилятора Go.
//
// Запуск:  npm start            (или: node server.mjs)
// Адрес:   0.0.0.0:8080         (SITEED_ADDR)
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDb, demoCredentials } from './data.mjs';
import { Hub, attach, CLOSE } from './ws.mjs';
import * as L from './lib.mjs';
import * as C from './crypto.mjs';
import { runTimers, addMessage, broadcastMessage, isMember } from './domain.mjs';
import { authRoutes } from './routes-auth.mjs';
import { catalogRoutes } from './routes-catalog.mjs';
import { orderRoutes } from './routes-orders.mjs';
import { messengerRoutes } from './routes-messenger.mjs';
import { economyRoutes } from './routes-economy.mjs';
import { disputeRoutes } from './routes-disputes.mjs';
import { adminRoutes } from './routes-admin.mjs';
import * as persist from './persist.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0-preview';
const FRONTEND_DIR = process.env.SITEED_FRONTEND_DIR
  ? path.resolve(process.env.SITEED_FRONTEND_DIR)
  : path.resolve(HERE, '../../frontend');

// ---------------------------------------------------------------------------
// Контекст приложения
// ---------------------------------------------------------------------------
const db = createDb();
db.securityEvents = [];
db.ipBans = new Map();
db.invoices = new Map();

const hub = new Hub();
const stats = { requests: 0, errors: 0, wsConnections: 0, wsMessages: 0, startedAt: Date.now() };

const ctx = {
  db,
  hub,
  version: VERSION,
  guards: new Map(),
  stats,
  securityEvent(kind, data = {}, score = 0) {
    db.securityEvents.push({ ts: new Date().toISOString(), kind, score, ...data });
    if (db.securityEvents.length > 5000) db.securityEvents.splice(0, db.securityEvents.length - 5000);
  },
};

const restored = persist.load(ctx);

// ---------------------------------------------------------------------------
// Маршрутизатор
// ---------------------------------------------------------------------------
const routes = [
  ...authRoutes(ctx),
  ...catalogRoutes(ctx),
  ...orderRoutes(ctx),
  ...messengerRoutes(ctx),
  ...economyRoutes(ctx),
  ...disputeRoutes(ctx),
  ...adminRoutes(ctx),
].map(([method, pattern, handler, opts = {}]) => ({
  method,
  segments: pattern.split('/').filter(Boolean),
  handler,
  rate: opts.rate ?? 'public',
  pattern,
}));

function match(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== parts.length) continue;
    const params = {};
    let hit = true;
    for (let i = 0; i < parts.length; i += 1) {
      const seg = route.segments[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return { route, params };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Статика (Telegram Mini App)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Сжатие и ETag: на медленном канале это решает — JS/CSS жмутся в ~4 раза,
// а ETag даёт 304 вместо повторной загрузки неизменившихся файлов.
// ---------------------------------------------------------------------------
const TEXTUAL = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map']);

function negotiateEncoding(req) {
  const accept = String(req.headers['accept-encoding'] ?? '');
  if (accept.includes('gzip')) return 'gzip';
  if (accept.includes('deflate')) return 'deflate';
  return null;
}

function compress(body, encoding) {
  if (!encoding || body.length < 1024) return { body, headers: {} };
  const packed = encoding === 'gzip' ? zlib.gzipSync(body) : zlib.deflateSync(body);
  // Сжимаем только если реально стало меньше.
  if (packed.length >= body.length) return { body, headers: {} };
  return { body: packed, headers: { 'Content-Encoding': encoding, Vary: 'Accept-Encoding' } };
}

function etag(body) {
  // crc32 быстрее sha1 и достаточно для проверки свежести статики.
  let crc = ~0;
  for (let i = 0; i < body.length; i += 1) {
    crc ^= body[i];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return `W/"${body.length.toString(16)}-${((~crc) >>> 0).toString(36)}"`;
}

function sendJson(req, res, status, payload, extraHeaders = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const { body, headers } = compress(Buffer.from(text), negotiateEncoding(req));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...headers,
    ...extraHeaders,
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let file = path.resolve(FRONTEND_DIR, rel);
  if (!file.startsWith(FRONTEND_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA: пути без расширения отдаём как index.html
    file = path.join(FRONTEND_DIR, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('frontend не найден: соберите каталог frontend/ (SITEED_FRONTEND_DIR)');
      return;
    }
  }
  const ext = path.extname(file).toLowerCase();
  const raw = fs.readFileSync(file);
  const tag = etag(raw);
  // ETag + 304: браузер не качает файл заново, если он не менялся.
  if (req.headers['if-none-match'] === tag) {
    res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }
  const { body, headers: compressed } = compress(raw, TEXTUAL.has(ext) ? negotiateEncoding(req) : null);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': body.length,
    ETag: tag,
    // no-cache + ETag = «проверяй свежесть, но используй кэш при совпадении».
    'Cache-Control': ['.html', '.js', '.mjs', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=300',
    // TMA открывается внутри webview Telegram — фреймы разрешаем.
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://telegram.org; connect-src 'self' ws: wss: https://telegram.org; frame-ancestors *",
    ...compressed,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------------------------------------------------------------------------
// HTTP-сервер
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const requestId = C.newId('req');
  stats.requests += 1;
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const ip = L.clientIp(req);

  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-TOTP-Code');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  // Блокировка IP из админ-панели (FR-ABF-*).
  const ban = db.ipBans?.get(ip);
  if (ban && new Date(ban.until) > new Date()) {
    sendJson(req, res, 403, { error: { code: 'IP_BANNED', message: `IP заблокирован до ${ban.until}`, status: 403, request_id: requestId } });
    return;
  }

  try {
    if (pathname === '/healthz') {
      sendJson(req, res, 200, { status: 'ok', version: VERSION, uptime_s: Math.round((Date.now() - stats.startedAt) / 1000) });
      return;
    }
    if (pathname === '/readyz') {
      L.send(res, 200, {
        status: 'ready', store: 'in-memory', users: db.users.size, shops: db.shops.size,
        orders: db.orders.size, ws_connections: hub.count(), snapshot: restored ? restored.file : null,
      });
      return;
    }
    if (pathname === '/metrics') {
      const lines = [
        '# TYPE sitee_http_requests_total counter',
        `sitee_http_requests_total ${stats.requests}`,
        '# TYPE sitee_http_errors_total counter',
        `sitee_http_errors_total ${stats.errors}`,
        '# TYPE sitee_ws_connections gauge',
        `sitee_ws_connections ${hub.count()}`,
        '# TYPE sitee_ws_messages_total counter',
        `sitee_ws_messages_total ${stats.wsMessages}`,
        '# TYPE sitee_uptime_seconds gauge',
        `sitee_uptime_seconds ${Math.round((Date.now() - stats.startedAt) / 1000)}`,
        '# TYPE sitee_ledger_entries gauge',
        `sitee_ledger_entries ${db.ledger.entries.length}`,
        '# TYPE sitee_audit_records gauge',
        `sitee_audit_records ${db.audit.length}`,
      ];
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }).end(`${lines.join('\n')}\n`);
      return;
    }

    const found = match(req.method, pathname);
    if (!found) {
      if ((req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api/') && pathname !== '/ws') {
        serveStatic(req, res, pathname);
        return;
      }
      sendJson(req, res, 404, { error: { code: 'NOT_FOUND', message: 'маршрут не найден', status: 404, request_id: requestId } });
      return;
    }

    // Rate limit по профилю маршрута.
    const limit = L.allow(`rl:${found.route.rate}:${ip}`, found.route.rate);
    if (!limit.allowed) {
      stats.errors += 1;
      ctx.securityEvent('rate_limit', { ip, path: pathname, profile: found.route.rate }, 200);
      res.setHeader('Retry-After', String(limit.retryAfter));
      L.send(res, limit.blocked ? 423 : 429, {
        error: {
          code: limit.blocked ? 'BLOCKED' : 'RATE_LIMITED',
          message: limit.blocked ? 'слишком много запросов, доступ временно заблокирован' : 'слишком много запросов, повторите позже',
          status: limit.blocked ? 423 : 429, request_id: requestId, retry_after: limit.retryAfter,
        },
      });
      return;
    }
    res.setHeader('X-RateLimit-Limit', String(limit.limit));
    res.setHeader('X-RateLimit-Remaining', String(limit.remaining));

    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await L.readBody(req) : {};
    const auth = L.authenticate(ctx, req);
    const result = found.route.handler({ ctx, req, params: found.params, query: Object.fromEntries(url.searchParams), body, auth, ip });
    const status = result?.status ?? 200;
    const payload = result?.body ?? { status: 'ok' };
    sendJson(req, res, status, payload);
  } catch (err) {
    stats.errors += 1;
    if (err instanceof L.ApiError && err.status >= 400 && err.status < 500) {
      ctx.securityEvent('api_error', { ip, path: pathname, code: err.code }, err.status === 429 ? 300 : 50);
    }
    L.fail(res, err, requestId);
  }
});

// ---------------------------------------------------------------------------
// WebSocket: WSS-мост (docs/api.md §12)
// ---------------------------------------------------------------------------
attach(server, hub, {
  maxPerIp: 5,
  onConnection(conn, url) {
    stats.wsConnections += 1;
    const tokenFromQuery = url.searchParams.get('token') ?? '';
    let authenticated = false;
    let user = null;

    const fakeReq = (token) => ({
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'sitee-preview-ws' },
      socket: { remoteAddress: conn.remoteIp },
      url: '/ws',
    });

    const tryAuth = (token) => {
      if (!token) return false;
      const auth = L.authenticate(ctx, fakeReq(token));
      if (!auth) return false;
      const perUser = [...hub.peers.values()].reduce((acc, set) => acc + (set.has(conn) ? 0 : 0), 0);
      void perUser;
      user = auth.user;
      conn.userId = user.id;
      hub.register(user.id, conn);
      authenticated = true;
      const unread = L.userDto(ctx, user).unread?.chats ?? 0;
      conn.send({
        v: 1, t: 'hello', ts: Date.now(),
        d: {
          user_id: user.id, nickname: user.nickname, role: user.role,
          server_time: new Date().toISOString(), ping_interval_s: 25,
          chats_unread: unread, session_id: auth.session.id,
          e2ee: 'сервер хранит только шифртекст; ключи — на устройстве',
        },
      });
      return true;
    };

    if (tokenFromQuery) tryAuth(tokenFromQuery);

    const authTimer = setTimeout(() => {
      if (!authenticated) conn.close(CLOSE.UNAUTHORIZED, 'auth window expired');
    }, 10_000);

    conn.onMessage = (raw) => {
      stats.wsMessages += 1;
      if (raw.length > 65536) {
        conn.send({ v: 1, t: 'error', ts: Date.now(), d: { code: 'FRAME_TOO_LARGE', message: 'кадр больше 64 КБ' } });
        return;
      }
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        conn.send({ v: 1, t: 'error', ts: Date.now(), d: { code: 'BAD_JSON', message: 'ожидается JSON-кадр' } });
        return;
      }
      const type = String(frame.t ?? '');
      const data = frame.d ?? {};

      if (type === 'auth') {
        if (tryAuth(String(data.token ?? ''))) {
          clearTimeout(authTimer);
        } else {
          conn.send({ v: 1, t: 'error', ts: Date.now(), d: { code: 'UNAUTHENTICATED', message: 'токен недействителен' } });
          conn.close(CLOSE.UNAUTHORIZED, 'bad token');
        }
        return;
      }
      if (!authenticated) {
        conn.send({ v: 1, t: 'error', ts: Date.now(), d: { code: 'UNAUTHENTICATED', message: 'сначала отправьте кадр auth' } });
        conn.close(CLOSE.UNAUTHORIZED, 'not authenticated');
        return;
      }
      const limit = L.allow(`rl:wsmsg:${user.id}`, 'wsmsg');
      if (!limit.allowed) {
        conn.send({ v: 1, t: 'error', ts: Date.now(), d: { code: 'RATE_LIMITED', message: 'слишком много кадров', retry_after: limit.retryAfter } });
        return;
      }

      switch (type) {
        case 'ping':
          conn.send({ v: 1, t: 'pong', ts: Date.now(), d: { client_ts: data.ts ?? null } });
          break;
        case 'presence':
          hub.sendMany([...ctx.db.users.keys()].filter((id) => id !== user.id), {
            v: 1, t: 'presence', ts: Date.now(), d: { user_id: user.id, online: data.status !== 'away' },
          });
          conn.send({ v: 1, t: 'ack', ts: Date.now(), d: { t: 'presence' } });
          break;
        case 'typing': {
          const chat = ctx.db.chats.get(String(data.chat_id ?? ''));
          if (!chat || !isMember(ctx, chat.id, user.id)) break;
          hub.sendMany(chatPeers(ctx, chat.id, user.id), {
            v: 1, t: 'typing', ts: Date.now(), d: { chat_id: chat.id, user_id: user.id, typing: data.typing !== false },
          });
          break;
        }
        case 'msg.read': {
          const chat = ctx.db.chats.get(String(data.chat_id ?? ''));
          if (!chat) break;
          const mine = (ctx.db.members.get(chat.id) ?? []).find((m) => m.user_id === user.id);
          if (!mine) break;
          const seq = Math.min(chat.last_seq ?? 0, Number(data.seq ?? chat.last_seq ?? 0));
          mine.last_read_seq = Math.max(mine.last_read_seq ?? 0, seq);
          hub.sendMany(chatPeers(ctx, chat.id, user.id), {
            v: 1, t: 'chat.read', ts: Date.now(), d: { chat_id: chat.id, user_id: user.id, seq: mine.last_read_seq },
          });
          conn.send({ v: 1, t: 'ack', ts: Date.now(), d: { t: 'msg.read', chat_id: chat.id, seq: mine.last_read_seq } });
          break;
        }
        case 'msg.backfill': {
          const chat = ctx.db.chats.get(String(data.chat_id ?? ''));
          if (!chat) break;
          if (!isMember(ctx, chat.id, user.id) && !['arbiter', 'moderator', 'superadmin'].includes(user.role)) break;
          const limitRows = Math.min(100, Math.max(1, Number(data.limit ?? 30)));
          const beforeSeq = Number(data.before_seq ?? 0);
          let messages = ctx.db.messages.get(chat.id) ?? [];
          if (beforeSeq > 0) messages = messages.filter((m) => m.seq < beforeSeq);
          conn.send({
            v: 1, t: 'msg.backfill', ts: Date.now(),
            d: {
              chat_id: chat.id,
              items: messages.slice(-limitRows).reverse().map((m) => {
                const dto = {
                  id: m.id, seq: m.seq, type: m.type, sender_visible_as: m.sender_visible_as,
                  sender_id: m.sender_id, created_at: m.created_at, e2ee: !!m.e2ee,
                };
                if (m.e2ee) dto.body_ct = m.body_ct;
                else dto.body = C.tryDecrypt(C.DOMAINS.message, m.id, m.body_ct) ?? '';
                if (m.system) dto.system = m.system;
                return dto;
              }),
              has_more: beforeSeq > 0 && messages.length > limitRows,
            },
          });
          break;
        }
        case 'msg.send': {
          const chat = ctx.db.chats.get(String(data.chat_id ?? ''));
          if (!chat) {
            conn.send({ v: 1, t: 'error', ts: Date.now(), d: { code: 'NOT_FOUND', message: 'чат не найден' } });
            break;
          }
          if (!isMember(ctx, chat.id, user.id)) {
            conn.send({ v: 1, t: 'error', ts: Date.now(), d: { code: 'FORBIDDEN', message: 'вы не участник чата' } });
            break;
          }
          if (chat.closed_at) {
            conn.send({ v: 1, t: 'error', ts: Date.now(), d: { code: 'CHAT_CLOSED', message: 'чат закрыт' } });
            break;
          }
          const mine = (ctx.db.members.get(chat.id) ?? []).find((m) => m.user_id === user.id);
          if (mine?.blocked) {
            conn.send({ v: 1, t: 'error', ts: Date.now(), d: { code: 'BLOCKED', message: 'участник заблокирован в этом чате' } });
            break;
          }
          if (mine?.muted) {
            conn.send({ v: 1, t: 'error', ts: Date.now(), d: { code: 'MUTED', message: 'отправка ограничена модератором' } });
            break;
          }
          // FR-MSG-10: троттлинг отправки по WS — те же лимиты, что и в REST.
          const rl = L.allow(`chatmsg:${chat.id}:${user.id}`, 'chat-msg');
          if (!rl.allowed) {
            conn.send({ v: 1, t: 'error', ts: Date.now(), d: {
              code: 'RATE_LIMITED',
              message: rl.blocked
                ? `отправка ограничена на ${rl.retryAfter} с: слишком много сообщений`
                : `слишком много сообщений, повторите через ${rl.retryAfter} с`,
              retry_after: rl.retryAfter,
            } });
            break;
          }
          const e2ee = !!data.e2ee || !!chat.e2ee;
          let msg;
          if (e2ee) {
            const bodyCt = String(data.body_ct ?? '');
            if (!bodyCt) {
              conn.send({ v: 1, t: 'error', ts: Date.now(), d: { code: 'VALIDATION', message: 'для E2EE передайте body_ct' } });
              break;
            }
            msg = addMessage(ctx, chat, user, '', { e2ee: true, bodyCt, clientMsgId: String(data.client_msg_id ?? ''), visibleAs: mine?.visible_as ?? '' });
          } else {
            const body = String(data.body ?? '');
            if (!body.trim() || body.length > 4000) {
              conn.send({ v: 1, t: 'error', ts: Date.now(), d: { code: 'VALIDATION', message: 'пустое или слишком длинное сообщение' } });
              break;
            }
            msg = addMessage(ctx, chat, user, body, { clientMsgId: String(data.client_msg_id ?? ''), visibleAs: mine?.visible_as ?? '' });
          }
          broadcastMessage(ctx, chat, msg, user);
          conn.send({
            v: 1, t: 'msg.sent', ts: Date.now(),
            d: {
              id: msg.id, chat_id: chat.id, seq: msg.seq, client_msg_id: msg.client_msg_id || undefined,
              created_at: msg.created_at, e2ee: msg.e2ee, status: 'sent',
            },
          });
          break;
        }
        case 'subscribe':
        case 'unsubscribe':
          conn.send({ v: 1, t: 'ack', ts: Date.now(), d: { t: type, topics: data.topics ?? [] } });
          break;
        default:
          conn.send({ v: 1, t: 'error', ts: Date.now(), d: { code: 'UNKNOWN_FRAME', message: `неизвестный тип кадра: ${type}` } });
      }
    };
  },
});

function chatPeers(chatId, excludeUserId) {
  return (ctx.db.members.get(chatId) ?? [])
    .filter((m) => m.user_id !== excludeUserId && !m.left_at)
    .map((m) => m.user_id);
}

// ---------------------------------------------------------------------------
// Фоновые таймеры (эквивалент backend/internal/api/jobs.go)
// ---------------------------------------------------------------------------
setInterval(() => {
  try {
    runTimers(ctx);
  } catch (err) {
    console.error('[preview] timers:', err.message);
  }
}, 15_000).unref();

if (process.env.SITEED_SNAPSHOT !== '0') {
  setInterval(() => {
    try {
      persist.save(ctx);
    } catch (err) {
      console.warn('[preview] снапшот не сохранён:', err.message);
    }
  }, 60_000).unref();
}

// ---------------------------------------------------------------------------
// Старт
// ---------------------------------------------------------------------------
const [host, portRaw] = String(L.CONFIG.addr).split(':');
const port = Number(portRaw || 8080);
server.listen(port, host || '0.0.0.0', () => {
  const line = '─'.repeat(74);
  console.log(line);
  console.log(`SITEE preview ${VERSION} — http://${host || '0.0.0.0'}:${port}`);
  console.log(`  API:      /api/v1/…   WS: /ws   Метрики: /metrics   Фронтенд: ${FRONTEND_DIR}`);
  console.log(`  БД:       in-memory (${db.users.size} пользователей, ${db.shops.size} магазинов, ${db.orders.size} заказов, ${db.ledger.entries.length} проводок)`);
  console.log(`  Крипто:   KEK fingerprint ${C.KEK_FINGERPRINT} (AES-256-GCM + HKDF, формат как в Go cryptod)`);
  if (restored) console.log(`  Снапшот:  восстановлен из ${restored.file} (${restored.saved_at})`);
  console.log('  Демо-доступ (роль / email / пароль / backup-код входа):');
  for (const cred of demoCredentials(db)) {
    console.log(`    ${cred.role.padEnd(11)} ${cred.email.padEnd(22)} ${cred.password.padEnd(13)} ${cred.backup_login.split(',')[0]}`);
  }
  console.log('  TOTP-секреты тех же аккаунтов: GET /api/v1/dev/credentials');
  console.log(line);
});

// Необработанные ошибки не должны ронять стенд: без этого процесс умирает
// и preview показывает вечную загрузку (пользователь видит «долго грузится»).
process.on('uncaughtException', (err) => {
  console.error('[preview] необработанное исключение:', err?.message ?? err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[preview] необработанный reject:', reason?.message ?? reason);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[preview] ${signal}: останавливаюсь`);
    try {
      persist.save(ctx);
    } catch { /* снапшот не критичен */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
