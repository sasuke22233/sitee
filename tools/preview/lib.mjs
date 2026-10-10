// Общие помощники preview-сервера: ответы, авторизация, DTO, аудит, rate-limit.
import * as C from './crypto.mjs';

export const CONFIG = {
  env: process.env.SITEED_ENV || 'dev',
  addr: process.env.SITEED_ADDR || '0.0.0.0:8080',
  accessTtl: 15 * 60,
  refreshTtl: 30 * 24 * 3600,
  payTimeoutMinutes: 30,
  autoConfirmHours: 72,
  disputeReplyHours: 72,
  disputeWindowDays: 30,
  reviewWindowDays: 30,
  warmupHours: 0,
  exchangeFeeBps: Number(process.env.EXCHANGE_FEE_BPS || 100),
  solStarsRate: Number(process.env.SOL_STARS_RATE || 0.01),
  withdrawDailySol: Number(process.env.LIMIT_WITHDRAW_DAILY_SOL || 50),
  fourEyesSol: Number(process.env.LIMIT_FOUR_EYES_SOL || 100),
  opsThresholdSol: Number(process.env.THRESHOLD_OPS_TOTP_SOL || 5),
  opsThresholdStars: Number(process.env.THRESHOLD_OPS_TOTP_STARS || 1000),
  captchaSiteKey: process.env.CAPTCHA_SITE_KEY || 'sitee-dev-captcha',
  tgBotUsername: process.env.TG_BOT_USERNAME || 'sitee_bot',
  solanaNetwork: process.env.SOLANA_NETWORK || 'devnet',
  confirmations: Number(process.env.SOL_CONFIRMATIONS || 32),
  minDepositSol: Number(process.env.SOL_MIN_DEPOSIT || 0.01),
};

// Операции, требующие второй фактор 2FA (FR-2FA-04).
const OPS_OPERATIONS = new Set([
  'withdraw', 'exchange', 'rent', 'create_shop', 'transfer_shop', 'dispute_open',
  'dispute_resolve', 'gift_buy', 'password_change', 'admin_write', 'sanction', 'order_pay',
]);

export class ApiError extends Error {
  constructor(status, code, message, details = null, retryAfter = 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retry_after = retryAfter;
  }
}

export const bad = (msg, details = null) => new ApiError(400, 'VALIDATION', msg, details);
export const unauthorized = (msg = 'требуется авторизация') => new ApiError(401, 'UNAUTHENTICATED', msg);
export const forbidden = (code, msg) => new ApiError(403, code, msg);
export const notFound = (msg) => new ApiError(404, 'NOT_FOUND', msg);
export const conflict = (code, msg) => new ApiError(409, code, msg);
export const unprocessable = (code, msg) => new ApiError(422, code, msg);
export const tooMany = (msg, retryAfter = 60) => new ApiError(429, 'RATE_LIMITED', msg, null, retryAfter);
export const locked = (msg, retryAfter = 900) => new ApiError(423, 'LOCKED', msg, null, retryAfter);

export function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export function fail(res, err, requestId) {
  const e = err instanceof ApiError ? err : new ApiError(500, 'INTERNAL', 'внутренняя ошибка сервера');
  if (e.status >= 500) console.error('[preview] 500:', err);
  send(res, e.status, {
    error: {
      code: e.code, message: e.status >= 500 ? 'внутренняя ошибка сервера' : e.message,
      status: e.status, request_id: requestId ?? null,
      ...(e.details ? { details: e.details } : {}),
      ...(e.retry_after ? { retry_after: e.retry_after } : {}),
    },
  });
}

export function ledgerError(errCode) {
  switch (errCode) {
    case 'INSUFFICIENT_FUNDS': return unprocessable('INSUFFICIENT_FUNDS', 'недостаточно средств');
    case 'ALREADY_USED': return conflict('ALREADY_USED', 'операция уже исполнена');
    case 'UNBALANCED': return new ApiError(500, 'INTERNAL', 'несбалансированная проводка');
    case 'BAD_AMOUNT': return bad('сумма должна быть больше нуля');
    default: return new ApiError(500, 'INTERNAL', 'ошибка ledger: ' + errCode);
  }
}

export function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(bad('тело запроса слишком большое'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(bad('некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Rate limiting (token bucket, профили из docs/security.md §8)
// ---------------------------------------------------------------------------
// Пороги из docs/security.md §8. SITEED_RATE_SCALE масштабирует их для демо-стенда,
// где весь трафик приходит с одного IP прокси (в prod масштаб = 1).
const SCALE = Math.max(1, Number(process.env.SITEED_RATE_SCALE || 1));
const scaleProfile = (p) => ({ ...p, rate: p.rate * SCALE, burst: Math.round(p.burst * SCALE) });
const PROFILES = {
  public: scaleProfile({ rate: 60, burst: 20 }),
  auth: scaleProfile({ rate: 10, burst: 5, blockAfter: 20, blockFor: 15 * 60000 }),
  '2fa': scaleProfile({ rate: 12, burst: 2, blockAfter: 10, blockFor: 30 * 60000 }),
  payment: scaleProfile({ rate: 10, burst: 4 }),
  write: scaleProfile({ rate: 120, burst: 40 }),
  admin: scaleProfile({ rate: 120, burst: 40 }),
  search: scaleProfile({ rate: 30, burst: 10 }),
  register: scaleProfile({ rate: 3, burst: 3, blockAfter: 3, blockFor: 24 * 3600000 }),
  ws: scaleProfile({ rate: 5, burst: 3 }),
  wsmsg: scaleProfile({ rate: 60, burst: 20 }),
};
const buckets = new Map();

// resetRateLimits — сброс счётчиков (только dev-стенд, используется смоук-тестом).
export function resetRateLimits() {
  buckets.clear();
}

export function allow(key, profileName) {
  const profile = PROFILES[profileName] ?? PROFILES.public;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: profile.burst, updated: now, rejects: 0, blockedTil: 0 };
    buckets.set(key, b);
  }
  if (b.blockedTil > now) {
    return { allowed: false, blocked: true, retryAfter: Math.ceil((b.blockedTil - now) / 1000), limit: profile.burst, remaining: 0 };
  }
  b.tokens = Math.min(profile.burst, b.tokens + ((now - b.updated) / 60000) * profile.rate);
  b.updated = now;
  if (b.tokens < 1) {
    b.rejects += 1;
    if (profile.blockAfter && b.rejects >= profile.blockAfter) {
      b.blockedTil = now + (profile.blockFor ?? 60000);
      b.rejects = 0;
      return { allowed: false, blocked: true, retryAfter: Math.ceil((profile.blockFor ?? 60000) / 1000), limit: profile.burst, remaining: 0 };
    }
    return { allowed: false, blocked: false, retryAfter: Math.ceil(60 / profile.rate), limit: profile.burst, remaining: 0 };
  }
  b.tokens -= 1;
  b.rejects = 0;
  return { allowed: true, blocked: false, retryAfter: 0, limit: profile.burst, remaining: Math.floor(b.tokens) };
}

// ---------------------------------------------------------------------------
// Сессии и токены
// ---------------------------------------------------------------------------
export function issueSession(ctx, user, { factorOps = false, deviceId = '', ip = '', ua = '' } = {}) {
  const sessionId = C.newId('ses');
  const session = {
    id: sessionId, user_id: user.id, device_id: deviceId, status: 'active',
    factor_ops_ok: factorOps, factor_ops_at: factorOps ? new Date().toISOString() : null,
    ip, ua, created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + CONFIG.refreshTtl * 1000).toISOString(),
  };
  ctx.db.sessions.set(sessionId, session);
  const access = C.signToken({ sub: user.id, sid: sessionId, role: user.role, nick: user.nickname }, CONFIG.accessTtl);
  const refresh = C.randomToken(32);
  ctx.db.refresh.set(C.tokenHash(refresh), {
    token_hash: C.tokenHash(refresh), session_id: sessionId, family_id: C.newId('fam'),
    expires_at: new Date(Date.now() + CONFIG.refreshTtl * 1000).toISOString(), created_at: new Date().toISOString(),
  });
  return { access_token: access, refresh_token: refresh, session_id: sessionId, expires_in: CONFIG.accessTtl, token_type: 'Bearer' };
}

export function authenticate(ctx, req) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    const url = new URL(req.url, 'http://localhost');
    token = url.searchParams.get('token') || '';
  }
  if (!token) return null;
  const claims = C.verifyToken(token);
  if (!claims) return null;
  const user = ctx.db.users.get(claims.sub);
  const session = ctx.db.sessions.get(claims.sid);
  if (!user || user.status !== 'active') return null;
  if (!session || session.status !== 'active' || new Date(session.expires_at) < new Date()) return null;
  return { user, session, claims };
}

export function requireAuth(ctx, req) {
  const auth = authenticate(ctx, req);
  if (!auth) throw unauthorized();
  if (auth.user.status !== 'active') throw forbidden('ACCOUNT_RESTRICTED', 'аккаунт ограничен');
  return auth;
}

export function requireRole(ctx, req, ...roles) {
  const auth = requireAuth(ctx, req);
  if (!roles.includes(auth.user.role)) throw forbidden('FORBIDDEN', 'недостаточно прав');
  return auth;
}

// requireOps — проверка второго фактора 2FA (FR-2FA-04).
export function requireOps(ctx, req, auth, operation, { amountSol = 0, amountStars = 0, totpCode = '' } = {}) {
  const user = auth.user;
  const privileged = ['shop_admin', 'moderator', 'arbiter', 'superadmin'].includes(user.role);
  const needsOps = privileged || amountSol >= CONFIG.opsThresholdSol * C.LAMPORTS_PER_SOL ||
    amountStars >= CONFIG.opsThresholdStars || OPS_OPERATIONS.has(operation);
  if (user.session?.factor_ops_ok) return true;
  if (auth.session.factor_ops_ok) return true;
  const factor = user.factors?.ops;
  if (!factor || factor.status !== 'active') {
    if (needsOps) throw forbidden('2FA_NOT_ENROLLED', `для операции «${operation}» требуется настроить второй фактор 2FA`);
    return true;
  }
  if (!totpCode) {
    throw new ApiError(428, 'TOTP_STEP2_REQUIRED', `операция «${operation}» требует код второго фактора 2FA (SITEE (операции))`,
      { operation, factor: 'ops' });
  }
  const secret = Buffer.from(factor.secret_ct ? C.tryDecrypt(C.DOMAINS.totp, `${user.id}:ops`, factor.secret_ct) ?? '' : '', 'base64');
  const key = secret.length === 20 ? secret : C.decodeBase32(factor.secret_b32);
  const res = C.validateTotp(key, String(totpCode).trim());
  if (!res.ok) {
    const bidx = C.verifyBackupCode(String(totpCode).trim(), factor.backup_hashes ?? []);
    if (bidx < 0 || factor.backup_used?.[bidx]) throw forbidden('TOTP_INVALID', 'код 2FA неверен или истёк');
    factor.backup_used[bidx] = true;
  } else {
    const until = Math.floor(Date.now() / 1000) + 120;
    factor.used_codes[String(totpCode)] = until;
  }
  auth.session.factor_ops_ok = true;
  auth.session.factor_ops_at = new Date().toISOString();
  return true;
}

// ---------------------------------------------------------------------------
// Аудит, уведомления, WS-события
// ---------------------------------------------------------------------------
export function audit(ctx, req, actor, action, objType, objId, reason = '', totpFactor = '', before = null, after = null) {
  const record = {
    id: C.newId('aud'), ts: new Date().toISOString(), actor_id: actor?.id ?? '',
    actor_role: actor?.role ?? '', action, object_type: objType, object_id: objId, reason,
    ip: clientIp(req), ua: req?.headers?.['user-agent'] ?? '', totp_factor: totpFactor,
    before, after, prev_hash: ctx.db.auditHead, record_hash: '',
  };
  record.record_hash = C.auditHash(record);
  ctx.db.auditHead = record.record_hash;
  ctx.db.audit.push(record);
  if (ctx.db.audit.length > 5000) ctx.db.audit.splice(0, ctx.db.audit.length - 5000);
  return record;
}

export function notify(ctx, userId, kind, title, body, dedupKey, data = null) {
  if (!userId) return null;
  const list = ctx.db.notifications.get(userId) ?? [];
  if (list.some((n) => n.dedup_key === dedupKey)) return null;
  const n = {
    id: C.newId('ntf'), user_id: userId, channel: 'inapp', kind, title, body,
    dedup_key: dedupKey, data, read: false, created_at: new Date().toISOString(),
  };
  list.push(n);
  ctx.db.notifications.set(userId, list);
  push(ctx, userId, 'notify', { id: n.id, kind, title, body, ts: n.created_at });
  return n;
}

export function push(ctx, userId, type, data) {
  ctx.hub.send(userId, { v: 1, t: type, ts: Date.now(), d: data });
}

export function pushMany(ctx, userIds, type, data) {
  ctx.hub.sendMany([...new Set(userIds.filter(Boolean))], { v: 1, t: type, ts: Date.now(), d: data });
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

export function recordAuthEvent(ctx, userId, event, req, reason = '', risk = 0) {
  ctx.db.authEvents.push({
    ts: new Date().toISOString(), user_id: userId, event, ip: clientIp(req),
    geo: '', ua: req.headers['user-agent'] ?? '', reason, risk_score: risk,
  });
  if (ctx.db.authEvents.length > 5000) ctx.db.authEvents.splice(0, ctx.db.authEvents.length - 5000);
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------
// rentPlanList — тарифы аренды без дублей (в сиде план хранится под id и под code).
export function rentPlanList(ctx) {
  const seen = new Set();
  const items = [];
  for (const plan of ctx.db.rentPlans.values()) {
    if (seen.has(plan.id)) continue;
    seen.add(plan.id);
    items.push(plan);
  }
  return items.sort((a, b) => a.price_sol - b.price_sol);
}

export function cityName(ctx, id) {
  return ctx.db.cities.get(id)?.name_ru ?? '';
}

export function userDto(ctx, user) {
  if (!user) return null;
  const factors = {
    login: user.factors?.login?.status ?? 'pending',
    ops: user.factors?.ops?.status ?? 'pending',
  };
  const shops = [...ctx.db.shops.values()]
    .filter((sh) => sh.admin_user_id === user.id)
    .map((sh) => ({
      id: sh.id, slug: sh.slug, name: sh.name, status: sh.status,
      rent_status: rentStatus(ctx, sh.id), is_crowned: isCrowned(ctx, sh),
      rating: Number((sh.rating_bayes ?? 0).toFixed(1)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  let unread = 0;
  for (const [chatId, members] of ctx.db.members) {
    const mine = members.find((m) => m.user_id === user.id && !m.left_at);
    if (!mine) continue;
    const chat = ctx.db.chats.get(chatId);
    if (chat && chat.last_seq > (mine.last_read_seq ?? 0)) unread += chat.last_seq - mine.last_read_seq;
  }
  let gifts = 0;
  for (const gp of ctx.db.giftPurchases.values()) {
    if (gp.status !== 'delivered') continue;
    if ((gp.recipient_type === 'user' && gp.recipient_id === user.id) ||
        (gp.recipient_type === 'self' && gp.buyer_id === user.id)) gifts += 1;
  }
  const sol = ctx.db.ledger.userBalance(user.id, 'SOL');
  return {
    id: user.id, nickname: user.nickname, role: user.role,
    country: user.country, country_name: ctx.db.countries.get(user.country)?.name_ru ?? '',
    city_id: user.city_id ?? null, city_name: cityName(ctx, user.city_id),
    locale: user.locale, theme: user.theme, status: user.status, is_18plus: user.is_18plus,
    factors,
    balances: { SOL: C.formatSol(sol), SOL_raw: sol, STARS: ctx.db.ledger.userBalance(user.id, 'STARS') },
    shops, gifts_count: gifts, unread: { chats: unread },
    created_at: user.created_at, last_login_at: user.last_login_at,
    warmup_until: user.warmup_until ?? null,
    is_privileged: ['shop_admin', 'moderator', 'arbiter', 'superadmin'].includes(user.role),
    risk_score: user.risk_score ?? 0,
    email_masked: maskEmail(user.email ?? ''),
    deposit_address: user.deposit_address ?? null,
  };
}

export function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${name.slice(0, 2)}***@${domain}`;
}

// FR-GEO-03(б): категория запрещена в юрисдикции покупателя/продавца.
// Возвращает первую заблокированную категорию или null.
export function geoBlock(ctx, categoryIds, country) {
  const code = String(country ?? '').toUpperCase();
  if (!code) return null;
  for (const id of categoryIds ?? []) {
    const cat = ctx.db.categories.get(Number(id));
    if (cat && (cat.blocked_countries ?? []).includes(code)) return cat;
  }
  return null;
}

// Все категории магазина, запрещённые в стране (для фильтра ленты).
export function geoBlockedAll(ctx, categoryIds, country) {
  const ids = (categoryIds ?? []).map(Number);
  if (ids.length === 0) return false;
  return ids.every((id) => {
    const cat = ctx.db.categories.get(id);
    return !!cat && (cat.blocked_countries ?? []).includes(String(country ?? '').toUpperCase());
  });
}

export function isCrowned(ctx, shop) {
  if (shop.status !== 'active') return false;
  if (shop.sanction_level && shop.sanction_level !== 'none') return false;
  if (shop.rating_count > 0 && shop.rating_bayes < 4.0) return false;
  const sub = ctx.db.subs.get(shop.id);
  if (!sub || !['active', 'expiring', 'trial'].includes(sub.status)) return false;
  return !!ctx.db.rentPlans.get(sub.plan_id)?.crown;
}

export function rentStatus(ctx, shopId) {
  return ctx.db.subs.get(shopId)?.status ?? 'none';
}

export function feeBps(ctx, shopId) {
  const sub = ctx.db.subs.get(shopId);
  return ctx.db.rentPlans.get(sub?.plan_id)?.fee_bps ?? Number(ctx.db.settings.get('default_fee_bps') ?? 700);
}

export function shopCard(ctx, shop, viewerCountry = '') {
  const sub = ctx.db.subs.get(shop.id);
  const plan = ctx.db.rentPlans.get(sub?.plan_id);
  const products = [...ctx.db.products.values()].filter((p) => p.shop_id === shop.id && p.status === 'published');
  const minPrice = products.length ? Math.min(...products.map((p) => p.price_sol)) : 0;
  return {
    id: shop.id, slug: shop.slug, name: shop.name, description: shop.description,
    cover_url: shop.cover_url || null, avatar_url: shop.avatar_url || null,
    accent: shop.accent ?? '#6c5ce7',
    rating: Number(shop.rating_bayes.toFixed(2)), rating_count: shop.rating_count,
    crown: isCrowned(ctx, shop), verified: shop.is_verified,
    sales_count: shop.sales_count, country: shop.country, city: cityName(ctx, shop.city_id),
    categories: (shop.category_ids ?? []).map((id) => ctx.db.categories.get(id)?.name_ru).filter(Boolean),
    rent_status: rentStatus(ctx, shop.id), plan: plan?.code ?? null,
    accepts_stars: shop.accepts_stars, products_total: products.length,
    price_from_sol: minPrice ? C.formatSol(minPrice) : null,
    feed_score: Number((shop.feed_score ?? 0).toFixed(4)),
    gift_boost: shop.gift_boost ?? 0,
    same_country: !!viewerCountry && viewerCountry === shop.country,
  };
}

export function shopDetail(ctx, shop, viewer) {
  const card = shopCard(ctx, shop, viewer?.country ?? '');
  const sub = ctx.db.subs.get(shop.id);
  const plan = ctx.db.rentPlans.get(sub?.plan_id);
  return {
    ...card,
    admin_user_id: shop.admin_user_id,
    response_p50_s: shop.response_p50_s, dispute_rate: Number((shop.dispute_rate ?? 0).toFixed(3)),
    created_at: shop.created_at, tz: shop.tz, status: shop.status,
    sanction_level: shop.sanction_level,
    rent: sub ? {
      plan: plan?.code, plan_name: plan?.name_ru, status: sub.status,
      period_end: sub.period_end, grace_end: sub.grace_end, auto_renew: sub.auto_renew,
      price_sol: C.formatSol(sub.price_sol), price_stars: sub.price_stars, fee_bps: plan?.fee_bps,
    } : null,
    is_mine: viewer ? shop.admin_user_id === viewer.id : false,
    actions: shopActions(ctx, shop, viewer),
  };
}

function shopActions(ctx, shop, viewer) {
  const actions = ['open_chat', 'view_products'];
  if (viewer && shop.admin_user_id === viewer.id) {
    actions.push('edit_shop', 'add_product', 'subscribe_rent', 'shop_stats');
  }
  if (viewer && ['superadmin', 'moderator'].includes(viewer.role)) actions.push('admin_panel');
  if (rentStatus(ctx, shop.id) === 'suspended') actions.push('rent_required');
  return actions;
}

export function productDto(ctx, product, viewer = null) {
  const shop = ctx.db.shops.get(product.shop_id);
  const items = ctx.db.stock.get(product.id) ?? [];
  return {
    id: product.id, shop_id: product.shop_id, shop_name: shop?.name,
    title: product.title, description: product.description, kind: product.kind,
    category_id: product.category_id,
    category: ctx.db.categories.get(product.category_id)?.name_ru ?? null,
    price_sol: C.formatSol(product.price_sol), price_sol_raw: product.price_sol,
    price_stars: product.price_stars, warranty_days: product.warranty_days,
    delivery_sla_h: product.delivery_sla_h, status: product.status,
    stock_free: items.filter((i) => i.status === 'free').length,
    stock_total: items.length, delivery_kind: items.length ? 'auto' : 'manual',
    rating: product.rating_count ? Number((product.rating_sum / product.rating_count).toFixed(2)) : null,
    created_at: product.created_at,
    can_buy: product.status === 'published' && shop?.status === 'active' && rentStatus(ctx, shop.id) !== 'suspended',
    is_mine: viewer ? shop?.admin_user_id === viewer.id : false,
  };
}

export const STATUS_TITLES = {
  created: 'Создан', awaiting_payment: 'Ожидает оплаты', paid_escrow: 'Оплачен (эскроу)',
  processing: 'В обработке', delivered: 'Доставлен', completed: 'Завершён',
  dispute_opened: 'Открыт спор', in_arbitration: 'Арбитраж', refunded: 'Возврат',
  cancelled: 'Отменён', expired: 'Истёк',
};

export function statusTitle(status) {
  return STATUS_TITLES[status] ?? status;
}

export function orderActions(order, role) {
  const isBuyer = role === 'buyer';
  switch (order.status) {
    case 'awaiting_payment':
    case 'created':
      return isBuyer ? ['pay', 'cancel', 'chat_with_admin'] : ['chat_with_admin'];
    case 'paid_escrow':
      return isBuyer ? ['open_dispute', 'chat_with_admin'] : ['processing', 'deliver', 'cancel', 'chat_with_admin'];
    case 'processing':
      return isBuyer ? ['open_dispute', 'chat_with_admin'] : ['deliver', 'chat_with_admin'];
    case 'delivered':
      return isBuyer ? ['confirm', 'extend', 'open_dispute', 'review', 'chat_with_admin'] : ['chat_with_admin'];
    case 'completed':
      return isBuyer ? ['review', 'open_dispute'] : [];
    case 'dispute_opened':
    case 'in_arbitration':
      return isBuyer ? ['reply_dispute', 'escalate'] : ['reply_dispute', 'offer_refund'];
    default:
      return [];
  }
}

export function orderDto(ctx, order, viewer) {
  const shop = ctx.db.shops.get(order.shop_id);
  const role = order.buyer_id === viewer?.id ? 'buyer' : 'shop';
  const total = order.pay_asset === 'STARS' ? order.total_stars : order.total_sol;
  const dto = {
    id: order.id, number: order.number, status: order.status, status_title: statusTitle(order.status),
    shop_id: order.shop_id, shop_name: shop?.name, buyer_id: order.buyer_id,
    pay_asset: order.pay_asset, delivery_kind: order.delivery_kind, fee_bps: order.fee_bps,
    total_raw: total,
    total: order.pay_asset === 'STARS' ? `${order.total_stars} ⭐` : `${C.formatSol(order.total_sol)} SOL`,
    subtotal: order.pay_asset === 'STARS' ? `${order.subtotal_stars} ⭐` : `${C.formatSol(order.subtotal_sol)} SOL`,
    fee: order.pay_asset === 'STARS' ? `${order.fee_stars} ⭐` : `${C.formatSol(order.fee_sol)} SOL`,
    items: order.items.map((it) => ({
      id: it.id, product_id: it.product_id, title: it.title, qty: it.qty,
      unit_price: order.pay_asset === 'STARS' ? `${it.unit_price_stars} ⭐` : `${C.formatSol(it.unit_price_sol)} SOL`,
      delivered_at: it.delivered_at, download_count: it.download_count,
    })),
    chat_id: order.chat_id, dispute_id: order.dispute_id || null, review_id: order.review_id || null,
    created_at: order.created_at, paid_at: order.paid_at, delivered_at: order.delivered_at,
    completed_at: order.completed_at, cancelled_at: order.cancelled_at,
    pay_deadline: order.pay_deadline, delivery_deadline: order.delivery_deadline,
    confirm_deadline: order.confirm_deadline, extend_used: order.extend_used,
    role, actions: orderActions(order, role),
    escrow_account: `escrow:${order.id}:${order.pay_asset}`,
  };
  return dto;
}

export function chatDto(ctx, chat, viewerId) {
  const members = ctx.db.members.get(chat.id) ?? [];
  const messages = ctx.db.messages.get(chat.id) ?? [];
  const mine = members.find((m) => m.user_id === viewerId);
  const unread = messages.filter((m) => m.seq > (mine?.last_read_seq ?? 0) && m.sender_id !== viewerId).length;
  const shop = chat.shop_id ? ctx.db.shops.get(chat.shop_id) : null;
  const peers = members.filter((m) => m.user_id !== viewerId).map((m) => ({
    user_id: m.user_id, role: m.role,
    nickname: m.visible_as || ctx.db.users.get(m.user_id)?.nickname || 'Участник',
    online: ctx.hub.online(m.user_id),
  }));
  let title = chat.title;
  if (chat.kind === 'direct') {
    const other = members.find((m) => m.user_id !== viewerId);
    title = ctx.db.users.get(other?.user_id)?.nickname ?? 'Приватный чат';
  }
  const last = messages[messages.length - 1];
  return {
    id: chat.id, kind: chat.kind, title, shop_id: chat.shop_id || null,
    shop_name: shop?.name ?? null, order_id: chat.order_id || null,
    dispute_id: chat.dispute_id || null, e2ee: !!chat.e2ee, pinned: !!chat.pinned,
    admin_user_id: chat.admin_user_id || null, members: peers, unread,
    last_seq: chat.last_seq, last_message_at: chat.last_message_at ?? null,
    last_preview: chat.e2ee ? '<encrypted>' : (chat.last_preview ?? null),
    last_message_preview: last ? (chat.e2ee ? '<encrypted>' : C.tryDecrypt(C.DOMAINS.message, last.id, last.body_ct) ?? '<encrypted>') : null,
    created_at: chat.created_at, closed_at: chat.closed_at ?? null,
  };
}

export function messageDto(ctx, chat, msg, viewerId) {
  const members = ctx.db.members.get(chat.id) ?? [];
  const mine = members.find((m) => m.user_id === viewerId);
  let sender = msg.sender_visible_as;
  if (chat.kind === 'dispute' && mine?.visible_as && msg.sender_id === viewerId) sender = mine.visible_as;
  const dto = {
    id: msg.id, chat_id: chat.id, seq: msg.seq, type: msg.type,
    sender_id: msg.e2ee ? '' : msg.sender_id, sender_visible_as: sender,
    e2ee: !!msg.e2ee, created_at: msg.created_at, client_msg_id: msg.client_msg_id || null,
    reply_to: msg.reply_to || null,
  };
  if (msg.type === 'system' && msg.system) dto.system = msg.system;
  if (msg.e2ee) {
    dto.body_ct = msg.body_ct;
  } else {
    const isMember = members.some((m) => m.user_id === viewerId);
    dto.body = isMember ? C.tryDecrypt(C.DOMAINS.message, msg.id, msg.body_ct) ?? '<encrypted>' : '<encrypted>';
    dto.body_stored_encrypted = true;
  }
  return dto;
}

export function giftDto(gift) {
  return {
    id: gift.id, sku: gift.sku, title_ru: gift.title_ru, title_en: gift.title_en,
    description: gift.description, rarity: gift.rarity, emoji: gift.emoji,
    media_url: gift.media_url || null, media_kind: gift.media_kind,
    price_stars: gift.price_stars, price_sol: C.formatSol(gift.price_sol),
    boosts_shop: gift.boosts_shop, boost_value: gift.boost_value, boost_days: gift.boost_days,
    collectible: gift.collectible, status: gift.status, sort: gift.sort,
    per_user_limit: gift.per_user_limit || undefined,
  };
}

export function walletDto(ctx, user) {
  const sol = ctx.db.ledger.userBalance(user.id, 'SOL');
  const stars = ctx.db.ledger.userBalance(user.id, 'STARS');
  return {
    balances: [
      { asset: 'SOL', available: C.formatSol(sol), available_raw: sol, locked: '0' },
      { asset: 'STARS', available: stars, locked: 0 },
    ],
    deposit: {
      asset: 'SOL', address: user.deposit_address, path: user.deposit_path,
      min: C.formatSol(Math.round(CONFIG.minDepositSol * C.LAMPORTS_PER_SOL)),
      confirmations_required: CONFIG.confirmations, network: CONFIG.solanaNetwork, memo: null,
    },
    limits: {
      withdraw_daily_sol: String(CONFIG.withdrawDailySol),
      withdraw_four_eyes_sol: String(CONFIG.fourEyesSol),
      withdraw_whitelist_cooling_h: 24,
      ops_totp_threshold_sol: String(CONFIG.opsThresholdSol),
      ops_totp_threshold_stars: CONFIG.opsThresholdStars,
    },
    exchange_rate: { sol_per_star: CONFIG.solStarsRate, stars_per_sol: 1 / CONFIG.solStarsRate, fee_bps: CONFIG.exchangeFeeBps },
    network: CONFIG.solanaNetwork,
  };
}

export function disputeDto(ctx, dispute, viewer) {
  const isArbiter = viewer && (dispute.arbiter_id === viewer.id ||
    ['arbiter', 'moderator', 'superadmin'].includes(viewer.role));
  const youAre = viewer?.id === dispute.seller_id ? 'shop_admin' : isArbiter ? 'arbiter' : 'buyer';
  const reveal = !!isArbiter;
  const yourAlias = youAre === 'shop_admin' ? dispute.seller_alias : dispute.buyer_alias;
  const counterAlias = youAre === 'shop_admin' ? dispute.buyer_alias : dispute.seller_alias;
  const order = ctx.db.orders.get(dispute.order_id);
  const actions = dispute.status === 'in_arbitration'
    ? (youAre === 'arbiter' ? ['resolve', 'request_evidence'] : ['reply', 'attach_evidence'])
    : ['reply', 'attach_evidence', 'escalate'];
  return {
    id: dispute.id, order_id: dispute.order_id, order_number: order?.number, shop_id: dispute.shop_id,
    status: dispute.status, reason_code: dispute.reason_code, chat_id: dispute.chat_id,
    you_are: youAre, your_alias: yourAlias, counterparty_alias: counterAlias, reveal,
    buyer_id: reveal ? dispute.buyer_id : undefined, seller_id: reveal ? dispute.seller_id : undefined,
    arbiter_id: dispute.arbiter_id || undefined,
    participants: [
      { role: 'buyer', visible_as: dispute.buyer_alias, ...(reveal ? { id: dispute.buyer_id, nickname: ctx.db.users.get(dispute.buyer_id)?.nickname } : {}) },
      { role: 'shop_admin', visible_as: dispute.seller_alias, ...(reveal ? { id: dispute.seller_id, nickname: ctx.db.users.get(dispute.seller_id)?.nickname } : {}) },
      ...(dispute.arbiter_id ? [{ role: 'arbiter', visible_as: 'Арбитр', ...(reveal ? { id: dispute.arbiter_id } : {}) }] : []),
    ],
    evidence: dispute.evidence.map((ev) => ({
      id: ev.id, kind: ev.kind, name: ev.name, size: ev.size, sha256: ev.sha256,
      meta_stripped: ev.meta_stripped, created_at: ev.created_at,
      ...(reveal || ev.uploader_id === viewer?.id ? { uploader_id: ev.uploader_id } : {}),
    })),
    timeline: dispute.timeline.map((ev) => ({ ts: ev.ts, kind: ev.kind, actor_visible_as: ev.actor_visible_as, note: ev.note })),
    actions, reply_deadline: dispute.reply_deadline, resolve_deadline: dispute.resolve_deadline,
    created_at: dispute.created_at, description: dispute.description,
    resolution: dispute.resolution || undefined, resolution_reason: dispute.resolution_reason || undefined,
    resolved_at: dispute.resolved_at || undefined,
    masking_notice: `Вы видите вторую сторону как ${counterAlias}. Личные данные скрыты; арбитр видит обе стороны.`,
  };
}

export function reviewDto(ctx, review) {
  const author = ctx.db.users.get(review.author_id);
  return {
    id: review.id, order_id: review.order_id || null, shop_id: review.shop_id,
    product_id: review.product_id || null,
    author: author ? `${author.nickname.slice(0, 1)}***${author.nickname.slice(-1)}` : 'пользователь',
    rating: review.rating, rating_delivery: review.rating_delivery,
    rating_description: review.rating_description, rating_support: review.rating_support,
    body: review.body, is_verified_purchase: review.is_verified_purchase,
    shop_reply: review.shop_reply || null, shop_reply_at: review.shop_reply_at,
    status: review.status, helpful_count: review.helpful_count, created_at: review.created_at,
  };
}

// ---------------------------------------------------------------------------
// Лента: feed_score (docs/economy.md §6.2)
// ---------------------------------------------------------------------------
export function recalcFeedScores(ctx) {
  const shops = [...ctx.db.shops.values()];
  const maxSales = Math.max(1, ...shops.map((s) => s.sales_count));
  const now = Date.now();
  for (const shop of shops) {
    const rating = (shop.rating_bayes ?? 3.8) / 5;
    const sales = shop.sales_count / maxSales;
    const ageDays = Math.max(1, (now - new Date(shop.created_at).getTime()) / 86400000);
    const recency = 1 / (1 + Math.log10(ageDays));
    const sub = ctx.db.subs.get(shop.id);
    const plan = ctx.db.rentPlans.get(sub?.plan_id);
    const rentBoost = plan?.boost ?? 0;
    const response = shop.response_p50_s ? Math.max(0, 1 - shop.response_p50_s / 86400) : 0.5;
    const giftBoost = Math.min(0.6, shop.gift_boost ?? 0);
    const score = 0.30 * rating + 0.20 * sales + 0.15 * recency + 0.15 * rentBoost +
      0.10 * 0.5 + 0.05 * response + 0.05 * giftBoost -
      0.20 * (shop.complaint_penalty ?? 0) - 0.30 * (shop.dispute_loss_penalty ?? 0);
    shop.feed_score = Math.max(0, score);
  }
}

export function paginate(items, limit, cursor) {
  const start = cursor ? Math.max(0, Number(cursor) || 0) : 0;
  const page = items.slice(start, start + limit);
  const next = start + limit < items.length ? String(start + limit) : null;
  return { items: page, next_cursor: next, has_more: next !== null, total: items.length };
}

export function truncate(str, n) {
  const s = String(str ?? '');
  return [...s].length > n ? `${[...s].slice(0, n).join('')}…` : s;
}

export function maskDisputeText(text) {
  let out = String(text ?? '');
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '***@***');
  out = out.replace(/@([A-Za-z0-9_]{4,})/g, '@***');
  out = out.split(' ').map((w) => (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w) ? `${w.slice(0, 4)}…${w.slice(-4)}` : w)).join(' ');
  return out;
}

export { C as crypto };

// Хелперы ответов для роутов: обработчик возвращает {status, body}.
export const ok = (body, status = 200) => ({ status, body });
export const created = (body) => ({ status: 201, body });
