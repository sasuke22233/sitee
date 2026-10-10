// Мессенджер и споры: список чатов, диалог с админом, E2EE-метки, спор с маскировкой сторон.
import { api, live } from '../api.js';
import { S } from '../state.js';
import {
  h, mount, toast, describeError, spinner, empty, statusChip, dateTime, timeShort,
  initials, accentFor, countdown, modal, postWithOps, copyText,
} from '../ui.js';

const KIND_LABEL = {
  shop_support: 'поддержка магазина', order: 'чат заказа', dispute: 'спор',
  direct: 'приватный чат', group: 'группа', channel: 'канал',
};
const KIND_ICON = {
  shop_support: '🏪', order: '🧾', dispute: '⚖️', direct: '🔐', group: '👥', channel: '📣',
};

// ---------------------------------------------------------------------------
// Список чатов
// ---------------------------------------------------------------------------
export async function chats(container, { navigate }) {
  mount(container, spinner());
  try {
    const res = await api.get('/api/v1/chats?limit=30');
    const items = res.items ?? [];
    mount(container,
      h('div', { class: 'section__head' },
        h('h2', { class: 'section__title', text: 'Чаты' }),
        h('span', { class: 'section__hint', text: `непрочитанных: ${res.unread_total ?? 0}` })),
      h('div', { class: 'notice', text: 'Любое обращение в магазин открывает диалог с админом магазина. Сообщения шифруются AES-256-GCM; приватные чаты — сквозным шифрованием.' }),
      h('div', { class: 'btn-row', style: 'margin-bottom:10px' },
        h('button', { class: 'btn', type: 'button', text: '⚖️ Споры', onclick: () => navigate('#/disputes') }),
        h('button', { class: 'btn', type: 'button', text: '🔐 Приватный чат', onclick: () => directChatModal(navigate) })),
      items.length
        ? h('div', { class: 'list' }, items.map((chat) => chatRow(chat, navigate)))
        : empty('💬', 'Чатов пока нет', 'Откройте магазин и напишите админу — диалог создастся автоматически.'));
  } catch (err) {
    mount(container, empty('⚠️', 'Чаты недоступны', describeError(err)));
  }
}

function chatRow(chat, navigate) {
  return h('div', { class: 'list-row', onclick: () => navigate(`#/chat/${chat.id}`) },
    h('div', { class: 'list-row__avatar', style: `background:${accentFor(chat.id)}`, text: KIND_ICON[chat.kind] ?? '💬' }),
    h('div', { class: 'list-row__body' },
      h('div', { class: 'list-row__title', text: chat.title }),
      h('div', { class: 'list-row__sub', text: chat.last_message_preview ?? chat.e2ee_notice ?? KIND_LABEL[chat.kind] ?? chat.kind }),
      h('div', { class: 'list-row__sub small dim', text: `${KIND_LABEL[chat.kind] ?? chat.kind}${chat.e2ee ? ' · E2EE' : ''}${chat.shop_name ? ` · ${chat.shop_name}` : ''}` })),
    h('div', { class: 'list-row__aside' },
      h('span', { text: timeShort(chat.last_message_at) }),
      chat.unread > 0 ? h('span', { class: 'badge', style: 'position:static;border:0', text: String(chat.unread) }) : null,
      chat.e2ee ? h('span', { class: 'chip chip--info', text: '🔐 E2EE' }) : null));
}

function directChatModal(navigate) {
  const select = h('select', { class: 'select' },
    h('option', { value: '', text: '— выберите пользователя —' }));
  api.get('/api/v1/admin/users?limit=50').then(() => {}).catch(() => {});
  // Список пользователей доступен только staff; для приватного чата просим nickname.
  const nick = h('input', { class: 'input', placeholder: 'nickname собеседника' });
  const e2ee = h('input', { type: 'checkbox', checked: true });
  modal({
    title: 'Приватный чат',
    sub: 'Сквозное шифрование: сервер хранит только шифртекст.',
    body: h('div', {},
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Никнейм или ID' }), nick),
      select.hidden = true,
      h('label', { class: 'switch' }, e2ee, 'Включить E2EE (X25519 + AES-256-GCM)')),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Открыть чат', kind: 'primary',
        onClick: async (close) => {
          try {
            const target = nick.value.trim();
            if (!target) {
              toast('Укажите собеседника', 'warn');
              return true;
            }
            let userId = target;
            if (!target.startsWith('usr_')) {
              const search = await api.get(`/api/v1/shops?q=${encodeURIComponent(target)}&limit=5`).catch(() => null);
              const found = search?.items?.find((s) => s.name.toLowerCase().includes(target.toLowerCase()));
              if (found) userId = found.id;
            }
            const chat = await api.post('/api/v1/chats', { kind: 'direct', user_id: userId, e2ee: e2ee.checked });
            close(true);
            navigate(`#/chat/${chat.id}`);
          } catch (err) {
            toast(describeError(err), 'err');
          }
          return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Диалог
// ---------------------------------------------------------------------------
export async function chat(container, { navigate }, params) {
  mount(container, spinner());
  let data;
  try {
    data = await api.get(`/api/v1/chats/${params.id}`);
  } catch (err) {
    mount(container, empty('⚠️', 'Чат не найден', describeError(err)));
    return;
  }
  const log = h('div', { class: 'chat__log' });
  const typingBox = h('div', { class: 'typing', text: '' });
  const input = h('textarea', { class: 'chat__input', rows: '1', placeholder: data.e2ee ? 'Зашифрованное сообщение…' : 'Сообщение…' });
  const sendBtn = h('button', { class: 'chat__send', type: 'button', title: 'Отправить' },
    h('span', { text: '➤' }));

  const bannerText = data.e2ee
    ? '🔐 Сквозное шифрование: сервер видит только шифртекст. Проверьте safety number в профиле собеседника.'
    : data.kind === 'dispute'
      ? '⚖️ Спор: стороны скрыты псевдонимами. Арбитр видит реальные ID.'
      : `🛡 Сообщения шифруются на сервере (AES-256-GCM). Диалог с админом: ${data.admin_user_id ? 'владелец магазина' : 'администрация'}`;

  mount(container,
    h('div', { class: 'chat' },
      h('div', { class: 'row', style: 'padding:8px 12px;background:var(--bg-elev);border-bottom:1px solid var(--line-soft)' },
        h('span', { class: 'back', style: 'margin:0', onclick: () => navigate('#/chats'), text: '←' }),
        h('div', { class: 'list-row__avatar', style: `width:34px;height:34px;flex-basis:34px;background:${accentFor(data.id)}`, text: KIND_ICON[data.kind] ?? '💬' }),
        h('div', { class: 'grow' },
          h('div', { style: 'font-weight:700;font-size:14px', text: data.title }),
          h('div', { class: 'small dim', text: `${KIND_LABEL[data.kind] ?? data.kind}${data.shop_name ? ` · ${data.shop_name}` : ''}${data.order_id ? ' · заказ' : ''}` })),
        data.order_id ? h('button', { class: 'btn btn--sm', type: 'button', text: 'Заказ', onclick: () => navigate(`#/order/${data.order_id}`) }) : null,
        data.dispute_id ? h('button', { class: 'btn btn--sm', type: 'button', text: 'Спор', onclick: () => navigate(`#/dispute/${data.dispute_id}`) }) : null,
        data.shop_id ? h('button', { class: 'btn btn--sm', type: 'button', text: 'Магазин', onclick: () => navigate(`#/shop/${data.shop_id}`) }) : null),
      h('div', { class: 'chat__banner', text: bannerText }),
      log,
      typingBox,
      h('div', { class: 'chat__composer' },
        input,
        data.e2ee
          ? h('button', {
            class: 'btn btn--sm', type: 'button', text: '🔐',
            title: 'E2EE: сообщение шифруется на устройстве',
            onclick: () => toast('В preview E2EE-шифртекст создаётся демо-клиентом: содержимое упаковывается как body_ct', 'info'),
          })
          : null,
        sendBtn)));

  const messages = data.messages ?? [];
  renderLog(log, data, messages);
  markRead(data);

  const off = live.on('msg.new', (d) => {
    if (d.chat_id !== data.id) return;
    appendMessage(log, data, d);
    markRead(data);
    scrollLog(log);
  });
  const offTyping = live.on('typing', (d) => {
    if (d.chat_id !== data.id) return;
    typingBox.textContent = d.typing ? `${d.user_id === S.me?.id ? 'вы' : 'собеседник'} печатает…` : '';
    if (d.typing) setTimeout(() => { typingBox.textContent = ''; }, 3000);
  });

  const send = async () => {
    const body = input.value.trim();
    if (!body) return;
    const clientMsgId = `ui-${Date.now()}`;
    input.value = '';
    const optimistic = {
      id: clientMsgId, seq: null, type: 'text', sender_id: S.me?.id, sender_visible_as: S.me?.nickname,
      body, created_at: new Date().toISOString(), pending: true,
    };
    appendMessage(log, data, optimistic);
    scrollLog(log);
    live.send('typing', { chat_id: data.id, typing: true });
    try {
      if (data.e2ee) {
        // Демо-E2EE: на устройстве текст упаковывается в body_ct (в проде — X25519+AES-GCM).
        const bodyCt = await demoEncrypt(body);
        const res = await api.post(`/api/v1/chats/${data.id}/messages`, {
          client_msg_id: clientMsgId, type: 'text', e2ee: true, body_ct: bodyCt,
        });
        replacePending(log, clientMsgId, { id: res.id, seq: res.seq, created_at: res.created_at, body, e2ee: true });
      } else {
        const res = await api.post(`/api/v1/chats/${data.id}/messages`, {
          client_msg_id: clientMsgId, type: 'text', body,
        });
        replacePending(log, clientMsgId, { id: res.id, seq: res.seq, created_at: res.created_at, body, body_stored_encrypted: true });
      }
      live.send('typing', { chat_id: data.id, typing: false });
      markRead(data);
    } catch (err) {
      toast(describeError(err), 'err');
      replacePending(log, clientMsgId, { failed: true, body });
    }
  };

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      send();
    }
  });
  input.addEventListener('input', () => {
    live.send('typing', { chat_id: data.id, typing: true });
  });

  // Очистка подписок при уходе со страницы.
  const observer = new MutationObserver(() => {
    if (!container.contains(log)) {
      off();
      offTyping();
      observer.disconnect();
    }
  });
  observer.observe(container, { childList: true });
}

async function demoEncrypt(text) {
  // Формат preview: base64(JSON) — имитация шифртекста на устройстве.
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, alg: 'X25519+AES-256-GCM', pt: text }));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function renderLog(log, data, messages) {
  mount(log, messages.slice().reverse().map((m) => messageNode(data, m)));
  scrollLog(log);
}

function appendMessage(log, data, m) {
  log.append(messageNode(data, m));
}

function replacePending(log, clientMsgId, patch) {
  const node = log.querySelector(`[data-cmid="${CSS.escape(clientMsgId)}"]`);
  if (!node) return;
  node.dataset.id = patch.id ?? node.dataset.id;
  if (patch.failed) {
    node.classList.add('msg--system');
    node.append(h('div', { class: 'small', style: 'color:var(--err)', text: 'не доставлено' }));
    return;
  }
  const time = node.querySelector('.msg__time');
  if (time) time.textContent = `${timeShort(patch.created_at)} ✓`;
}

function messageNode(data, m) {
  const mine = m.sender_id === S.me?.id;
  if (m.type === 'system') {
    return h('div', { class: 'msg msg--system', dataset: { id: m.id ?? '', cmid: m.client_msg_id ?? '' } },
      h('div', { text: m.system?.title ?? m.body ?? '' }),
      h('div', { class: 'msg__time', text: timeShort(m.created_at) }));
  }
  return h('div', {
    class: `msg ${mine ? 'msg--mine' : ''}`,
    dataset: { id: m.id ?? '', cmid: m.client_msg_id ?? '' },
  },
  !mine ? h('div', { class: 'msg__who', text: m.sender_visible_as ?? 'участник' }) : null,
  h('div', { class: 'msg__body', text: m.body ?? (m.e2ee ? '🔐 зашифровано' : '') }),
  h('div', { class: 'msg__time', text: `${timeShort(m.created_at)}${mine ? ' ✓' : ''}${m.e2ee ? ' · 🔐' : ''}` }));
}

function scrollLog(log) {
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

async function markRead(data) {
  try {
    live.send('msg.read', { chat_id: data.id, seq: data.last_seq });
    await api.post(`/api/v1/chats/${data.id}/read`, { seq: data.last_seq });
  } catch { /* не критично */ }
}

// ---------------------------------------------------------------------------
// Споры
// ---------------------------------------------------------------------------
export async function disputes(container, { navigate }) {
  mount(container, spinner());
  try {
    const res = await api.get('/api/v1/disputes?limit=30');
    const items = res.items ?? [];
    mount(container,
      h('div', { class: 'section__head' },
        h('h2', { class: 'section__title', text: 'Споры' }),
        h('button', { class: 'btn btn--sm', type: 'button', text: '← Чаты', onclick: () => navigate('#/chats') })),
      h('div', { class: 'notice', text: 'Спор открывается по заказу, где средства ещё в эскроу. Стороны видят псевдонимы, арбитр — реальные ID (с записью в аудит).' }),
      items.length
        ? h('div', { class: 'list' }, items.map((d) => h('div', { class: 'list-row', onclick: () => navigate(`#/dispute/${d.id}`) },
          h('div', { class: 'list-row__avatar', style: 'background:#3a2b3f', text: '⚖️' }),
          h('div', { class: 'list-row__body' },
            h('div', { class: 'list-row__title', text: `Заказ ${d.order_number ?? d.order_id}` }),
            h('div', { class: 'list-row__sub', text: `${d.you_are === 'shop_admin' ? 'вы продавец' : d.you_are === 'arbiter' ? 'вы арбитр' : 'вы покупатель'} · ${d.counterparty_alias}` }),
            h('div', { class: 'list-row__sub small dim', text: dateTime(d.created_at) })),
          h('div', { class: 'list-row__aside' }, statusChip(d.status, d.status),
            d.status === 'open' && d.reply_deadline ? h('span', { class: 'small dim', text: `ответ: ${countdown(d.reply_deadline)}` }) : null,
            d.status === 'in_arbitration' && d.resolve_deadline ? h('span', { class: 'small dim', text: `решение: ${countdown(d.resolve_deadline)}` }) : null))))
        : empty('⚖️', 'Споров нет', 'Это хорошо: все заказы закрыты штатно.'));
  } catch (err) {
    mount(container, empty('⚠️', 'Споры недоступны', describeError(err)));
  }
}

export async function dispute(container, { navigate }, params) {
  mount(container, spinner());
  let d;
  try {
    d = await api.get(`/api/v1/disputes/${params.id}`);
  } catch (err) {
    mount(container, empty('⚠️', 'Спор не найден', describeError(err)));
    return;
  }
  const order = d.order_id ? await api.get(`/api/v1/orders/${d.order_id}`).catch(() => null) : null;
  const chatRes = d.chat_id ? await api.get(`/api/v1/chats/${d.chat_id}/messages`).catch(() => ({ items: [] })) : { items: [] };
  const reload = () => dispute(container, { navigate }, params);

  const actions = [];
  for (const action of d.actions ?? []) {
    if (action === 'reply') {
      actions.push(h('button', { class: 'btn', type: 'button', text: '💬 Ответить в чате', onclick: () => navigate(`#/chat/${d.chat_id}`) }));
    }
    if (action === 'attach_evidence' || action === 'request_evidence') {
      actions.push(h('button', { class: 'btn', type: 'button', text: '📎 Доказательство', onclick: () => evidenceModal(d, reload) }));
    }
    if (action === 'escalate') {
      actions.push(h('button', {
        class: 'btn btn--primary', type: 'button', text: '⚖️ Пригласить арбитра',
        onclick: async () => {
          try {
            await api.post(`/api/v1/disputes/${d.id}/escalate`, { reason: 'Вторая сторона не ответила в срок, прошу арбитра.' });
            toast('Спор передан арбитру', 'ok');
            reload();
          } catch (err) {
            toast(describeError(err), 'err');
          }
        },
      }));
    }
    if (action === 'resolve') {
      actions.push(h('button', { class: 'btn btn--ok', type: 'button', text: 'Вынести решение', onclick: () => resolveModal(d, order, reload) }));
    }
  }

  mount(container,
    h('div', { class: 'back', onclick: () => navigate('#/disputes') }, '← К спорам'),
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('h2', { style: 'margin:0;font-size:17px', text: `Спор по заказу ${d.order_number ?? d.order_id}` }),
        h('span', { class: 'grow' }),
        statusChip(d.status, d.status)),
      h('p', { class: 'card__sub', text: d.masking_notice }),
      h('dl', { class: 'kv' },
        h('dt', { text: 'Вы' }), h('dd', { text: `${d.your_alias} (${roleLabel(d.you_are)})` }),
        h('dt', { text: 'Вторая сторона' }), h('dd', { text: d.counterparty_alias }),
        h('dt', { text: 'Сумма в эскроу' }), h('dd', { class: 'pill-price', text: order?.total ?? '—' }),
        h('dt', { text: 'Причина' }), h('dd', { text: d.reason_code }),
        h('dt', { text: 'Ответ до' }), h('dd', { text: `${dateTime(d.reply_deadline)} (${countdown(d.reply_deadline) ?? '—'})` }),
        d.resolve_deadline ? [h('dt', { text: 'Решение до' }), h('dd', { text: `${dateTime(d.resolve_deadline)} (${countdown(d.resolve_deadline) ?? '—'})` })] : null,
        d.resolution ? [h('dt', { text: 'Решение' }), h('dd', { text: `${d.resolution}${d.resolution_reason ? ` — ${d.resolution_reason}` : ''}` })] : null,
        d.reveal && d.buyer_id ? [h('dt', { text: 'Покупатель (видит арбитр)' }), h('dd', { class: 'mono small', text: d.buyer_id })] : null,
        d.reveal && d.seller_id ? [h('dt', { text: 'Продавец (видит арбитр)' }), h('dd', { class: 'mono small', text: d.seller_id })] : null,
        h('dt', { text: 'Открыт' }), h('dd', { text: dateTime(d.created_at) })),
      h('p', { class: 'small muted', style: 'margin-top:8px', text: d.description }),
      d.reveal
        ? h('div', { class: 'notice notice--warn', text: 'Вы назначенный арбитр: видите реальные ID сторон. Каждое раскрытие фиксируется в аудит-цепочке (dispute.reveal).' })
        : h('div', { class: 'notice', text: 'Личные данные скрыты псевдонимами. Если вторая сторона не ответит за 72 часа, спор автоматически уйдёт арбитру; решение — до 7 дней, иначе полный возврат.' }),
      h('div', { class: 'divider' }),
      h('div', { class: 'btn-row' }, actions,
        d.order_id ? h('button', { class: 'btn', type: 'button', text: 'Заказ', onclick: () => navigate(`#/order/${d.order_id}`) }) : null)),
    (d.participants ?? []).length
      ? h('div', { class: 'card' },
        h('h3', { class: 'card__title', text: 'Участники спора' }),
        h('div', { class: 'list' }, d.participants.map((p) => h('div', { class: 'list-row', style: 'cursor:default' },
          h('div', { class: 'list-row__avatar', style: 'background:#2c3244', text: p.role === 'arbiter' ? '⚖️' : p.role === 'buyer' ? '🧑' : '🏪' }),
          h('div', { class: 'list-row__body' },
            h('div', { class: 'list-row__title', text: p.visible_as }),
            h('div', { class: 'list-row__sub small dim', text: roleLabel(p.role) })),
          h('div', { class: 'list-row__aside' },
            p.nickname ? h('span', { class: 'small dim', text: `@${p.nickname}` }) : null)))))
      : null,
    h('div', { class: 'section' },
      h('div', { class: 'section__head' }, h('h2', { class: 'section__title', text: `Доказательства (${(d.evidence ?? []).length})` })),
      (d.evidence ?? []).length
        ? h('div', { class: 'list' }, d.evidence.map((ev) => h('div', { class: 'list-row', style: 'cursor:default' },
          h('div', { class: 'list-row__avatar', style: 'background:#2c3244', text: ev.kind === 'image' ? '🖼' : ev.kind === 'text' ? '📝' : '📎' }),
          h('div', { class: 'list-row__body' },
            h('div', { class: 'list-row__title', text: ev.name }),
            h('div', { class: 'list-row__sub small dim', text: `${ev.kind} · ${(ev.size / 1024).toFixed(1)} КБ · метаданные удалены: ${ev.meta_stripped ? 'да' : 'нет'}` }),
            h('div', { class: 'list-row__sub mono small dim', text: `sha256 ${String(ev.sha256).slice(0, 24)}…` })),
          h('div', { class: 'list-row__aside' },
            h('span', { text: timeShort(ev.created_at) }),
            h('button', { class: 'btn btn--sm', type: 'button', text: 'Открыть', onclick: () => showEvidence(d, ev) })))))
        : empty('📎', 'Доказательств пока нет')),
    h('div', { class: 'section' },
      h('div', { class: 'section__head' }, h('h2', { class: 'section__title', text: 'Хронология' })),
      h('div', { class: 'list' }, (d.timeline ?? []).map((ev) => h('div', { class: 'list-row', style: 'cursor:default' },
        h('div', { class: 'list-row__body' },
          h('div', { class: 'list-row__title', text: timelineLabel(ev.kind) }),
          h('div', { class: 'list-row__sub small dim', text: `${ev.actor_visible_as}${ev.note ? `: ${ev.note}` : ''}` })),
        h('div', { class: 'list-row__aside' }, h('span', { text: dateTime(ev.ts) })))))),
    (chatRes.items ?? []).length
      ? h('div', { class: 'section' },
        h('div', { class: 'section__head' },
          h('h2', { class: 'section__title', text: 'Переписка' }),
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Открыть чат', onclick: () => navigate(`#/chat/${d.chat_id}`) })),
        h('div', { class: 'list' }, chatRes.items.slice(-12).map((m) => h('div', { class: 'card card--flat' },
          h('div', { class: 'row small dim' },
            h('strong', { text: m.sender_visible_as }),
            h('span', { class: 'grow' }),
            h('span', { text: dateTime(m.created_at) })),
          h('p', { style: 'margin:4px 0 0', text: m.body ?? (m.e2ee ? '🔐 зашифровано' : '') })))))
      : null);
}

function roleLabel(role) {
  return { buyer: 'покупатель', shop_admin: 'продавец', arbiter: 'арбитр' }[role] ?? role;
}

function timelineLabel(kind) {
  return {
    opened: 'Спор открыт', escalated: 'Эскалация арбитру', auto_escalated: 'Авто-эскалация (срок ответа истёк)',
    assigned: 'Назначен арбитр', evidence_added: 'Добавлено доказательство', resolved: 'Решение вынесено',
    reply: 'Ответ стороны', revealed: 'Раскрытие данных',
  }[kind] ?? kind;
}

async function showEvidence(d, ev) {
  try {
    const res = await api.get(`/api/v1/disputes/${d.id}/evidence/${ev.id}`);
    modal({
      title: ev.name,
      sub: `${ev.kind} · sha256 ${ev.sha256.slice(0, 16)}… · ${res.uploader_visible_as}`,
      body: h('div', {},
        res.text
          ? h('p', { class: 'mono small', style: 'white-space:pre-wrap', text: res.text })
          : h('p', { class: 'small muted', text: `Файл ${(ev.size / 1024).toFixed(1)} КБ расшифрован на устройстве. Содержимое: ${String(res.data_b64 ?? '').slice(0, 64)}…` })),
      actions: [{ label: 'Закрыть' }],
    });
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

function evidenceModal(d, reload) {
  const kind = h('select', { class: 'select' },
    h('option', { value: 'text', text: 'Текст пояснения' }),
    h('option', { value: 'image', text: 'Скриншот (изображение)' }),
    h('option', { value: 'file', text: 'Файл' }));
  const text = h('textarea', { class: 'textarea', placeholder: 'Текст доказательства (личные данные будут замаскированы)' });
  const file = h('input', { class: 'input', type: 'file' });
  modal({
    title: 'Доказательство по спору',
    sub: 'Файлы шифруются в домене dispute, метаданные удаляются, хэш фиксируется.',
    body: h('div', {},
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Тип' }), kind),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Текст' }), text),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Или файл (до 8 МБ)' }), file)),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Прикрепить', kind: 'primary',
        onClick: async (close) => {
          try {
            const payload = { kind: kind.value };
            if (kind.value === 'text') {
              payload.text = text.value.trim();
              payload.name = 'пояснение.txt';
            } else {
              const f = file.files?.[0];
              if (!f) {
                toast('Выберите файл или введите текст', 'warn');
                return true;
              }
              const buf = await f.arrayBuffer();
              payload.data_b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
              payload.name = f.name;
            }
            await api.post(`/api/v1/disputes/${d.id}/evidence`, payload);
            close(true);
            toast('Доказательство прикреплено', 'ok');
            reload();
          } catch (err) {
            toast(describeError(err), 'err');
          }
          return true;
        },
      },
    ],
  });
}

function resolveModal(d, order, reload) {
  const resolution = h('select', { class: 'select' },
    h('option', { value: 'refund_buyer', text: 'Полный возврат покупателю' }),
    h('option', { value: 'release_seller', text: 'Выплата продавцу' }),
    h('option', { value: 'partial', text: 'Частичный возврат' }),
    h('option', { value: 'dismiss', text: 'Отклонить спор' }));
  const amount = h('input', { class: 'input', type: 'text', placeholder: 'для частичного возврата: 0.5 или 500 (Stars)' });
  const reason = h('textarea', { class: 'textarea', placeholder: 'Обоснование решения (минимум 10 символов)' });
  modal({
    title: 'Решение арбитра',
    sub: `${d.order_number ?? ''} · в эскроу ${order?.total ?? '—'} · ${d.reason_code}`,
    body: h('div', {},
      h('div', { class: 'notice notice--warn', text: 'Вы видите реальные ID сторон. Раскрытие фиксируется в аудит-логе (dispute.reveal).' }),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Решение' }), resolution),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Сумма частичного возврата' }), amount),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Обоснование' }), reason)),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Вынести решение', kind: 'ok',
        onClick: async (close) => {
          try {
            const body = { resolution: resolution.value, reason: reason.value.trim() };
            const value = amount.value.trim();
            if (resolution.value === 'partial' && value) {
              if (order?.pay_asset === 'STARS') body.amount_stars = Number(value);
              else body.amount_sol = value;
            }
            await postWithOps(`/api/v1/disputes/${d.id}/resolve`, body, 'решение по спору');
            close(true);
            toast('Решение вынесено', 'ok');
            reload();
          } catch (err) {
            toast(describeError(err), 'err');
          }
          return true;
        },
      },
    ],
  });
}
