// Доменная логика preview-сервера: заказы, эскроу, чаты, аренда, рейтинги.
// Повторяет правила Go-бэкенда (backend/internal/api) и приложения G к TZ.
import * as C from './crypto.mjs';
import {
  CONFIG, ApiError, bad, conflict, forbidden, notFound, notify, push, pushMany,
  recalcFeedScores, statusTitle, ledgerError,
} from './lib.mjs';
import { ACC } from './data.mjs';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const TRANSITIONS = {
  created: ['awaiting_payment', 'paid_escrow', 'cancelled', 'expired'],
  awaiting_payment: ['paid_escrow', 'cancelled', 'expired'],
  paid_escrow: ['processing', 'delivered', 'dispute_opened', 'cancelled'],
  processing: ['delivered', 'dispute_opened'],
  delivered: ['completed', 'dispute_opened'],
  dispute_opened: ['in_arbitration', 'completed', 'refunded'],
  in_arbitration: ['completed', 'refunded'],
  completed: ['dispute_opened'],
  refunded: ['dispute_opened'],
  cancelled: [],
  expired: [],
};

export function canTransition(from, to) {
  if (from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function findShop(ctx, idOrSlug) {
  if (!idOrSlug) return null;
  return ctx.db.shops.get(idOrSlug) ?? ctx.db.shops.get(ctx.db.shopsBySlug.get(idOrSlug)) ?? null;
}

export function findProduct(ctx, id) {
  return ctx.db.products.get(id) ?? null;
}

export function findOrder(ctx, idOrNumber) {
  if (!idOrNumber) return null;
  return ctx.db.orders.get(idOrNumber) ?? ctx.db.orders.get(ctx.db.ordersByNumber.get(idOrNumber)) ?? null;
}

export function orderNumber(ctx) {
  const n = 1000 + ctx.db.orders.size + 1;
  return `SITEE-${n}`;
}

export function appendStatus(ctx, orderId, from, to, actorKind, reason = '', actorId = '') {
  ctx.db.orderStatuses.push({
    order_id: orderId, from, to, actor_kind: actorKind, actor_id: actorId,
    reason, ts: new Date().toISOString(),
  });
}

export function transition(ctx, order, to, actorKind, reason = '', actorId = '') {
  if (!canTransition(order.status, to)) {
    throw conflict('INVALID_TRANSITION',
      `переход ${order.status} → ${to} запрещён машиной состояний`);
  }
  const from = order.status;
  if (from !== to) {
    order.status = to;
    order.updated_at = new Date().toISOString();
    appendStatus(ctx, order.id, from, to, actorKind, reason, actorId);
  }
  return order;
}

// ---------------------------------------------------------------------------
// Сток: резервирование, выдача, возврат
// ---------------------------------------------------------------------------
export function reserveStock(ctx, order, product, qty) {
  const items = ctx.db.stock.get(product.id) ?? [];
  const taken = [];
  for (const item of items) {
    if (taken.length >= qty) break;
    if (item.status === 'free') {
      item.status = 'reserved';
      item.reserved_by = order.id;
      taken.push(item);
    }
  }
  if (taken.length < qty) {
    for (const item of taken) {
      item.status = 'free';
      item.reserved_by = '';
    }
    return null;
  }
  return taken;
}

export function releaseStock(ctx, order) {
  for (const item of order.items) {
    for (const id of item.stock_item_ids ?? []) {
      const si = (ctx.db.stock.get(item.product_id) ?? []).find((x) => x.id === id);
      if (si && si.status === 'reserved') {
        si.status = 'free';
        si.reserved_by = '';
      }
    }
  }
  for (const product of ctx.db.products.values()) {
    const items = ctx.db.stock.get(product.id) ?? [];
    product.stock_free = items.filter((i) => i.status === 'free').length;
    product.stock_total = items.length;
  }
}

export function autoDeliver(ctx, order) {
  let deliveredAll = true;
  for (const item of order.items) {
    const items = ctx.db.stock.get(item.product_id) ?? [];
    const reserved = items.filter((i) => i.reserved_by === order.id && i.status === 'reserved');
    if (reserved.length < item.qty) {
      deliveredAll = false;
      continue;
    }
    const payload = reserved.map((si) => {
      si.status = 'sold';
      si.sold_at = new Date().toISOString();
      item.stock_item_ids.push(si.id);
      return C.tryDecrypt(C.DOMAINS.stock, si.id, si.payload_ct) ?? '';
    }).join('\n---\n');
    // Перешифрование в домен msg под позицию заказа (docs/security.md §3.2).
    item.delivered_payload_ct = C.encrypt(C.DOMAINS.message, item.id, payload);
    item.delivered_at = new Date().toISOString();
  }
  return deliveredAll;
}

// ---------------------------------------------------------------------------
// Эскроу
// ---------------------------------------------------------------------------
export function holdEscrow(ctx, order) {
  const asset = order.pay_asset;
  const total = asset === 'STARS' ? order.total_stars : order.total_sol;
  if (total <= 0) throw bad('сумма заказа должна быть больше нуля');
  ctx.db.ledger.ensure('user', order.buyer_id, asset);
  ctx.db.ledger.ensure('escrow', order.id, asset);
  const res = ctx.db.ledger.post(`hold:${order.id}`, asset, 'order_hold', 'order', order.id, order.buyer_id, [
    ctx.db.ledger.debit(ACC.user(order.buyer_id, asset), total),
    ctx.db.ledger.credit(ACC.escrow(order.id, asset), total),
  ]);
  if (res.error) throw ledgerError(res.error);
  return res.tx_id;
}

export function releaseEscrow(ctx, order, actorId = '') {
  const asset = order.pay_asset;
  const total = asset === 'STARS' ? order.total_stars : order.total_sol;
  if (total <= 0) return '';
  const fee = asset === 'STARS' ? order.fee_stars : order.fee_sol;
  ctx.db.ledger.ensure('escrow', order.id, asset);
  ctx.db.ledger.ensure('shop', order.shop_id, asset);
  ctx.db.ledger.ensure('platform', 'fees', asset);
  const postings = [ctx.db.ledger.debit(ACC.escrow(order.id, asset), total)];
  if (total - fee > 0) postings.push(ctx.db.ledger.credit(ACC.shop(order.shop_id, asset), total - fee));
  if (fee > 0) postings.push(ctx.db.ledger.credit(ACC.platform('fees', asset), fee));
  const res = ctx.db.ledger.post(`release:${order.id}`, asset, 'order_release', 'order', order.id, actorId, postings);
  if (res.error) return '';
  return res.tx_id;
}

export function refundEscrow(ctx, order, amount, actorId = '') {
  const asset = order.pay_asset;
  const total = asset === 'STARS' ? order.total_stars : order.total_sol;
  const value = amount > 0 && amount <= total ? amount : total;
  ctx.db.ledger.ensure('escrow', order.id, asset);
  ctx.db.ledger.ensure('user', order.buyer_id, asset);
  const res = ctx.db.ledger.post(`refund:${order.id}:${value}`, asset, 'refund', 'order', order.id, actorId, [
    ctx.db.ledger.debit(ACC.escrow(order.id, asset), value),
    ctx.db.ledger.credit(ACC.user(order.buyer_id, asset), value),
  ]);
  if (res.error) throw ledgerError(res.error);
  return { tx_id: res.tx_id, amount: value };
}

export function finishOrderStats(ctx, order) {
  const shop = ctx.db.shops.get(order.shop_id);
  if (!shop) return;
  shop.sales_count += order.items.reduce((acc, it) => acc + it.qty, 0);
  shop.sales_volume_sol += order.total_sol;
  for (const product of ctx.db.products.values()) {
    const items = ctx.db.stock.get(product.id) ?? [];
    product.stock_total = items.length;
    product.stock_free = items.filter((i) => i.status === 'free').length;
  }
  recalcDisputeRate(ctx, shop);
  recalcFeedScores(ctx);
}

export function recalcDisputeRate(ctx, shop) {
  let total = 0;
  let disputed = 0;
  for (const order of ctx.db.orders.values()) {
    if (order.shop_id !== shop.id) continue;
    total += 1;
    if (order.dispute_id) disputed += 1;
  }
  shop.dispute_rate = total ? disputed / total : 0;
}

// ---------------------------------------------------------------------------
// Чаты
// ---------------------------------------------------------------------------
export function addMember(ctx, chatId, userId, role, visibleAs = '') {
  if (!userId) return;
  const list = ctx.db.members.get(chatId) ?? [];
  const existing = list.find((m) => m.user_id === userId);
  if (existing) {
    if (role) existing.role = role;
    if (visibleAs) existing.visible_as = visibleAs;
    return;
  }
  list.push({
    chat_id: chatId, user_id: userId, role, visible_as: visibleAs,
    joined_at: new Date().toISOString(), left_at: null, last_read_seq: 0,
    muted: false, blocked: false,
  });
  ctx.db.members.set(chatId, list);
}

export function isMember(ctx, chatId, userId) {
  return (ctx.db.members.get(chatId) ?? []).some((m) => m.user_id === userId && !m.left_at);
}

export function addMessage(ctx, chat, sender, text, { type = 'text', system = null, e2ee = false, bodyCt = '', clientMsgId = '', visibleAs = '' } = {}) {
  chat.last_seq = (chat.last_seq ?? 0) + 1;
  const id = C.newId('msg');
  const msg = {
    id, chat_id: chat.id, seq: chat.last_seq, sender_id: sender?.id ?? '',
    sender_visible_as: visibleAs || sender?.nickname || 'Система', type,
    body_ct: e2ee ? bodyCt : C.encrypt(C.DOMAINS.message, id, text),
    body_size: e2ee ? (bodyCt?.length ?? 0) : text.length,
    e2ee, client_msg_id: clientMsgId, created_at: new Date().toISOString(), system,
  };
  if (!ctx.db.messages.has(chat.id)) ctx.db.messages.set(chat.id, []);
  ctx.db.messages.get(chat.id).push(msg);
  chat.last_message_at = msg.created_at;
  chat.last_preview = e2ee ? '<encrypted>' : String(text).slice(0, 80);
  return msg;
}

export function systemMessage(ctx, chat, text, extra = {}) {
  return addMessage(ctx, chat, null, text, { type: 'system', system: { kind: 'system', title: text, ...extra } });
}

export function broadcastMessage(ctx, chat, msg, senderUser) {
  const members = ctx.db.members.get(chat.id) ?? [];
  const payload = {
    chat_id: chat.id, id: msg.id, seq: msg.seq, type: msg.type,
    sender_id: msg.sender_id, sender_visible_as: msg.sender_visible_as,
    e2ee: !!msg.e2ee, created_at: msg.created_at, client_msg_id: msg.client_msg_id || undefined,
    chat_kind: chat.kind, shop_id: chat.shop_id || undefined, order_id: chat.order_id || undefined,
  };
  if (msg.e2ee) {
    payload.body_ct = msg.body_ct;
  } else {
    payload.body = C.tryDecrypt(C.DOMAINS.message, msg.id, msg.body_ct) ?? '';
    payload.body_stored_encrypted = true;
  }
  if (msg.system) payload.system = msg.system;
  pushMany(ctx, members.map((m) => m.user_id), 'msg.new', payload);
}

export function chatPeers(ctx, chatId, excludeUserId) {
  return (ctx.db.members.get(chatId) ?? [])
    .filter((m) => m.user_id !== excludeUserId && !m.left_at)
    .map((m) => m.user_id);
}

export function ensureShopChannel(ctx, shop, admin) {
  for (const chat of ctx.db.chats.values()) {
    if (chat.kind === 'channel' && chat.shop_id === shop.id) return chat;
  }
  const chat = {
    id: C.newId('cht'), kind: 'channel', title: `${shop.name} · анонсы`, shop_id: shop.id,
    admin_user_id: shop.admin_user_id, e2ee: false, last_seq: 0,
    created_at: new Date().toISOString(),
  };
  ctx.db.chats.set(chat.id, chat);
  ctx.db.messages.set(chat.id, []);
  addMember(ctx, chat.id, admin?.id ?? shop.admin_user_id, 'owner');
  systemMessage(ctx, chat, 'Канал магазина создан. Публикуйте анонсы и акции.');
  return chat;
}

export function openSupportChat(ctx, shop, buyer) {
  for (const chat of ctx.db.chats.values()) {
    if (chat.kind === 'shop_support' && chat.shop_id === shop.id && !chat.closed_at &&
      isMember(ctx, chat.id, buyer.id)) return chat;
  }
  const chat = {
    id: C.newId('cht'), kind: 'shop_support', title: `${shop.name} · поддержка`, shop_id: shop.id,
    admin_user_id: shop.admin_user_id, e2ee: false, last_seq: 0,
    created_at: new Date().toISOString(),
  };
  ctx.db.chats.set(chat.id, chat);
  ctx.db.messages.set(chat.id, []);
  addMember(ctx, chat.id, shop.admin_user_id, 'admin', 'Админ магазина');
  if (buyer.id !== shop.admin_user_id) addMember(ctx, chat.id, buyer.id, 'member');
  for (const op of shop.operators ?? []) addMember(ctx, chat.id, op, 'operator');
  systemMessage(ctx, chat, `Диалог открыт с админом магазина «${shop.name}». Все обращения маршрутизируются владельцу.`);
  return chat;
}

export function openOrderChat(ctx, order, shop, buyer) {
  if (order.chat_id && ctx.db.chats.get(order.chat_id)) return ctx.db.chats.get(order.chat_id);
  for (const chat of ctx.db.chats.values()) {
    if (chat.kind === 'order' && chat.order_id === order.id) {
      order.chat_id = chat.id;
      return chat;
    }
  }
  const chat = {
    id: C.newId('cht'), kind: 'order', title: `Заказ ${order.number}`, shop_id: shop.id,
    order_id: order.id, admin_user_id: shop.admin_user_id, e2ee: false, last_seq: 0,
    created_at: new Date().toISOString(),
  };
  ctx.db.chats.set(chat.id, chat);
  ctx.db.messages.set(chat.id, []);
  addMember(ctx, chat.id, shop.admin_user_id, 'admin', 'Админ магазина');
  addMember(ctx, chat.id, buyer.id, 'member');
  order.chat_id = chat.id;
  systemMessage(ctx, chat, `Заказ ${order.number} создан. Все вопросы — админу магазина.`,
    { kind: 'order_status', order_id: order.id, status: order.status });
  return chat;
}

export function orderStatusMessage(ctx, order, text) {
  const chat = ctx.db.chats.get(order.chat_id);
  if (!chat) return null;
  const msg = systemMessage(ctx, chat, text, { kind: 'order_status', order_id: order.id, status: order.status });
  broadcastMessage(ctx, chat, msg, null);
  return msg;
}

// ---------------------------------------------------------------------------
// Аренда
// ---------------------------------------------------------------------------
export function planByCode(ctx, code) {
  for (const plan of ctx.db.rentPlans.values()) {
    if (plan.code === code) return plan;
  }
  return null;
}

export function shopCount(ctx, userId) {
  return [...ctx.db.shops.values()].filter((sh) => sh.admin_user_id === userId).length;
}

// ---------------------------------------------------------------------------
// Отзывы и рейтинг
// ---------------------------------------------------------------------------
export function recalcRating(ctx, shopId) {
  const shop = ctx.db.shops.get(shopId);
  if (!shop) return;
  let sum = 0;
  let count = 0;
  for (const rv of ctx.db.reviews.values()) {
    if (rv.shop_id !== shopId || rv.status !== 'published') continue;
    sum += rv.rating;
    count += 1;
  }
  shop.rating_sum = sum;
  shop.rating_count = count;
  shop.rating_bayes = (10 * 3.8 + sum) / (10 + count);
  recalcFeedScores(ctx);
}

export function reviewSummary(ctx, shopId) {
  const list = [...ctx.db.reviews.values()].filter((r) => r.shop_id === shopId && r.status === 'published');
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const rv of list) distribution[rv.rating] = (distribution[rv.rating] ?? 0) + 1;
  const shop = ctx.db.shops.get(shopId);
  const positive = list.filter((r) => r.rating >= 4).length;
  return {
    bayes: Number((shop?.rating_bayes ?? 3.8).toFixed(2)),
    count: list.length,
    positive_pct: list.length ? Math.round((positive / list.length) * 100) : 0,
    distribution,
  };
}

// ---------------------------------------------------------------------------
// Споры
// ---------------------------------------------------------------------------
export function pickArbiter(ctx, dispute) {
  const excluded = new Set([dispute.buyer_id, dispute.seller_id, dispute.opened_by]);
  const shop = ctx.db.shops.get(dispute.shop_id);
  for (const op of shop?.operators ?? []) excluded.add(op);
  let best = null;
  let bestLoad = Infinity;
  for (const user of ctx.db.users.values()) {
    if (excluded.has(user.id)) continue;
    if (!['arbiter', 'moderator', 'superadmin'].includes(user.role)) continue;
    const load = [...ctx.db.disputes.values()]
      .filter((d) => d.arbiter_id === user.id && !['resolved', 'dismissed', 'closed'].includes(d.status)).length;
    if (load < bestLoad) {
      best = user.id;
      bestLoad = load;
    }
  }
  return best ?? '';
}

// Старший арбитр для апелляции: исключаем предыдущего арбитра и стороны (FR-DSP-08).
export function pickSeniorArbiter(ctx, dispute) {
  const excluded = new Set([
    dispute.buyer_id, dispute.seller_id, dispute.opened_by, dispute.arbiter_id,
  ]);
  const shop = ctx.db.shops.get(dispute.shop_id);
  for (const op of shop?.operators ?? []) excluded.add(op);
  let best = null;
  let bestLoad = Infinity;
  for (const user of ctx.db.users.values()) {
    if (excluded.has(user.id)) continue;
    if (!['arbiter', 'moderator', 'superadmin'].includes(user.role)) continue;
    const load = [...ctx.db.disputes.values()]
      .filter((d) => d.arbiter_id === user.id && !['resolved', 'dismissed', 'closed'].includes(d.status)).length;
    if (load < bestLoad) {
      best = user.id;
      bestLoad = load;
    }
  }
  return best ?? '';
}

export function arbiterPool(ctx) {
  return [...ctx.db.users.values()]
    .filter((u) => ['arbiter', 'moderator', 'superadmin'].includes(u.role) && u.status === 'active')
    .map((u) => u.id)
    .sort();
}

export function shopAdmins(ctx, shopId) {
  const shop = ctx.db.shops.get(shopId);
  if (!shop) return [];
  return [shop.admin_user_id, ...(shop.operators ?? [])].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Таймеры (эквивалент backend/internal/api/jobs.go)
// ---------------------------------------------------------------------------
// plural — русская форма числительного: 1 день, 2 дня, 5 дней.
export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

// dateOnly — дата в формате ДД.ММ.ГГГГ (для текстов уведомлений).
export function dateOnly(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function runTimers(ctx) {
  const now = Date.now();
  let touched = 0;

  for (const order of ctx.db.orders.values()) {
    if (['created', 'awaiting_payment'].includes(order.status) && order.pay_deadline &&
      now > new Date(order.pay_deadline).getTime()) {
      if (canTransition(order.status, 'expired')) {
        transition(ctx, order, 'expired', 'timer', `истёк срок оплаты (${CONFIG.payTimeoutMinutes} мин)`);
        releaseStock(ctx, order);
        orderStatusMessage(ctx, order, 'Заказ отменён: срок оплаты истёк.');
        notify(ctx, order.buyer_id, 'order_expired', `Заказ ${order.number} отменён`,
          'Срок оплаты истёк, товар возвращён в продажу', `order:${order.id}:expired`);
        push(ctx, order.buyer_id, 'order.updated', { order_id: order.id, status: 'expired' });
        touched += 1;
      }
    }
    if (order.status === 'delivered' && order.confirm_deadline &&
      now > new Date(order.confirm_deadline).getTime() && !order.dispute_id) {
      if (canTransition(order.status, 'completed')) {
        transition(ctx, order, 'completed', 'timer', `автоподтверждение через ${CONFIG.autoConfirmHours} ч`);
        const tx = releaseEscrow(ctx, order);
        order.completed_at = new Date().toISOString();
        order.confirm_deadline = null;
        finishOrderStats(ctx, order);
        orderStatusMessage(ctx, order, 'Заказ завершён автоматически: средства перечислены продавцу.');
        notify(ctx, order.buyer_id, 'order_completed', `Заказ ${order.number} завершён`,
          'Оставьте отзыв — это помогает другим покупателям', `order:${order.id}:completed`);
        pushMany(ctx, [order.buyer_id, ...shopAdmins(ctx, order.shop_id)], 'order.updated',
          { order_id: order.id, status: 'completed', tx_id: tx });
        touched += 1;
      }
    }
  }

  for (const dispute of ctx.db.disputes.values()) {
    if (['open', 'awaiting_reply'].includes(dispute.status) && dispute.reply_deadline &&
      now > new Date(dispute.reply_deadline).getTime()) {
      dispute.status = 'in_arbitration';
      dispute.arbiter_id = pickArbiter(ctx, dispute);
      dispute.assigned_at = new Date().toISOString();
      dispute.resolve_deadline = new Date(now + 7 * 24 * HOUR).toISOString();
      dispute.timeline.push({
        ts: dispute.assigned_at, kind: 'auto_escalated', actor_visible_as: 'Система',
        note: 'срок ответа истёк — спор передан арбитру автоматически',
      });
      const order = ctx.db.orders.get(dispute.order_id);
      if (order && canTransition(order.status, 'in_arbitration')) {
        transition(ctx, order, 'in_arbitration', 'timer', 'истёк срок ответа в споре');
      }
      for (const userId of [dispute.buyer_id, dispute.seller_id]) {
        notify(ctx, userId, 'dispute_escalated', 'Спор передан арбитру', 'Срок ответа истёк',
          `dispute:${dispute.id}:auto:${userId}`);
      }
      touched += 1;
    }
  }

  for (const [shopId, sub] of ctx.db.subs) {
    const shop = ctx.db.shops.get(shopId);
    if (!shop) continue;
    const from = sub.status;
    const end = sub.period_end ? new Date(sub.period_end).getTime() : 0;
    if (['trial', 'active', 'expiring'].includes(sub.status) && end) {
      if (now > end - 72 * HOUR && sub.status !== 'expiring') sub.status = 'expiring';
      if (now > end) {
        sub.status = 'grace';
        sub.grace_end = new Date(now + 72 * HOUR).toISOString();
      }
    }
    if (sub.status === 'grace' && sub.grace_end && now > new Date(sub.grace_end).getTime()) {
      sub.status = 'suspended';
      shop.status = 'suspended';
    }
    if (sub.status !== from) {
      sub.updated_at = new Date().toISOString();
      notify(ctx, shop.admin_user_id, `rent_${sub.status}`, rentTitle(sub.status),
        `${shop.name}: ${rentBody(sub.status, sub.period_end)}`, `rent:${shopId}:${sub.status}:${sub.period_end}`);
      push(ctx, shop.admin_user_id, 'rent.updated', { shop_id: shopId, status: sub.status });
      touched += 1;
    }
    // FR-SHOP-05: напоминания T-5/3/1 суток до окончания аренды, по одному на порог.
    if (['trial', 'active', 'expiring'].includes(sub.status) && end) {
      sub.rent_reminders ??= {};
      for (const days of [5, 3, 1]) {
        const threshold = end - days * DAY;
        if (now > threshold && !sub.rent_reminders[days]) {
          sub.rent_reminders[days] = new Date(now).toISOString();
          notify(ctx, shop.admin_user_id, 'rent_reminder',
            `Аренда «${shop.name}» истекает через ${days} ${plural(days, 'день', 'дня', 'дней')}`,
            `До ${dateOnly(sub.period_end)} осталось ${days} ${plural(days, 'день', 'дня', 'дней')}. `
            + 'Продлите аренду, иначе магазин уйдёт в grace на 72 часа, а новые заказы будут запрещены.',
            `rent:${shopId}:remind:${days}:${sub.period_end}`);
          touched += 1;
        }
      }
    }
  }

  for (const shop of ctx.db.shops.values()) {
    if (shop.gift_boost > 0 && shop.gift_boost_until && now > new Date(shop.gift_boost_until).getTime()) {
      shop.gift_boost = 0;
      shop.gift_boost_until = null;
      touched += 1;
    }
  }
  if (touched > 0) recalcFeedScores(ctx);
  return touched;
}

function rentTitle(status) {
  return {
    expiring: 'Аренда магазина истекает', grace: 'Grace-период аренды (72 часа)',
    suspended: 'Магазин приостановлен', active: 'Аренда продлена',
  }[status] ?? 'Статус аренды изменён';
}

function rentBody(status, periodEnd) {
  const date = periodEnd ? new Date(periodEnd).toLocaleDateString('ru-RU') : '';
  return {
    expiring: `Период до ${date}. Продлите, чтобы сохранить место в ленте.`,
    grace: 'Оплата не прошла. Магазин останется в ленте ещё 72 часа.',
    suspended: 'Магазин скрыт из ленты: аренда не продлена. Оплатите тариф, чтобы вернуть магазин.',
    active: `Новый период до ${date}.`,
  }[status] ?? '';
}

export function deliveryDeadlineFor(ctx, order, product) {
  const hours = product?.delivery_sla_h ?? 24;
  return new Date(Date.now() + hours * HOUR).toISOString();
}

export function statusTitleRu(status) {
  return statusTitle(status);
}

export { ApiError, HOUR };
