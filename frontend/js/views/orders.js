// Заказы: список (покупатель/продавец), карточка заказа, действия по статусу, выдача, отзыв, спор.
import { api } from '../api.js';
import { S } from '../state.js';
import {
  h, mount, toast, describeError, spinner, empty, statusChip, dateTime, countdown,
  postWithOps, modal, confirmDialog, copyText, askOps,
} from '../ui.js';

const REASONS = [
  ['not_delivered', 'Товар не доставлен'],
  ['wrong_item', 'Прислали не тот товар'],
  ['invalid_key', 'Ключ/аккаунт не работает'],
  ['duplicate', 'Товар уже использован (дубликат)'],
  ['partial', 'Поставка неполная'],
  ['quality', 'Качество не соответствует описанию'],
  ['fraud', 'Признаки мошенничества'],
  ['refund_request', 'Запрос возврата'],
  ['other', 'Другое'],
];

export async function list(container, { navigate }) {
  const hasShops = (S.me?.shops ?? []).length > 0 || ['shop_admin', 'superadmin', 'moderator'].includes(S.me?.role);
  const role = sessionStorage.getItem('sitee.orders.role') ?? (hasShops ? 'shop' : 'buyer');
  const box = h('div', {});
  const tabs = h('div', { class: 'tabs-inline' });

  const renderTabs = (active) => mount(tabs,
    ...[['buyer', 'Мои покупки'], ['shop', 'Заказы магазинов']].map(([value, label]) => h('button', {
      class: 'filter', type: 'button', 'aria-pressed': String(active === value), text: label,
      onclick: () => {
        sessionStorage.setItem('sitee.orders.role', value);
        renderTabs(value);
        load(value);
      },
    })));

  mount(container,
    h('div', { class: 'section__head' },
      h('h2', { class: 'section__title', text: 'Заказы' }),
      h('button', { class: 'btn btn--sm', type: 'button', text: 'Споры', onclick: () => navigate('#/disputes') })),
    tabs, box);
  renderTabs(role);
  load(role);

  async function load(currentRole) {
    mount(box, spinner());
    try {
      const res = await api.get(`/api/v1/orders?role=${currentRole}&limit=30`);
      if (!res.items.length) {
        mount(box, empty('🧾', currentRole === 'shop' ? 'В ваших магазинах пока нет заказов' : 'У вас пока нет заказов',
          currentRole === 'shop' ? 'Добавьте товары и продлите аренду, чтобы получать заказы.' : 'Выберите магазин в ленте и оформите первый заказ.'));
        return;
      }
      mount(box,
        res.counts
          ? h('div', { class: 'row row--wrap', style: 'margin-bottom:8px' },
            Object.entries(res.counts).map(([status, count]) => h('span', { class: 'chip', text: `${status}: ${count}` })))
          : null,
        h('div', { class: 'list' }, res.items.map((order) => row(order, navigate))));
    } catch (err) {
      mount(box, empty('⚠️', 'Не удалось загрузить заказы', describeError(err)));
    }
  }
}

function row(order, navigate) {
  return h('div', { class: 'list-row', onclick: () => navigate(`#/order/${order.id}`) },
    h('div', { class: 'list-row__avatar', style: 'background:#2c3244', text: order.role === 'buyer' ? '🧾' : '🏪' }),
    h('div', { class: 'list-row__body' },
      h('div', { class: 'list-row__title', text: `${order.number} · ${order.shop_name ?? ''}` }),
      h('div', { class: 'list-row__sub', text: order.items.map((i) => `${i.title} ×${i.qty}`).join(', ') }),
      h('div', { class: 'list-row__sub small dim', text: dateTime(order.created_at) })),
    h('div', { class: 'list-row__aside' },
      statusChip(order.status, order.status_title),
      h('strong', { text: order.total }),
      order.status === 'created' || order.status === 'awaiting_payment'
        ? h('span', { class: 'small dim', text: `оплата: ${countdown(order.pay_deadline) ?? '—'}` })
        : null,
      order.status === 'delivered'
        ? h('span', { class: 'small dim', text: `подтвердить: ${countdown(order.confirm_deadline) ?? '—'}` })
        : null));
}

// ---------------------------------------------------------------------------
// Карточка заказа
// ---------------------------------------------------------------------------
export async function detail(container, { navigate }, params) {
  mount(container, spinner());
  let order;
  try {
    order = await api.get(`/api/v1/orders/${params.id}`);
  } catch (err) {
    mount(container, empty('⚠️', 'Заказ не найден', describeError(err)));
    return;
  }
  const reload = () => detail(container, { navigate }, params);
  const actionsBox = h('div', { class: 'btn-row' });
  const deliveryBox = h('div', {});
  const historyBox = h('div', {});

  mount(container,
    h('div', { class: 'back', onclick: () => navigate('#/orders') }, '← К заказам'),
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('h2', { style: 'margin:0;font-size:17px', text: `${order.number}` }),
        h('span', { class: 'grow' }),
        statusChip(order.status, order.status_title)),
      h('p', { class: 'card__sub', style: 'margin-top:6px', text: `${order.shop_name} · ${order.role === 'buyer' ? 'вы покупатель' : 'ваш магазин'}` }),
      h('dl', { class: 'kv' },
        h('dt', { text: 'Сумма' }), h('dd', { class: 'pill-price', text: order.total }),
        h('dt', { text: 'Комиссия площадки' }), h('dd', { text: `${order.fee} (${order.fee_bps / 100} %)` }),
        h('dt', { text: 'Создан' }), h('dd', { text: dateTime(order.created_at) }),
        order.paid_at ? [h('dt', { text: 'Оплачен' }), h('dd', { text: dateTime(order.paid_at) })] : null,
        order.delivered_at ? [h('dt', { text: 'Выдан' }), h('dd', { text: dateTime(order.delivered_at) })] : null,
        order.completed_at ? [h('dt', { text: 'Завершён' }), h('dd', { text: dateTime(order.completed_at) })] : null,
        order.pay_deadline && ['created', 'awaiting_payment'].includes(order.status)
          ? [h('dt', { text: 'Оплатить до' }), h('dd', { text: `${dateTime(order.pay_deadline)} (${countdown(order.pay_deadline)})` })] : null,
        order.confirm_deadline && order.status === 'delivered'
          ? [h('dt', { text: 'Подтвердить до' }), h('dd', { text: `${dateTime(order.confirm_deadline)} (${countdown(order.confirm_deadline)})` })] : null,
        order.dispute_id ? [h('dt', { text: 'Спор' }), h('dd', {}, h('a', { href: `#/dispute/${order.dispute_id}`, style: 'color:var(--accent)', text: 'открыть спор' }))] : null),
      h('div', { class: 'divider' }),
      h('p', { class: 'small dim', text: 'Позиции:' }),
      h('div', { class: 'list' }, order.items.map((item) => h('div', { class: 'list-row', style: 'cursor:default' },
        h('div', { class: 'list-row__body' },
          h('div', { class: 'list-row__title', text: item.title }),
          h('div', { class: 'list-row__sub', text: `${item.qty} × ${item.unit_price}` }),
          item.delivered_at ? h('div', { class: 'list-row__sub small dim', text: `выдано ${dateTime(item.delivered_at)} · скачано ${item.download_count ?? 0} раз` }) : null)))),
      h('div', { class: 'divider' }),
      actionsBox),
    deliveryBox,
    h('div', { class: 'section' },
      h('div', { class: 'section__head' }, h('h2', { class: 'section__title', text: 'История статусов' })),
      historyBox));

  renderActions(order, actionsBox, navigate, reload);
  renderDelivery(order, deliveryBox, navigate);
  renderHistory(order, historyBox);
}

function renderActions(order, box, navigate, reload) {
  const buttons = [];
  const act = (label, kind, fn) => buttons.push(h('button', { class: `btn ${kind ? `btn--${kind}` : ''}`, type: 'button', text: label, onclick: fn }));

  for (const action of order.actions ?? []) {
    switch (action) {
      case 'pay':
        act('Оплатить в эскроу', 'primary', () => payOrder(order, reload, navigate));
        break;
      case 'cancel':
        act('Отменить', 'danger', async () => {
          const reason = await promptText('Отмена заказа', 'Причина отмены (видна второй стороне)', 'не актуально');
          if (reason === null) return;
          try {
            await api.post(`/api/v1/orders/${order.id}/cancel`, { reason });
            toast('Заказ отменён', 'ok');
            reload();
          } catch (err) {
            toast(describeError(err), 'err');
          }
        });
        break;
      case 'chat_with_admin':
        act('💬 Чат с админом', '', () => navigate(order.chat_id ? `#/chat/${order.chat_id}` : `#/shop/${order.shop_id}`));
        break;
      case 'processing':
        act('Принять в работу', '', async () => {
          try {
            await api.post(`/api/v1/orders/${order.id}/processing`, {});
            toast('Заказ в обработке', 'ok');
            reload();
          } catch (err) {
            toast(describeError(err), 'err');
          }
        });
        break;
      case 'deliver':
        act('Выдать товар', 'ok', () => deliverOrder(order, reload));
        break;
      case 'confirm':
        act('Подтвердить получение', 'ok', async () => {
          const yes = await confirmDialog('Подтвердить заказ?',
            'Средства из эскроу уйдут продавцу. После подтверждения можно оставить отзыв и открыть спор в течение 30 дней.');
          if (!yes) return;
          try {
            await api.post(`/api/v1/orders/${order.id}/confirm`, {});
            toast('Заказ завершён', 'ok');
            reload();
          } catch (err) {
            toast(describeError(err), 'err');
          }
        });
        break;
      case 'extend':
        act('Продлить срок', '', async () => {
          try {
            await api.post(`/api/v1/orders/${order.id}/extend`, {});
            toast('Срок подтверждения продлён на 72 часа', 'ok');
            reload();
          } catch (err) {
            toast(describeError(err), 'err');
          }
        });
        break;
      case 'review':
        act('Оставить отзыв', 'primary', () => reviewOrder(order, reload));
        break;
      case 'open_dispute':
        act('Открыть спор', 'danger', () => disputeOrder(order, navigate, reload));
        break;
      case 'reply_dispute':
        act('Ответить в споре', '', () => navigate(`#/dispute/${order.dispute_id}`));
        break;
      case 'escalate':
        act('Пригласить арбитра', 'primary', () => navigate(`#/dispute/${order.dispute_id}`));
        break;
      case 'offer_refund':
        act('Спор', 'danger', () => navigate(`#/dispute/${order.dispute_id}`));
        break;
      default:
        break;
    }
  }
  if (!buttons.length) {
    mount(box, h('p', { class: 'small dim', text: 'Действий по текущему статусу нет.' }));
    return;
  }
  mount(box, buttons);
}

function payOrder(order, reload, navigate) {
  const asset = h('select', { class: 'select' },
    h('option', { value: order.pay_asset, text: order.pay_asset === 'STARS' ? `⭐ Stars — ${order.total}` : `◎ SOL — ${order.total}` }),
    order.pay_asset === 'SOL' ? h('option', { value: 'STARS', text: '⭐ Telegram Stars' }) : h('option', { value: 'SOL', text: '◎ SOL' }));
  modal({
    title: `Оплата заказа ${order.number}`,
    sub: 'Средства резервируются в эскроу и перечисляются продавцу только после подтверждения.',
    body: h('div', {},
      h('dl', { class: 'kv' },
        h('dt', { text: 'Сумма' }), h('dd', { class: 'pill-price', text: order.total }),
        h('dt', { text: 'Подытог' }), h('dd', { text: order.subtotal }),
        h('dt', { text: 'Комиссия' }), h('dd', { text: order.fee })),
      h('div', { class: 'field', style: 'margin-top:10px' }, h('label', { class: 'field__label', text: 'Актив' }), asset),
      h('div', { class: 'notice', text: 'Потребуется код второго фактора 2FA («операции») — это защита от вывода средств при компрометации пароля.' })),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Оплатить', kind: 'primary',
        onClick: async (close) => {
          try {
            const res = await postWithOps(`/api/v1/orders/${order.id}/pay`, { asset: asset.value }, 'оплата заказа');
            close(true);
            toast(res.delivered ? 'Оплачено и выдано автоматически' : 'Оплата принята в эскроу', 'ok');
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

function deliverOrder(order, reload) {
  const text = h('textarea', { class: 'textarea mono', placeholder: 'Ключ, логин/пароль, ссылка на файл… Данные будут зашифрованы (AES-256-GCM).' });
  modal({
    title: `Выдача товара · ${order.number}`,
    sub: 'Товар попадёт покупателю в зашифрованном виде; доступ — только у покупателя и арбитра при споре.',
    body: h('div', { class: 'field' },
      h('label', { class: 'field__label', text: 'Данные цифрового товара' }), text,
      h('div', { class: 'field__hint', text: 'Для автовыдачи сток шифруется при загрузке — этот экран нужен только при ручной выдаче.' })),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Выдать', kind: 'primary',
        onClick: async (close) => {
          if (!text.value.trim()) {
            toast('Заполните данные товара', 'warn');
            return true;
          }
          try {
            await api.post(`/api/v1/orders/${order.id}/deliver`, { payload: text.value.trim() });
            close(true);
            toast('Товар выдан', 'ok');
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

function reviewOrder(order, reload) {
  const rating = h('select', { class: 'select' }, [5, 4, 3, 2, 1].map((v) => h('option', { value: v, text: `${v} ★` })));
  const delivery = h('select', { class: 'select' }, [5, 4, 3, 2, 1].map((v) => h('option', { value: v, text: `${v} ★` })));
  const description = h('select', { class: 'select' }, [5, 4, 3, 2, 1].map((v) => h('option', { value: v, text: `${v} ★` })));
  const support = h('select', { class: 'select' }, [5, 4, 3, 2, 1].map((v) => h('option', { value: v, text: `${v} ★` })));
  const body = h('textarea', { class: 'textarea', placeholder: 'Что понравилось, что улучшить (минимум 10 символов)' });
  modal({
    title: 'Отзыв о покупке',
    sub: `${order.shop_name} · заказ ${order.number}`,
    body: h('div', {},
      h('div', { class: 'row row--wrap' },
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Общая оценка' }), rating),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Доставка' }), delivery),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Описание' }), description),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Поддержка' }), support)),
      h('div', { class: 'field', style: 'margin-top:8px' }, h('label', { class: 'field__label', text: 'Текст отзыва' }), body)),
    actions: [
      { label: 'Позже' },
      {
        label: 'Опубликовать', kind: 'primary',
        onClick: async (close) => {
          try {
            await api.post(`/api/v1/orders/${order.id}/review`, {
              rating: Number(rating.value), rating_delivery: Number(delivery.value),
              rating_description: Number(description.value), rating_support: Number(support.value),
              body: body.value.trim(),
            });
            close(true);
            toast('Спасибо за отзыв', 'ok');
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

function disputeOrder(order, navigate, reload) {
  const reason = h('select', { class: 'select' }, REASONS.map(([value, label]) => h('option', { value, text: label })));
  const text = h('textarea', { class: 'textarea', placeholder: 'Опишите проблему (минимум 20 символов). Не указывайте личные данные — они будут скрыты.' });
  modal({
    title: 'Открытие спора',
    sub: `${order.number} · сумма ${order.total} в эскроу`,
    body: h('div', {},
      h('div', { class: 'notice', text: 'В споре стороны видят друг друга как «Покупатель #XXX» и «Продавец #XXX». Реальные данные доступны только арбитру, каждое раскрытие фиксируется в аудите.' }),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Причина' }), reason),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Описание' }), text),
      h('p', { class: 'field__hint', text: 'У продавца 72 часа на ответ, затем спор автоматически уходит арбитру. Решение — до 7 дней, иначе полный возврат.' })),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Открыть спор', kind: 'danger',
        onClick: async (close) => {
          try {
            const res = await postWithOps(`/api/v1/orders/${order.id}/dispute`, {
              reason_code: reason.value, description: text.value.trim(),
            }, 'открытие спора');
            close(true);
            toast('Спор открыт', 'ok');
            navigate(`#/dispute/${res.id}`);
          } catch (err) {
            toast(describeError(err), 'err');
          }
          return true;
        },
      },
    ],
  });
}

function renderDelivery(order, box, navigate) {
  if (!order.delivery_available) {
    mount(box, null);
    return;
  }
  const content = h('div', {});
  mount(box,
    h('div', { class: 'card' },
      h('h3', { class: 'card__title', text: 'Выданный товар' }),
      h('p', { class: 'card__sub', text: 'Данные хранятся зашифрованными и расшифровываются по запросу покупателя.' }),
      h('button', {
        class: 'btn btn--primary', type: 'button', text: 'Показать данные',
        onclick: async () => {
          mount(content, spinner());
          try {
            const res = await api.get(`/api/v1/orders/${order.id}/delivery`);
            mount(content, res.items.map((item) => h('div', { class: 'card card--flat' },
              h('div', { class: 'row' },
                h('strong', { class: 'grow', text: item.title }),
                h('span', { class: 'small dim', text: `×${item.qty}` })),
              h('pre', { class: 'mono', style: 'white-space:pre-wrap;background:var(--bg-input);padding:10px;border-radius:8px;margin:8px 0', text: item.payload }),
              h('div', { class: 'row' },
                h('button', { class: 'btn btn--sm', type: 'button', text: 'Скопировать', onclick: () => copyText(item.payload, 'Данные скопированы') }),
                h('span', { class: 'grow' }),
                h('span', { class: 'small dim', text: `скачано: ${item.download_count}` })))));
          } catch (err) {
            mount(content, empty('⚠️', 'Не удалось получить данные', describeError(err)));
          }
        },
      }),
      content));
}

function renderHistory(order, box) {
  mount(box, h('div', { class: 'list' }, (order.history ?? []).map((ev) => h('div', { class: 'list-row', style: 'cursor:default' },
    h('div', { class: 'list-row__avatar', style: 'width:34px;height:34px;flex-basis:34px;background:#2c3244;font-size:14px', text: actorEmoji(ev.actor_kind) }),
    h('div', { class: 'list-row__body' },
      h('div', { class: 'list-row__title', text: ev.to_title }),
      h('div', { class: 'list-row__sub small dim', text: ev.reason ? `${actorLabel(ev.actor_kind)}: ${ev.reason}` : actorLabel(ev.actor_kind) })),
    h('div', { class: 'list-row__aside' }, h('span', { text: dateTime(ev.ts) }))))));
}

function actorEmoji(kind) {
  return { buyer: '🧑', shop: '🏪', admin: '🛡', arbiter: '⚖️', system: '🤖', timer: '⏱' }[kind] ?? '•';
}
function actorLabel(kind) {
  return { buyer: 'покупатель', shop: 'магазин', admin: 'администрация', arbiter: 'арбитр', system: 'система', timer: 'таймер' }[kind] ?? kind;
}

function promptText(title, label, placeholder = '') {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', placeholder, value: '' });
    modal({
      title, body: h('div', { class: 'field' }, h('label', { class: 'field__label', text: label }), input),
      actions: [
        { label: 'Отмена', value: null },
        { label: 'Отправить', kind: 'primary', value: '__ok__' },
      ],
      onClose: (value) => resolve(value === '__ok__' ? input.value.trim() : null),
    });
  });
}

export { REASONS };
