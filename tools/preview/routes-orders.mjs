// Роуты заказов: создание, оплата (эскроу), выдача, подтверждение, отмена, история, отзывы.
// Соответствует docs/api.md §7 и docs/orders-disputes.md (машина состояний).
import * as C from './crypto.mjs';
import {
  CONFIG, bad, conflict, forbidden, notFound, unprocessable,
  ok, created, paginate, truncate, orderDto, statusTitle, orderActions,
  requireAuth, requireOps, audit, notify, push, pushMany, reviewDto, recalcFeedScores,
} from './lib.mjs';
import { ACC } from './data.mjs';
import {
  findOrder, findProduct, findShop, orderNumber, transition, canTransition,
  reserveStock, releaseStock, autoDeliver, holdEscrow, releaseEscrow, refundEscrow,
  finishOrderStats, openOrderChat, orderStatusMessage, addMessage, broadcastMessage,
  recalcRating, reviewSummary, deliveryDeadlineFor, shopAdmins, HOUR,
} from './domain.mjs';

function amountStr(asset, lamports, stars) {
  return asset === 'STARS' ? `${stars} ⭐` : `${C.formatSol(lamports)} SOL`;
}

function pushOrder(ctx, order, audience = []) {
  const payload = {
    order_id: order.id, number: order.number, status: order.status,
    status_title: statusTitle(order.status), ts: new Date().toISOString(),
  };
  for (const userId of audience) {
    const role = order.buyer_id === userId ? 'buyer' : 'shop';
    push(ctx, userId, 'order.status', { ...payload, actions: orderActions(order, role) });
  }
}

// loadOrderForUser — доступ к заказу по роли (buyer / shop / arbiter).
function loadOrderForUser(ctx, r, expectedRole) {
  const auth = requireAuth(ctx, r.req);
  const order = findOrder(ctx, r.params.id);
  if (!order) throw notFound('заказ не найден');
  const isBuyer = order.buyer_id === auth.user.id;
  const isShop = shopAdmins(ctx, order.shop_id).includes(auth.user.id);
  const isStaff = ['arbiter', 'moderator', 'superadmin'].includes(auth.user.role);
  const role = isBuyer ? 'buyer' : isShop ? 'shop' : isStaff ? 'staff' : '';
  if (expectedRole === 'buyer' && !isBuyer && !isStaff) throw forbidden('FORBIDDEN', 'заказ принадлежит другому покупателю');
  if (expectedRole === 'shop' && !isShop && !isStaff) throw forbidden('FORBIDDEN', 'доступ только для админа магазина');
  if (!role) throw notFound('заказ не найден');
  return { auth, order, role };
}

export function orderRoutes(ctx) {
  const routes = [];

  routes.push(['GET', '/api/v1/orders', (r) => {
    const auth = requireAuth(ctx, r.req);
    const roleParam = String(r.query.role ?? 'buyer');
    const statusParam = String(r.query.status ?? '');
    const limit = Math.min(50, Math.max(1, Number(r.query.limit ?? 20)));
    const mineShopIds = [...ctx.db.shops.values()]
      .filter((s) => s.admin_user_id === auth.user.id || (s.operators ?? []).includes(auth.user.id))
      .map((s) => s.id);
    let items = [...ctx.db.orders.values()].filter((order) => {
      if (roleParam === 'shop') return mineShopIds.includes(order.shop_id);
      if (roleParam === 'all') return order.buyer_id === auth.user.id || mineShopIds.includes(order.shop_id);
      return order.buyer_id === auth.user.id;
    });
    if (['arbiter', 'moderator', 'superadmin'].includes(auth.user.role) && roleParam === 'staff') {
      items = [...ctx.db.orders.values()];
    }
    if (statusParam) items = items.filter((o) => o.status === statusParam);
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const page = paginate(items.map((o) => orderDto(ctx, o, auth.user)), limit, r.query.cursor);
    const counts = {};
    for (const order of items) counts[order.status] = (counts[order.status] ?? 0) + 1;
    return ok({ ...page, role: roleParam, counts, statuses: Object.keys(TRANSITIONS_ALL) });
  }, { rate: 'public' }]);

  routes.push(['POST', '/api/v1/orders', (r) => {
    const auth = requireAuth(ctx, r.req);
    const b = r.body ?? {};
    const idem = String(b.idempotency_key ?? r.req.headers['idempotency-key'] ?? '').trim();
    if (idem && ctx.db.idempotency.has(`order:${idem}`)) {
      const existing = findOrder(ctx, ctx.db.idempotency.get(`order:${idem}`));
      if (existing) return created(orderDto(ctx, existing, auth.user));
    }
    const product = findProduct(ctx, String(b.product_id ?? ''));
    if (!product) throw notFound('товар не найден');
    const shop = findShop(ctx, product.shop_id);
    if (!shop || shop.status !== 'active') throw unprocessable('SHOP_UNAVAILABLE', `магазин недоступен: ${shop?.status ?? 'не найден'}`);
    if (ctx.db.subs.get(shop.id)?.status === 'suspended') {
      throw unprocessable('SHOP_RENT_SUSPENDED', 'магазин приостановлен: аренда не оплачена');
    }
    if (product.status !== 'published') throw unprocessable('PRODUCT_UNAVAILABLE', 'товар снят с продажи');
    if (shop.admin_user_id === auth.user.id) throw bad('нельзя покупать в собственном магазине');

    const qty = Math.max(1, Math.min(50, Number(b.qty ?? 1)));
    const asset = String(b.pay_asset ?? (product.price_stars > 0 && product.price_sol === 0 ? 'STARS' : 'SOL')).toUpperCase();
    if (!['SOL', 'STARS'].includes(asset)) throw bad('pay_asset должен быть SOL или STARS');
    if (asset === 'STARS' && !shop.accepts_stars) throw unprocessable('STARS_NOT_ACCEPTED', 'магазин не принимает Telegram Stars');
    const unitSol = product.price_sol;
    const unitStars = product.price_stars;
    if (asset === 'SOL' && unitSol <= 0) throw unprocessable('ORDER_NOT_PAYABLE', 'цена в SOL не задана');
    if (asset === 'STARS' && unitStars <= 0) throw unprocessable('ORDER_NOT_PAYABLE', 'цена в Stars не задана');

    const itemsStock = ctx.db.stock.get(product.id) ?? [];
    const free = itemsStock.filter((i) => i.status === 'free').length;
    const deliveryKind = free > 0 ? 'auto' : 'manual';
    if (deliveryKind === 'auto' && free < qty) {
      throw unprocessable('OUT_OF_STOCK', `в наличии ${free} шт., запрошено ${qty}`);
    }

    const id = C.newId('ord');
    const now = new Date().toISOString();
    const feeBpsValue = Number(ctx.db.rentPlans.get(ctx.db.subs.get(shop.id)?.plan_id)?.fee_bps ?? 700);
    const order = {
      id, number: orderNumber(ctx), buyer_id: auth.user.id, shop_id: shop.id, status: 'created',
      items: [], pay_asset: asset, delivery_kind: deliveryKind, fee_bps: feeBpsValue,
      created_at: now, updated_at: now, extend_used: false, idempotency_key: idem,
      paid_at: null, delivered_at: null, completed_at: null, cancelled_at: null,
      pay_deadline: new Date(Date.now() + CONFIG.payTimeoutMinutes * 60_000).toISOString(),
      delivery_deadline: null, confirm_deadline: null, dispute_id: '', review_id: '',
      subtotal_sol: 0, fee_sol: 0, total_sol: 0, subtotal_stars: 0, fee_stars: 0, total_stars: 0,
      cancel_reason: '', chat_id: '', escrow_account: '',
    };
    const item = {
      id: C.newId('oit'), product_id: product.id, title: product.title, qty,
      unit_price_sol: unitSol, unit_price_stars: unitStars, stock_item_ids: [],
      delivered_payload_ct: '', delivered_at: null, download_count: 0,
    };
    order.items = [item];
    if (asset === 'STARS') {
      order.subtotal_stars = unitStars * qty;
      order.fee_stars = Math.round((order.subtotal_stars * feeBpsValue) / 10000);
      order.total_stars = order.subtotal_stars + order.fee_stars;
    } else {
      order.subtotal_sol = unitSol * qty;
      order.fee_sol = Math.round((order.subtotal_sol * feeBpsValue) / 10000);
      order.total_sol = order.subtotal_sol + order.fee_sol;
    }
    if (deliveryKind === 'auto') {
      const taken = reserveStock(ctx, order, product, qty);
      if (!taken) throw unprocessable('OUT_OF_STOCK', 'товар закончился, пока оформлялся заказ');
      item.stock_item_ids = taken.map((si) => si.id);
      product.stock_free = itemsStock.filter((i) => i.status === 'free').length;
    }
    ctx.db.orders.set(id, order);
    ctx.db.ordersByNumber.set(order.number, id);
    if (idem) ctx.db.idempotency.set(`order:${idem}`, id);
    ctx.db.orderStatuses.push({
      order_id: id, from: '', to: 'created', actor_kind: 'buyer', actor_id: auth.user.id,
      reason: 'оформлен заказ', ts: now,
    });
    const chat = openOrderChat(ctx, order, shop, auth.user);
    recalcFeedScores(ctx);
    audit(ctx, r.req, auth.user, 'order.create', 'order', id, '', '', null, {
      shop_id: shop.id, asset, total_sol: order.total_sol, total_stars: order.total_stars, qty,
    });
    notify(ctx, shop.admin_user_id, 'order.created', 'Новый заказ',
      `Заказ ${order.number} на ${amountStr(asset, order.total_sol, order.total_stars)} ожидает оплаты.`,
      `order-created:${id}`, { order_id: id });
    pushMany(ctx, shopAdmins(ctx, shop.id), 'order.status', {
      order_id: id, number: order.number, status: order.status,
      status_title: statusTitle(order.status), actions: orderActions(order, 'shop'),
    });
    const dto = orderDto(ctx, order, auth.user);
    dto.chat_id = chat.id;
    dto.pay_deadline = order.pay_deadline;
    return created(dto);
  }, { rate: 'write' }]);

  routes.push(['GET', '/api/v1/orders/:id', (r) => {
    const { auth, order, role } = loadOrderForUser(ctx, r, '');
    const dto = orderDto(ctx, order, auth.user);
    dto.history = ctx.db.orderStatuses
      .filter((ev) => ev.order_id === order.id)
      .map((ev) => ({
        ts: ev.ts, from: ev.from || null, to: ev.to, to_title: statusTitle(ev.to),
        actor_kind: ev.actor_kind, reason: ev.reason || null,
      }));
    dto.delivery_available = role === 'buyer' && order.status === 'delivered' ||
      (role === 'buyer' && order.status === 'completed');
    dto.shop = (() => {
      const shop = ctx.db.shops.get(order.shop_id);
      return shop ? { id: shop.id, name: shop.name, rating: Number(shop.rating_bayes.toFixed(2)), crown: shop.crown ?? false } : null;
    })();
    if (role === 'buyer' && !order.review_id && ['completed', 'delivered'].includes(order.status)) {
      dto.review_available = true;
    }
    dto.review_summary = reviewSummary(ctx, order.shop_id);
    return ok(dto);
  }, { rate: 'public' }]);

  routes.push(['POST', '/api/v1/orders/:id/pay', (r) => {
    const { auth, order } = loadOrderForUser(ctx, r, 'buyer');
    const b = r.body ?? {};
    const asset = String(b.asset ?? order.pay_asset).toUpperCase();
    if (!['SOL', 'STARS'].includes(asset)) throw bad('asset должен быть SOL или STARS');
    if (!['created', 'awaiting_payment'].includes(order.status)) {
      throw conflict('INVALID_TRANSITION', `заказ уже оплачен или закрыт: ${order.status}`);
    }
    if (order.pay_deadline && new Date(order.pay_deadline) < new Date()) {
      transition(ctx, order, 'expired', 'timer', 'истёк срок оплаты');
      releaseStock(ctx, order);
      throw conflict('INVALID_TRANSITION', 'срок оплаты истёк');
    }
    const lamports = asset === 'SOL' ? order.total_sol : 0;
    const stars = asset === 'STARS' ? order.total_stars : 0;
    if (!lamports && !stars) throw unprocessable('ORDER_NOT_PAYABLE', 'цена товара не задана в выбранном активе');
    requireOps(ctx, r.req, auth, 'order_pay', {
      amountSol: lamports / C.LAMPORTS_PER_SOL, amountStars: stars, totpCode: String(b.totp_code ?? ''),
    });
    const balance = ctx.db.ledger.userBalance(auth.user.id, asset);
    if (balance < (asset === 'STARS' ? stars : lamports)) {
      throw unprocessable('INSUFFICIENT_FUNDS',
        `недостаточно средств: на балансе ${amountStr(asset, balance, balance)}, нужно ${amountStr(asset, lamports, stars)}`);
    }
    order.pay_asset = asset;
    if (asset === 'STARS') {
      order.subtotal_stars = order.items[0].unit_price_stars * order.items[0].qty;
      order.fee_stars = Math.round((order.subtotal_stars * order.fee_bps) / 10000);
      order.total_stars = order.subtotal_stars + order.fee_stars;
      order.subtotal_sol = 0; order.fee_sol = 0; order.total_sol = 0;
    } else {
      order.subtotal_sol = order.items[0].unit_price_sol * order.items[0].qty;
      order.fee_sol = Math.round((order.subtotal_sol * order.fee_bps) / 10000);
      order.total_sol = order.subtotal_sol + order.fee_sol;
      order.subtotal_stars = 0; order.fee_stars = 0; order.total_stars = 0;
    }
    const txId = holdEscrow(ctx, order);
    order.paid_at = new Date().toISOString();
    order.pay_deadline = null;
    order.escrow_account = ACC.escrow(order.id, asset);
    transition(ctx, order, 'paid_escrow', 'buyer', 'оплата получена, средства в эскроу', auth.user.id);

    let delivered = false;
    if (order.delivery_kind === 'auto') {
      delivered = autoDeliver(ctx, order);
      if (delivered) {
        order.delivered_at = new Date().toISOString();
        order.confirm_deadline = new Date(Date.now() + CONFIG.autoConfirmHours * HOUR).toISOString();
        for (const item of order.items) item.delivered_at = order.delivered_at;
        transition(ctx, order, 'delivered', 'system', 'автовыдача цифрового товара', auth.user.id);
      }
    } else {
      const product = findProduct(ctx, order.items[0].product_id);
      order.delivery_deadline = deliveryDeadlineFor(ctx, order, product);
    }

    const shop = ctx.db.shops.get(order.shop_id);
    orderStatusMessage(ctx, order,
      `Оплата получена: ${amountStr(asset, order.total_sol, order.total_stars)} в эскроу.` +
      (delivered ? ' Товар выдан автоматически — проверьте данные и подтвердите заказ.' : ''));
    audit(ctx, r.req, auth.user, 'order.pay', 'order', order.id, `asset=${asset}`, '', null,
      { tx_id: txId, status: order.status, amount: amountStr(asset, order.total_sol, order.total_stars) });
    notify(ctx, shop.admin_user_id, 'order.paid', 'Заказ оплачен',
      `Заказ ${order.number} оплачен (${amountStr(asset, order.total_sol, order.total_stars)}). Средства в эскроу до завершения.`,
      `order-paid:${order.id}`, { order_id: order.id, status: order.status });
    if (delivered) {
      notify(ctx, auth.user.id, 'order.delivered', `Товар выдан: заказ ${order.number}`,
        'Проверьте данные и подтвердите заказ — после этого средства уйдут продавцу.',
        `order:${order.id}:delivered`);
    }
    push(ctx, auth.user.id, 'wallet.updated', { asset, tx_id: txId, balance: ctx.db.ledger.userBalance(auth.user.id, asset) });
    pushOrder(ctx, order, [auth.user.id, ...shopAdmins(ctx, order.shop_id)]);
    return ok({
      ...orderDto(ctx, order, auth.user), tx_id: txId,
      delivered, delivery: delivered ? { available_at: order.delivered_at, url: `/api/v1/orders/${order.id}/delivery` } : null,
    });
  }, { rate: 'payment' }]);

  routes.push(['POST', '/api/v1/orders/:id/processing', (r) => {
    const { auth, order } = loadOrderForUser(ctx, r, 'shop');
    if (!canTransition(order.status, 'processing')) throw conflict('INVALID_TRANSITION', `статус ${order.status} не позволяет перейти в обработку`);
    transition(ctx, order, 'processing', 'shop', 'магазин принял заказ в работу', auth.user.id);
    const product = findProduct(ctx, order.items[0].product_id);
    order.delivery_deadline = deliveryDeadlineFor(ctx, order, product);
    orderStatusMessage(ctx, order, `Магазин принял заказ в работу. Срок выдачи: ${product?.delivery_sla_h ?? 24} ч.`);
    notify(ctx, order.buyer_id, 'order.processing', `Заказ ${order.number} в обработке`,
      'Магазин готовит выдачу', `order:${order.id}:processing`);
    pushOrder(ctx, order, [order.buyer_id, ...shopAdmins(ctx, order.shop_id)]);
    return ok(orderDto(ctx, order, auth.user));
  }, { rate: 'write' }]);

  routes.push(['POST', '/api/v1/orders/:id/deliver', (r) => {
    const { auth, order } = loadOrderForUser(ctx, r, 'shop');
    if (!['paid_escrow', 'processing'].includes(order.status)) {
      throw conflict('INVALID_TRANSITION', `выдача недоступна в статусе ${order.status}`);
    }
    const payload = String(r.body?.payload ?? '').trim();
    for (const item of order.items) {
      const text = payload || (r.body?.items?.[item.id] ? String(r.body.items[item.id]) : '');
      if (!text) throw bad('передайте payload — данные цифрового товара');
      item.delivered_payload_ct = C.encrypt(C.DOMAINS.message, item.id, text);
      item.delivered_at = new Date().toISOString();
      item.stock_item_ids = item.stock_item_ids ?? [];
    }
    order.delivered_at = new Date().toISOString();
    order.confirm_deadline = new Date(Date.now() + CONFIG.autoConfirmHours * HOUR).toISOString();
    order.delivery_deadline = null;
    transition(ctx, order, 'delivered', 'shop', 'товар выдан вручную', auth.user.id);
    orderStatusMessage(ctx, order, `Товар выдан. Подтвердите получение в течение ${CONFIG.autoConfirmHours} ч.`);
    notify(ctx, order.buyer_id, 'order.delivered', `Товар выдан: заказ ${order.number}`,
      `Подтвердите заказ в течение ${CONFIG.autoConfirmHours} часов — иначе завершится автоматически.`,
      `order:${order.id}:delivered`);
    audit(ctx, r.req, auth.user, 'order.deliver', 'order', order.id, '', '', null,
      { items: order.items.length, encrypted: true });
    pushOrder(ctx, order, [order.buyer_id, ...shopAdmins(ctx, order.shop_id)]);
    return ok(orderDto(ctx, order, auth.user));
  }, { rate: 'write' }]);

  routes.push(['GET', '/api/v1/orders/:id/delivery', (r) => {
    const { auth, order, role } = loadOrderForUser(ctx, r, 'buyer');
    if (!order.delivered_at) throw conflict('NOT_DELIVERED', 'товар ещё не выдан');
    const items = order.items.map((item) => {
      const text = C.tryDecrypt(C.DOMAINS.message, item.id, item.delivered_payload_ct);
      item.download_count = (item.download_count ?? 0) + 1;
      return {
        item_id: item.id, product_id: item.product_id, title: item.title, qty: item.qty,
        payload: text ?? '<encrypted>', delivered_at: item.delivered_at,
        download_count: item.download_count,
        watermark: role === 'staff' ? `просмотр арбитром ${auth.user.id} ${new Date().toISOString()}` : null,
        storage_note: 'Данные хранятся зашифрованными (AES-256-GCM) и расшифровываются только для покупателя.',
      };
    });
    if (role === 'staff') {
      audit(ctx, r.req, auth.user, 'order.delivery_view', 'order', order.id, 'arbitration', '', null, null);
    }
    return ok({ order_id: order.id, number: order.number, items, viewed_at: new Date().toISOString() });
  }, { rate: 'public' }]);

  routes.push(['POST', '/api/v1/orders/:id/confirm', (r) => {
    const { auth, order } = loadOrderForUser(ctx, r, 'buyer');
    if (order.status !== 'delivered') throw conflict('INVALID_TRANSITION', `подтверждение недоступно в статусе ${order.status}`);
    transition(ctx, order, 'completed', 'buyer', 'покупатель подтвердил получение', auth.user.id);
    const txId = releaseEscrow(ctx, order, auth.user.id);
    order.completed_at = new Date().toISOString();
    order.confirm_deadline = null;
    finishOrderStats(ctx, order);
    orderStatusMessage(ctx, order, 'Заказ завершён: средства перечислены продавцу.');
    const shop = ctx.db.shops.get(order.shop_id);
    notify(ctx, shop.admin_user_id, 'order.completed', `Заказ ${order.number} завершён`,
      `Средства зачислены: ${amountStr(order.pay_asset, order.total_sol - order.fee_sol, order.total_stars - order.fee_stars)} (комиссия ${order.fee_bps / 100} %).`,
      `order:${order.id}:completed`);
    notify(ctx, auth.user.id, 'review_reminder', 'Оставьте отзыв',
      `${shop.name}: ваш отзыв помогает другим покупателям`, `order:${order.id}:review-reminder`);
    audit(ctx, r.req, auth.user, 'order.confirm', 'order', order.id, '', '', null, { tx_id: txId });
    push(ctx, auth.user.id, 'wallet.updated', { asset: order.pay_asset, tx_id: txId });
    pushMany(ctx, shopAdmins(ctx, order.shop_id), 'wallet.updated', { asset: order.pay_asset, tx_id: txId });
    pushOrder(ctx, order, [order.buyer_id, ...shopAdmins(ctx, order.shop_id)]);
    return ok({ ...orderDto(ctx, order, auth.user), tx_id: txId, review_available: true });
  }, { rate: 'write' }]);

  routes.push(['POST', '/api/v1/orders/:id/extend', (r) => {
    const { auth, order } = loadOrderForUser(ctx, r, 'buyer');
    if (order.status !== 'delivered') throw conflict('INVALID_TRANSITION', 'продление доступно только для выданного заказа');
    if (order.extend_used) throw conflict('ALREADY_EXTENDED', 'срок подтверждения уже продлён один раз');
    order.extend_used = true;
    order.confirm_deadline = new Date(Date.now() + CONFIG.autoConfirmHours * HOUR).toISOString();
    order.updated_at = new Date().toISOString();
    orderStatusMessage(ctx, order, `Срок подтверждения продлён на ${CONFIG.autoConfirmHours} ч.`);
    audit(ctx, r.req, auth.user, 'order.extend', 'order', order.id, '', '', null,
      { confirm_deadline: order.confirm_deadline });
    pushOrder(ctx, order, [order.buyer_id, ...shopAdmins(ctx, order.shop_id)]);
    return ok(orderDto(ctx, order, auth.user));
  }, { rate: 'write' }]);

  routes.push(['POST', '/api/v1/orders/:id/cancel', (r) => {
    const { auth, order, role } = loadOrderForUser(ctx, r, '');
    const reason = truncate(String(r.body?.reason ?? 'отменён участником сделки'), 300);
    if (!['created', 'awaiting_payment', 'paid_escrow'].includes(order.status)) {
      throw conflict('INVALID_TRANSITION', `отмена недоступна в статусе ${order.status}`);
    }
    const paid = !!order.paid_at;
    if (role === 'buyer' && paid) throw conflict('INVALID_TRANSITION', 'оплаченный заказ отменяется через спор или арбитраж');
    if (role === 'shop' && order.status === 'paid_escrow') {
      // Магазин может отменить оплаченный заказ только с возвратом.
      const refund = refundEscrow(ctx, order, 0, auth.user.id);
      order.refund_tx_id = refund.tx_id;
      orderStatusMessage(ctx, order, `Магазин отменил заказ, возврат ${amountStr(order.pay_asset, refund.amount, refund.amount)} выполнен.`);
      push(ctx, order.buyer_id, 'wallet.updated', { asset: order.pay_asset, tx_id: refund.tx_id });
    }
    transition(ctx, order, 'cancelled', role === 'buyer' ? 'buyer' : 'shop', reason, auth.user.id);
    order.cancelled_at = new Date().toISOString();
    order.cancel_reason = reason;
    order.pay_deadline = null;
    releaseStock(ctx, order);
    if (!paid) orderStatusMessage(ctx, order, `Заказ отменён: ${reason}`);
    audit(ctx, r.req, auth.user, 'order.cancel', 'order', order.id, reason, '', null, { paid });
    for (const userId of [order.buyer_id, ...shopAdmins(ctx, order.shop_id)]) {
      if (userId === auth.user.id) continue;
      notify(ctx, userId, 'order.cancelled', `Заказ ${order.number} отменён`, reason,
        `order:${order.id}:cancelled:${userId}`);
    }
    pushOrder(ctx, order, [order.buyer_id, ...shopAdmins(ctx, order.shop_id)]);
    return ok(orderDto(ctx, order, auth.user));
  }, { rate: 'write' }]);

  routes.push(['GET', '/api/v1/orders/:id/history', (r) => {
    const { auth, order } = loadOrderForUser(ctx, r, '');
    return ok({
      order_id: order.id, number: order.number, status: order.status,
      items: ctx.db.orderStatuses
        .filter((ev) => ev.order_id === order.id)
        .map((ev) => ({
          ts: ev.ts, from: ev.from || null, to: ev.to, to_title: statusTitle(ev.to),
          actor_kind: ev.actor_kind, actor_id: ev.actor_id || null, reason: ev.reason || null,
        })),
    });
  }, { rate: 'public' }]);

  // ------------------------------------------------------------------
  // Отзыв по завершённому заказу (FR-REV-01…04)
  // ------------------------------------------------------------------
  routes.push(['POST', '/api/v1/orders/:id/review', (r) => {
    const { auth, order } = loadOrderForUser(ctx, r, 'buyer');
    if (!['completed', 'delivered'].includes(order.status)) {
      throw conflict('INVALID_TRANSITION', 'отзыв можно оставить после завершения заказа');
    }
    if (order.review_id) throw conflict('ALREADY_REVIEWED', 'отзыв уже оставлен');
    const windowMs = CONFIG.reviewWindowDays * 24 * HOUR;
    const finished = order.completed_at ?? order.delivered_at;
    if (finished && Date.now() - new Date(finished).getTime() > windowMs) {
      throw conflict('REVIEW_WINDOW_CLOSED', `окно отзыва закрыто (${CONFIG.reviewWindowDays} дней)`);
    }
    const b = r.body ?? {};
    const rating = Number(b.rating ?? 0);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw bad('оценка от 1 до 5');
    const body = truncate(String(b.body ?? ''), 1000);
    if (body.length < 10) throw bad('опишите опыт покупки (минимум 10 символов)');
    const id = C.newId('rev');
    const review = {
      id, order_id: order.id, shop_id: order.shop_id, product_id: order.items[0]?.product_id ?? '',
      author_id: auth.user.id, rating,
      rating_delivery: clampRating(b.rating_delivery, rating),
      rating_description: clampRating(b.rating_description, rating),
      rating_support: clampRating(b.rating_support, rating),
      body, is_verified_purchase: true, shop_reply: '', shop_reply_at: null,
      status: 'published', helpful_count: 0, created_at: new Date().toISOString(),
    };
    ctx.db.reviews.set(id, review);
    order.review_id = id;
    recalcRating(ctx, order.shop_id);
    const product = ctx.db.products.get(review.product_id);
    if (product) {
      product.rating_sum += rating;
      product.rating_count += 1;
    }
    recalcFeedScores(ctx);
    const shop = ctx.db.shops.get(order.shop_id);
    audit(ctx, r.req, auth.user, 'review.create', 'review', id, '', '', null, { rating, shop_id: order.shop_id });
    notify(ctx, shop.admin_user_id, 'review_new', 'Новый отзыв',
      `${auth.user.nickname.slice(0, 1)}***: ${rating}★ — ${truncate(body, 90)}`, `review:${id}:${shop.admin_user_id}`);
    push(ctx, shop.admin_user_id, 'review.new', { review_id: id, shop_id: order.shop_id, rating });
    return created(reviewDto(ctx, review));
  }, { rate: 'write' }]);

  return routes;
}

function clampRating(value, fallback) {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < 1 || n > 5) return fallback;
  return n;
}

const TRANSITIONS_ALL = {
  created: 1, awaiting_payment: 1, paid_escrow: 1, processing: 1, delivered: 1,
  completed: 1, dispute_opened: 1, in_arbitration: 1, refunded: 1, cancelled: 1, expired: 1,
};
