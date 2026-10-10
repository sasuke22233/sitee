// Роуты: лента магазинов, магазин, аренда, товары, сток, отзывы.
// Соответствует docs/api.md §4–6 и FR-FEED / FR-SHOP / FR-PROD / FR-REV.
import * as C from './crypto.mjs';
import {
  CONFIG, bad, conflict, forbidden, notFound, unprocessable,
  ok, created, paginate, truncate,
  requireAuth, requireOps, audit, notify, push,
  shopCard, shopDetail, productDto, isCrowned, rentStatus, feeBps, recalcFeedScores, rentPlanList,
} from './lib.mjs';
import {
  findShop, planByCode, shopCount, ensureShopChannel, addMember, systemMessage,
  recalcRating, reviewSummary, broadcastMessage, HOUR,
} from './domain.mjs';
import { reviewDto } from './lib.mjs';
import { ACC } from './data.mjs';

const DAY = 24 * HOUR;

function slugify(value) {
  const map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  return String(value ?? '').toLowerCase()
    .split('').map((ch) => (map[ch] !== undefined ? map[ch] : ch)).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export function catalogRoutes(ctx) {
  const routes = [];

  // ------------------------------------------------------------------
  // Лента магазинов (FR-FEED-01…07)
  // ------------------------------------------------------------------
  routes.push(['GET', '/api/v1/shops', (r) => {
    recalcFeedScores(ctx);
    const q = String(r.query.q ?? '').trim().toLowerCase();
    const country = String(r.query.country ?? '').toUpperCase();
    const cityId = Number(r.query.city ?? 0);
    const category = r.query.category === undefined || r.query.category === '' ? null : Number(r.query.category);
    const minRating = Number(r.query.min_rating ?? 0);
    const crownOnly = String(r.query.crown_only ?? '') === 'true';
    const verifiedOnly = String(r.query.verified_only ?? '') === 'true';
    const starsOnly = String(r.query.stars_only ?? '') === 'true';
    const sort = String(r.query.sort ?? 'feed');
    const limit = Math.min(50, Math.max(1, Number(r.query.limit ?? 12)));
    const viewer = r.auth?.user ?? null;

    let items = [...ctx.db.shops.values()].filter((shop) => {
      if (shop.status !== 'active') return false;
      if (rentStatus(ctx, shop.id) === 'suspended') return false; // FR-SHOP-08
      if (q) {
        const hay = `${shop.name} ${shop.slug} ${shop.description} ${(shop.category_ids ?? []).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (country && shop.country !== country) return false;
      if (cityId && shop.city_id !== cityId) return false;
      if (category !== null && !(shop.category_ids ?? []).map(Number).includes(category)) return false;
      if (minRating && shop.rating_bayes < minRating) return false;
      if (crownOnly && !isCrowned(ctx, shop)) return false;
      if (verifiedOnly && !shop.is_verified) return false;
      if (starsOnly && !shop.accepts_stars) return false;
      return true;
    });

    switch (sort) {
      case 'rating': items.sort((a, b) => b.rating_bayes - a.rating_bayes); break;
      case 'sales': items.sort((a, b) => b.sales_count - a.sales_count); break;
      case 'new': items.sort((a, b) => b.created_at.localeCompare(a.created_at)); break;
      default: items.sort((a, b) => b.feed_score - a.feed_score);
    }

    const cards = items.map((shop) => shopCard(ctx, shop, viewer?.country ?? ''));
    // Не более одного promoted-магазина на 8 карточек (FR-FEED-06).
    const perPage = Number(ctx.db.settings.get('promoted_slots_per_page') ?? 1);
    const page = paginate(cards, limit, r.query.cursor);
    let promoted = 0;
    page.items = page.items.map((card, i) => {
      const shop = ctx.db.shops.get(card.id);
      if (shop?.promoted && promoted < perPage) {
        promoted += 1;
        return { ...card, promoted: true, promoted_reason: 'оплаченное продвижение' };
      }
      return { ...card, promoted: false };
    });
    return ok({
      items: page.items, next_cursor: page.next_cursor, has_more: page.has_more, total: page.total,
      filters: {
        q: q || null, country: country || null, city_id: cityId || null, category: category || null,
        min_rating: minRating || null, crown_only: crownOnly, verified_only: verifiedOnly,
        stars_only: starsOnly, sort,
      },
      geo: viewer ? { country: viewer.country, city_id: viewer.city_id, city: ctx.db.cities.get(viewer.city_id)?.name_ru ?? null } : null,
      boosted: cards.filter((c) => (c.gift_boost ?? 0) > 0).map((c) => c.id),
    });
  }, { rate: 'search' }]);

  routes.push(['POST', '/api/v1/shops', (r) => {
    const auth = requireAuth(ctx, r.req);
    const b = r.body ?? {};
    requireOps(ctx, r.req, auth, 'create_shop', { totpCode: String(b.totp_code ?? '') });
    if (!['buyer', 'shop_admin', 'superadmin', 'moderator'].includes(auth.user.role)) {
      throw forbidden('FORBIDDEN', 'роль не может создавать магазины');
    }
    const max = Number(ctx.db.settings.get('max_shops_per_account') ?? 3);
    if (shopCount(ctx, auth.user.id) >= max) throw conflict('SHOP_LIMIT', `максимум ${max} магазина на аккаунт`);
    const name = String(b.name ?? '').trim();
    if (name.length < 3 || name.length > 60) throw bad('название магазина: 3–60 символов');
    let slug = slugify(b.slug || name);
    if (!slug || slug.length < 3) throw bad('укажите slug магазина (латиница, 3–40 символов)');
    if (ctx.db.shopsBySlug.has(slug)) slug = `${slug}-${C.hex(2)}`;
    const country = String(b.country ?? auth.user.country ?? '').toUpperCase();
    if (!ctx.db.countries.get(country)) throw bad('некорректная страна');
    const cityId = Number(b.city_id ?? auth.user.city_id ?? 0);
    if (!ctx.db.cities.get(cityId)) throw bad('выберите город');
    const categories = (Array.isArray(b.category_ids) ? b.category_ids : []).map(Number).filter((id) => ctx.db.categories.has(id));
    if (categories.length === 0) throw bad('выберите хотя бы одну категорию');
    const restricted = categories.some((id) => ctx.db.categories.get(id)?.restricted);
    if (restricted && !auth.user.is_18plus) throw forbidden('AGE_RESTRICTED', 'категория доступна только 18+');

    const id = C.newId('shp');
    const now = new Date().toISOString();
    const shop = {
      id, admin_user_id: auth.user.id, slug, name,
      description: truncate(String(b.description ?? ''), 500),
      category_ids: categories, country, city_id: cityId,
      tz: ctx.db.cities.get(cityId).tz ?? 'Europe/Moscow',
      status: 'active', is_verified: false, accepts_stars: b.accepts_stars !== false,
      sanction_level: 'none', accent: String(b.accent ?? '#6c5ce7'),
      cover_url: String(b.cover_url ?? ''), avatar_url: '',
      rating_sum: 0, rating_count: 0, rating_bayes: 3.8, sales_count: 0, sales_volume_sol: 0,
      response_p50_s: 0, dispute_rate: 0, gift_boost: 0, gift_boost_until: null,
      complaint_penalty: 0, dispute_loss_penalty: 0, feed_score: 0,
      operators: Array.isArray(b.operator_ids) ? b.operator_ids.filter((x) => ctx.db.users.has(x)) : [],
      created_at: now, updated_at: now,
    };
    ctx.db.shops.set(id, shop);
    ctx.db.shopsBySlug.set(slug, id);
    // Trial 7 дней (FR-SHOP-06).
    const trialDays = Number(ctx.db.settings.get('rent_trial_days') ?? 7);
    const starter = planByCode(ctx, 'starter');
    ctx.db.subs.set(id, {
      id: C.newId('sub'), shop_id: id, plan_id: starter.id, status: 'trial', asset: 'SOL',
      price_sol: starter.price_sol, price_stars: starter.price_stars,
      period_start: now, period_end: new Date(Date.now() + trialDays * DAY).toISOString(),
      grace_end: null, auto_renew: false, renew_attempts: 0, created_at: now, updated_at: now,
    });
    ensureShopChannel(ctx, shop, auth.user);
    if (auth.user.role === 'buyer') {
      auth.user.role = 'shop_admin';
    }
    recalcFeedScores(ctx);
    audit(ctx, r.req, auth.user, 'shop.create', 'shop', id, '', 'ops', null, { name, slug, plan: 'trial' });
    notify(ctx, auth.user.id, 'shop_created', 'Магазин создан',
      `${name}: trial ${trialDays} дней. Добавьте товары и продлите аренду.`, `shop:${id}:created`);
    return created(shopDetail(ctx, shop, auth.user));
  }, { rate: 'write' }]);

  routes.push(['GET', '/api/v1/shops/:id', (r) => {
    const shop = findShop(ctx, r.params.id);
    if (!shop) throw notFound('магазин не найден');
    const detail = shopDetail(ctx, shop, r.auth?.user ?? null);
    detail.reviews_summary = reviewSummary(ctx, shop.id);
    detail.products_preview = [...ctx.db.products.values()]
      .filter((p) => p.shop_id === shop.id && p.status === 'published')
      .slice(0, 4)
      .map((p) => productDto(ctx, p, r.auth?.user ?? null));
    detail.chat_id = ctx.db.supportChats?.get(shop.id) ?? null;
    return ok(detail);
  }, { rate: 'public' }]);

  routes.push(['PATCH', '/api/v1/shops/:id', (r) => {
    const auth = requireAuth(ctx, r.req);
    const shop = findShop(ctx, r.params.id);
    if (!shop) throw notFound('магазин не найден');
    const isOwner = shop.admin_user_id === auth.user.id;
    if (!isOwner && !['superadmin', 'moderator'].includes(auth.user.role)) {
      throw forbidden('FORBIDDEN', 'изменять магазин может только его админ');
    }
    const b = r.body ?? {};
    const before = { name: shop.name, description: shop.description, country: shop.country, city_id: shop.city_id };
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (name.length < 3 || name.length > 60) throw bad('название: 3–60 символов');
      shop.name = name;
    }
    if (b.description !== undefined) shop.description = truncate(String(b.description), 500);
    if (b.category_ids !== undefined) {
      const categories = (Array.isArray(b.category_ids) ? b.category_ids : []).map(Number).filter((id) => ctx.db.categories.has(id));
      if (!categories.length) throw bad('выберите хотя бы одну категорию');
      shop.category_ids = categories;
    }
    if (b.country !== undefined) {
      const country = String(b.country).toUpperCase();
      if (!ctx.db.countries.get(country)) throw bad('некорректная страна');
      shop.country = country;
    }
    if (b.city_id !== undefined) {
      const city = ctx.db.cities.get(Number(b.city_id));
      if (!city) throw bad('выберите город');
      shop.city_id = city.id;
      shop.tz = city.tz;
    }
    if (b.accepts_stars !== undefined) shop.accepts_stars = !!b.accepts_stars;
    if (b.accent !== undefined) shop.accent = String(b.accent);
    if (b.cover_url !== undefined) shop.cover_url = String(b.cover_url);
    if (b.operator_ids !== undefined) {
      shop.operators = (Array.isArray(b.operator_ids) ? b.operator_ids : []).filter((id) => ctx.db.users.has(id));
    }
    shop.updated_at = new Date().toISOString();
    recalcFeedScores(ctx);
    audit(ctx, r.req, auth.user, 'shop.update', 'shop', shop.id, '', 'ops', before,
      { name: shop.name, description: shop.description, country: shop.country, city_id: shop.city_id });
    return ok(shopDetail(ctx, shop, auth.user));
  }, { rate: 'write' }]);

  routes.push(['GET', '/api/v1/shops/:id/stats', (r) => {
    const auth = requireAuth(ctx, r.req);
    const shop = findShop(ctx, r.params.id);
    if (!shop) throw notFound('магазин не найден');
    const isOwner = shop.admin_user_id === auth.user.id || (shop.operators ?? []).includes(auth.user.id);
    if (!isOwner && !['superadmin', 'moderator', 'arbiter'].includes(auth.user.role)) {
      throw forbidden('FORBIDDEN', 'статистика доступна только админу магазина');
    }
    const orders = [...ctx.db.orders.values()].filter((o) => o.shop_id === shop.id);
    const days = 30;
    const since = Date.now() - days * DAY;
    const salesByDay = {};
    for (const order of orders) {
      const t = new Date(order.created_at).getTime();
      if (t < since) continue;
      const key = new Date(t).toISOString().slice(0, 10);
      salesByDay[key] = (salesByDay[key] ?? 0) + order.total_sol;
    }
    const sub = ctx.db.subs.get(shop.id);
    const plan = ctx.db.rentPlans.get(sub?.plan_id);
    return ok({
      shop_id: shop.id, period_days: days,
      orders_total: orders.length,
      orders_completed: orders.filter((o) => o.status === 'completed').length,
      orders_disputed: orders.filter((o) => o.dispute_id).length,
      revenue_sol: C.formatSol(orders.reduce((a, o) => a + o.total_sol, 0)),
      revenue_stars: orders.reduce((a, o) => a + o.total_stars, 0),
      fee_paid_sol: C.formatSol(orders.reduce((a, o) => a + o.fee_sol, 0)),
      fee_bps: feeBps(ctx, shop.id),
      sales_by_day: Object.entries(salesByDay).map(([date, lamports]) => ({ date, sol: C.formatSol(lamports) })).sort((a, b) => a.date.localeCompare(b.date)),
      rating: reviewSummary(ctx, shop.id),
      response_p50_s: shop.response_p50_s, dispute_rate: Number((shop.dispute_rate ?? 0).toFixed(3)),
      feed_score: Number((shop.feed_score ?? 0).toFixed(4)),
      crown: isCrowned(ctx, shop), rent: sub ? { plan: plan?.code, status: sub.status, period_end: sub.period_end, auto_renew: sub.auto_renew } : null,
      products: {
        total: [...ctx.db.products.values()].filter((p) => p.shop_id === shop.id).length,
        published: [...ctx.db.products.values()].filter((p) => p.shop_id === shop.id && p.status === 'published').length,
        stock_free: [...ctx.db.products.values()].filter((p) => p.shop_id === shop.id)
          .reduce((a, p) => a + (ctx.db.stock.get(p.id) ?? []).filter((i) => i.status === 'free').length, 0),
      },
    });
  }, { rate: 'public' }]);

  // ------------------------------------------------------------------
  // Аренда (FR-SHOP-05…09)
  // ------------------------------------------------------------------
  routes.push(['GET', '/api/v1/rent/plans', () => ok({
    items: rentPlanList(ctx)
      .map((p) => ({
        id: p.id, code: p.code, name_ru: p.name_ru, description: p.description,
        price_sol: C.formatSol(p.price_sol), price_sol_raw: p.price_sol, price_stars: p.price_stars,
        fee_bps: p.fee_bps, boost: p.boost, crown: !!p.crown, verified: !!p.verified,
        max_products: p.max_products, priority_support: !!p.priority_support, active: p.active !== false,
      })),
    trial_days: Number(ctx.db.settings.get('rent_trial_days') ?? 7),
    grace_hours: 72,
  }), { rate: 'public' }]);

  routes.push(['GET', '/api/v1/shops/:id/rent', (r) => {
    const auth = requireAuth(ctx, r.req);
    const shop = findShop(ctx, r.params.id);
    if (!shop) throw notFound('магазин не найден');
    const sub = ctx.db.subs.get(shop.id);
    const plan = ctx.db.rentPlans.get(sub?.plan_id);
    return ok({
      shop_id: shop.id, shop_name: shop.name,
      is_owner: shop.admin_user_id === auth.user.id,
      status: sub?.status ?? 'none',
      plan: plan ? { code: plan.code, name_ru: plan.name_ru, fee_bps: plan.fee_bps, crown: !!plan.crown } : null,
      period_start: sub?.period_start ?? null, period_end: sub?.period_end ?? null,
      grace_end: sub?.grace_end ?? null, auto_renew: !!sub?.auto_renew,
      price_sol: sub ? C.formatSol(sub.price_sol) : null, price_stars: sub?.price_stars ?? null,
      days_left: sub?.period_end ? Math.max(0, Math.ceil((new Date(sub.period_end) - Date.now()) / DAY)) : 0,
      crown: isCrowned(ctx, shop),
      notice: sub?.status === 'suspended'
        ? 'Магазин скрыт из ленты: аренда не продлена. Оплатите тариф, чтобы вернуть магазин.'
        : sub?.status === 'grace' ? 'Оплата не прошла: осталось 72 часа grace-периода.' : null,
    });
  }, { rate: 'public' }]);

  routes.push(['POST', '/api/v1/shops/:id/rent', (r) => {
    const auth = requireAuth(ctx, r.req);
    const shop = findShop(ctx, r.params.id);
    if (!shop) throw notFound('магазин не найден');
    if (shop.admin_user_id !== auth.user.id && auth.user.role !== 'superadmin') {
      throw forbidden('FORBIDDEN', 'аренду оплачивает админ магазина');
    }
    const b = r.body ?? {};
    const asset = String(b.asset ?? 'SOL').toUpperCase();
    if (!['SOL', 'STARS'].includes(asset)) throw bad('asset должен быть SOL или STARS');
    const plan = planByCode(ctx, String(b.plan_code ?? 'starter'));
    if (!plan) throw notFound('тариф не найден');
    const price = asset === 'STARS' ? plan.price_stars : plan.price_sol;
    if (price <= 0) throw bad('некорректная цена тарифа');
    requireOps(ctx, r.req, auth, 'rent', {
      amountSol: asset === 'SOL' ? price : 0, amountStars: asset === 'STARS' ? price : 0,
      totpCode: String(b.totp_code ?? ''),
    });
    const balance = ctx.db.ledger.userBalance(auth.user.id, asset);
    if (balance < price) throw unprocessable('INSUFFICIENT_FUNDS', `недостаточно средств: нужно ${asset === 'STARS' ? `${price} ⭐` : `${C.formatSol(price)} SOL`}`);

    ctx.db.ledger.ensure('user', auth.user.id, asset);
    ctx.db.ledger.ensure('platform', 'rent', asset);
    const sub = ctx.db.subs.get(shop.id);
    const idem = `rent:${shop.id}:${asset}:${sub?.period_end ?? 'new'}:${Date.now()}`;
    const res = ctx.db.ledger.post(idem, asset, 'rent', 'shop', shop.id, auth.user.id, [
      ctx.db.ledger.debit(ACC.user(auth.user.id, asset), price),
      ctx.db.ledger.credit(ACC.platform('rent', asset), price),
    ]);
    if (res.error) throw ledgerErrorFrom(res.error);
    const now = Date.now();
    const base = sub && sub.period_end && new Date(sub.period_end) > new Date()
      ? new Date(sub.period_end).getTime() : now;
    const periodEnd = new Date(base + 30 * DAY);
    ctx.db.subs.set(shop.id, {
      ...(sub ?? {}), id: sub?.id ?? C.newId('sub'), shop_id: shop.id, plan_id: plan.id,
      status: 'active', asset, price_sol: asset === 'SOL' ? price : plan.price_sol,
      price_stars: asset === 'STARS' ? price : plan.price_stars,
      period_start: new Date(now).toISOString(), period_end: periodEnd.toISOString(),
      grace_end: null, auto_renew: b.auto_renew !== undefined ? !!b.auto_renew : (sub?.auto_renew ?? false),
      renew_attempts: 0, created_at: sub?.created_at ?? new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    });
    shop.status = 'active';
    shop.sanction_level = shop.sanction_level === 'none' ? 'none' : shop.sanction_level;
    recalcFeedScores(ctx);
    audit(ctx, r.req, auth.user, 'shop.rent_paid', 'shop', shop.id, '', 'ops',
      { status: sub?.status, plan: sub ? ctx.db.rentPlans.get(sub.plan_id)?.code : null },
      { status: 'active', plan: plan.code, asset, price, period_end: periodEnd.toISOString(), tx_id: res.tx_id });
    notify(ctx, auth.user.id, 'rent_paid', 'Аренда продлена',
      `${shop.name}: тариф «${plan.name_ru}» до ${periodEnd.toLocaleDateString('ru-RU')}. Комиссия ${plan.fee_bps / 100} %.`,
      `rent:${shop.id}:paid:${res.tx_id}`, { shop_id: shop.id, plan: plan.code });
    push(ctx, auth.user.id, 'rent.updated', { shop_id: shop.id, status: 'active', period_end: periodEnd.toISOString() });
    push(ctx, auth.user.id, 'wallet.updated', { asset, tx_id: res.tx_id });
    const channel = [...ctx.db.chats.values()].find((ch) => ch.kind === 'channel' && ch.shop_id === shop.id);
    if (channel) {
      const msg = systemMessage(ctx, channel, `Аренда продлена: тариф «${plan.name_ru}» до ${periodEnd.toLocaleDateString('ru-RU')}.`,
        { kind: 'rent', shop_id: shop.id });
      broadcastMessage(ctx, channel, msg, null);
    }
    return ok({
      status: 'active', shop_id: shop.id, plan: plan.code, plan_name: plan.name_ru,
      asset, paid: asset === 'STARS' ? `${price} ⭐` : `${C.formatSol(price)} SOL`,
      tx_id: res.tx_id, period_end: periodEnd.toISOString(), fee_bps: plan.fee_bps,
      crown: isCrowned(ctx, shop), auto_renew: !!b.auto_renew,
      balance_after: asset === 'STARS' ? ctx.db.ledger.userBalance(auth.user.id, asset) : C.formatSol(ctx.db.ledger.userBalance(auth.user.id, asset)),
    });
  }, { rate: 'payment' }]);

  // ------------------------------------------------------------------
  // Товары и зашифрованный сток (FR-PROD-*)
  // ------------------------------------------------------------------
  routes.push(['GET', '/api/v1/shops/:id/products', (r) => {
    const shop = findShop(ctx, r.params.id);
    if (!shop) throw notFound('магазин не найден');
    const viewer = r.auth?.user ?? null;
    const isOwner = viewer && (shop.admin_user_id === viewer.id || (shop.operators ?? []).includes(viewer.id));
    const q = String(r.query.q ?? '').trim().toLowerCase();
    const kind = String(r.query.kind ?? '');
    const limit = Math.min(50, Math.max(1, Number(r.query.limit ?? 20)));
    let items = [...ctx.db.products.values()].filter((p) => p.shop_id === shop.id);
    if (!isOwner) items = items.filter((p) => p.status === 'published');
    if (kind) items = items.filter((p) => p.kind === kind);
    if (q) items = items.filter((p) => `${p.title} ${p.description}`.toLowerCase().includes(q));
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const page = paginate(items.map((p) => productDto(ctx, p, viewer)), limit, r.query.cursor);
    return ok({ ...page, shop_id: shop.id, shop_name: shop.name, rent_status: rentStatus(ctx, shop.id) });
  }, { rate: 'search' }]);

  routes.push(['POST', '/api/v1/shops/:id/products', (r) => {
    const auth = requireAuth(ctx, r.req);
    const shop = findShop(ctx, r.params.id);
    if (!shop) throw notFound('магазин не найден');
    if (shop.admin_user_id !== auth.user.id && !['superadmin', 'moderator'].includes(auth.user.role)) {
      throw forbidden('FORBIDDEN', 'товары добавляет админ магазина');
    }
    const sub = ctx.db.subs.get(shop.id);
    const plan = ctx.db.rentPlans.get(sub?.plan_id);
    const owned = [...ctx.db.products.values()].filter((p) => p.shop_id === shop.id).length;
    if (plan?.max_products && owned >= plan.max_products) {
      throw forbidden('PLAN_LIMIT', `тариф «${plan.name_ru}» допускает ${plan.max_products} товаров`);
    }
    const b = r.body ?? {};
    const title = String(b.title ?? '').trim();
    if (title.length < 3 || title.length > 120) throw bad('название товара: 3–120 символов');
    const categoryId = b.category_id !== undefined && b.category_id !== null && b.category_id !== ''
      ? Number(b.category_id) : Number(shop.category_ids?.[0] ?? 0);
    const category = ctx.db.categories.get(categoryId);
    if (!category) throw bad('выберите категорию товара');
    const priceSol = C.parseSol(String(b.price_sol ?? '0'));
    const priceStars = Math.max(0, Number(b.price_stars ?? 0));
    if (priceSol <= 0 && priceStars <= 0) throw bad('укажите цену в SOL или Stars');
    const payloads = Array.isArray(b.stock_payloads) ? b.stock_payloads.map((x) => String(x)).filter(Boolean) : [];
    const id = C.newId('prd');
    const now = new Date().toISOString();
    const product = {
      id, shop_id: shop.id, title, description: truncate(String(b.description ?? ''), 2000),
      kind: String(b.kind ?? 'license_key'), category_id: categoryId,
      price_sol: priceSol, price_stars: priceStars,
      warranty_days: Math.max(0, Number(b.warranty_days ?? 7)),
      delivery_sla_h: Math.max(1, Number(b.delivery_sla_h ?? 24)),
      status: payloads.length ? 'published' : 'draft',
      stock_total: payloads.length, stock_free: payloads.length,
      media_urls: Array.isArray(b.media_urls) ? b.media_urls.map(String) : [],
      rating_sum: 0, rating_count: 0, moderation_note: '',
      created_at: now, updated_at: now,
    };
    ctx.db.products.set(id, product);
    ctx.db.stock.set(id, payloads.map((payload) => {
      const itemId = C.newId('stk');
      return {
        id: itemId, product_id: id, status: 'free',
        payload_ct: C.encrypt(C.DOMAINS.stock, itemId, payload), // AES-256-GCM, домен product_stock
        created_at: now,
      };
    }));
    recalcFeedScores(ctx);
    audit(ctx, r.req, auth.user, 'product.create', 'product', id, '', '',
      null, { title, price_sol: priceSol, price_stars: priceStars, stock: payloads.length });
    return created({ ...productDto(ctx, product, auth.user), stock_encrypted: payloads.length > 0 });
  }, { rate: 'write' }]);

  routes.push(['GET', '/api/v1/products/:id', (r) => {
    const product = ctx.db.products.get(r.params.id);
    if (!product) throw notFound('товар не найден');
    const viewer = r.auth?.user ?? null;
    const shop = ctx.db.shops.get(product.shop_id);
    if (product.status !== 'published' && !(viewer && shop?.admin_user_id === viewer.id)) {
      throw notFound('товар не найден');
    }
    const items = ctx.db.stock.get(product.id) ?? [];
    return ok({
      ...productDto(ctx, product, viewer),
      shop: shop ? shopCard(ctx, shop, viewer?.country ?? '') : null,
      warranty_days: product.warranty_days, delivery_sla_h: product.delivery_sla_h,
      delivery_kind: items.length ? 'auto' : 'manual',
      stock: { total: items.length, free: items.filter((i) => i.status === 'free').length, encrypted: true },
      media_urls: product.media_urls ?? [],
      actions: ['buy', 'open_chat', ...(viewer && shop?.admin_user_id === viewer.id ? ['edit', 'add_stock', 'unpublish'] : [])],
    });
  }, { rate: 'public' }]);

  routes.push(['PATCH', '/api/v1/products/:id', (r) => {
    const auth = requireAuth(ctx, r.req);
    const product = ctx.db.products.get(r.params.id);
    if (!product) throw notFound('товар не найден');
    const shop = ctx.db.shops.get(product.shop_id);
    if (shop.admin_user_id !== auth.user.id && !['superadmin', 'moderator'].includes(auth.user.role)) {
      throw forbidden('FORBIDDEN', 'изменять товар может админ магазина');
    }
    const b = r.body ?? {};
    const before = { title: product.title, price_sol: product.price_sol, status: product.status };
    if (b.title !== undefined) product.title = String(b.title).trim().slice(0, 120);
    if (b.description !== undefined) product.description = truncate(String(b.description), 2000);
    if (b.price_sol !== undefined) product.price_sol = C.parseSol(String(b.price_sol));
    if (b.price_stars !== undefined) product.price_stars = Math.max(0, Number(b.price_stars));
    if (b.warranty_days !== undefined) product.warranty_days = Math.max(0, Number(b.warranty_days));
    if (b.delivery_sla_h !== undefined) product.delivery_sla_h = Math.max(1, Number(b.delivery_sla_h));
    if (b.status !== undefined) {
      if (!['draft', 'published', 'archived'].includes(b.status)) throw bad('некорректный статус товара');
      product.status = b.status;
    }
    product.updated_at = new Date().toISOString();
    audit(ctx, r.req, auth.user, 'product.update', 'product', product.id, '', '', before,
      { title: product.title, price_sol: product.price_sol, status: product.status });
    return ok(productDto(ctx, product, auth.user));
  }, { rate: 'write' }]);

  routes.push(['POST', '/api/v1/products/:id/stock', (r) => {
    const auth = requireAuth(ctx, r.req);
    const product = ctx.db.products.get(r.params.id);
    if (!product) throw notFound('товар не найден');
    const shop = ctx.db.shops.get(product.shop_id);
    if (shop.admin_user_id !== auth.user.id && auth.user.role !== 'superadmin') {
      throw forbidden('FORBIDDEN', 'сток пополняет админ магазина');
    }
    const payloads = Array.isArray(r.body?.payloads) ? r.body.payloads.map((x) => String(x)).filter(Boolean) : [];
    if (!payloads.length) throw bad('передайте payloads — список цифровых товаров');
    if (payloads.length > 500) throw bad('максимум 500 позиций за раз');
    const list = ctx.db.stock.get(product.id) ?? [];
    const now = new Date().toISOString();
    for (const payload of payloads) {
      const itemId = C.newId('stk');
      list.push({
        id: itemId, product_id: product.id, status: 'free',
        payload_ct: C.encrypt(C.DOMAINS.stock, itemId, payload), created_at: now,
      });
    }
    ctx.db.stock.set(product.id, list);
    product.stock_total = list.length;
    product.stock_free = list.filter((i) => i.status === 'free').length;
    product.updated_at = now;
    if (product.status === 'draft' && product.stock_free > 0) product.status = 'published';
    audit(ctx, r.req, auth.user, 'product.stock_add', 'product', product.id, '', '',
      { stock_free: product.stock_free - payloads.length }, { added: payloads.length, stock_free: product.stock_free });
    return ok({
      product_id: product.id, added: payloads.length, stock_free: product.stock_free,
      stock_total: product.stock_total, status: product.status, encrypted: true,
    });
  }, { rate: 'write' }]);

  // ------------------------------------------------------------------
  // Отзывы (FR-REV-*)
  // ------------------------------------------------------------------
  routes.push(['GET', '/api/v1/shops/:id/reviews', (r) => {
    const shop = findShop(ctx, r.params.id);
    if (!shop) throw notFound('магазин не найден');
    const limit = Math.min(50, Math.max(1, Number(r.query.limit ?? 20)));
    const minRating = Number(r.query.min_rating ?? 0);
    let items = [...ctx.db.reviews.values()].filter((rv) => rv.shop_id === shop.id && rv.status === 'published');
    if (minRating) items = items.filter((rv) => rv.rating >= minRating);
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const page = paginate(items.map((rv) => reviewDto(ctx, rv)), limit, r.query.cursor);
    return ok({ ...page, summary: reviewSummary(ctx, shop.id) });
  }, { rate: 'public' }]);

  routes.push(['POST', '/api/v1/reviews/:id/reply', (r) => {
    const auth = requireAuth(ctx, r.req);
    const review = ctx.db.reviews.get(r.params.id);
    if (!review) throw notFound('отзыв не найден');
    const shop = ctx.db.shops.get(review.shop_id);
    if (shop.admin_user_id !== auth.user.id && !['superadmin', 'moderator'].includes(auth.user.role)) {
      throw forbidden('FORBIDDEN', 'отвечать на отзывы может админ магазина');
    }
    const body = truncate(String(r.body?.body ?? ''), 1000);
    if (body.length < 2) throw bad('текст ответа слишком короткий');
    review.shop_reply = body;
    review.shop_reply_at = new Date().toISOString();
    audit(ctx, r.req, auth.user, 'review.reply', 'review', review.id, '', '', null, { body });
    notify(ctx, review.author_id, 'review_reply', 'Магазин ответил на ваш отзыв',
      `${shop.name}: ${truncate(body, 120)}`, `review:${review.id}:reply`);
    push(ctx, review.author_id, 'review.reply', { review_id: review.id, shop_id: shop.id });
    return ok(reviewDto(ctx, review));
  }, { rate: 'write' }]);

  routes.push(['POST', '/api/v1/reviews/:id/report', (r) => {
    const auth = requireAuth(ctx, r.req);
    const review = ctx.db.reviews.get(r.params.id);
    if (!review) throw notFound('отзыв не найден');
    const reason = String(r.body?.reason ?? '').trim();
    if (reason.length < 3) throw bad('опишите причину жалобы');
    const id = C.newId('rpt');
    ctx.db.reports.set(id, {
      id, kind: 'review', target_id: review.id, reporter_id: auth.user.id, reason,
      status: 'open', created_at: new Date().toISOString(), resolution: '', resolved_at: null,
    });
    review.reported = true;
    audit(ctx, r.req, auth.user, 'review.report', 'review', review.id, reason, '', null, null);
    for (const moderator of [...ctx.db.users.values()].filter((u) => ['moderator', 'superadmin'].includes(u.role))) {
      notify(ctx, moderator.id, 'moderation_report', 'Жалоба на отзыв',
        `Пользователь ${auth.user.nickname}: ${truncate(reason, 120)}`, `report:${id}:${moderator.id}`);
    }
    return created({ id, status: 'open', message: 'жалоба передана модераторам' });
  }, { rate: 'write' }]);

  return routes;
}

function ledgerErrorFrom(code) {
  switch (code) {
    case 'INSUFFICIENT_FUNDS': return unprocessable('INSUFFICIENT_FUNDS', 'недостаточно средств');
    case 'ALREADY_USED': return conflict('ALREADY_USED', 'операция уже исполнена');
    default: return new Error(`ledger error: ${code}`);
  }
}
