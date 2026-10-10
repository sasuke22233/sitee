// Роуты споров: открытие, список, детали, эскалация арбитру, resolution, доказательства.
// Соответствует docs/api.md §10, docs/orders-disputes.md §3 и FR-DSP-* (маскировка сторон).
import crypto from 'node:crypto';
import * as C from './crypto.mjs';
import {
  CONFIG, bad, conflict, forbidden, notFound, unprocessable,
  ok, created, paginate, truncate, disputeDto, maskDisputeText, statusTitle,
  requireAuth, requireOps, audit, notify, push, pushMany,
} from './lib.mjs';
import { ACC, aliasFor } from './data.mjs';
import {
  findOrder, findShop, transition, canTransition, releaseEscrow, refundEscrow,
  addMember, addMessage, broadcastMessage, systemMessage, shopAdmins,
  pickArbiter, pickSeniorArbiter, arbiterPool, finishOrderStats, orderStatusMessage, HOUR,
} from './domain.mjs';

const REASONS = {
  not_delivered: 'Товар не доставлен',
  wrong_item: 'Прислали не тот товар',
  invalid_key: 'Ключ/аккаунт не работает',
  duplicate: 'Товар уже использован (дубликат)',
  partial: 'Поставка неполная',
  quality: 'Качество не соответствует описанию',
  fraud: 'Признаки мошенничества',
  refund_request: 'Запрос возврата',
  other: 'Другое',
};

const RESOLUTIONS = ['refund_buyer', 'release_seller', 'partial', 'dismiss'];

export function disputeRoutes(ctx) {
  const routes = [];

  // ------------------------------------------------------------------
  // Открытие спора покупателем (FR-DSP-01…04)
  // ------------------------------------------------------------------
  routes.push(['POST', '/api/v1/orders/:id/dispute', (r) => {
    const auth = requireAuth(ctx, r.req);
    const order = findOrder(ctx, r.params.id);
    if (!order) throw notFound('заказ не найден');
    if (order.buyer_id !== auth.user.id) throw forbidden('FORBIDDEN', 'спор открывает покупатель заказа');
    if (order.dispute_id) throw conflict('DISPUTE_EXISTS', 'спор по заказу уже открыт');
    if (!['paid_escrow', 'processing', 'delivered', 'completed'].includes(order.status)) {
      throw conflict('INVALID_TRANSITION', `спор недоступен в статусе ${statusTitle(order.status)}`);
    }
    const anchor = order.delivered_at ?? order.paid_at ?? order.created_at;
    if (anchor && Date.now() - new Date(anchor).getTime() > CONFIG.disputeWindowDays * 24 * HOUR) {
      throw conflict('DISPUTE_WINDOW_CLOSED', `окно спора закрыто (${CONFIG.disputeWindowDays} дней)`);
    }
    const b = r.body ?? {};
    const reasonCode = String(b.reason_code ?? '');
    if (!REASONS[reasonCode]) throw bad('некорректная причина спора', { reasons: Object.keys(REASONS) });
    const description = truncate(String(b.description ?? ''), 2000);
    if (description.length < 20) throw bad('опишите проблему подробнее (минимум 20 символов)');
    requireOps(ctx, r.req, auth, 'dispute_open', { totpCode: String(b.totp_code ?? '') });

    const shop = findShop(ctx, order.shop_id);
    const seller = ctx.db.users.get(shop.admin_user_id);
    const salt = C.hex(16);
    const disputeId = C.newId('dsp');
    const buyerAlias = aliasFor(salt, auth.user.id, 'buyer');
    const sellerAlias = aliasFor(salt, seller.id, 'shop');
    const now = new Date().toISOString();

    const chat = {
      id: C.newId('cht'), kind: 'dispute', title: `Спор по заказу ${order.number}`,
      shop_id: shop.id, order_id: order.id, dispute_id: disputeId,
      admin_user_id: shop.admin_user_id, e2ee: false, pinned: true, last_seq: 0,
      created_at: now, closed_at: null,
    };
    ctx.db.chats.set(chat.id, chat);
    ctx.db.messages.set(chat.id, []);
    // Маскировка: каждая сторона видит псевдоним оппонента, арбитр — реальные ID.
    addMember(ctx, chat.id, auth.user.id, 'member', buyerAlias);
    addMember(ctx, chat.id, seller.id, 'admin', sellerAlias);

    const dispute = {
      id: disputeId, order_id: order.id, shop_id: shop.id, opened_by: auth.user.id,
      reason_code: reasonCode, description: maskDisputeText(description), status: 'open',
      buyer_id: auth.user.id, seller_id: seller.id, buyer_alias: buyerAlias, seller_alias: sellerAlias,
      arbiter_id: '', assigned_at: null, salt, chat_id: chat.id,
      reply_deadline: new Date(Date.now() + CONFIG.disputeReplyHours * HOUR).toISOString(),
      resolve_deadline: null, resolution: '', resolution_reason: '', resolved_at: null,
      evidence: [], timeline: [{
        ts: now, kind: 'opened', actor_id: auth.user.id, actor_visible_as: buyerAlias,
        note: REASONS[reasonCode],
      }],
      created_at: now, updated_at: now,
    };
    ctx.db.disputes.set(disputeId, dispute);
    order.dispute_id = disputeId;
    transition(ctx, order, 'dispute_opened', 'buyer', `спор: ${REASONS[reasonCode]}`, auth.user.id);

    addMessage(ctx, chat, null,
      'Спор открыт. Личные данные скрыты: стороны видят псевдонимы. Ответ продавца ожидается в течение 72 часов, затем спор автоматически уходит арбитру.',
      { type: 'system', system: { kind: 'dispute', order_id: order.id, dispute_id: disputeId, title: 'Спор открыт' } });
    addMessage(ctx, chat, auth.user, dispute.description, { visibleAs: buyerAlias });
    orderStatusMessage(ctx, order, `Открыт спор: ${REASONS[reasonCode]}.`);

    audit(ctx, r.req, auth.user, 'dispute.open', 'dispute', disputeId, REASONS[reasonCode], '', null,
      { order_id: order.id, shop_id: shop.id, reason_code: reasonCode });
    notify(ctx, seller.id, 'dispute_opened', `Спор по заказу ${order.number}`,
      `${REASONS[reasonCode]}. Ответьте в течение ${CONFIG.disputeReplyHours} ч, иначе спор уйдёт арбитру.`,
      `dispute:${disputeId}:${seller.id}`, { dispute_id: disputeId, order_id: order.id });
    push(ctx, seller.id, 'dispute.opened', { dispute_id: disputeId, order_id: order.id, chat_id: chat.id, reason: reasonCode });
    push(ctx, auth.user.id, 'dispute.opened', { dispute_id: disputeId, order_id: order.id, chat_id: chat.id, reason: reasonCode });
    return created(disputeDto(ctx, dispute, auth.user));
  }, { rate: 'write' }]);

  routes.push(['GET', '/api/v1/disputes', (r) => {
    const auth = requireAuth(ctx, r.req);
    const roleParam = String(r.query.role ?? 'mine');
    const statusParam = String(r.query.status ?? '');
    const limit = Math.min(50, Math.max(1, Number(r.query.limit ?? 20)));
    const staff = ['arbiter', 'moderator', 'superadmin'].includes(auth.user.role);
    let items = [...ctx.db.disputes.values()].filter((d) => {
      if (roleParam === 'arbiter') return staff && (d.arbiter_id === auth.user.id || !d.arbiter_id);
      if (roleParam === 'all' && staff) return true;
      return d.buyer_id === auth.user.id || d.seller_id === auth.user.id ||
        (staff && d.arbiter_id === auth.user.id);
    });
    if (statusParam) items = items.filter((d) => d.status === statusParam);
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const page = paginate(items.map((d) => disputeDto(ctx, d, auth.user)), limit, r.query.cursor);
    const counts = {};
    for (const d of items) counts[d.status] = (counts[d.status] ?? 0) + 1;
    return ok({ ...page, counts, reason_codes: REASONS });
  }, { rate: 'public' }]);

  routes.push(['GET', '/api/v1/disputes/:id', (r) => {
    const auth = requireAuth(ctx, r.req);
    const dispute = ctx.db.disputes.get(r.params.id);
    if (!dispute) throw notFound('спор не найден');
    const staff = ['arbiter', 'moderator', 'superadmin'].includes(auth.user.role);
    const participant = dispute.buyer_id === auth.user.id || dispute.seller_id === auth.user.id;
    if (!participant && !(staff && (dispute.arbiter_id === auth.user.id || dispute.arbiter_id === ''))) {
      throw forbidden('FORBIDDEN', 'доступ к спору есть только у сторон и назначенного арбитра');
    }
    const dto = disputeDto(ctx, dispute, auth.user);
    const chat = ctx.db.chats.get(dispute.chat_id);
    dto.chat = chat ? {
      id: chat.id, title: chat.title, kind: chat.kind, e2ee: false,
      messages: (ctx.db.messages.get(chat.id) ?? []).slice(-30).map((m) => ({
        id: m.id, seq: m.seq, type: m.type, sender_visible_as: m.sender_visible_as,
        sender_id: m.sender_id === auth.user.id ? auth.user.id : '',
        body: C.tryDecrypt(C.DOMAINS.message, m.id, m.body_ct) ?? '',
        created_at: m.created_at, system: m.system ?? undefined,
      })),
    } : null;
    dto.order = (() => {
      const order = ctx.db.orders.get(dispute.order_id);
      return order ? {
        id: order.id, number: order.number, status: order.status, status_title: statusTitle(order.status),
        pay_asset: order.pay_asset,
        total: order.pay_asset === 'STARS' ? `${order.total_stars} ⭐` : `${C.formatSol(order.total_sol)} SOL`,
        total_raw: order.pay_asset === 'STARS' ? order.total_stars : order.total_sol,
        escrow_balance: order.pay_asset === 'STARS'
          ? ctx.db.ledger.balance(ACC.escrow(order.id, 'STARS'))
          : C.formatSol(ctx.db.ledger.balance(ACC.escrow(order.id, 'SOL'))),
      } : null;
    })();
    dto.deadlines = {
      reply: dispute.reply_deadline, resolve: dispute.resolve_deadline,
      hours_left: dispute.reply_deadline && dispute.status === 'open'
        ? Math.max(0, Math.round((new Date(dispute.reply_deadline) - Date.now()) / HOUR)) : null,
    };
    dto.arbitration_notice = staff
      ? 'Вы видите реальные ID сторон. Любое раскрытие фиксируется в аудит-логе (dispute.reveal).'
      : 'Личные данные сторон скрыты. Арбитр видит обе стороны и отвечает за решение.';
    return ok(dto);
  }, { rate: 'public' }]);

  // ------------------------------------------------------------------
  // Эскалация: приглашение арбитра (FR-DSP-06…08)
  // ------------------------------------------------------------------
  routes.push(['POST', '/api/v1/disputes/:id/escalate', (r) => {
    const auth = requireAuth(ctx, r.req);
    const dispute = ctx.db.disputes.get(r.params.id);
    if (!dispute) throw notFound('спор не найден');
    const isBuyer = dispute.buyer_id === auth.user.id;
    const isSeller = dispute.seller_id === auth.user.id;
    const staff = ['arbiter', 'moderator', 'superadmin'].includes(auth.user.role);
    if (!isBuyer && !isSeller && !staff) throw forbidden('FORBIDDEN', 'эскалировать спор могут только стороны');
    if (dispute.status === 'in_arbitration' && !staff) throw conflict('ALREADY_ESCALATED', 'спор уже в арбитраже');
    if (['resolved', 'dismissed', 'closed'].includes(dispute.status)) throw conflict('DISPUTE_CLOSED', 'спор закрыт');
    const reason = truncate(String(r.body?.reason ?? 'сторона запросила арбитра'), 500);
    if (!dispute.arbiter_id) dispute.arbiter_id = pickArbiter(ctx, dispute);
    dispute.status = 'in_arbitration';
    dispute.assigned_at = new Date().toISOString();
    dispute.resolve_deadline = new Date(Date.now() + 7 * 24 * HOUR).toISOString();
    dispute.updated_at = new Date().toISOString();
    dispute.timeline.push({
      ts: dispute.assigned_at, kind: 'escalated', actor_id: auth.user.id,
      actor_visible_as: isBuyer ? dispute.buyer_alias : isSeller ? dispute.seller_alias : 'Арбитр',
      note: reason,
    });
    const order = ctx.db.orders.get(dispute.order_id);
    if (order && canTransition(order.status, 'in_arbitration')) {
      transition(ctx, order, 'in_arbitration', isBuyer ? 'buyer' : 'shop', 'спор передан арбитру', auth.user.id);
      orderStatusMessage(ctx, order, 'Спор передан арбитру. Решение — в течение 7 дней.');
    }
    const chat = ctx.db.chats.get(dispute.chat_id);
    if (chat) {
      addMember(ctx, chat.id, dispute.arbiter_id, 'arbiter', 'Арбитр');
      const msg = systemMessage(ctx, chat,
        'Спор передан арбитру. Арбитр видит реальные ID сторон; для участников они остаются скрытыми.',
        { kind: 'dispute_escalated', dispute_id: dispute.id });
      broadcastMessage(ctx, chat, msg, null);
    }
    audit(ctx, r.req, auth.user, 'dispute.escalate', 'dispute', dispute.id, reason, '', null,
      { arbiter_id: dispute.arbiter_id, status: 'in_arbitration' });
    notify(ctx, dispute.arbiter_id, 'dispute_assigned', 'Назначен спор',
      `${REASONS[dispute.reason_code]}: заказ ${order?.number ?? dispute.order_id}. Решение в течение 7 дней.`,
      `dispute:${dispute.id}:assigned`, { dispute_id: dispute.id });
    for (const userId of [dispute.buyer_id, dispute.seller_id]) {
      if (userId === auth.user.id) continue;
      notify(ctx, userId, 'dispute_escalated', 'Спор в арбитраже',
        'Приглашён арбитр. Добавьте доказательства до истечения срока.',
        `dispute:${dispute.id}:esc:${userId}`, { dispute_id: dispute.id });
      push(ctx, userId, 'dispute.updated', { dispute_id: dispute.id, status: 'in_arbitration' });
    }
    pushMany(ctx, arbiterPool(ctx).filter((id) => id !== dispute.arbiter_id), 'dispute.new',
      { dispute_id: dispute.id, arbiter_id: dispute.arbiter_id });
    return ok(disputeDto(ctx, dispute, auth.user));
  }, { rate: 'write' }]);

  // ------------------------------------------------------------------
  // Решение арбитра (FR-DSP-09…12)
  // ------------------------------------------------------------------
  routes.push(['POST', '/api/v1/disputes/:id/resolve', (r) => {
    const auth = requireRoleArbiter(ctx, r);
    const dispute = ctx.db.disputes.get(r.params.id);
    if (!dispute) throw notFound('спор не найден');
    if (['resolved', 'dismissed', 'closed'].includes(dispute.status)) throw conflict('DISPUTE_CLOSED', 'решение уже вынесено');
    const b = r.body ?? {};
    const resolution = String(b.resolution ?? '');
    if (!RESOLUTIONS.includes(resolution)) throw bad('resolution: refund_buyer, release_seller, partial или dismiss');
    const reason = truncate(String(b.reason ?? ''), 1000);
    if (reason.length < 10) throw bad('обоснуйте решение (минимум 10 символов)');
    requireOps(ctx, r.req, auth, 'dispute_resolve', { totpCode: String(b.totp_code ?? '') });

    const order = ctx.db.orders.get(dispute.order_id);
    if (!order) throw notFound('заказ спора не найден');
    const asset = order.pay_asset;
    const total = asset === 'STARS' ? order.total_stars : order.total_sol;
    let partialAmount = 0;
    if (resolution === 'partial') {
      partialAmount = asset === 'STARS' ? Number(b.amount_stars ?? 0) : C.parseSol(String(b.amount_sol ?? '0'));
      if (partialAmount <= 0 || partialAmount >= total) throw bad('частичная сумма должна быть больше 0 и меньше суммы заказа');
    }
    const escrowBalance = ctx.db.ledger.balance(ACC.escrow(order.id, asset));
    if (escrowBalance <= 0) throw unprocessable('ESCROW_EMPTY', 'в эскроу нет средств: заказ уже завершён');

    let txId = '';
    let refunded = 0;
    let released = 0;
    if (resolution === 'refund_buyer') {
      const res = refundEscrow(ctx, order, total, auth.user.id);
      txId = res.tx_id;
      refunded = res.amount;
      transition(ctx, order, 'refunded', 'arbiter', `арбитраж: полный возврат (${reason})`, auth.user.id);
      order.refunded_at = new Date().toISOString();
    } else if (resolution === 'release_seller' || resolution === 'dismiss') {
      txId = releaseEscrow(ctx, order, auth.user.id);
      released = total;
      transition(ctx, order, 'completed', 'arbiter', `арбитраж: ${resolution === 'dismiss' ? 'спор отклонён' : 'выплата продавцу'}`, auth.user.id);
      order.completed_at = new Date().toISOString();
      order.confirm_deadline = null;
      finishOrderStats(ctx, order);
      if (resolution === 'dismiss') {
        const shop = ctx.db.shops.get(order.shop_id);
        shop.dispute_loss_penalty = 0;
      }
    } else {
      // partial: возврат покупателю + выплата продавцу остатка.
      ctx.db.ledger.ensure('escrow', order.id, asset);
      ctx.db.ledger.ensure('user', order.buyer_id, asset);
      ctx.db.ledger.ensure('shop', order.shop_id, asset);
      ctx.db.ledger.ensure('platform', 'fees', asset);
      const fee = asset === 'STARS' ? order.fee_stars : order.fee_sol;
      const sellerPart = Math.max(0, escrowBalance - partialAmount);
      const postings = [ctx.db.ledger.debit(ACC.escrow(order.id, asset), escrowBalance)];
      if (partialAmount > 0) postings.push(ctx.db.ledger.credit(ACC.user(order.buyer_id, asset), partialAmount));
      if (sellerPart - fee > 0) postings.push(ctx.db.ledger.credit(ACC.shop(order.shop_id, asset), sellerPart - fee));
      if (fee > 0 && sellerPart >= fee) postings.push(ctx.db.ledger.credit(ACC.platform('fees', asset), fee));
      else if (fee > 0) postings.push(ctx.db.ledger.credit(ACC.platform('fees', asset), sellerPart));
      // Балансировка: сумма кредитов должна равняться дебиту.
      const creditSum = postings.filter((p) => p.direction === 'credit').reduce((a, p) => a + p.amount, 0);
      if (creditSum !== escrowBalance) {
        postings.push(ctx.db.ledger.credit(ACC.user(order.buyer_id, asset), escrowBalance - creditSum));
      }
      const res = ctx.db.ledger.post(`resolve:partial:${dispute.id}`, asset, 'refund', 'dispute', dispute.id, auth.user.id, postings);
      if (res.error) throw new ApiError(500, 'INTERNAL', `ledger: ${res.error}`);
      txId = res.tx_id;
      refunded = partialAmount;
      released = sellerPart;
      transition(ctx, order, 'completed', 'arbiter', `арбитраж: частичный возврат ${partialAmount}`, auth.user.id);
      order.completed_at = new Date().toISOString();
      order.confirm_deadline = null;
      finishOrderStats(ctx, order);
    }

    dispute.status = resolution === 'dismiss' ? 'dismissed' : 'resolved';
    dispute.resolution = resolution;
    dispute.resolution_reason = reason;
    dispute.resolved_at = new Date().toISOString();
    dispute.updated_at = dispute.resolved_at;
    dispute.resolve_deadline = null;
    dispute.timeline.push({
      ts: dispute.resolved_at, kind: 'resolved', actor_id: auth.user.id, actor_visible_as: 'Арбитр',
      note: `${resolutionLabel(resolution)}: ${reason}`,
    });
    const chat = ctx.db.chats.get(dispute.chat_id);
    if (chat) {
      const msg = systemMessage(ctx, chat,
        `Решение арбитра: ${resolutionLabel(resolution)}. ${reason}`,
        { kind: 'dispute_resolved', dispute_id: dispute.id, resolution });
      broadcastMessage(ctx, chat, msg, null);
      chat.closed_at = new Date().toISOString();
    }
    orderStatusMessage(ctx, order, `Спор закрыт: ${resolutionLabel(resolution)}.`);
    // Раскрытие сторон арбитром фиксируется в аудите (docs/security.md §4.5).
    audit(ctx, r.req, auth.user, 'dispute.reveal', 'dispute', dispute.id, 'арбитраж: доступ к реальным ID', 'ops',
      null, { buyer_id: dispute.buyer_id, seller_id: dispute.seller_id });
    audit(ctx, r.req, auth.user, 'dispute.resolve', 'dispute', dispute.id, reason, 'ops',
      { status: 'in_arbitration' },
      { resolution, tx_id: txId, refunded, released, order_status: order.status });
    const shop = ctx.db.shops.get(order.shop_id);
    for (const userId of [dispute.buyer_id, dispute.seller_id]) {
      notify(ctx, userId, 'dispute_resolved', `Решение по спору: ${resolutionLabel(resolution)}`,
        `${reason}. ${refunded > 0 ? `Возврат: ${refunded > 0 && asset === 'SOL' ? C.formatSol(refunded) + ' SOL' : refunded + ' ⭐'}.` : ''}`,
        `dispute:${dispute.id}:resolved:${userId}`, { dispute_id: dispute.id, resolution });
      push(ctx, userId, 'dispute.resolved', { dispute_id: dispute.id, resolution, order_status: order.status });
      push(ctx, userId, 'wallet.updated', { asset, tx_id: txId });
    }
    push(ctx, shop.admin_user_id, 'shop.sanction', { shop_id: shop.id, dispute_loss: resolution !== 'dismiss' });
    return ok({
      ...disputeDto(ctx, dispute, auth.user),
      order_status: order.status, order_status_title: statusTitle(order.status),
      tx_id: txId, refunded, released,
      ledger: {
        escrow_after: ctx.db.ledger.balance(ACC.escrow(order.id, asset)),
        buyer_balance: asset === 'STARS' ? ctx.db.ledger.userBalance(order.buyer_id, asset) : C.formatSol(ctx.db.ledger.userBalance(order.buyer_id, asset)),
      },
    });
  }, { rate: 'admin' }]);

  // ------------------------------------------------------------------
  // Апелляция (FR-DSP-08): одна на спор, окно 72 ч, старший арбитр,
  // исполнение refund_* приостанавливается до решения по апелляции.
  // ------------------------------------------------------------------
  routes.push(['POST', '/api/v1/disputes/:id/appeal', (r) => {
    const auth = requireAuth(ctx, r.req);
    const reason = String(r.body?.reason ?? '').trim();
    if (reason.length < 30) throw bad('обоснование апелляции — не менее 30 символов');
    const dispute = ctx.db.disputes.get(r.params.id);
    if (!dispute) throw notFound('спор не найден');
    if (dispute.buyer_id !== auth.user.id && dispute.seller_id !== auth.user.id) {
      throw forbidden('FORBIDDEN', 'апелляция подаётся стороной спора');
    }
    if (dispute.appeal_of) throw conflict('ALREADY_APPEALED', 'по этому спору апелляция уже подана');
    if (!['resolved', 'dismissed'].includes(dispute.status)) {
      throw conflict('DISPUTE_NOT_APPEALABLE', 'апелляция возможна только после решения по спору');
    }
    if (dispute.resolved_at && Date.now() - new Date(dispute.resolved_at).getTime() > 72 * 3600_000) {
      throw conflict('APPEAL_WINDOW_CLOSED', 'окно апелляции — 72 часа с момента решения');
    }
    const senior = pickSeniorArbiter(ctx, dispute);
    if (!senior) throw conflict('NO_ARBITER', 'свободный старший арбитр не найден');

    const now = new Date().toISOString();
    dispute.status = 'appeal';
    dispute.appeal_of = dispute.id;
    dispute.appealed_by = auth.user.id;
    dispute.appealed_at = now;
    dispute.appeal_reason = reason;
    dispute.arbiter_id = senior;
    dispute.assigned_at = now;
    dispute.updated_at = now;
    dispute.execution_suspended = ['refund_buyer', 'partial'].includes(dispute.resolution);
    dispute.timeline.push({
      ts: now, kind: 'appeal', actor_id: auth.user.id,
      actor_visible_as: dispute.buyer_id === auth.user.id ? dispute.buyer_alias : dispute.seller_alias,
      note: reason,
    });
    const order = ctx.db.orders.get(dispute.order_id);
    if (order && dispute.execution_suspended) {
      orderStatusMessage(ctx, order, 'Исполнение решения приостановлено: подана апелляция.');
    }
    audit(ctx, r.req, auth.user, 'dispute.appeal', 'dispute', dispute.id, reason, '',
      { resolution: dispute.resolution, execution_suspended: dispute.execution_suspended },
      { status: dispute.status, arbiter_id: senior });
    for (const userId of [dispute.buyer_id, dispute.seller_id, senior]) {
      notify(ctx, userId, 'dispute_appeal',
        userId === senior ? 'Назначена апелляция' : 'Апелляция по спору',
        userId === senior
          ? 'Вам назначен спор по апелляции. Срок решения — 5 суток.'
          : 'Спор передан старшему арбитру. Исполнение решения приостановлено.',
        `dispute:${dispute.id}:appeal:${userId}`, { dispute_id: dispute.id });
      push(ctx, userId, 'dispute.appealed', {
        dispute_id: dispute.id, status: dispute.status,
        execution_suspended: dispute.execution_suspended,
      });
    }
    return ok({
      ...disputeDto(ctx, dispute, auth.user),
      appeal_of: dispute.appeal_of, appealed_by: dispute.appealed_by, appealed_at: dispute.appealed_at,
      appeal_reason: dispute.appeal_reason, execution_suspended: dispute.execution_suspended,
      senior_arbiter_assigned: senior,
    });
  }, { rate: 'write' }]);

  // ------------------------------------------------------------------
  // Доказательства (FR-DSP-05)
  // ------------------------------------------------------------------
  routes.push(['POST', '/api/v1/disputes/:id/evidence', (r) => {
    const auth = requireAuth(ctx, r.req);
    const dispute = ctx.db.disputes.get(r.params.id);
    if (!dispute) throw notFound('спор не найден');
    const staff = ['arbiter', 'moderator', 'superadmin'].includes(auth.user.role);
    const participant = dispute.buyer_id === auth.user.id || dispute.seller_id === auth.user.id;
    if (!participant && !(staff && dispute.arbiter_id === auth.user.id)) {
      throw forbidden('FORBIDDEN', 'доказательства добавляют стороны и арбитр');
    }
    if (['resolved', 'dismissed', 'closed'].includes(dispute.status)) throw conflict('DISPUTE_CLOSED', 'спор закрыт');
    const b = r.body ?? {};
    const kind = String(b.kind ?? 'text');
    if (!['image', 'video', 'file', 'text'].includes(kind)) throw bad('kind: image, video, file или text');
    const dataB64 = String(b.data_b64 ?? '');
    const text = truncate(String(b.text ?? ''), 2000);
    if (!dataB64 && !text) throw bad('передайте data_b64 или text');
    let raw = Buffer.alloc(0);
    if (dataB64) {
      try {
        raw = Buffer.from(dataB64, 'base64');
      } catch {
        throw bad('data_b64 не является корректным base64');
      }
      if (raw.length > 8 * 1024 * 1024) throw bad('файл больше 8 МБ');
    } else {
      raw = Buffer.from(text, 'utf8');
    }
    const id = C.newId('evd');
    // Метаданные срезаются, содержимое шифруется в домене dispute.
    const evidence = {
      id, kind, uploader_id: auth.user.id,
      name: truncate(String(b.name ?? (kind === 'text' ? 'пояснение.txt' : 'evidence.bin')), 80),
      size: raw.length, sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      meta_stripped: true, created_at: new Date().toISOString(),
      data_ct: C.encrypt(C.DOMAINS.dispute, id, raw.toString('base64')),
      text_preview: kind === 'text' ? maskDisputeText(text).slice(0, 120) : null,
    };
    dispute.evidence.push(evidence);
    dispute.updated_at = new Date().toISOString();
    const alias = dispute.buyer_id === auth.user.id ? dispute.buyer_alias
      : dispute.seller_id === auth.user.id ? dispute.seller_alias : 'Арбитр';
    dispute.timeline.push({
      ts: evidence.created_at, kind: 'evidence_added', actor_id: auth.user.id,
      actor_visible_as: alias, note: `${kind}: ${evidence.name}`,
    });
    const chat = ctx.db.chats.get(dispute.chat_id);
    if (chat) {
      const msg = addMessage(ctx, chat, auth.user,
        kind === 'text' ? maskDisputeText(text) : `Прикреплено доказательство: ${evidence.name}`,
        { visibleAs: alias });
      broadcastMessage(ctx, chat, msg, auth.user);
    }
    audit(ctx, r.req, auth.user, 'dispute.evidence', 'dispute', dispute.id, kind, '', null,
      { evidence_id: id, size: evidence.size, sha256: evidence.sha256 });
    const counterparty = dispute.buyer_id === auth.user.id ? dispute.seller_id : dispute.buyer_id;
    notify(ctx, counterparty, 'dispute_evidence', 'Добавлено доказательство',
      `${alias}: ${evidence.name}`, `dispute:${dispute.id}:evd:${id}:${counterparty}`, { evidence_id: id });
    push(ctx, counterparty, 'dispute.evidence', { dispute_id: dispute.id, evidence_id: id, kind });
    if (dispute.arbiter_id && dispute.arbiter_id !== auth.user.id) {
      push(ctx, dispute.arbiter_id, 'dispute.evidence', { dispute_id: dispute.id, evidence_id: id, kind });
    }
    return created({
      id, kind, name: evidence.name, size: evidence.size, sha256: evidence.sha256,
      meta_stripped: true, created_at: evidence.created_at,
      total_evidence: dispute.evidence.length,
      notice: 'Файл зашифрован (AES-256-GCM, домен dispute); метаданные удалены.',
    });
  }, { rate: 'write' }]);

  routes.push(['GET', '/api/v1/disputes/:id/evidence/:evidenceId', (r) => {
    const auth = requireAuth(ctx, r.req);
    const dispute = ctx.db.disputes.get(r.params.id);
    if (!dispute) throw notFound('спор не найден');
    const staff = ['arbiter', 'moderator', 'superadmin'].includes(auth.user.role);
    const participant = dispute.buyer_id === auth.user.id || dispute.seller_id === auth.user.id;
    if (!participant && !staff) throw forbidden('FORBIDDEN', 'нет доступа к доказательствам');
    const evidence = dispute.evidence.find((ev) => ev.id === r.params.evidenceId);
    if (!evidence) throw notFound('доказательство не найдено');
    if (staff) {
      audit(ctx, r.req, auth.user, 'dispute.evidence_view', 'dispute', dispute.id, 'просмотр арбитром', '',
        null, { evidence_id: evidence.id });
    }
    const raw = C.tryDecrypt(C.DOMAINS.dispute, evidence.id, evidence.data_ct) ?? '';
    return ok({
      id: evidence.id, kind: evidence.kind, name: evidence.name, sha256: evidence.sha256,
      data_b64: evidence.kind === 'text' ? undefined : raw,
      text: evidence.kind === 'text' ? Buffer.from(raw, 'base64').toString('utf8') : undefined,
      uploader_visible_as: dispute.buyer_id === evidence.uploader_id ? dispute.buyer_alias
        : dispute.seller_id === evidence.uploader_id ? dispute.seller_alias : 'Арбитр',
    });
  }, { rate: 'public' }]);

  return routes;
}

function requireRoleArbiter(ctx, r) {
  const auth = requireAuth(ctx, r.req);
  if (!['arbiter', 'moderator', 'superadmin'].includes(auth.user.role)) {
    throw forbidden('FORBIDDEN', 'решение выносит только арбитр');
  }
  return auth;
}

function resolutionLabel(resolution) {
  return {
    refund_buyer: 'полный возврат покупателю', release_seller: 'выплата продавцу',
    partial: 'частичный возврат', dismiss: 'спор отклонён',
  }[resolution] ?? resolution;
}
