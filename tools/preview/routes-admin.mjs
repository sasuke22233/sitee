// Роуты админ-панели: дашборд, подарки, магазины, санкции, тарифы, споры, заказы,
// модерация, пользователи, финансы, аудит, безопасность, настройки.
// Соответствует docs/api.md §11 и FR-ADM-* / FR-ABF-*.
import * as C from './crypto.mjs';
import {
  CONFIG, bad, conflict, forbidden, notFound, unprocessable,
  ok, created, paginate, truncate, giftDto, shopCard, orderDto, statusTitle, userDto,
  requireAuth, requireRole, requireOps, audit, notify, push, pushMany, clientIp,
  isCrowned, rentStatus, feeBps, recalcFeedScores, rentPlanList, resetRateLimits,
} from './lib.mjs';
import { ACC, demoCredentials } from './data.mjs';
import {
  findShop, transition, canTransition, releaseEscrow, refundEscrow, releaseStock,
  finishOrderStats, orderStatusMessage, recalcDisputeRate, shopAdmins, HOUR,
} from './domain.mjs';

const DAY = 24 * HOUR;
const STAFF = ['superadmin', 'moderator', 'arbiter'];

function staffOnly(ctx, r) {
  const auth = requireRole(ctx, r.req, ...STAFF);
  return auth;
}

function superOnly(ctx, r) {
  return requireRole(ctx, r.req, 'superadmin');
}

export function adminRoutes(ctx) {
  const routes = [];

  // Демо-доступ для preview (в Go-бэкенде креды печатаются в лог при ENV=dev).
  routes.push(['GET', '/api/v1/dev/credentials', () => {
    if (CONFIG.env === 'prod') throw forbidden('FORBIDDEN', 'эндпоинт отключён в prod');
    return ok({
      notice: 'Учётные данные демо-стенда. В prod не выдаются: 2FA-секреты показываются один раз при активации.',
      users: demoCredentials(ctx.db),
      totp_hint: 'Коды TOTP меняются каждые 30 секунд; для входа используйте backup-коды из поля backup_login.',
    });
  }, { rate: 'public' }]);

  // Сброс демо-состояния защитных счётчиков (dev/stage only) — для повторяемых прогонов.
  routes.push(['POST', '/api/v1/dev/reset-guards', () => {
    if (CONFIG.env === 'prod') throw forbidden('FORBIDDEN', 'эндпоинт отключён в prod');
    ctx.guards.clear();
    resetRateLimits();
    ctx.db.authEvents.length = 0;
    ctx.db.securityEvents.length = 0;
    return ok({ status: 'ok', guards: 0, note: 'счётчики анти-брутфорса и rate-limit обнулены' });
  }, { rate: 'public' }]);

  routes.push(['GET', '/api/v1/admin/dashboard', (r) => {
    const auth = staffOnly(ctx, r);
    const orders = [...ctx.db.orders.values()];
    const disputes = [...ctx.db.disputes.values()];
    const shops = [...ctx.db.shops.values()];
    const now = Date.now();
    const last24 = (ts) => ts && now - new Date(ts).getTime() < DAY;
    const escrowSol = [...ctx.db.ledger.accounts.keys()]
      .filter((k) => k.startsWith('escrow:') && k.endsWith(':SOL'))
      .reduce((a, k) => a + ctx.db.ledger.accounts.get(k).balance, 0);
    const escrowStars = [...ctx.db.ledger.accounts.keys()]
      .filter((k) => k.startsWith('escrow:') && k.endsWith(':STARS'))
      .reduce((a, k) => a + ctx.db.ledger.accounts.get(k).balance, 0);
    return ok({
      generated_at: new Date().toISOString(),
      role: auth.user.role,
      counts: {
        users: ctx.db.users.size, shops: shops.size, products: ctx.db.products.size,
        orders: orders.length, disputes: disputes.length, chats: ctx.db.chats.size,
        gifts: ctx.db.gifts.size, reviews: ctx.db.reviews.size,
      },
      orders_24h: orders.filter((o) => last24(o.created_at)).length,
      orders_by_status: orders.reduce((acc, o) => ({ ...acc, [o.status]: (acc[o.status] ?? 0) + 1 }), {}),
      gmv: {
        sol: C.formatSol(orders.reduce((a, o) => a + o.total_sol, 0)),
        stars: orders.reduce((a, o) => a + o.total_stars, 0),
        fees_sol: C.formatSol(orders.reduce((a, o) => a + o.fee_sol, 0)),
        fees_stars: orders.reduce((a, o) => a + o.fee_stars, 0),
        rent_sol: C.formatSol(ctx.db.ledger.balance(ACC.platform('rent', 'SOL'))),
      },
      escrow: { sol: C.formatSol(escrowSol), stars: escrowStars },
      balances: {
        custody_sol: C.formatSol(ctx.db.ledger.balance(ACC.platform('custody', 'SOL'))),
        fees_sol: C.formatSol(ctx.db.ledger.balance(ACC.platform('fees', 'SOL'))),
        fees_stars: ctx.db.ledger.balance(ACC.platform('fees', 'STARS')),
        stars_reserve: ctx.db.ledger.balance(ACC.platform('stars_reserve', 'STARS')),
        withdrawals_pending_sol: C.formatSol(ctx.db.ledger.balance(ACC.platform('withdrawals_pending', 'SOL'))),
        gift_revenue_stars: ctx.db.ledger.balance(ACC.platform('gift_revenue', 'STARS')),
      },
      disputes_open: disputes.filter((d) => ['open', 'awaiting_reply', 'in_arbitration'].includes(d.status)).length,
      disputes_sla_breach: disputes.filter((d) => d.status === 'in_arbitration' && d.resolve_deadline &&
        new Date(d.resolve_deadline) < new Date()).length,
      rent: {
        active: [...ctx.db.subs.values()].filter((s) => s.status === 'active').length,
        expiring: [...ctx.db.subs.values()].filter((s) => s.status === 'expiring').length,
        grace: [...ctx.db.subs.values()].filter((s) => s.status === 'grace').length,
        suspended: [...ctx.db.subs.values()].filter((s) => s.status === 'suspended').length,
      },
      security: {
        auth_events_24h: ctx.db.authEvents.filter((e) => last24(e.ts)).length,
        failed_logins_24h: ctx.db.authEvents.filter((e) => last24(e.ts) && e.event === 'login_failed').length,
        ip_bans: ctx.db.ipBans?.size ?? 0,
        ws_connections: ctx.hub.count(),
        audit_records: ctx.db.audit.length,
      },
      moderation_queue: [...ctx.db.products.values()].filter((p) => p.status === 'pending_moderation').length,
      top_shops: shops.slice().sort((a, b) => b.sales_count - a.sales_count).slice(0, 5)
        .map((s) => ({ id: s.id, name: s.name, sales: s.sales_count, rating: Number(s.rating_bayes.toFixed(2)), crown: isCrowned(ctx, s) })),
      alerts: buildAlerts(ctx),
    });
  }, { rate: 'admin' }]);

  // ------------------------------------------------------------------
  // Подарки (FR-ADM-04…07)
  // ------------------------------------------------------------------
  routes.push(['GET', '/api/v1/admin/gifts', (r) => {
    staffOnly(ctx, r);
    const items = [...ctx.db.gifts.values()].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)).map((g) => ({
      ...giftDto(g),
      purchases: [...ctx.db.giftPurchases.values()].filter((p) => p.gift_id === g.id).length,
      revenue_stars: [...ctx.db.giftPurchases.values()]
        .filter((p) => p.gift_id === g.id && p.asset === 'STARS').reduce((a, p) => a + p.amount, 0),
      revenue_sol: C.formatSol([...ctx.db.giftPurchases.values()]
        .filter((p) => p.gift_id === g.id && p.asset === 'SOL').reduce((a, p) => a + p.amount, 0)),
      created_at: g.created_at, updated_at: g.updated_at,
    }));
    return ok({ items, total: items.length });
  }, { rate: 'admin' }]);

  routes.push(['POST', '/api/v1/admin/gifts', (r) => {
    const auth = staffOnly(ctx, r);
    const b = r.body ?? {};
    requireOps(ctx, r.req, auth, 'admin_write', { totpCode: String(b.totp_code ?? '') });
    const sku = String(b.sku ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{3,40}$/.test(sku)) throw bad('sku: 3–40 символов (латиница, цифры, -, _)');
    if ([...ctx.db.gifts.values()].some((g) => g.sku === sku)) throw conflict('SKU_TAKEN', 'такой sku уже используется');
    const titleRu = truncate(String(b.title_ru ?? ''), 60);
    if (titleRu.length < 2) throw bad('title_ru обязателен');
    const priceStars = Math.max(0, Number(b.price_stars ?? 0));
    const priceSol = C.parseSol(String(b.price_sol ?? '0'));
    if (priceStars <= 0 && priceSol <= 0) throw bad('укажите цену в Stars или SOL');
    const rarity = String(b.rarity ?? 'common');
    if (!['common', 'rare', 'epic', 'legendary'].includes(rarity)) throw bad('rarity: common, rare, epic или legendary');
    const id = C.newId('gft');
    const now = new Date().toISOString();
    const gift = {
      id, sku, title_ru: titleRu, title_en: truncate(String(b.title_en ?? ''), 60),
      description: truncate(String(b.description ?? ''), 500), rarity,
      emoji: String(b.emoji ?? '🎁'), media_url: String(b.media_url ?? ''),
      media_kind: String(b.media_kind ?? (b.media_url ? 'image' : 'emoji')),
      price_stars: priceStars, price_sol: priceSol, per_user_limit: Math.max(0, Number(b.per_user_limit ?? 0)),
      boosts_shop: !!b.boosts_shop, boost_value: Number(b.boost_value ?? 0), boost_days: Math.min(14, Math.max(0, Number(b.boost_days ?? 0))),
      collectible: !!b.collectible, status: String(b.status ?? 'published'),
      sort: Number(b.sort ?? ctx.db.gifts.size + 1), created_by: auth.user.id,
      created_at: now, updated_at: now,
    };
    if (gift.boosts_shop && (gift.boost_value <= 0 || gift.boost_days <= 0)) {
      throw bad('для буста укажите boost_value (≤0.6) и boost_days (≤14)');
    }
    ctx.db.gifts.set(id, gift);
    audit(ctx, r.req, auth.user, 'admin.gift_create', 'gift', id, '', 'ops', null,
      { sku, title_ru: titleRu, price_stars: priceStars, price_sol: priceSol, rarity });
    return created(giftDto(gift));
  }, { rate: 'admin' }]);

  routes.push(['PATCH', '/api/v1/admin/gifts/:id', (r) => {
    const auth = staffOnly(ctx, r);
    const gift = ctx.db.gifts.get(r.params.id);
    if (!gift) throw notFound('подарок не найден');
    requireOps(ctx, r.req, auth, 'admin_write', { totpCode: String(r.body?.totp_code ?? '') });
    const b = r.body ?? {};
    const before = { title_ru: gift.title_ru, price_stars: gift.price_stars, price_sol: gift.price_sol, status: gift.status };
    if (b.title_ru !== undefined) gift.title_ru = truncate(String(b.title_ru), 60);
    if (b.title_en !== undefined) gift.title_en = truncate(String(b.title_en), 60);
    if (b.description !== undefined) gift.description = truncate(String(b.description), 500);
    if (b.rarity !== undefined) {
      if (!['common', 'rare', 'epic', 'legendary'].includes(b.rarity)) throw bad('некорректная редкость');
      gift.rarity = b.rarity;
    }
    if (b.emoji !== undefined) gift.emoji = String(b.emoji).slice(0, 8);
    if (b.media_url !== undefined) gift.media_url = String(b.media_url);
    if (b.media_kind !== undefined) gift.media_kind = String(b.media_kind);
    if (b.price_stars !== undefined) gift.price_stars = Math.max(0, Number(b.price_stars));
    if (b.price_sol !== undefined) gift.price_sol = C.parseSol(String(b.price_sol));
    if (b.per_user_limit !== undefined) gift.per_user_limit = Math.max(0, Number(b.per_user_limit));
    if (b.boosts_shop !== undefined) gift.boosts_shop = !!b.boosts_shop;
    if (b.boost_value !== undefined) gift.boost_value = Math.max(0, Number(b.boost_value));
    if (b.boost_days !== undefined) gift.boost_days = Math.min(14, Math.max(0, Number(b.boost_days)));
    if (b.collectible !== undefined) gift.collectible = !!b.collectible;
    if (b.status !== undefined) {
      if (!['published', 'draft', 'archived'].includes(b.status)) throw bad('status: published, draft или archived');
      gift.status = b.status;
    }
    if (b.sort !== undefined) gift.sort = Number(b.sort);
    gift.updated_at = new Date().toISOString();
    audit(ctx, r.req, auth.user, 'admin.gift_update', 'gift', gift.id, '', 'ops', before,
      { title_ru: gift.title_ru, price_stars: gift.price_stars, price_sol: gift.price_sol, status: gift.status });
    return ok(giftDto(gift));
  }, { rate: 'admin' }]);

  routes.push(['DELETE', '/api/v1/admin/gifts/:id', (r) => {
    const auth = staffOnly(ctx, r);
    const gift = ctx.db.gifts.get(r.params.id);
    if (!gift) throw notFound('подарок не найден');
    requireOps(ctx, r.req, auth, 'admin_write', { totpCode: String(r.query.totp_code ?? '') });
    gift.status = 'archived';
    gift.updated_at = new Date().toISOString();
    audit(ctx, r.req, auth.user, 'admin.gift_archive', 'gift', gift.id, 'архивация', 'ops',
      { status: 'published' }, { status: 'archived' });
    return ok({ id: gift.id, status: 'archived' });
  }, { rate: 'admin' }]);

  // ------------------------------------------------------------------
  // Магазины, санкции, верификация, аренда (FR-ADM-08…12)
  // ------------------------------------------------------------------
  routes.push(['GET', '/api/v1/admin/shops', (r) => {
    staffOnly(ctx, r);
    const q = String(r.query.q ?? '').trim().toLowerCase();
    const status = String(r.query.status ?? '');
    const rent = String(r.query.rent ?? '');
    const limit = Math.min(100, Math.max(1, Number(r.query.limit ?? 30)));
    let items = [...ctx.db.shops.values()];
    if (q) items = items.filter((s) => `${s.name} ${s.slug}`.toLowerCase().includes(q));
    if (status) items = items.filter((s) => s.status === status);
    if (rent) items = items.filter((s) => rentStatus(ctx, s.id) === rent);
    items.sort((a, b) => b.feed_score - a.feed_score);
    const page = paginate(items.map((s) => ({
      ...shopCard(ctx, s, ''),
      admin_user_id: s.admin_user_id,
      admin_nickname: ctx.db.users.get(s.admin_user_id)?.nickname ?? '',
      sanction_level: s.sanction_level, is_verified: s.is_verified,
      revenue_sol: C.formatSol(s.sales_volume_sol ?? 0),
      dispute_rate: Number((s.dispute_rate ?? 0).toFixed(3)),
      gift_boost: s.gift_boost ?? 0, gift_boost_until: s.gift_boost_until ?? null,
      period_end: ctx.db.subs.get(s.id)?.period_end ?? null,
    })), limit, r.query.cursor);
    return ok({ ...page, statuses: ['active', 'suspended', 'banned'], rent_statuses: ['trial', 'active', 'expiring', 'grace', 'suspended'] });
  }, { rate: 'admin' }]);

  routes.push(['POST', '/api/v1/admin/shops/:id/sanction', (r) => {
    const auth = staffOnly(ctx, r);
    const shop = findShop(ctx, r.params.id);
    if (!shop) throw notFound('магазин не найден');
    const b = r.body ?? {};
    const level = String(b.level ?? 'none');
    if (!['none', 'warning', 'shadow_ban', 'suspend', 'ban'].includes(level)) {
      throw bad('level: none, warning, shadow_ban, suspend или ban');
    }
    const reason = truncate(String(b.reason ?? ''), 500);
    if (level !== 'none' && reason.length < 5) throw bad('укажите причину санкции');
    requireOps(ctx, r.req, auth, 'sanction', { totpCode: String(b.totp_code ?? '') });
    const before = { sanction_level: shop.sanction_level, status: shop.status, complaint_penalty: shop.complaint_penalty };
    shop.sanction_level = level;
    shop.complaint_penalty = level === 'warning' ? 0.1 : level === 'shadow_ban' ? 0.4 : level === 'none' ? 0 : shop.complaint_penalty;
    if (level === 'suspend' || level === 'ban') shop.status = 'suspended';
    else if (shop.status === 'suspended' && rentStatus(ctx, shop.id) !== 'suspended') shop.status = 'active';
    shop.updated_at = new Date().toISOString();
    recalcFeedScores(ctx);
    audit(ctx, r.req, auth.user, 'admin.shop_sanction', 'shop', shop.id, reason, 'ops', before,
      { sanction_level: level, status: shop.status });
    notify(ctx, shop.admin_user_id, 'shop_sanction', 'Санкция применена к магазину',
      `${shop.name}: ${sanctionLabel(level)}. ${reason}`, `sanction:${shop.id}:${level}:${Date.now()}`,
      { shop_id: shop.id, level });
    push(ctx, shop.admin_user_id, 'shop.sanction', { shop_id: shop.id, level, reason });
    for (const userId of shopAdmins(ctx, shop.id)) {
      push(ctx, userId, 'shop.sanction', { shop_id: shop.id, level, reason });
    }
    return ok({ id: shop.id, sanction_level: level, status: shop.status, crown: isCrowned(ctx, shop), feed_score: Number(shop.feed_score.toFixed(4)) });
  }, { rate: 'admin' }]);

  routes.push(['POST', '/api/v1/admin/shops/:id/verified', (r) => {
    const auth = staffOnly(ctx, r);
    const shop = findShop(ctx, r.params.id);
    if (!shop) throw notFound('магазин не найден');
    const value = !!r.body?.verified;
    requireOps(ctx, r.req, auth, 'admin_write', { totpCode: String(r.body?.totp_code ?? '') });
    if (value && shop.rating_count < 5) throw unprocessable('NOT_ENOUGH_REVIEWS', 'верификация доступна при 5+ отзывах');
    const before = { is_verified: shop.is_verified };
    shop.is_verified = value;
    shop.updated_at = new Date().toISOString();
    audit(ctx, r.req, auth.user, 'admin.shop_verified', 'shop', shop.id, value ? 'верификация' : 'снятие верификации', 'ops',
      before, { is_verified: value });
    notify(ctx, shop.admin_user_id, 'shop_verified', value ? 'Магазин верифицирован' : 'Верификация снята',
      `${shop.name}: ${value ? 'значок подтверждения включён' : 'значок подтверждения снят'}`,
      `verified:${shop.id}:${value}:${Date.now()}`);
    return ok({ id: shop.id, is_verified: value });
  }, { rate: 'admin' }]);

  routes.push(['POST', '/api/v1/admin/shops/:id/rent/extend', (r) => {
    const auth = staffOnly(ctx, r);
    const shop = findShop(ctx, r.params.id);
    if (!shop) throw notFound('магазин не найден');
    const days = Math.max(1, Math.min(365, Number(r.body?.days ?? 30)));
    requireOps(ctx, r.req, auth, 'admin_write', { totpCode: String(r.body?.totp_code ?? '') });
    const sub = ctx.db.subs.get(shop.id);
    if (!sub) throw notFound('подписка магазина не найдена');
    const base = sub.period_end && new Date(sub.period_end) > new Date() ? new Date(sub.period_end).getTime() : Date.now();
    const before = { status: sub.status, period_end: sub.period_end };
    sub.period_end = new Date(base + days * DAY).toISOString();
    sub.status = 'active';
    sub.grace_end = null;
    sub.updated_at = new Date().toISOString();
    shop.status = 'active';
    recalcFeedScores(ctx);
    audit(ctx, r.req, auth.user, 'admin.rent_extend', 'shop', shop.id, `+${days} дн.`, 'ops', before,
      { status: sub.status, period_end: sub.period_end });
    notify(ctx, shop.admin_user_id, 'rent_extended', 'Аренда продлена администрацией',
      `${shop.name}: +${days} дн., до ${new Date(sub.period_end).toLocaleDateString('ru-RU')}`,
      `rent:${shop.id}:admin:${sub.period_end}`);
    push(ctx, shop.admin_user_id, 'rent.updated', { shop_id: shop.id, status: 'active', period_end: sub.period_end });
    return ok({ id: shop.id, status: sub.status, period_end: sub.period_end, days_added: days });
  }, { rate: 'admin' }]);

  routes.push(['GET', '/api/v1/admin/rent/plans', (r) => {
    staffOnly(ctx, r);
    return ok({
      items: rentPlanList(ctx).map((p) => ({
        ...p, price_sol: C.formatSol(p.price_sol), price_sol_raw: p.price_sol,
        subscribers: [...ctx.db.subs.values()].filter((s) => s.plan_id === p.id).length,
      })),
    });
  }, { rate: 'admin' }]);

  routes.push(['PATCH', '/api/v1/admin/rent/plans/:id', (r) => {
    const auth = superOnly(ctx, r);
    const plan = ctx.db.rentPlans.get(r.params.id);
    if (!plan) throw notFound('тариф не найден');
    requireOps(ctx, r.req, auth, 'admin_write', { totpCode: String(r.body?.totp_code ?? '') });
    const b = r.body ?? {};
    const before = { price_sol: plan.price_sol, price_stars: plan.price_stars, fee_bps: plan.fee_bps, crown: plan.crown };
    if (b.name_ru !== undefined) plan.name_ru = truncate(String(b.name_ru), 40);
    if (b.description !== undefined) plan.description = truncate(String(b.description), 300);
    if (b.price_sol !== undefined) plan.price_sol = C.parseSol(String(b.price_sol));
    if (b.price_stars !== undefined) plan.price_stars = Math.max(0, Number(b.price_stars));
    if (b.fee_bps !== undefined) {
      const fee = Number(b.fee_bps);
      if (!Number.isInteger(fee) || fee < 0 || fee > 5000) throw bad('fee_bps: 0…5000');
      plan.fee_bps = fee;
    }
    if (b.boost !== undefined) plan.boost = Math.max(0, Number(b.boost));
    if (b.crown !== undefined) plan.crown = !!b.crown;
    if (b.verified !== undefined) plan.verified = !!b.verified;
    if (b.max_products !== undefined) plan.max_products = Math.max(1, Number(b.max_products));
    if (b.active !== undefined) plan.active = !!b.active;
    audit(ctx, r.req, auth.user, 'admin.rent_plan_update', 'rent_plan', plan.id, '', 'ops', before,
      { price_sol: plan.price_sol, price_stars: plan.price_stars, fee_bps: plan.fee_bps, crown: plan.crown });
    recalcFeedScores(ctx);
    return ok({ ...plan, price_sol: C.formatSol(plan.price_sol), price_sol_raw: plan.price_sol });
  }, { rate: 'admin' }]);

  // ------------------------------------------------------------------
  // Споры и заказы
  // ------------------------------------------------------------------
  routes.push(['GET', '/api/v1/admin/disputes', (r) => {
    staffOnly(ctx, r);
    const status = String(r.query.status ?? '');
    const limit = Math.min(100, Math.max(1, Number(r.query.limit ?? 30)));
    let items = [...ctx.db.disputes.values()];
    if (status) items = items.filter((d) => d.status === status);
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const page = paginate(items.map((d) => {
      const order = ctx.db.orders.get(d.order_id);
      return {
        id: d.id, order_id: d.order_id, order_number: order?.number ?? '',
        shop_id: d.shop_id, shop_name: ctx.db.shops.get(d.shop_id)?.name ?? '',
        status: d.status, reason_code: d.reason_code, arbiter_id: d.arbiter_id || null,
        arbiter_nickname: d.arbiter_id ? ctx.db.users.get(d.arbiter_id)?.nickname ?? '' : null,
        buyer_id: d.buyer_id, seller_id: d.seller_id,
        amount: order ? (order.pay_asset === 'STARS' ? `${order.total_stars} ⭐` : `${C.formatSol(order.total_sol)} SOL`) : '',
        evidence_count: d.evidence.length, created_at: d.created_at,
        reply_deadline: d.reply_deadline, resolve_deadline: d.resolve_deadline,
        sla_breach: d.status === 'in_arbitration' && d.resolve_deadline && new Date(d.resolve_deadline) < new Date(),
        resolution: d.resolution || null,
      };
    }), limit, r.query.cursor);
    return ok({ ...page, statuses: ['open', 'awaiting_reply', 'in_arbitration', 'resolved', 'dismissed', 'closed'] });
  }, { rate: 'admin' }]);

  routes.push(['POST', '/api/v1/admin/disputes/:id/assign', (r) => {
    const auth = staffOnly(ctx, r);
    const dispute = ctx.db.disputes.get(r.params.id);
    if (!dispute) throw notFound('спор не найден');
    const arbiterId = String(r.body?.arbiter_id ?? '');
    const arbiter = ctx.db.users.get(arbiterId);
    if (!arbiter || !STAFF.includes(arbiter.role)) throw bad('арбитр не найден или не имеет роли арбитра');
    if ([arbiterId].includes(dispute.buyer_id) || arbiterId === dispute.seller_id) {
      throw conflict('CONFLICT_OF_INTEREST', 'арбитр не может быть стороной спора');
    }
    requireOps(ctx, r.req, auth, 'admin_write', { totpCode: String(r.body?.totp_code ?? '') });
    const before = { arbiter_id: dispute.arbiter_id, status: dispute.status };
    dispute.arbiter_id = arbiterId;
    dispute.assigned_at = new Date().toISOString();
    if (dispute.status === 'open' || dispute.status === 'awaiting_reply') {
      dispute.status = 'in_arbitration';
      dispute.resolve_deadline = new Date(Date.now() + 7 * DAY).toISOString();
    }
    dispute.updated_at = new Date().toISOString();
    dispute.timeline.push({
      ts: dispute.assigned_at, kind: 'assigned', actor_id: auth.user.id, actor_visible_as: 'Администратор',
      note: `назначен арбитр ${arbiter.nickname}`,
    });
    const order = ctx.db.orders.get(dispute.order_id);
    if (order && canTransition(order.status, 'in_arbitration')) {
      transition(ctx, order, 'in_arbitration', 'admin', 'назначен арбитр', auth.user.id);
    }
    audit(ctx, r.req, auth.user, 'admin.dispute_assign', 'dispute', dispute.id, '', 'ops', before,
      { arbiter_id: arbiterId, status: dispute.status });
    notify(ctx, arbiterId, 'dispute_assigned', 'Назначен спор',
      `Заказ ${order?.number ?? dispute.order_id}: решение в течение 7 дней.`, `dispute:${dispute.id}:assigned:${arbiterId}`,
      { dispute_id: dispute.id });
    push(ctx, arbiterId, 'dispute.new', { dispute_id: dispute.id, status: dispute.status });
    for (const userId of [dispute.buyer_id, dispute.seller_id]) {
      push(ctx, userId, 'dispute.updated', { dispute_id: dispute.id, status: dispute.status });
    }
    return ok({ id: dispute.id, arbiter_id: arbiterId, status: dispute.status, resolve_deadline: dispute.resolve_deadline });
  }, { rate: 'admin' }]);

  routes.push(['GET', '/api/v1/admin/orders', (r) => {
    staffOnly(ctx, r);
    const status = String(r.query.status ?? '');
    const q = String(r.query.q ?? '').trim().toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(r.query.limit ?? 30)));
    let items = [...ctx.db.orders.values()];
    if (status) items = items.filter((o) => o.status === status);
    if (q) items = items.filter((o) => `${o.number} ${o.id}`.toLowerCase().includes(q));
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const page = paginate(items.map((o) => ({
      id: o.id, number: o.number, status: o.status, status_title: statusTitle(o.status),
      shop_id: o.shop_id, shop_name: ctx.db.shops.get(o.shop_id)?.name ?? '',
      buyer_id: o.buyer_id, buyer_nickname: ctx.db.users.get(o.buyer_id)?.nickname ?? '',
      pay_asset: o.pay_asset,
      total: o.pay_asset === 'STARS' ? `${o.total_stars} ⭐` : `${C.formatSol(o.total_sol)} SOL`,
      fee_bps: o.fee_bps, dispute_id: o.dispute_id || null, created_at: o.created_at,
      paid_at: o.paid_at, completed_at: o.completed_at,
      escrow: o.pay_asset === 'STARS'
        ? ctx.db.ledger.balance(ACC.escrow(o.id, 'STARS'))
        : C.formatSol(ctx.db.ledger.balance(ACC.escrow(o.id, 'SOL'))),
    })), limit, r.query.cursor);
    return ok(page);
  }, { rate: 'admin' }]);

  routes.push(['PATCH', '/api/v1/admin/orders/:id/status', (r) => {
    const auth = staffOnly(ctx, r);
    const order = ctx.db.orders.get(r.params.id) ?? ctx.db.orders.get(ctx.db.ordersByNumber.get(r.params.id));
    if (!order) throw notFound('заказ не найден');
    const to = String(r.body?.status ?? '');
    const reason = truncate(String(r.body?.reason ?? ''), 500);
    if (!['created', 'awaiting_payment', 'paid_escrow', 'processing', 'delivered', 'completed',
      'dispute_opened', 'in_arbitration', 'refunded', 'cancelled', 'expired'].includes(to)) {
      throw bad('некорректный статус');
    }
    if (!canTransition(order.status, to)) throw conflict('INVALID_TRANSITION', `${order.status} → ${to} недопустим`);
    if (reason.length < 5) throw bad('укажите причину вмешательства');
    requireOps(ctx, r.req, auth, 'admin_write', { totpCode: String(r.body?.totp_code ?? '') });
    const from = order.status;
    let txId = '';
    if (to === 'refunded') {
      const res = refundEscrow(ctx, order, 0, auth.user.id);
      txId = res.tx_id;
      order.refunded_at = new Date().toISOString();
    } else if (to === 'completed' && from !== 'completed') {
      txId = releaseEscrow(ctx, order, auth.user.id);
      order.completed_at = new Date().toISOString();
      order.confirm_deadline = null;
      finishOrderStats(ctx, order);
    } else if (to === 'cancelled' || to === 'expired') {
      releaseStock(ctx, order);
      order.cancelled_at = new Date().toISOString();
      if (order.paid_at) {
        const res = refundEscrow(ctx, order, 0, auth.user.id);
        txId = res.tx_id;
      }
    }
    transition(ctx, order, to, 'admin', reason, auth.user.id);
    orderStatusMessage(ctx, order, `Администратор изменил статус: ${statusTitle(to)}. Причина: ${reason}`);
    audit(ctx, r.req, auth.user, 'admin.order_status', 'order', order.id, reason, 'ops', { status: from },
      { status: to, tx_id: txId });
    for (const userId of [order.buyer_id, ...shopAdmins(ctx, order.shop_id)]) {
      notify(ctx, userId, 'order_admin_update', `Заказ ${order.number}: ${statusTitle(to)}`, reason,
        `order:${order.id}:admin:${to}:${Date.now()}`, { order_id: order.id, status: to });
      push(ctx, userId, 'order.status', { order_id: order.id, status: to, status_title: statusTitle(to), admin: true });
      if (txId) push(ctx, userId, 'wallet.updated', { asset: order.pay_asset, tx_id: txId });
    }
    return ok({ id: order.id, status: order.status, status_title: statusTitle(order.status), tx_id: txId || null });
  }, { rate: 'admin' }]);

  // ------------------------------------------------------------------
  // Модерация товаров (FR-ADM-13…15)
  // ------------------------------------------------------------------
  routes.push(['GET', '/api/v1/admin/moderation/products', (r) => {
    staffOnly(ctx, r);
    const status = String(r.query.status ?? 'pending_moderation');
    const limit = Math.min(100, Math.max(1, Number(r.query.limit ?? 30)));
    let items = [...ctx.db.products.values()].filter((p) => (status === 'all' ? true : p.status === status));
    items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const page = paginate(items.map((p) => ({
      id: p.id, title: p.title, kind: p.kind, status: p.status,
      shop_id: p.shop_id, shop_name: ctx.db.shops.get(p.shop_id)?.name ?? '',
      price_sol: C.formatSol(p.price_sol), price_stars: p.price_stars,
      category: ctx.db.categories.get(p.category_id)?.name_ru ?? '',
      restricted: !!ctx.db.categories.get(p.category_id)?.restricted,
      stock_free: (ctx.db.stock.get(p.id) ?? []).filter((i) => i.status === 'free').length,
      moderation_note: p.moderation_note || null, created_at: p.created_at, updated_at: p.updated_at,
    })), limit, r.query.cursor);
    return ok(page);
  }, { rate: 'admin' }]);

  routes.push(['POST', '/api/v1/admin/moderation/products/:id/approve', (r) => {
    const auth = staffOnly(ctx, r);
    const product = ctx.db.products.get(r.params.id);
    if (!product) throw notFound('товар не найден');
    requireOps(ctx, r.req, auth, 'admin_write', { totpCode: String(r.body?.totp_code ?? '') });
    const before = { status: product.status };
    product.status = 'published';
    product.moderation_note = truncate(String(r.body?.note ?? 'одобрено модерацией'), 300);
    product.updated_at = new Date().toISOString();
    recalcFeedScores(ctx);
    audit(ctx, r.req, auth.user, 'admin.product_approve', 'product', product.id, product.moderation_note, 'ops',
      before, { status: product.status });
    const shop = ctx.db.shops.get(product.shop_id);
    notify(ctx, shop.admin_user_id, 'product_approved', 'Товар опубликован',
      `${product.title}: модерация пройдена`, `product:${product.id}:approved`, { product_id: product.id });
    push(ctx, shop.admin_user_id, 'product.moderation', { product_id: product.id, status: 'published' });
    return ok({ id: product.id, status: product.status });
  }, { rate: 'admin' }]);

  routes.push(['POST', '/api/v1/admin/moderation/products/:id/reject', (r) => {
    const auth = staffOnly(ctx, r);
    const product = ctx.db.products.get(r.params.id);
    if (!product) throw notFound('товар не найден');
    const reason = truncate(String(r.body?.reason ?? ''), 500);
    if (reason.length < 5) throw bad('укажите причину отклонения');
    requireOps(ctx, r.req, auth, 'admin_write', { totpCode: String(r.body?.totp_code ?? '') });
    const before = { status: product.status };
    product.status = 'rejected';
    product.moderation_note = reason;
    product.updated_at = new Date().toISOString();
    recalcFeedScores(ctx);
    audit(ctx, r.req, auth.user, 'admin.product_reject', 'product', product.id, reason, 'ops', before,
      { status: product.status });
    const shop = ctx.db.shops.get(product.shop_id);
    notify(ctx, shop.admin_user_id, 'product_rejected', 'Товар отклонён модерацией',
      `${product.title}: ${reason}`, `product:${product.id}:rejected`, { product_id: product.id });
    push(ctx, shop.admin_user_id, 'product.moderation', { product_id: product.id, status: 'rejected', reason });
    return ok({ id: product.id, status: product.status, reason });
  }, { rate: 'admin' }]);

  // ------------------------------------------------------------------
  // Пользователи (FR-ADM-16…18)
  // ------------------------------------------------------------------
  routes.push(['GET', '/api/v1/admin/users', (r) => {
    staffOnly(ctx, r);
    const q = String(r.query.q ?? '').trim().toLowerCase();
    const role = String(r.query.role ?? '');
    const status = String(r.query.status ?? '');
    const limit = Math.min(100, Math.max(1, Number(r.query.limit ?? 30)));
    let items = [...ctx.db.users.values()];
    if (q) items = items.filter((u) => u.nickname.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q));
    if (role) items = items.filter((u) => u.role === role);
    if (status) items = items.filter((u) => u.status === status);
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const page = paginate(items.map((u) => ({
      id: u.id, nickname: u.nickname, role: u.role, status: u.status,
      country: u.country, city: ctx.db.cities.get(u.city_id)?.name_ru ?? '',
      email_masked: `${(u.email ?? '').slice(0, 2)}***@${(u.email ?? '').split('@')[1] ?? ''}`,
      factors: { login: u.factors?.login?.status ?? 'none', ops: u.factors?.ops?.status ?? 'none' },
      balances: {
        sol: C.formatSol(ctx.db.ledger.userBalance(u.id, 'SOL')),
        stars: ctx.db.ledger.userBalance(u.id, 'STARS'),
      },
      risk_score: u.risk_score ?? 0, created_at: u.created_at, last_login_at: u.last_login_at ?? null,
      shops: [...ctx.db.shops.values()].filter((s) => s.admin_user_id === u.id).map((s) => s.name),
      online: ctx.hub.online(u.id),
    })), limit, r.query.cursor);
    return ok({ ...page, roles: ['buyer', 'shop_admin', 'moderator', 'arbiter', 'superadmin'] });
  }, { rate: 'admin' }]);

  routes.push(['PATCH', '/api/v1/admin/users/:id', (r) => {
    const auth = staffOnly(ctx, r);
    const user = ctx.db.users.get(r.params.id);
    if (!user) throw notFound('пользователь не найден');
    const b = r.body ?? {};
    if (user.id === auth.user.id && b.status && b.status !== 'active') {
      throw conflict('SELF_SANCTION', 'нельзя ограничить собственный аккаунт');
    }
    if (b.role !== undefined && auth.user.role !== 'superadmin') {
      throw forbidden('FORBIDDEN', 'смену роли выполняет только супер-админ');
    }
    requireOps(ctx, r.req, auth, 'admin_write', { totpCode: String(b.totp_code ?? '') });
    const reason = truncate(String(b.reason ?? ''), 500);
    const before = { role: user.role, status: user.status, risk_score: user.risk_score };
    if (b.role !== undefined) {
      if (!['buyer', 'shop_admin', 'moderator', 'arbiter', 'superadmin'].includes(b.role)) throw bad('некорректная роль');
      user.role = b.role;
    }
    if (b.status !== undefined) {
      if (!['active', 'restricted', 'suspended', 'banned'].includes(b.status)) throw bad('некорректный статус');
      user.status = b.status;
      if (b.status !== 'active') {
        for (const [id, s] of ctx.db.sessions) {
          if (s.user_id === user.id) {
            s.status = 'revoked';
            ctx.db.sessions.delete(id);
          }
        }
        push(ctx, user.id, 'user.banned', { status: b.status, reason });
      }
    }
    if (b.risk_score !== undefined) user.risk_score = Math.max(0, Math.min(1000, Number(b.risk_score)));
    if (b.warmup_hours !== undefined) {
      user.warmup_until = new Date(Date.now() + Number(b.warmup_hours) * HOUR).toISOString();
    }
    audit(ctx, r.req, auth.user, 'admin.user_update', 'user', user.id, reason || 'изменение профиля', 'ops', before,
      { role: user.role, status: user.status, risk_score: user.risk_score });
    notify(ctx, user.id, 'admin_user_update', 'Изменения аккаунта администрацией',
      reason || `Статус: ${user.status}, роль: ${user.role}`, `admin:user:${user.id}:${Date.now()}`);
    return ok(userDto(ctx, user));
  }, { rate: 'admin' }]);

  // ------------------------------------------------------------------
  // Финансы, аудит, безопасность, настройки
  // ------------------------------------------------------------------
  routes.push(['GET', '/api/v1/admin/finance/reconciliation', (r) => {
    staffOnly(ctx, r);
    const accounts = [...ctx.db.ledger.accounts.values()].map((a) => ({
      id: a.id, owner_type: a.owner_type, owner_id: a.owner_id, asset: a.asset,
      balance: a.asset === 'SOL' ? C.formatSol(a.balance) : a.balance, balance_raw: a.balance, version: a.version,
    }));
    const byAsset = {};
    for (const a of accounts) {
      byAsset[a.asset] ??= { users: 0, shops: 0, escrow: 0, platform: 0 };
      const bucket = a.owner_type === 'user' ? 'users' : a.owner_type === 'shop' ? 'shops' : a.owner_type === 'escrow' ? 'escrow' : 'platform';
      byAsset[a.asset][bucket] += a.balance_raw;
    }
    const custody = ctx.db.ledger.balance(ACC.platform('custody', 'SOL'));
    const liabilities = byAsset.SOL ? byAsset.SOL.users + byAsset.SOL.shops + byAsset.SOL.escrow : 0;
    const breach = custody < liabilities;
    return ok({
      generated_at: new Date().toISOString(),
      entries_total: ctx.db.ledger.entries.length,
      accounts_total: accounts.length,
      summary: {
        SOL: {
          custody: C.formatSol(custody), liabilities: C.formatSol(liabilities),
          delta: C.formatSol(custody - liabilities),
          users: C.formatSol(byAsset.SOL?.users ?? 0), shops: C.formatSol(byAsset.SOL?.shops ?? 0),
          escrow: C.formatSol(byAsset.SOL?.escrow ?? 0), platform: C.formatSol(byAsset.SOL?.platform ?? 0),
          fees: C.formatSol(ctx.db.ledger.balance(ACC.platform('fees', 'SOL'))),
          rent: C.formatSol(ctx.db.ledger.balance(ACC.platform('rent', 'SOL'))),
          withdrawals_pending: C.formatSol(ctx.db.ledger.balance(ACC.platform('withdrawals_pending', 'SOL'))),
        },
        STARS: {
          reserve: ctx.db.ledger.balance(ACC.platform('stars_reserve', 'STARS')),
          users: byAsset.STARS?.users ?? 0, shops: byAsset.STARS?.shops ?? 0,
          escrow: byAsset.STARS?.escrow ?? 0, fees: ctx.db.ledger.balance(ACC.platform('fees', 'STARS')),
          gift_revenue: ctx.db.ledger.balance(ACC.platform('gift_revenue', 'STARS')),
        },
      },
      status: breach ? 'breach' : 'ok',
      breach,
      alert: breach ? 'P1: кастодия меньше обязательств — заморозить выводы, начать расследование (docs/solana.md §6).' : null,
      accounts: accounts.slice(0, 200),
      recent_entries: ctx.db.ledger.entries.slice(-50).reverse().map((e) => ({
        id: e.id, tx_id: e.tx_id, ts: e.ts, account_id: e.account_id, direction: e.direction,
        amount: e.asset === 'SOL' ? C.formatSol(e.amount) : e.amount, asset: e.asset,
        kind: e.kind, ref_type: e.ref_type, ref_id: e.ref_id, idempotency_key: e.idempotency_key,
      })),
    });
  }, { rate: 'admin' }]);

  routes.push(['GET', '/api/v1/admin/audit', (r) => {
    staffOnly(ctx, r);
    const limit = Math.min(200, Math.max(1, Number(r.query.limit ?? 50)));
    const action = String(r.query.action ?? '');
    const actor = String(r.query.actor ?? '');
    let items = ctx.db.audit.slice();
    if (action) items = items.filter((a) => a.action.includes(action));
    if (actor) items = items.filter((a) => a.actor_id === actor || a.actor_role === actor);
    const tail = items.slice(-limit);
    const chainOk = verifyChain(ctx, tail);
    tail.reverse();
    return ok({
      items: tail.map((a) => ({
        id: a.id, ts: a.ts, actor_id: a.actor_id, actor_role: a.actor_role, action: a.action,
        object_type: a.object_type, object_id: a.object_id, reason: a.reason, ip: a.ip,
        totp_factor: a.totp_factor, prev_hash: a.prev_hash, record_hash: a.record_hash,
      })),
      total: items.length, chain_verified: chainOk,
      chain_notice: 'Каждая запись содержит HMAC-хэш предыдущей (hash-chained audit log, docs/security.md §11).',
    });
  }, { rate: 'admin' }]);

  routes.push(['GET', '/api/v1/admin/security/events', (r) => {
    staffOnly(ctx, r);
    const limit = Math.min(200, Math.max(1, Number(r.query.limit ?? 50)));
    const event = String(r.query.event ?? '');
    let items = ctx.db.securityEvents.slice();
    if (event) items = items.filter((e) => e.kind === event);
    return ok({
      items: items.slice(-limit).reverse(),
      total: items.length,
      guards: [...ctx.guards.entries()].map(([key, g]) => ({ key, fails: g.fails, captcha: !!g.captcha, blocked_until: g.until || g.hard || null })),
      ip_bans: [...(ctx.db.ipBans ?? new Map()).values()],
      kinds: ['rate_limit', 'login_failed', '2fa_failed', 'fraud', 'ws_abuse', 'ip_ban', 'captcha'],
    });
  }, { rate: 'admin' }]);

  routes.push(['POST', '/api/v1/admin/security/ip-ban', (r) => {
    const auth = staffOnly(ctx, r);
    const ip = String(r.body?.ip ?? '').trim();
    if (!ip) throw bad('укажите ip');
    const hours = Math.max(1, Math.min(24 * 30, Number(r.body?.hours ?? 24)));
    const reason = truncate(String(r.body?.reason ?? ''), 300);
    if (reason.length < 5) throw bad('укажите причину блокировки');
    requireOps(ctx, r.req, auth, 'admin_write', { totpCode: String(r.body?.totp_code ?? '') });
    ctx.db.ipBans ??= new Map();
    const until = new Date(Date.now() + hours * HOUR).toISOString();
    ctx.db.ipBans.set(ip, { ip, until, reason, created_by: auth.user.id, created_at: new Date().toISOString() });
    ctx.securityEvent('ip_ban', { ip, hours, reason }, 900);
    audit(ctx, r.req, auth.user, 'admin.ip_ban', 'ip', ip, reason, 'ops', null, { until, hours });
    return created({ ip, until, reason, hours });
  }, { rate: 'admin' }]);

  routes.push(['GET', '/api/v1/admin/settings', (r) => {
    staffOnly(ctx, r);
    return ok({
      items: [...ctx.db.settings.entries()].map(([key, value]) => ({ key, value })),
      schema: {
        registration_open: 'bool', rent_trial_days: 'int', max_shops_per_account: 'int',
        default_fee_bps: 'int', gift_boost_max: 'float', promoted_slots_per_page: 'int',
        maintenance_mode: 'bool', withdrawals_frozen: 'bool',
      },
    });
  }, { rate: 'admin' }]);

  routes.push(['PATCH', '/api/v1/admin/settings/:key', (r) => {
    const auth = superOnly(ctx, r);
    const key = r.params.key;
    if (!ctx.db.settings.has(key)) throw notFound('настройка не найдена');
    const b = r.body ?? {};
    if (b.value === undefined) throw bad('передайте value');
    requireOps(ctx, r.req, auth, 'admin_write', { totpCode: String(b.totp_code ?? '') });
    const before = ctx.db.settings.get(key);
    let value = b.value;
    if (typeof before === 'boolean') value = !!value;
    else if (typeof before === 'number') {
      value = Number(value);
      if (!Number.isFinite(value)) throw bad('значение должно быть числом');
    } else value = String(value);
    ctx.db.settings.set(key, value);
    recalcFeedScores(ctx);
    audit(ctx, r.req, auth.user, 'admin.setting', 'setting', key, String(b.reason ?? ''), 'ops',
      { value: before }, { value });
    if (key === 'maintenance_mode' && value) {
      for (const user of ctx.db.users.values()) push(ctx, user.id, 'system.maintenance', { enabled: true });
    }
    return ok({ key, value, previous: before });
  }, { rate: 'admin' }]);

  return routes;
}

function verifyChain(ctx, tail) {
  // Проверка непрерывности цепочки хэшей на выборке.
  for (let i = 1; i < tail.length; i += 1) {
    if (tail[i].prev_hash !== tail[i - 1].record_hash) return false;
  }
  return true;
}

function buildAlerts(ctx) {
  const alerts = [];
  const breaches = [...ctx.db.disputes.values()]
    .filter((d) => d.status === 'in_arbitration' && d.resolve_deadline && new Date(d.resolve_deadline) < new Date());
  if (breaches.length) {
    alerts.push({ level: 'P2', kind: 'dispute_sla', message: `Просрочено решение арбитра: ${breaches.length}`, ids: breaches.map((d) => d.id) });
  }
  const suspended = [...ctx.db.subs.values()].filter((s) => s.status === 'suspended');
  if (suspended.length) {
    alerts.push({ level: 'P3', kind: 'rent_suspended', message: `Магазинов с приостановленной арендой: ${suspended.length}`, ids: suspended.map((s) => s.shop_id) });
  }
  const pendingWithdrawals = [...ctx.db.withdrawals.values()].filter((w) => w.status === 'pending_approval');
  if (pendingWithdrawals.length) {
    alerts.push({
      level: 'P2', kind: 'four_eyes', message: `Заявок на вывод требуют второго подтверждения: ${pendingWithdrawals.length}`,
      ids: pendingWithdrawals.map((w) => w.id),
    });
  }
  const failed = ctx.db.authEvents.filter((e) => e.event === 'login_failed' && Date.now() - new Date(e.ts).getTime() < HOUR).length;
  if (failed >= 10) {
    alerts.push({ level: 'P1', kind: 'brute_force', message: `Попыток входа с неверным паролем за час: ${failed}`, ids: [] });
  }
  return alerts;
}

function sanctionLabel(level) {
  return {
    none: 'санкция снята', warning: 'предупреждение (понижение в ленте)',
    shadow_ban: 'теневой бан (магазин не виден в ленте)', suspend: 'приостановка магазина',
    ban: 'блокировка магазина',
  }[level] ?? level;
}
