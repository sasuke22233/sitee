// Headless-прогон фронтенда SITEE (Telegram Mini App) в jsdom против живого preview-сервера.
//
// Что проверяет:
//   1. приложение стартует без ошибок (boot, справочники, /auth/me);
//   2. каждый экран рендерится: нет исключений, нет 404/500 по API;
//   3. ленты, карточки и админ-разделы показывают данные, а не «экран недоступен».
//
// Запуск:
//   1) cd tools/preview && npm start              (поднять preview-сервер)
//   2) cd tools/fe-test && npm install && npm test
//
// Опции: node run.mjs [base] [--keep-open]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const BASE = (process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/$/, '');

const errors = [];
const badRequests = [];
const jsdomNoise = new Set();
const screens = [];

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => {
  if (/Not implemented/i.test(e.message)) jsdomNoise.add(e.message.split('\n')[0]);
  else errors.push(`jsdomError: ${e.message}`);
});
virtualConsole.on('error', (...args) => errors.push(`console.error: ${args.join(' ').slice(0, 300)}`));

const html = fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8')
  .replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');

const dom = new JSDOM(html, { url: `${BASE}/`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
const { window } = dom;

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}
defineGlobal('window', window);
defineGlobal('document', window.document);
defineGlobal('navigator', window.navigator);
defineGlobal('localStorage', window.localStorage);
defineGlobal('sessionStorage', window.sessionStorage);
defineGlobal('location', window.location);
defineGlobal('requestAnimationFrame', (fn) => setTimeout(() => fn(Date.now()), 0));
defineGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
defineGlobal('MutationObserver', window.MutationObserver);
defineGlobal('HTMLElement', window.HTMLElement);
defineGlobal('Node', window.Node);
// Глобальный Event не переопределяем: его использует undici WebSocket в Node.
defineGlobal('CustomEvent', window.CustomEvent);
defineGlobal('CSS', { escape: (s) => String(s).replace(/["\\]/g, '\\$&') });
window.CSS = globalThis.CSS;
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
window.addEventListener('error', (ev) => errors.push(`window.onerror: ${ev.message ?? ev.error?.stack ?? ev}`));
window.addEventListener('unhandledrejection', (ev) => errors.push(`unhandled rejection: ${String(ev.reason?.stack ?? ev.reason).slice(0, 300)}`));

const realFetch = globalThis.fetch;
let currentScreen = 'boot';
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const full = url.startsWith('/') ? BASE + url : url;
  const res = await realFetch(full, init);
  if (res.status >= 400 && full.includes('/api/')) {
    badRequests.push(`${currentScreen}: ${init?.method ?? 'GET'} ${url.split('?')[0]} → ${res.status}`);
  }
  return res;
};
window.fetch = globalThis.fetch;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const view = () => document.getElementById('view');
const text = () => (view()?.textContent ?? '').replace(/\s+/g, ' ').trim();

async function call(method, url, { token, body } = {}) {
  const res = await realFetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const textBody = await res.text();
  let data = null;
  try { data = JSON.parse(textBody); } catch { data = { raw: textBody.slice(0, 120) }; }
  return { status: res.status, data };
}

// TOTP RFC 6238 (SHA-1/30 s/6 цифр) — backup-коды одноразовые, поэтому считаем код из секрета.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(secret) {
  const clean = String(secret).toUpperCase().replace(/=+$/g, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function totp(secret, offset = 0) {
  const counter = Math.floor(Date.now() / 1000 / 30) + offset;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const sig = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = sig[sig.length - 1] & 0x0f;
  const code = ((sig[o] & 0x7f) << 24) | (sig[o + 1] << 16) | (sig[o + 2] << 8) | sig[o + 3];
  return String(code % 1000000).padStart(6, '0');
}

async function loginAs(cred) {
  let s1 = await call('POST', '/api/v1/auth/login', {
    body: { identifier: cred.email, password: cred.password, device: { device_id: 'fe-test' } },
  });
  if (s1.status === 428) {
    // сработала captcha-защита — в dev достаточно любого токена
    s1 = await call('POST', '/api/v1/auth/login', {
      body: { identifier: cred.email, password: cred.password, device: { device_id: 'fe-test' }, captcha_token: 'dev' },
    });
  }
  if (s1.status !== 200) throw new Error(`login step1 ${cred.nickname}: ${s1.status} ${JSON.stringify(s1.data).slice(0, 120)}`);
  const s2 = await call('POST', '/api/v1/auth/2fa/verify', {
    body: { session_id: s1.data.session_id, factor: 'login', code: totp(cred.totp_login) },
  });
  if (s2.status !== 200) throw new Error(`login step2 ${cred.nickname}: ${s2.status} ${JSON.stringify(s2.data).slice(0, 120)}`);
  return { token: s2.data.access_token, refresh: s2.data.refresh_token, ops: cred.backup_ops.split(','), user: s2.data.user };
}

async function go(hash, wait = 800) {
  currentScreen = hash;
  const before = errors.length;
  location.hash = hash;
  window.dispatchEvent(new window.Event('hashchange'));
  await sleep(wait);
  const body = text();
  const failed = /недоступн|не найден|Ошибка экрана|нет связи с сервером/i.test(body);
  screens.push({ hash, chars: body.length, failed, newErrors: errors.length - before, preview: body.slice(0, 110) });
}

// ---------------------------------------------------------------------------
console.log(`SITEE frontend smoke → ${BASE}`);
// Сбрасываем защитные счётчики (dev-only эндпоинт): после backend-смока вход может требовать captcha.
const reset = await call('POST', '/api/v1/dev/reset-guards');
console.log(`сброс лимитеров: ${reset.status}`);
await import(path.join(ROOT, 'frontend/js/app.js'));
await sleep(1200);
console.log(`\nboot: ${text().slice(0, 90)}…`);

const creds = (await call('GET', '/api/v1/dev/credentials')).data;
const byNick = Object.fromEntries(creds.users.map((u) => [u.nickname, u]));
const { setTokens, loadMe, S } = await import(path.join(ROOT, 'frontend/js/state.js'));

async function switchUser(nickname) {
  const session = await loginAs(byNick[nickname]);
  setTokens({ access: session.token, refresh: session.refresh });
  await loadMe();
  window.__opsCodes = session.ops;
  window.__totpOps = () => totp(byNick[session.user.nickname].totp_ops);
  window.__session = session;
  console.log(`\n— вошёл как ${nickname} (${session.user.role}) —`);
  return session;
}

// 1. Покупатель
await switchUser('buyer_nova');
const feed = (await call('GET', '/api/v1/shops?limit=3')).data;
const shopId = feed.items[0].id;
const shopProducts = (await call('GET', `/api/v1/shops/${shopId}/products`)).data;
const chatsList = (await call('GET', '/api/v1/chats', { token: window.__session.token })).data;
const ordersList = (await call('GET', '/api/v1/orders?role=buyer', { token: window.__session.token })).data;
const disputesList = (await call('GET', '/api/v1/disputes', { token: window.__session.token })).data;

for (const hash of ['#/shops', '#/chats', '#/exchange', '#/profile', '#/orders', '#/disputes',
  '#/profile/2fa', '#/profile/sessions', '#/profile/notifications', '#/profile/shops',
  `#/shop/${shopId}`, `#/product/${shopProducts.items[0].id}`,
  chatsList.items[0] ? `#/chat/${chatsList.items[0].id}` : '#/chats',
  ordersList.items[0] ? `#/order/${ordersList.items[0].id}` : '#/orders',
  disputesList.items[0] ? `#/dispute/${disputesList.items[0].id}` : '#/disputes']) {
  await go(hash);
}

// 2. Публичные экраны и регистрация
setTokens(null);
S.me = null;
for (const hash of ['#/welcome', '#/login', '#/register']) await go(hash);

// 3. Админ
await switchUser('sitee_admin');
for (const section of ['dashboard', 'users', 'shops', 'moderation', 'orders', 'disputes', 'gifts',
  'rent', 'finance', 'audit', 'security', 'settings']) {
  await go(`#/admin/${section}`, 700);
}

// 4. Продавец
await switchUser('keymaster');
const myShops = S.me?.shops ?? [];
await go('#/profile/shops');
if (myShops[0]) await go(`#/profile/shop/${myShops[0].id}`);
await go('#/orders');
await go('#/chats');

// ---------------------------------------------------------------------------
console.log('\n────────────────────────────────────────────────────────────');
console.log('Экраны:');
for (const s of screens) {
  const mark = s.failed || s.newErrors ? '✗' : '✓';
  console.log(`  ${mark} ${s.hash.padEnd(38)} ${String(s.chars).padStart(5)} симв.${s.newErrors ? ` · +${s.newErrors} ошибок` : ''}`);
  if (s.failed || s.newErrors || s.chars < 420 || process.env.FE_VERBOSE) console.log(`      ${s.preview}`);
}
const failedScreens = screens.filter((s) => s.failed || s.newErrors);
console.log(`\nОшибки исполнения: ${errors.length}`);
for (const e of [...new Set(errors)].slice(0, 15)) console.log(`  • ${e.slice(0, 260)}`);
console.log(`\nЗапросы с ошибкой (4xx/5xx): ${badRequests.length}`);
for (const b of [...new Set(badRequests)].slice(0, 25)) console.log(`  • ${b}`);
if (jsdomNoise.size) {
  console.log(`\nНе реализовано в jsdom (не влияет на браузер): ${jsdomNoise.size}`);
  for (const n of [...jsdomNoise].slice(0, 5)) console.log(`  • ${n.slice(0, 110)}`);
}
console.log(`\nИтог: экранов ${screens.length}, проблемных ${failedScreens.length}, ошибок ${errors.length}, неудачных запросов ${new Set(badRequests).size}`);
process.exit(errors.length || failedScreens.length || badRequests.length ? 1 : 0);
