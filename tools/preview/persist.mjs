// Снапшоты состояния preview-БД (эквивалент JSON-снапшотов Go-стора).
// Каталоги data/ исключены из git (.gitignore).
import fs from 'node:fs';
import path from 'node:path';
import { Ledger } from './data.mjs';

const MAP_KEYS = [
  'countries', 'cities', 'categories', 'rentPlans', 'users', 'usersByNick', 'usersByMail',
  'shops', 'shopsBySlug', 'subs', 'products', 'stock', 'orders', 'ordersByNumber',
  'chats', 'members', 'messages', 'prekeys', 'e2eeSessions', 'disputes', 'gifts',
  'giftPurchases', 'reviews', 'reports', 'withdrawals', 'solTxs', 'quotes',
  'notifications', 'sessions', 'refresh', 'enrollments', 'settings', 'idempotency',
  'invoices', 'ipBans', 'supportChats',
];
const ARRAY_KEYS = ['orderStatuses', 'authEvents', 'audit', 'securityEvents'];

export function snapshotPath() {
  const dir = process.env.SITEED_DATA_DIR || path.resolve('data');
  return path.join(dir, 'preview-snapshot.json');
}

export function save(ctx) {
  const file = snapshotPath();
  const payload = {
    v: 1, saved_at: new Date().toISOString(), version: ctx.version,
    auditHead: ctx.db.auditHead,
    userSeq: ctx.db.userSeq,
    db: {},
  };
  for (const key of MAP_KEYS) {
    const map = ctx.db[key];
    if (map instanceof Map) payload.db[key] = [...map.entries()];
  }
  for (const key of ARRAY_KEYS) {
    if (Array.isArray(ctx.db[key])) payload.db[key] = ctx.db[key];
  }
  payload.db.ledger = {
    accounts: [...ctx.db.ledger.accounts.entries()],
    entries: ctx.db.ledger.entries,
    seen: [...ctx.db.ledger.seen],
  };
  payload.db.usersByNickRef = [...ctx.db.usersByNick.entries()];
  payload.db.shopsBySlugRef = [...ctx.db.shopsBySlug.entries()];
  payload.db.productsRef = [...ctx.db.products.values()].map((p) => p.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
  return file;
}

// load — восстанавливает БД снапшота поверх свежего сида (если снапшот валиден).
export function load(ctx) {
  const file = snapshotPath();
  if (!process.env.SITEED_SNAPSHOT || process.env.SITEED_SNAPSHOT === '0') return null;
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.v !== 1) return null;
    for (const key of MAP_KEYS) {
      if (Array.isArray(raw.db?.[key])) ctx.db[key] = new Map(raw.db[key]);
    }
    for (const key of ARRAY_KEYS) {
      if (Array.isArray(raw.db?.[key])) ctx.db[key] = raw.db[key];
    }
    if (raw.db?.ledger) {
      const ledger = new Ledger();
      ledger.accounts = new Map(raw.db.ledger.accounts);
      ledger.entries = raw.db.ledger.entries ?? [];
      ledger.seen = new Set(raw.db.ledger.seen ?? []);
      ctx.db.ledger = ledger;
    }
    ctx.db.auditHead = raw.auditHead ?? '';
    ctx.db.userSeq = raw.userSeq ?? ctx.db.userSeq;
    // Ссылки, которые сид строит как обычные объекты.
    ctx.db.usersByNickRef = {};
    for (const [nick, id] of ctx.db.usersByNick) {
      ctx.db.usersByNickRef[nick] = ctx.db.users.get(id) ?? null;
    }
    ctx.db.shopsBySlugRef = {};
    for (const [slug, id] of ctx.db.shopsBySlug) {
      ctx.db.shopsBySlugRef[slug] = ctx.db.shops.get(id) ?? null;
    }
    ctx.db.productsRef = [...ctx.db.products.values()];
    ctx.db.supportChats = new Map();
    for (const chat of ctx.db.chats.values()) {
      if (chat.kind === 'shop_support' && chat.shop_id) ctx.db.supportChats.set(chat.shop_id, chat.id);
    }
    return { file, saved_at: raw.saved_at };
  } catch (err) {
    console.warn('[preview] снапшот не загружен:', err.message);
    return null;
  }
}
