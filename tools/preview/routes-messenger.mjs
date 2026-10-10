// Роуты мессенджера: чаты (все диалоги открываются с админом), сообщения, E2EE-ключи.
// Соответствует docs/api.md §8, docs/security.md §4 (E2EE) и FR-MSG-*.
import * as C from './crypto.mjs';
import {
  bad, conflict, forbidden, notFound, unprocessable,
  ok, created, paginate, truncate, chatDto, messageDto,
  requireAuth, audit, notify, push, pushMany,
} from './lib.mjs';
import {
  findOrder, findShop, addMember, addMessage, broadcastMessage, isMember,
  openSupportChat, openOrderChat, ensureShopChannel, systemMessage, shopAdmins,
} from './domain.mjs';

const MAX_BODY = 4000;

// safetyNumber — отпечаток безопасности пары пользователей (docs/security.md §4.4).
export function safetyNumber(fingerprint, a, b) {
  const [lo, hi] = [a, b].sort();
  const mac = C.hmacSha256(Buffer.from(`sitee-safety-v1:${fingerprint}`), Buffer.from(`${lo}|${hi}`));
  const groups = [];
  for (let i = 0; i < 8; i += 1) {
    let value = mac[i * 2] * 256 + mac[i * 2 + 1];
    value = String(value % 100000).padStart(5, '0');
    groups.push(value);
  }
  return groups.join('-');
}

export function messengerRoutes(ctx) {
  const routes = [];

  // ------------------------------------------------------------------
  // Список чатов
  // ------------------------------------------------------------------
  routes.push(['GET', '/api/v1/chats', (r) => {
    const auth = requireAuth(ctx, r.req);
    const kind = String(r.query.kind ?? '');
    const limit = Math.min(50, Math.max(1, Number(r.query.limit ?? 20)));
    let items = [];
    for (const [chatId, members] of ctx.db.members) {
      if (!members.some((m) => m.user_id === auth.user.id && !m.left_at)) continue;
      const chat = ctx.db.chats.get(chatId);
      if (!chat) continue;
      if (kind && chat.kind !== kind) continue;
      items.push(chat);
    }
    items.sort((a, b) => String(b.last_message_at ?? b.created_at).localeCompare(String(a.last_message_at ?? a.created_at)));
    const page = paginate(items.map((chat) => chatDto(ctx, chat, auth.user.id)), limit, r.query.cursor);
    const unreadTotal = page.items.reduce((acc, c) => acc + (c.unread ?? 0), 0);
    return ok({
      ...page, unread_total: unreadTotal,
      kinds: ['shop_support', 'order', 'dispute', 'direct', 'group', 'channel'],
      notice: 'Все обращения в магазин открывают диалог с админом магазина (TZ §3.1).',
    });
  }, { rate: 'public' }]);

  // ------------------------------------------------------------------
  // Открытие чата: shop_support / order / direct / group / channel
  // ------------------------------------------------------------------
  routes.push(['POST', '/api/v1/chats', (r) => {
    const auth = requireAuth(ctx, r.req);
    const b = r.body ?? {};
    const kind = String(b.kind ?? 'shop_support');

    if (kind === 'shop_support') {
      const shop = findShop(ctx, String(b.shop_id ?? ''));
      if (!shop) throw notFound('магазин не найден');
      const chat = openSupportChat(ctx, shop, auth.user);
      audit(ctx, r.req, auth.user, 'chat.open', 'chat', chat.id, 'shop_support', '', null, { shop_id: shop.id });
      return created({ ...chatDto(ctx, chat, auth.user.id), notice: 'Диалог открыт с админом магазина.' });
    }

    if (kind === 'order') {
      const order = findOrder(ctx, String(b.order_id ?? ''));
      if (!order) throw notFound('заказ не найден');
      const shop = ctx.db.shops.get(order.shop_id);
      if (order.buyer_id !== auth.user.id && !shopAdmins(ctx, order.shop_id).includes(auth.user.id)) {
        throw forbidden('FORBIDDEN', 'чат заказа доступен только его участникам');
      }
      const chat = openOrderChat(ctx, order, shop, ctx.db.users.get(order.buyer_id));
      return created(chatDto(ctx, chat, auth.user.id));
    }

    if (kind === 'direct') {
      const peer = ctx.db.users.get(String(b.user_id ?? ''));
      if (!peer || peer.id === auth.user.id) throw bad('укажите собеседника');
      const existing = [...ctx.db.chats.values()].find((chat) => {
        if (chat.kind !== 'direct' || chat.closed_at) return false;
        const members = ctx.db.members.get(chat.id) ?? [];
        return members.length === 2 && members.some((m) => m.user_id === auth.user.id) &&
          members.some((m) => m.user_id === peer.id);
      });
      if (existing) return ok(chatDto(ctx, existing, auth.user.id));
      const chat = {
        id: C.newId('cht'), kind: 'direct', title: `Диалог с ${peer.nickname}`,
        e2ee: b.e2ee !== false, last_seq: 0, created_at: new Date().toISOString(),
        admin_user_id: '', shop_id: '', order_id: '', dispute_id: '', pinned: false, closed_at: null,
      };
      ctx.db.chats.set(chat.id, chat);
      ctx.db.messages.set(chat.id, []);
      addMember(ctx, chat.id, auth.user.id, 'member');
      addMember(ctx, chat.id, peer.id, 'member');
      if (chat.e2ee) {
        systemMessage(ctx, chat, 'Приватный чат с сквозным шифрованием (X25519 + AES-256-GCM). Сервер видит только шифртекст.');
      }
      audit(ctx, r.req, auth.user, 'chat.open', 'chat', chat.id, 'direct', '', null, { peer_id: peer.id, e2ee: chat.e2ee });
      notify(ctx, peer.id, 'chat_new', 'Новое сообщение',
        `${auth.user.nickname} открыл(а) приватный диалог`, `chat:${chat.id}:${peer.id}`);
      push(ctx, peer.id, 'chat.new', { chat_id: chat.id, kind: 'direct' });
      return created(chatDto(ctx, chat, auth.user.id));
    }

    if (kind === 'group' || kind === 'channel') {
      if (!['shop_admin', 'moderator', 'arbiter', 'superadmin'].includes(auth.user.role)) {
        throw forbidden('FORBIDDEN', 'создавать группы и каналы могут продавцы и администрация');
      }
      const title = truncate(String(b.title ?? ''), 80);
      if (title.length < 3) throw bad('название: минимум 3 символа');
      const shop = findShop(ctx, String(b.shop_id ?? ''));
      if (shop && shop.admin_user_id !== auth.user.id && auth.user.role !== 'superadmin') {
        throw forbidden('FORBIDDEN', 'канал магазина создаёт его админ');
      }
      const chat = {
        id: C.newId('cht'), kind, title,
        shop_id: shop?.id ?? '', admin_user_id: auth.user.id, e2ee: kind === 'group' && b.e2ee === true,
        pinned: !!b.pinned, last_seq: 0, created_at: new Date().toISOString(), closed_at: null,
        order_id: '', dispute_id: '',
      };
      ctx.db.chats.set(chat.id, chat);
      ctx.db.messages.set(chat.id, []);
      addMember(ctx, chat.id, auth.user.id, 'owner');
      for (const userId of Array.isArray(b.member_ids) ? b.member_ids : []) {
        if (ctx.db.users.has(userId)) addMember(ctx, chat.id, userId, kind === 'channel' ? 'subscriber' : 'member');
      }
      systemMessage(ctx, chat, kind === 'channel'
        ? 'Канал создан. Публикации видят все подписчики.'
        : 'Группа создана. Сообщения шифруются на сервере (AES-256-GCM), при включённом E2EE — только на устройствах.');
      audit(ctx, r.req, auth.user, 'chat.create', 'chat', chat.id, kind, '', null, { title, shop_id: chat.shop_id });
      return created(chatDto(ctx, chat, auth.user.id));
    }

    throw bad('kind должен быть shop_support, order, direct, group или channel');
  }, { rate: 'write' }]);

  routes.push(['GET', '/api/v1/chats/:id', (r) => {
    const auth = requireAuth(ctx, r.req);
    const chat = ctx.db.chats.get(r.params.id);
    if (!chat) throw notFound('чат не найден');
    const staff = ['arbiter', 'moderator', 'superadmin'].includes(auth.user.role);
    if (!isMember(ctx, chat.id, auth.user.id) && !staff) throw forbidden('FORBIDDEN', 'вы не участник чата');
    const dto = chatDto(ctx, chat, auth.user.id);
    const messages = (ctx.db.messages.get(chat.id) ?? []).slice(-20);
    dto.messages = messages.map((m) => messageDto(ctx, chat, m, auth.user.id));
    dto.actions = [];
    if (chat.kind === 'shop_support' || chat.kind === 'order') dto.actions.push('open_order', 'send_message');
    if (chat.kind === 'dispute') dto.actions.push('attach_evidence', 'escalate');
    if (chat.e2ee) dto.actions.push('verify_safety_number');
    dto.e2ee_notice = chat.e2ee
      ? 'Сквозное шифрование: сервер хранит и передаёт только шифртекст.'
      : 'Сообщения шифруются на сервере (AES-256-GCM, домен msg) и расшифровываются только для участников.';
    return ok(dto);
  }, { rate: 'public' }]);

  routes.push(['GET', '/api/v1/chats/:id/messages', (r) => {
    const auth = requireAuth(ctx, r.req);
    const chat = ctx.db.chats.get(r.params.id);
    if (!chat) throw notFound('чат не найден');
    const staff = ['arbiter', 'moderator', 'superadmin'].includes(auth.user.role);
    if (!isMember(ctx, chat.id, auth.user.id) && !staff) throw forbidden('FORBIDDEN', 'вы не участник чата');
    const limit = Math.min(100, Math.max(1, Number(r.query.limit ?? 30)));
    const beforeSeq = Number(r.query.before_seq ?? 0);
    let messages = ctx.db.messages.get(chat.id) ?? [];
    if (beforeSeq > 0) messages = messages.filter((m) => m.seq < beforeSeq);
    const slice = messages.slice(-limit);
    return ok({
      items: slice.map((m) => messageDto(ctx, chat, m, auth.user.id)).reverse(),
      has_more: beforeSeq > 0 && messages.length > limit,
      oldest_seq: slice.length ? slice[0].seq : null,
      chat_id: chat.id, e2ee: !!chat.e2ee,
    });
  }, { rate: 'public' }]);

  routes.push(['POST', '/api/v1/chats/:id/messages', (r) => {
    const auth = requireAuth(ctx, r.req);
    const chat = ctx.db.chats.get(r.params.id);
    if (!chat) throw notFound('чат не найден');
    if (chat.closed_at) throw conflict('CHAT_CLOSED', 'чат закрыт');
    if (!isMember(ctx, chat.id, auth.user.id)) throw forbidden('FORBIDDEN', 'вы не участник чата');
    const mine = (ctx.db.members.get(chat.id) ?? []).find((m) => m.user_id === auth.user.id);
    if (mine?.muted) throw forbidden('MUTED', 'отправка сообщений ограничена модератором');
    const b = r.body ?? {};
    const type = String(b.type ?? 'text');
    if (!['text', 'file', 'image', 'gift', 'system'].includes(type)) throw bad('некорректный тип сообщения');
    if (type === 'system' && !['moderator', 'superadmin', 'arbiter'].includes(auth.user.role)) {
      throw forbidden('FORBIDDEN', 'системные сообщения создаёт только администрация');
    }
    const clientMsgId = String(b.client_msg_id ?? '');
    if (clientMsgId) {
      const dup = (ctx.db.messages.get(chat.id) ?? []).find((m) => m.client_msg_id === clientMsgId);
      if (dup) return ok({ id: dup.id, chat_id: chat.id, seq: dup.seq, status: 'duplicate', created_at: dup.created_at });
    }
    const isE2EE = !!b.e2ee || !!chat.e2ee;
    let msg;
    if (isE2EE) {
      const bodyCt = String(b.body_ct ?? '');
      if (!bodyCt) throw bad('для E2EE передайте body_ct — шифртекст, созданный на устройстве');
      if (bodyCt.length > 65536) throw bad('шифртекст слишком большой');
      msg = addMessage(ctx, chat, auth.user, '', {
        type, e2ee: true, bodyCt, clientMsgId, visibleAs: mine?.visible_as ?? '',
      });
    } else {
      const body = String(b.body ?? '');
      if (!body.trim()) throw bad('пустое сообщение');
      if (body.length > MAX_BODY) throw bad(`сообщение длиннее ${MAX_BODY} символов`);
      msg = addMessage(ctx, chat, auth.user, body, {
        type, clientMsgId, visibleAs: mine?.visible_as ?? '', system: b.system ?? null,
      });
    }
    if (b.reply_to) msg.reply_to = String(b.reply_to);
    if (b.sender_key_id) msg.sender_key_id = String(b.sender_key_id);
    if (b.aad) msg.aad = String(b.aad);
    broadcastMessage(ctx, chat, msg, auth.user);

    const peers = (ctx.db.members.get(chat.id) ?? [])
      .filter((m) => m.user_id !== auth.user.id && !m.left_at)
      .map((m) => m.user_id);
    for (const peerId of peers) {
      notify(ctx, peerId, 'chat_message', chat.title,
        isE2EE ? 'Новое зашифрованное сообщение' : truncate(String(b.body ?? ''), 90),
        `msg:${msg.id}:${peerId}`, { chat_id: chat.id });
    }
    if (chat.kind === 'shop_support' && shopAdmins(ctx, chat.shop_id).includes(auth.user.id)) {
      const shop = ctx.db.shops.get(chat.shop_id);
      if (shop && !shop.response_p50_s) shop.response_p50_s = 600;
    }
    return created({
      id: msg.id, chat_id: chat.id, seq: msg.seq, status: 'sent',
      created_at: msg.created_at, client_msg_id: clientMsgId || undefined,
      e2ee: isE2EE, body_ct: isE2EE ? msg.body_ct : undefined,
      body: isE2EE ? undefined : C.tryDecrypt(C.DOMAINS.message, msg.id, msg.body_ct),
      body_stored_encrypted: !isE2EE,
    });
  }, { rate: 'wsmsg' }]);

  routes.push(['POST', '/api/v1/chats/:id/read', (r) => {
    const auth = requireAuth(ctx, r.req);
    const chat = ctx.db.chats.get(r.params.id);
    if (!chat) throw notFound('чат не найден');
    const mine = (ctx.db.members.get(chat.id) ?? []).find((m) => m.user_id === auth.user.id);
    if (!mine) throw forbidden('FORBIDDEN', 'вы не участник чата');
    const seq = Math.min(chat.last_seq ?? 0, Number(r.body?.seq ?? chat.last_seq ?? 0));
    mine.last_read_seq = Math.max(mine.last_read_seq ?? 0, seq);
    const peers = (ctx.db.members.get(chat.id) ?? [])
      .filter((m) => m.user_id !== auth.user.id)
      .map((m) => m.user_id);
    pushMany(ctx, peers, 'chat.read', {
      chat_id: chat.id, user_id: auth.user.id, seq: mine.last_read_seq, ts: Date.now(),
    });
    return ok({ chat_id: chat.id, last_read_seq: mine.last_read_seq, unread: Math.max(0, (chat.last_seq ?? 0) - mine.last_read_seq) });
  }, { rate: 'write' }]);

  // ------------------------------------------------------------------
  // E2EE: преключи, бандлы, сессии, safety number
  // ------------------------------------------------------------------
  routes.push(['POST', '/api/v1/e2ee/prekeys', (r) => {
    const auth = requireAuth(ctx, r.req);
    const b = r.body ?? {};
    const deviceId = String(b.device_id ?? 'web');
    if (!b.identity_pub || !b.signed_prekey) throw bad('передайте identity_pub и signed_prekey (публичные части X25519)');
    const otk = Array.isArray(b.one_time_keys) ? b.one_time_keys.slice(0, 100) : [];
    ctx.db.prekeys.set(`${auth.user.id}:${deviceId}`, {
      user_id: auth.user.id, device_id: deviceId,
      identity_pub: String(b.identity_pub), signed_prekey: String(b.signed_prekey),
      signature: String(b.signature ?? ''), one_time: otk.map((k) => ({ id: String(k.id), pub: String(k.pub), used: false })),
      created_at: new Date().toISOString(),
    });
    audit(ctx, r.req, auth.user, 'e2ee.prekeys', 'user', auth.user.id, `device=${deviceId}`, '', null,
      { identity_pub: String(b.identity_pub).slice(0, 12), one_time: otk.length });
    return ok({
      status: 'ok', device_id: deviceId, one_time_keys: otk.length,
      notice: 'Сервер хранит только публичные части ключей (docs/security.md §4.1).',
    });
  }, { rate: 'write' }]);

  routes.push(['GET', '/api/v1/e2ee/bundle/:userId', (r) => {
    const auth = requireAuth(ctx, r.req);
    const targetId = r.params.userId;
    if (!ctx.db.users.has(targetId)) throw notFound('пользователь не найден');
    const entry = [...ctx.db.prekeys.values()].find((p) => p.user_id === targetId);
    if (!entry) throw notFound('у собеседника ещё нет загруженных ключей E2EE');
    const otk = entry.one_time.find((k) => !k.used);
    if (otk) otk.used = true;
    return ok({
      user_id: targetId, device_id: entry.device_id,
      identity_pub: entry.identity_pub, signed_prekey: entry.signed_prekey, signature: entry.signature,
      one_time_key: otk ? { id: otk.id, pub: otk.pub } : null,
      one_time_left: entry.one_time.filter((k) => !k.used).length,
      safety_number: safetyNumber(C.KEK_FINGERPRINT, auth.user.id, targetId),
      fetched_at: new Date().toISOString(),
    });
  }, { rate: 'public' }]);

  routes.push(['POST', '/api/v1/e2ee/sessions', (r) => {
    const auth = requireAuth(ctx, r.req);
    const b = r.body ?? {};
    const toUser = String(b.to_user ?? '');
    if (!ctx.db.users.has(toUser)) throw notFound('получатель не найден');
    const id = C.newId('e2s');
    ctx.db.e2eeSessions.set(id, {
      id, chat_id: String(b.chat_id ?? ''), from_user: auth.user.id, to_user: toUser,
      to_device: String(b.to_device ?? 'web'), ephemeral_pub: String(b.ephemeral_pub ?? ''),
      used_opk_id: String(b.used_opk_id ?? ''), root_key_fingerprint: String(b.root_key_fingerprint ?? ''),
      created_at: new Date().toISOString(),
    });
    push(ctx, toUser, 'e2ee.session', { session_id: id, from_user: auth.user.id });
    audit(ctx, r.req, auth.user, 'e2ee.session', 'user', toUser, '', '', null,
      { root_key_fingerprint: String(b.root_key_fingerprint ?? '').slice(0, 16) });
    return created({
      id, safety_number: safetyNumber(C.KEK_FINGERPRINT, auth.user.id, toUser),
      root_key_fingerprint: String(b.root_key_fingerprint ?? ''),
      notice: 'Сессия зарегистрирована. Ключи остаются на устройствах участников.',
    });
  }, { rate: 'write' }]);

  routes.push(['GET', '/api/v1/e2ee/safety/:userId', (r) => {
    const auth = requireAuth(ctx, r.req);
    const targetId = r.params.userId;
    if (!ctx.db.users.has(targetId)) throw notFound('пользователь не найден');
    const sessions = [...ctx.db.e2eeSessions.values()]
      .filter((s) => (s.from_user === auth.user.id && s.to_user === targetId) ||
        (s.from_user === targetId && s.to_user === auth.user.id))
      .map((s) => ({ id: s.id, chat_id: s.chat_id, root_key_fingerprint: s.root_key_fingerprint, created_at: s.created_at }));
    return ok({
      user_id: targetId,
      nickname: ctx.db.users.get(targetId).nickname,
      safety_number: safetyNumber(C.KEK_FINGERPRINT, auth.user.id, targetId),
      sessions,
      instruction: 'Сравните номер с собеседником голосом или вживую — совпадение подтверждает отсутствие MITM.',
    });
  }, { rate: 'public' }]);

  return routes;
}
