// Роуты экономики: кошелёк, вывод SOL, обмен SOL⇄Stars, подарки, Telegram Stars, dev-депозит.
// Соответствует docs/api.md §9, docs/economy.md и docs/solana.md.
import * as C from './crypto.mjs';
import {
  CONFIG, ApiError, bad, conflict, forbidden, notFound, unprocessable,
  ok, created, paginate, truncate, walletDto, giftDto,
  requireAuth, requireOps, audit, notify, push, pushMany, recalcFeedScores,
} from './lib.mjs';
import { ACC } from './data.mjs';
import { findShop, systemMessage, broadcastMessage, HOUR } from './domain.mjs';

const NETWORK_FEE_LAMPORTS = 5000;

const addressTail = (addr) => `…${String(addr).slice(-4)}`;
const pretty = (amount, asset) => (asset === 'STARS' ? `${amount} ⭐` : `${C.formatSol(amount)} SOL`);

function ledgerFail(code) {
  switch (code) {
    case 'INSUFFICIENT_FUNDS': return unprocessable('INSUFFICIENT_FUNDS', 'недостаточно средств');
    case 'ALREADY_USED': return conflict('ALREADY_USED', 'операция уже исполнена');
    case 'BAD_AMOUNT': return bad('некорректная сумма');
    default: return new ApiError(500, 'INTERNAL', `ошибка ledger: ${code}`);
  }
}

// антифрод-скоринг (docs/security.md §9): 0…1000 → allow/captcha/delay/manual_review/deny.
function fraudScore(ctx, user, amountSol) {
  let score = 0;
  const reasons = [];
  const ageHours = (Date.now() - new Date(user.created_at).getTime()) / HOUR;
  if (ageHours < CONFIG.warmupHours + 24) {
    score += 250;
    reasons.push('новый аккаунт');
  }
  if (amountSol >= CONFIG.fourEyesSol) {
    score += 200;
    reasons.push('крупная сумма');
  }
  const recent = [...ctx.db.withdrawals.values()]
    .filter((w) => w.user_id === user.id && Date.now() - new Date(w.created_at).getTime() < HOUR).length;
  if (recent >= 3) {
    score += 300;
    reasons.push('серия выводов за час');
  }
  if (user.risk_score > 200) {
    score += 150;
    reasons.push('повышенный риск профиля');
  }
  score = Math.min(1000, score);
  const action = score >= 700 ? 'deny' : score >= 450 ? 'manual_review' : score >= 250 ? 'delay' : score >= 100 ? 'captcha' : 'allow';
  return { score, action, reasons };
}

function withdrawalDto(rec) {
  return {
    id: rec.id, user_id: rec.user_id, asset: rec.asset,
    amount: pretty(rec.amount, rec.asset), amount_raw: rec.amount,
    dest_address: addressTail(rec.dest_address), status: rec.status,
    fee: C.formatSol(rec.fee ?? 0), tx_signature: rec.tx_signature ?? null,
    created_at: rec.created_at, updated_at: rec.updated_at, approved_by: rec.approved_by ?? null,
  };
}

export function economyRoutes(ctx) {
  const routes = [];

  routes.push(['GET', '/api/v1/wallet', (r) => {
    const auth = requireAuth(ctx, r.req);
    const dto = walletDto(ctx, auth.user);
    dto.withdrawals = [...ctx.db.withdrawals.values()]
      .filter((w) => w.user_id === auth.user.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 10)
      .map(withdrawalDto);
    dto.warmup_until = auth.user.warmup_until ?? null;
    dto.notice = 'Кастодиальная модель: депозит зачисляется после подтверждений сети, вывод подписывается горячим кошельком (docs/solana.md).';
    return ok(dto);
  }, { rate: 'public' }]);

  routes.push(['GET', '/api/v1/wallet/transactions', (r) => {
    const auth = requireAuth(ctx, r.req);
    const limit = Math.min(100, Math.max(1, Number(r.query.limit ?? 30)));
    const asset = String(r.query.asset ?? '');
    let entries = ctx.db.ledger.userEntries(auth.user.id, 500);
    if (asset) entries = entries.filter((e) => e.asset === asset.toUpperCase());
    const items = entries.slice(0, limit).map((e) => ({
      id: e.id, tx_id: e.tx_id, ts: e.ts, direction: e.direction, kind: e.kind,
      amount: e.asset === 'STARS' ? e.amount : C.formatSol(e.amount),
      amount_raw: e.amount, asset: e.asset, ref_type: e.ref_type, ref_id: e.ref_id,
      title: kindTitle(e.kind, e.direction),
    }));
    return ok({ items, total: entries.length, has_more: entries.length > limit, balances: walletDto(ctx, auth.user).balances });
  }, { rate: 'public' }]);

  routes.push(['POST', '/api/v1/wallet/withdraw', (r) => {
    const auth = requireAuth(ctx, r.req);
    const b = r.body ?? {};
    const asset = String(b.asset ?? 'SOL').toUpperCase();
    if (asset !== 'SOL') throw bad('вывод доступен только в SOL; Stars обмениваются на SOL во вкладке «Обмен»');
    const amount = C.parseSol(String(b.amount_sol ?? '0'));
    if (amount <= 0) throw bad('некорректная сумма вывода');
    const addr = String(b.dest_address ?? '').trim();
    if (!C.isValidAddress(addr)) throw bad('некорректный адрес Solana (base58, 32–44 символа)');
    if (auth.user.deposit_address && addr === auth.user.deposit_address) throw bad('нельзя вывести на собственный депозитный адрес');
    if (amount < Math.round(CONFIG.minDepositSol * C.LAMPORTS_PER_SOL)) {
      throw bad(`сумма меньше минимальной (${C.formatSol(Math.round(CONFIG.minDepositSol * C.LAMPORTS_PER_SOL))} SOL)`);
    }
    requireOps(ctx, r.req, auth, 'withdraw', { amountSol: amount / C.LAMPORTS_PER_SOL, totpCode: String(b.totp_code ?? '') });

    const user = auth.user;
    if (user.warmup_until && new Date(user.warmup_until) > new Date()) {
      throw forbidden('WARMUP_REQUIRED', `вывод доступен после прогрева аккаунта: ${user.warmup_until}`);
    }
    if (['restricted', 'suspended', 'banned'].includes(user.status)) {
      throw forbidden('ACCOUNT_RESTRICTED', 'аккаунт ограничен: вывод недоступен');
    }
    if (ctx.db.settings.get('withdrawals_frozen')) throw forbidden('WITHDRAWALS_FROZEN', 'выводы временно приостановлены');
    const dailyLimit = Math.round(CONFIG.withdrawDailySol * C.LAMPORTS_PER_SOL);
    const usedToday = [...ctx.db.withdrawals.values()]
      .filter((w) => w.user_id === user.id && Date.now() - new Date(w.created_at).getTime() < 24 * HOUR)
      .reduce((a, w) => a + w.amount, 0);
    if (usedToday + amount + NETWORK_FEE_LAMPORTS > dailyLimit) {
      throw forbidden('LIMIT_EXCEEDED',
        `превышен суточный лимит вывода ${C.formatSol(dailyLimit)} SOL (осталось ${C.formatSol(Math.max(0, dailyLimit - usedToday))} SOL)`);
    }
    // Охлаждение нового адреса: 24 часа с первого использования.
    const coolKey = `withdraw_addr:${addr}`;
    const seen = ctx.db.settings.get(coolKey);
    if (seen) {
      const wait = 24 * HOUR - (Date.now() - new Date(seen).getTime());
      if (wait > 0) {
        throw new ApiError(403, 'ADDRESS_COOLING',
          `новый адрес: вывод станет доступен через ${Math.ceil(wait / HOUR)} ч`,
          { address: addressTail(addr) }, Math.ceil(wait / 1000));
      }
    } else {
      ctx.db.settings.set(coolKey, new Date().toISOString());
      throw new ApiError(403, 'ADDRESS_COOLING',
        'адрес добавлен в белый список: вывод станет доступен через 24 часа',
        { address: addressTail(addr) }, 24 * 3600);
    }

    const risk = fraudScore(ctx, user, amount / C.LAMPORTS_PER_SOL);
    user.risk_score = risk.score;
    if (risk.action === 'deny') {
      throw forbidden('FRAUD_DENIED', `операция отклонена антифрод-системой: ${risk.reasons.join(', ')}`);
    }
    const balance = ctx.db.ledger.userBalance(user.id, 'SOL');
    if (balance < amount + NETWORK_FEE_LAMPORTS) {
      throw unprocessable('INSUFFICIENT_FUNDS',
        `недостаточно средств: нужно ${C.formatSol(amount + NETWORK_FEE_LAMPORTS)} SOL с учётом комиссии сети`);
    }
    const idem = String(b.idempotency_key ?? '').trim() || `withdraw:${user.id}:${amount}:${addr}`;
    ctx.db.ledger.ensure('platform', 'withdrawals_pending', 'SOL');
    const res = ctx.db.ledger.post(`hold:${idem}`, 'SOL', 'withdraw_hold', 'withdrawal', idem, user.id, [
      ctx.db.ledger.debit(ACC.user(user.id, 'SOL'), amount + NETWORK_FEE_LAMPORTS),
      ctx.db.ledger.credit(ACC.platform('withdrawals_pending', 'SOL'), amount + NETWORK_FEE_LAMPORTS),
    ]);
    if (res.error) throw ledgerFail(res.error);

    const fourEyes = amount >= Math.round(CONFIG.fourEyesSol * C.LAMPORTS_PER_SOL) || risk.action === 'manual_review';
    const now = new Date().toISOString();
    const rec = {
      id: C.newId('wdr'), user_id: user.id, asset: 'SOL', amount, dest_address: addr,
      status: fourEyes ? 'pending_approval' : 'approved', fee: NETWORK_FEE_LAMPORTS,
      tx_id: res.tx_id, tx_signature: null, risk_score: risk.score, risk_action: risk.action,
      created_at: now, updated_at: now, approved_by: null, second_approver: null,
    };
    ctx.db.withdrawals.set(rec.id, rec);
    audit(ctx, r.req, user, 'wallet.withdraw', 'withdrawal', rec.id, addressTail(addr), 'ops', null,
      { amount, risk_score: risk.score, risk_action: risk.action, four_eyes: fourEyes, status: rec.status });
    if (fourEyes) {
      for (const adm of [...ctx.db.users.values()].filter((u) => ['arbiter', 'moderator', 'superadmin'].includes(u.role))) {
        notify(ctx, adm.id, 'withdraw_approval', 'Заявка на вывод требует подтверждения',
          `${C.formatSol(amount)} SOL на ${addressTail(addr)}`, `withdraw:${rec.id}:${adm.id}`,
          { withdrawal_id: rec.id });
      }
    }
    notify(ctx, user.id, 'withdraw_created', 'Заявка на вывод создана',
      `${pretty(amount, 'SOL')} → ${addressTail(addr)}`, `withdraw:${rec.id}`,
      { withdrawal_id: rec.id, status: rec.status });
    push(ctx, user.id, 'wallet.withdraw', withdrawalDto(rec));
    push(ctx, user.id, 'wallet.updated', { asset: 'SOL', tx_id: res.tx_id });
    return ok({
      ...withdrawalDto(rec), four_eyes_required: fourEyes, risk_score: risk.score,
      notice: 'Холд средств проведён двойной записью; подпись формируется горячим кошельком.',
    }, 202);
  }, { rate: 'payment' }]);

  // ------------------------------------------------------------------
  // Обмен SOL ⇄ Stars
  // ------------------------------------------------------------------
  routes.push(['GET', '/api/v1/exchange/quote', (r) => {
    const auth = requireAuth(ctx, r.req);
    let from = String(r.query.from ?? 'STARS').toUpperCase();
    let to = String(r.query.to ?? 'SOL').toUpperCase();
    let fromAmount = 0;
    if (r.query.amount_sol) {
      fromAmount = C.parseSol(String(r.query.amount_sol));
      from = 'SOL';
      to = 'STARS';
    } else {
      fromAmount = Number(r.query.amount_stars ?? 0);
    }
    if (fromAmount <= 0) throw bad('укажите сумму обмена');
    if (from === to) throw bad('активы должны отличаться');
    const conv = convert(from, to, fromAmount);
    const quoteId = C.newId('qte');
    ctx.db.quotes.set(quoteId, {
      id: quoteId, user_id: auth.user.id, from_asset: from, to_asset: to,
      from_amount: fromAmount, to_amount: conv.toAmount, fee: conv.fee, fee_bps: CONFIG.exchangeFeeBps,
      rate: CONFIG.solStarsRate, created_at: new Date().toISOString(),
      valid_until: new Date(Date.now() + 60_000).toISOString(),
    });
    return ok({
      quote_id: quoteId, from_asset: from, to_asset: to,
      from_amount: from === 'SOL' ? C.formatSol(fromAmount) : fromAmount,
      from_amount_raw: fromAmount,
      to_amount: to === 'SOL' ? C.formatSol(conv.toAmount) : conv.toAmount,
      to_amount_raw: conv.toAmount,
      fee: to === 'SOL' ? C.formatSol(conv.fee) : conv.fee,
      fee_bps: CONFIG.exchangeFeeBps, rate: CONFIG.solStarsRate,
      valid_until: new Date(Date.now() + 60_000).toISOString(),
      balance_from: from === 'SOL' ? C.formatSol(ctx.db.ledger.userBalance(auth.user.id, from)) : ctx.db.ledger.userBalance(auth.user.id, from),
    });
  }, { rate: 'public' }]);

  routes.push(['POST', '/api/v1/exchange', (r) => {
    const auth = requireAuth(ctx, r.req);
    const b = r.body ?? {};
    requireOps(ctx, r.req, auth, 'exchange', {
      amountStars: Number(b.amount_stars ?? 0), totpCode: String(b.totp_code ?? ''),
    });
    let from;
    let to;
    let fromAmount;
    let toAmount;
    let fee = 0;
    const rate = CONFIG.solStarsRate;
    if (b.quote_id) {
      const quote = ctx.db.quotes.get(String(b.quote_id));
      if (!quote) throw notFound('котировка не найдена');
      if (quote.user_id !== auth.user.id) throw forbidden('FORBIDDEN', 'котировка принадлежит другому пользователю');
      if (new Date(quote.valid_until) < new Date()) throw conflict('QUOTE_EXPIRED', 'котировка истекла, запросите новую');
      from = quote.from_asset;
      to = quote.to_asset;
      fromAmount = quote.from_amount;
      toAmount = quote.to_amount;
      fee = quote.fee;
      ctx.db.quotes.delete(quote.id);
    } else {
      from = String(b.from_asset ?? 'STARS').toUpperCase();
      to = String(b.to_asset ?? 'SOL').toUpperCase();
      fromAmount = from === 'SOL' ? C.parseSol(String(b.amount_sol ?? '0')) : Number(b.amount_stars ?? 0);
      if (fromAmount <= 0) throw bad('укажите сумму обмена');
      const conv = convert(from, to, fromAmount);
      toAmount = conv.toAmount;
      fee = conv.fee;
    }
    if (fromAmount <= 0 || toAmount <= 0) throw bad('некорректные суммы обмена');
    const balance = ctx.db.ledger.userBalance(auth.user.id, from);
    if (balance < fromAmount) throw unprocessable('INSUFFICIENT_FUNDS', `недостаточно ${from}: есть ${pretty(balance, from)}`);

    const idem = String(b.idempotency_key ?? '').trim() ||
      `exchange:${auth.user.id}:${from}:${fromAmount}:${to}:${toAmount}`;
    const fromPlatform = from === 'SOL' ? 'custody' : 'stars_reserve';
    const toPlatform = from === 'SOL' ? 'stars_reserve' : 'custody';
    ctx.db.ledger.ensure('platform', fromPlatform, from);
    ctx.db.ledger.ensure('platform', toPlatform, to);
    ctx.db.ledger.ensure('platform', 'fees', to);
    const leg1 = ctx.db.ledger.post(`${idem}:leg_from`, from, 'exchange', 'user', auth.user.id, auth.user.id, [
      ctx.db.ledger.debit(ACC.user(auth.user.id, from), fromAmount),
      ctx.db.ledger.credit(ACC.platform(fromPlatform, from), fromAmount),
    ]);
    if (leg1.error) throw ledgerFail(leg1.error);
    const postings = [ctx.db.ledger.debit(ACC.platform(toPlatform, to), toAmount + fee)];
    if (fee > 0) {
      postings.push(ctx.db.ledger.credit(ACC.user(auth.user.id, to), toAmount));
      postings.push(ctx.db.ledger.credit(ACC.platform('fees', to), fee));
    } else {
      postings.push(ctx.db.ledger.credit(ACC.user(auth.user.id, to), toAmount));
    }
    const leg2 = ctx.db.ledger.post(`${idem}:leg_to`, to, 'exchange', 'user', auth.user.id, auth.user.id, postings);
    if (leg2.error) throw ledgerFail(leg2.error);

    audit(ctx, r.req, auth.user, 'wallet.exchange', 'user', auth.user.id, `${from}→${to}`, 'ops', null,
      { from_amount: fromAmount, to_amount: toAmount, fee, rate, tx_from: leg1.tx_id, tx_to: leg2.tx_id });
    notify(ctx, auth.user.id, 'exchange_done', 'Обмен выполнен',
      `${pretty(fromAmount, from)} → ${pretty(toAmount, to)} (комиссия ${pretty(fee, to)})`,
      `exchange:${leg2.tx_id}`);
    push(ctx, auth.user.id, 'wallet.updated', { asset: from, tx_id: leg1.tx_id });
    push(ctx, auth.user.id, 'wallet.updated', { asset: to, tx_id: leg2.tx_id });
    return ok({
      status: 'executed', from_asset: from, to_asset: to,
      from_amount: pretty(fromAmount, from), to_amount: pretty(toAmount, to),
      from_amount_raw: fromAmount, to_amount_raw: toAmount,
      fee: pretty(fee, to), fee_bps: CONFIG.exchangeFeeBps, rate,
      tx_from: leg1.tx_id, tx_to: leg2.tx_id,
      balances: walletDto(ctx, auth.user).balances,
    });
  }, { rate: 'payment' }]);

  // ------------------------------------------------------------------
  // Подарки и Stars (FR-STR-*, FR-GIF-*)
  // ------------------------------------------------------------------
  routes.push(['GET', '/api/v1/gifts', (r) => {
    const rarity = String(r.query.rarity ?? '');
    const limit = Math.min(50, Math.max(1, Number(r.query.limit ?? 24)));
    let items = [...ctx.db.gifts.values()].filter((g) => g.status === 'published');
    if (rarity) items = items.filter((g) => g.rarity === rarity);
    items.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    const page = paginate(items.map(giftDto), limit, r.query.cursor);
    return ok({
      ...page, rarities: ['common', 'rare', 'epic', 'legendary'],
      assets: ['STARS', 'SOL'],
      notice: 'Подарками можно поддержать магазин (буст в ленте) или пользователя (коллекция).',
    });
  }, { rate: 'public' }]);

  routes.push(['POST', '/api/v1/gifts/:id/buy', (r) => {
    const auth = requireAuth(ctx, r.req);
    const gift = ctx.db.gifts.get(r.params.id);
    if (!gift || gift.status !== 'published') throw notFound('подарок не найден');
    const b = r.body ?? {};
    const asset = String(b.asset ?? (gift.price_stars > 0 ? 'STARS' : 'SOL')).toUpperCase();
    if (!['SOL', 'STARS'].includes(asset)) throw bad('asset должен быть SOL или STARS');
    const qty = Math.max(1, Math.min(10, Number(b.qty ?? 1)));
    const unit = asset === 'STARS' ? gift.price_stars : gift.price_sol;
    if (unit <= 0) throw unprocessable('GIFT_NOT_PAYABLE', `цена подарка не задана в ${asset}`);
    const total = unit * qty;
    requireOps(ctx, r.req, auth, 'gift_buy', {
      amountSol: asset === 'SOL' ? total / C.LAMPORTS_PER_SOL : 0,
      amountStars: asset === 'STARS' ? total : 0, totpCode: String(b.totp_code ?? ''),
    });
    const recipientType = String(b.recipient_type ?? 'shop');
    if (!['self', 'user', 'shop'].includes(recipientType)) throw bad('recipient_type: self, user или shop');
    let recipientId = String(b.recipient_id ?? '');
    if (recipientType === 'self') recipientId = auth.user.id;
    if (!recipientId) throw bad('укажите получателя подарка');
    if (recipientType === 'user' && !ctx.db.users.has(recipientId)) throw notFound('получатель не найден');
    const shop = recipientType === 'shop' ? findShop(ctx, recipientId) : null;
    if (recipientType === 'shop' && !shop) throw notFound('магазин не найден');
    if (gift.per_user_limit) {
      const bought = [...ctx.db.giftPurchases.values()]
        .filter((p) => p.buyer_id === auth.user.id && p.gift_id === gift.id && p.status === 'delivered')
        .reduce((a, p) => a + p.qty, 0);
      if (bought + qty > gift.per_user_limit) {
        throw conflict('GIFT_LIMIT', `лимит подарка: ${gift.per_user_limit} шт. на пользователя`);
      }
    }
    const balance = ctx.db.ledger.userBalance(auth.user.id, asset);
    if (balance < total) throw unprocessable('INSUFFICIENT_FUNDS', `недостаточно средств: нужно ${pretty(total, asset)}`);

    const idem = String(b.idempotency_key ?? '').trim() || `gift:${gift.id}:${auth.user.id}:${recipientType}:${recipientId}:${qty}:${Date.now()}`;
    ctx.db.ledger.ensure('platform', 'gift_revenue', asset);
    const res = ctx.db.ledger.post(idem, asset, 'gift', 'gift', gift.id, auth.user.id, [
      ctx.db.ledger.debit(ACC.user(auth.user.id, asset), total),
      ctx.db.ledger.credit(ACC.platform('gift_revenue', asset), total),
    ]);
    if (res.error) throw ledgerFail(res.error);

    const now = new Date().toISOString();
    const purchase = {
      id: C.newId('gfp'), gift_id: gift.id, buyer_id: auth.user.id,
      recipient_type: recipientType, recipient_id: recipientId, qty,
      asset, amount: total, status: 'delivered', tx_id: res.tx_id,
      message: truncate(String(b.message ?? ''), 200), created_at: now, delivered_at: now,
    };
    ctx.db.giftPurchases.set(purchase.id, purchase);

    let boostApplied = false;
    if (recipientType === 'shop' && shop && gift.boosts_shop) {
      const cap = Number(ctx.db.settings.get('gift_boost_max') ?? 0.6);
      const days = Math.min(14, Math.max(1, gift.boost_days ?? 3));
      shop.gift_boost = Math.min(cap, (shop.gift_boost ?? 0) + (gift.boost_value ?? 0.1));
      shop.gift_boost_until = new Date(Date.now() + days * 24 * HOUR).toISOString();
      boostApplied = true;
      recalcFeedScores(ctx);
      notify(ctx, shop.admin_user_id, 'gift_received',
        `Вам подарили «${gift.title_ru}» ${gift.emoji ?? ''}`,
        `${auth.user.nickname.slice(0, 1)}*** поддержал магазин ${shop.name} — буст в ленте ${days} дн.`,
        `gift:${purchase.id}:${shop.admin_user_id}`, { gift_id: gift.id, boost: shop.gift_boost });
      push(ctx, shop.admin_user_id, 'gift.received', {
        gift_id: gift.id, purchase_id: purchase.id, shop_id: shop.id,
        boost_until: shop.gift_boost_until, buyer_masked: `${auth.user.nickname.slice(0, 1)}***`,
      });
      const channel = [...ctx.db.chats.values()].find((ch) => ch.kind === 'channel' && ch.shop_id === shop.id);
      if (channel) {
        const msg = systemMessage(ctx, channel,
          `Покупатель подарил «${gift.title_ru}» ${gift.emoji ?? ''} — магазин получил буст в ленте на ${days} дн.`,
          { kind: 'gift', gift_id: gift.id });
        broadcastMessage(ctx, channel, msg, null);
      }
    }
    if (recipientType === 'user' && recipientId !== auth.user.id) {
      notify(ctx, recipientId, 'gift_received', `Вам подарили «${gift.title_ru}» ${gift.emoji ?? ''}`,
        truncate(String(b.message ?? 'Без сообщения'), 120) || 'Без сообщения',
        `gift:${purchase.id}:${recipientId}`, { gift_id: gift.id });
      push(ctx, recipientId, 'gift.received', { gift_id: gift.id, purchase_id: purchase.id });
    }
    audit(ctx, r.req, auth.user, 'gift.buy', 'gift', gift.id, `${recipientType}:${recipientId}`, 'ops', null,
      { asset, amount: total, qty, tx_id: res.tx_id, boost_applied: boostApplied });
    push(ctx, auth.user.id, 'wallet.updated', { asset, tx_id: res.tx_id });
    return created({
      id: purchase.id, gift: giftDto(gift), recipient_type: recipientType, recipient_id: recipientId,
      asset, amount: total, amount_pretty: pretty(total, asset), tx_id: res.tx_id,
      status: purchase.status, boost_applied: boostApplied,
      balances: walletDto(ctx, auth.user).balances,
    });
  }, { rate: 'payment' }]);

  routes.push(['GET', '/api/v1/gifts/inventory', (r) => {
    const auth = requireAuth(ctx, r.req);
    const items = [...ctx.db.giftPurchases.values()]
      .filter((p) => (p.recipient_type === 'self' && p.buyer_id === auth.user.id) ||
        (p.recipient_type === 'user' && p.recipient_id === auth.user.id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((p) => {
        const gift = ctx.db.gifts.get(p.gift_id);
        return {
          id: p.id, gift: gift ? giftDto(gift) : null, qty: p.qty,
          from: p.buyer_id === auth.user.id ? 'вы' : `${ctx.db.users.get(p.buyer_id)?.nickname ?? 'пользователь'}`,
          message: p.message || null, created_at: p.created_at,
        };
      });
    const sent = [...ctx.db.giftPurchases.values()]
      .filter((p) => p.buyer_id === auth.user.id && p.recipient_type !== 'self')
      .map((p) => ({ id: p.id, gift_id: p.gift_id, recipient_type: p.recipient_type, amount_pretty: pretty(p.amount, p.asset), created_at: p.created_at }));
    return ok({ items, sent, total: items.length });
  }, { rate: 'public' }]);

  routes.push(['POST', '/api/v1/stars/invoice', (r) => {
    const auth = requireAuth(ctx, r.req);
    const b = r.body ?? {};
    const amountStars = Number(b.amount_stars ?? 0);
    if (!Number.isInteger(amountStars) || amountStars < 1) throw bad('amount_stars: целое число ≥ 1');
    if (amountStars > 100000) throw bad('максимум 100 000 Stars за один инвойс');
    const purpose = String(b.purpose ?? 'deposit');
    if (!['deposit', 'gift', 'rent', 'order'].includes(purpose)) throw bad('purpose: deposit, gift, rent или order');
    const invoiceId = C.newId('inv');
    const now = new Date().toISOString();
    ctx.db.invoices ??= new Map();
    ctx.db.invoices.set(invoiceId, {
      id: invoiceId, user_id: auth.user.id, amount_stars: amountStars, purpose,
      reference: String(b.reference ?? ''), status: 'created', created_at: now,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    audit(ctx, r.req, auth.user, 'stars.invoice', 'invoice', invoiceId, purpose, '', null, { amount_stars: amountStars });
    return created({
      invoice_id: invoiceId, amount_stars: amountStars, purpose,
      // В TMA клиент вызывает Telegram.WebApp.openInvoice(payload).
      payload: `stars_invoice_${invoiceId}`,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      dev_notice: CONFIG.env === 'prod'
        ? undefined
        : 'В preview оплата не проходит через Telegram: используйте POST /api/v1/dev/simulate-deposit с invoice_id.',
    });
  }, { rate: 'payment' }]);

  routes.push(['POST', '/api/v1/dev/simulate-deposit', (r) => {
    const auth = requireAuth(ctx, r.req);
    if (CONFIG.env === 'prod') throw forbidden('FORBIDDEN', 'эндпоинт отключён в prod');
    const b = r.body ?? {};
    const asset = String(b.asset ?? 'SOL').toUpperCase();
    if (!['SOL', 'STARS'].includes(asset)) throw bad('asset должен быть SOL или STARS');
    const userId = String(b.user_id ?? auth.user.id);
    const target = ctx.db.users.get(userId);
    if (!target) throw notFound('пользователь не найден');
    const amount = asset === 'SOL' ? C.parseSol(String(b.amount_sol ?? '0')) : Number(b.amount_stars ?? 0);
    if (amount <= 0) throw bad('укажите сумму депозита');
    if (asset === 'SOL' && amount < Math.round(CONFIG.minDepositSol * C.LAMPORTS_PER_SOL)) {
      throw bad(`минимальный депозит ${C.formatSol(Math.round(CONFIG.minDepositSol * C.LAMPORTS_PER_SOL))} SOL`);
    }
    ctx.db.ledger.ensure('user', target.id, asset);
    // Кастодия: горячий кошелёк пополняется извне (вне двойной записи пользователя),
    // проводка custody → user отражает зачисление после подтверждений сети.
    ctx.db.ledger.ensure('platform', asset === 'SOL' ? 'custody' : 'stars_reserve', asset);
    ctx.db.ledger.external(ACC.platform(asset === 'SOL' ? 'custody' : 'stars_reserve', asset), amount);
    const txSignature = b.invoice_id ? `invoice:${b.invoice_id}` : C.hex(32);
    const res = ctx.db.ledger.post(`deposit:${target.id}:${asset}:${txSignature}`, asset, 'deposit', 'user', target.id, target.id, [
      ctx.db.ledger.debit(ACC.platform(asset === 'SOL' ? 'custody' : 'stars_reserve', asset), amount),
      ctx.db.ledger.credit(ACC.user(target.id, asset), amount),
    ]);
    if (res.error) throw ledgerFail(res.error);
    if (b.invoice_id && ctx.db.invoices?.has(b.invoice_id)) {
      const invoice = ctx.db.invoices.get(b.invoice_id);
      invoice.status = 'paid';
      invoice.paid_at = new Date().toISOString();
      invoice.tx_id = res.tx_id;
    }
    ctx.db.solTxs.set(res.tx_id, {
      signature: txSignature, asset, amount, user_id: target.id,
      confirmations: CONFIG.confirmations, status: 'confirmed',
      slot: 250_000_000 + Math.floor(Math.random() * 1000), created_at: new Date().toISOString(),
    });
    audit(ctx, r.req, auth.user, 'wallet.deposit_simulated', 'user', target.id, `asset=${asset}`, '', null,
      { amount, signature: txSignature, confirmations: CONFIG.confirmations });
    notify(ctx, target.id, 'deposit_confirmed', 'Депозит зачислен',
      `${pretty(amount, asset)} зачислено после ${CONFIG.confirmations} подтверждений сети`,
      `deposit:${res.tx_id}`, { tx_id: res.tx_id });
    push(ctx, target.id, 'wallet.updated', { asset, tx_id: res.tx_id, balance: ctx.db.ledger.userBalance(target.id, asset) });
    return ok({
      status: 'credited', asset, amount: pretty(amount, asset), amount_raw: amount,
      tx_id: res.tx_id, signature: txSignature, confirmations: CONFIG.confirmations,
      network: CONFIG.solanaNetwork, balances: walletDto(ctx, target).balances,
      notice: 'Депозит симулирован: в prod зачисление выполняет сканер блокчейна (docs/solana.md §3).',
    });
  }, { rate: 'payment' }]);

  return routes;
}

function convert(from, to, fromAmount) {
  const rate = CONFIG.solStarsRate > 0 ? CONFIG.solStarsRate : 0.01;
  let toAmount;
  if (from === 'STARS' && to === 'SOL') toAmount = Math.floor(fromAmount * rate * C.LAMPORTS_PER_SOL) / 1;
  else if (from === 'SOL' && to === 'STARS') toAmount = Math.floor(fromAmount / (rate * C.LAMPORTS_PER_SOL));
  else throw bad(`неподдерживаемая пара ${from}→${to}`);
  toAmount = Math.floor(toAmount);
  const fee = Math.floor((toAmount * CONFIG.exchangeFeeBps) / 10000);
  if (toAmount - fee <= 0) throw bad('сумма слишком мала: результат обмена равен нулю');
  return { toAmount: toAmount - fee, fee, rate };
}

function kindTitle(kind, direction) {
  const titles = {
    deposit: 'Пополнение', withdraw: 'Вывод', withdraw_hold: 'Холд вывода',
    withdraw_unhold: 'Снятие холда', order_hold: 'Резерв под заказ', order_release: 'Выплата продавцу',
    refund: 'Возврат', rent: 'Аренда магазина', rent_refund: 'Возврат аренды',
    gift: 'Подарок', exchange: 'Обмен', fee: 'Комиссия', reward: 'Начисление', seed: 'Стартовое начисление',
  };
  const base = titles[kind] ?? kind;
  return direction === 'debit' ? `${base} (списание)` : `${base} (зачисление)`;
}
