// Админ-панель: дашборд, пользователи, магазины, модерация, заказы, споры, подарки,
// аренда, финансы и сверка кастодии, аудит-цепочка, безопасность, настройки.
// Пути и формы ответов сверены с preview-API (docs/api.md, routes-admin.mjs).
import { api } from '../api.js';
import { S } from '../state.js';
import {
  h, mount, toast, describeError, spinner, empty, statusChip, dateTime,
  countdown, postWithOps, modal, copyText, confirmDialog,
} from '../ui.js';

const SECTIONS = [
  ['dashboard', '📊 Дашборд'],
  ['users', '👥 Пользователи'],
  ['shops', '🏪 Магазины'],
  ['moderation', '🧹 Модерация'],
  ['orders', '🧾 Заказы'],
  ['disputes', '⚖️ Споры'],
  ['gifts', '🎁 Подарки'],
  ['rent', '🏷 Аренда'],
  ['finance', '💰 Финансы'],
  ['audit', '🔗 Аудит'],
  ['security', '🛡 Безопасность'],
  ['settings', '⚙️ Настройки'],
];

const ROLE_LABEL = { superadmin: 'супер-админ', arbiter: 'арбитр', moderator: 'модератор', shop_admin: 'продавец', buyer: 'покупатель' };

export async function admin(container, { navigate }, params) {
  const section = params.section ?? 'dashboard';
  const nav = h('div', { class: 'tabs-inline' });
  const box = h('div', {});
  mount(container,
    h('div', { class: 'section__head' },
      h('h2', { class: 'section__title', text: 'Админ-панель' }),
      h('span', { class: 'section__hint', text: `${ROLE_LABEL[S.me?.role] ?? ''} · @${S.me?.nickname ?? ''}` })),
    h('div', { class: 'notice notice--warn', text: 'Каждое изменение требует код фактора 2FA «операции» и пишется в hash-chain аудит (docs/security.md §11). Роли: superadmin — всё, moderator — модерация и санкции, arbiter — споры.' }),
    nav, box);
  mount(nav, SECTIONS.map(([key, label]) => h('button', {
    class: 'filter', type: 'button', text: label, 'aria-pressed': String(key === section),
    onclick: () => navigate(`#/admin/${key}`),
  })));

  const views = { dashboard, users, shops, moderation, orders, disputes, gifts, rent, finance, audit, security, settings };
  const render = views[section] ?? dashboard;
  await render(box, navigate);
}

// ---------------------------------------------------------------------------
async function dashboard(box, navigate) {
  mount(box, spinner());
  try {
    const [dash, auditLog] = await Promise.all([
      api.get('/api/v1/admin/dashboard'),
      api.get('/api/v1/admin/audit?limit=6').catch(() => ({ items: [], chain_verified: false })),
    ]);
    mount(box,
      h('div', { class: 'stat-grid' },
        h('div', { class: 'stat' },
          h('div', { class: 'stat__value', text: `${dash.gmv.sol} ◎` }),
          h('div', { class: 'stat__label', text: `GMV · Stars ${dash.gmv.stars} · заказов за 24 ч: ${dash.orders_24h}` })),
        h('div', { class: 'stat' },
          h('div', { class: 'stat__value', text: `${dash.escrow.sol} ◎` }),
          h('div', { class: 'stat__label', text: `в эскроу · Stars ${dash.escrow.stars}` })),
        h('div', { class: 'stat' },
          h('div', { class: 'stat__value', text: `${dash.gmv.fees_sol} ◎` }),
          h('div', { class: 'stat__label', text: `комиссии · Stars ${dash.gmv.fees_stars} · аренда ${dash.gmv.rent_sol} ◎` })),
        h('div', { class: 'stat' },
          h('div', { class: 'stat__value', text: `${dash.balances.custody_sol} ◎` }),
          h('div', { class: 'stat__label', text: `кастодия · вывод в ожидании ${dash.balances.withdrawals_pending_sol} ◎` }))),
      h('div', { class: 'stat-grid' },
        h('div', { class: 'stat' },
          h('div', { class: 'stat__value', text: String(dash.counts.users) }),
          h('div', { class: 'stat__label', text: `пользователей · магазинов в ленте ${dash.rent.active}` })),
        h('div', { class: 'stat' },
          h('div', { class: 'stat__value', text: `${dash.counts.products}` }),
          h('div', { class: 'stat__label', text: `товаров · отзывов ${dash.counts.reviews} · чатов ${dash.counts.chats}` })),
        h('div', { class: 'stat' },
          h('div', { class: 'stat__value', text: String(dash.disputes_open) }),
          h('div', { class: 'stat__label', text: `споров открыто · SLA нарушен: ${dash.disputes_sla_breach}` })),
        h('div', { class: 'stat' },
          h('div', { class: 'stat__value', text: String(dash.moderation_queue) }),
          h('div', { class: 'stat__label', text: 'в очереди модерации' }))),
      (dash.alerts ?? []).length
        ? h('div', { class: 'card' },
          h('h3', { class: 'card__title', text: 'Оповещения' }),
          h('div', { class: 'list' }, dash.alerts.map((a) => h('div', { class: 'list-row', style: 'cursor:default' },
            h('div', { class: 'list-row__avatar', style: `background:${a.level === 'P1' ? '#3a2530' : '#2c3244'}`, text: a.level }),
            h('div', { class: 'list-row__body' },
              h('div', { class: 'list-row__title', text: a.message }),
              h('div', { class: 'list-row__sub mono small dim', text: `${a.kind}${(a.ids ?? []).length ? ` · ${a.ids.join(', ')}` : ''}` }))))))
        : null,
      h('div', { class: 'section' },
        h('div', { class: 'section__head' },
          h('h2', { class: 'section__title', text: 'Заказы по статусам' }),
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Все заказы', onclick: () => navigate('#/admin/orders') })),
        h('div', { class: 'row row--wrap' },
          Object.entries(dash.orders_by_status ?? {}).map(([status, count]) => h('span', { class: `chip ${statusChipClass(status)}`, text: `${status}: ${count}` })))),
      h('div', { class: 'section' },
        h('div', { class: 'section__head' },
          h('h2', { class: 'section__title', text: 'Аренда магазинов' }),
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Тарифы', onclick: () => navigate('#/admin/rent') })),
        h('div', { class: 'row row--wrap' },
          h('span', { class: 'chip chip--ok', text: `active: ${dash.rent.active}` }),
          h('span', { class: 'chip chip--warn', text: `expiring: ${dash.rent.expiring}` }),
          h('span', { class: 'chip chip--warn', text: `grace: ${dash.rent.grace}` }),
          h('span', { class: 'chip chip--err', text: `suspended: ${dash.rent.suspended}` }))),
      h('div', { class: 'section' },
        h('div', { class: 'section__head' },
          h('h2', { class: 'section__title', text: 'Топ магазинов' }),
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Все магазины', onclick: () => navigate('#/admin/shops') })),
        h('div', { class: 'list' }, (dash.top_shops ?? []).map((s) => h('div', { class: 'list-row', onclick: () => navigate(`#/shop/${s.id}`) },
          h('div', { class: 'list-row__avatar', style: 'background:#2c3244', text: s.crown ? '👑' : '🏪' }),
          h('div', { class: 'list-row__body' },
            h('div', { class: 'list-row__title', text: s.name }),
            h('div', { class: 'list-row__sub small dim', text: `продаж: ${s.sales} · рейтинг ${s.rating}` })),
          h('div', { class: 'list-row__aside' }, h('span', { text: '›' })))))),
      h('div', { class: 'section' },
        h('div', { class: 'section__head' },
          h('h2', { class: 'section__title', text: 'Безопасность и аудит' }),
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Журнал аудита', onclick: () => navigate('#/admin/audit') })),
        h('div', { class: 'list' },
          miniRow('🔐', 'События входа за 24 ч', `${dash.security.auth_events_24h} (неудачных: ${dash.security.failed_logins_24h})`),
          miniRow('🌐', 'IP-баны', String(dash.security.ip_bans)),
          miniRow('🔌', 'WS-подключения', String(dash.security.ws_connections)),
          miniRow('🔗', 'Аудит-цепочка', auditLog.chain_verified ? `цела (${auditLog.total ?? (auditLog.items ?? []).length} записей)` : 'требует проверки')),
        auditLog.chain_verified
          ? h('div', { class: 'notice notice--ok', text: auditLog.chain_notice ?? 'Каждая запись содержит HMAC предыдущей.' })
          : h('div', { class: 'notice notice--err', text: 'Целостность аудит-цепочки не подтверждена — проверьте журнал.' })),
    h('div', { class: 'section' },
      h('div', { class: 'section__head' }, h('h2', { class: 'section__title', text: 'Последние записи аудита' })),
      h('div', { class: 'list' }, (auditLog.items ?? []).map((ev) => h('div', { class: 'list-row', style: 'cursor:default' },
        h('div', { class: 'list-row__avatar', style: 'background:#2c3244;font-size:13px', text: auditIcon(ev.action) }),
        h('div', { class: 'list-row__body' },
          h('div', { class: 'list-row__title', text: ev.action }),
          h('div', { class: 'list-row__sub small dim', text: `${ev.actor_role} · ${ev.object_type} ${String(ev.object_id).slice(0, 18)}${ev.reason ? ` · ${ev.reason}` : ''}` }),
          h('div', { class: 'list-row__sub mono small dim', text: `hash ${String(ev.record_hash).slice(0, 22)}…` })),
        h('div', { class: 'list-row__aside' }, h('span', { text: dateTime(ev.ts) })))))));
  } catch (err) {
    mount(box, empty('⚠️', 'Дашборд недоступен', describeError(err)));
  }
}

function statusChipClass(status) {
  const map = {
    completed: 'chip--ok', delivered: 'chip--ok', processing: 'chip--info', paid_escrow: 'chip--info',
    awaiting_payment: 'chip--warn', created: 'chip--warn', dispute_opened: 'chip--err',
    in_arbitration: 'chip--err', refunded: 'chip--muted', cancelled: 'chip--muted', expired: 'chip--muted',
  };
  return map[status] ?? '';
}

function miniRow(icon, title, sub) {
  return h('div', { class: 'list-row', style: 'cursor:default' },
    h('div', { class: 'list-row__avatar', style: 'background:#2c3244;font-size:14px', text: icon }),
    h('div', { class: 'list-row__body' },
      h('div', { class: 'list-row__title', text: title }),
      h('div', { class: 'list-row__sub small dim', text: sub })));
}

function auditIcon(action) {
  const head = String(action).split('.')[0];
  return { admin: '🛡', auth: '🔐', order: '🧾', dispute: '⚖️', wallet: '💳', shop: '🏪', rent: '🏷', gift: '🎁', stars: '⭐' }[head] ?? '•';
}

// ---------------------------------------------------------------------------
async function users(box, navigate) {
  const q = h('input', { class: 'input', placeholder: 'nickname, email или usr_…' });
  const status = h('select', { class: 'select' },
    h('option', { value: '', text: 'все статусы' }),
    ...['active', 'pending', 'suspended', 'banned'].map((v) => h('option', { value: v, text: v })));
  const role = h('select', { class: 'select' },
    h('option', { value: '', text: 'все роли' }),
    ...['buyer', 'shop_admin', 'moderator', 'arbiter', 'superadmin'].map((v) => h('option', { value: v, text: v })));
  const list = h('div', {});
  mount(box,
    h('div', { class: 'card' },
      h('div', { class: 'row row--wrap' },
        h('div', { class: 'grow' }, q), status, role,
        h('button', { class: 'btn btn--primary', type: 'button', text: 'Найти', onclick: () => load() }))),
    list);
  load();

  async function load() {
    mount(list, spinner());
    try {
      const params = new URLSearchParams({ limit: '25' });
      if (q.value.trim()) params.set('q', q.value.trim());
      if (status.value) params.set('status', status.value);
      if (role.value) params.set('role', role.value);
      const res = await api.get(`/api/v1/admin/users?${params.toString()}`);
      if (!(res.items ?? []).length) {
        mount(list, empty('👥', 'Никого не нашли'));
        return;
      }
      mount(list,
        h('p', { class: 'small dim', text: `Всего: ${res.total}` }),
        h('div', { class: 'list' }, res.items.map((u) => h('div', { class: 'list-row', style: 'cursor:default' },
          h('div', { class: 'list-row__avatar', style: 'background:#2c3244', text: u.online ? '🟢' : roleIcon(u.role) }),
          h('div', { class: 'list-row__body' },
            h('div', { class: 'list-row__title', text: `@${u.nickname} · ${u.email_masked}` }),
            h('div', { class: 'list-row__sub small dim', text: `${ROLE_LABEL[u.role] ?? u.role} · ${u.country ?? '—'} ${u.city ?? ''} · магазинов: ${(u.shops ?? []).length}` }),
            h('div', { class: 'list-row__sub small dim', text: `2FA вход/операции: ${u.factors?.login ?? '—'}/${u.factors?.ops ?? '—'} · риск ${u.risk_score} · ${u.balances?.sol ?? '0'} ◎ / ${u.balances?.stars ?? 0} ⭐` })),
          h('div', { class: 'list-row__aside' },
            statusChip(u.status, u.status),
            h('button', { class: 'btn btn--sm', type: 'button', text: 'Действия', onclick: () => userModal(u, load) }))))));
    } catch (err) {
      mount(list, empty('⚠️', 'Список недоступен', describeError(err)));
    }
  }
}

function roleIcon(role) {
  return { superadmin: '🛡', arbiter: '⚖️', moderator: '🧹', shop_admin: '🏪', buyer: '🧑' }[role] ?? '👤';
}

function userModal(u, reload) {
  const status = h('select', { class: 'select' },
    ...['active', 'suspended', 'banned'].map((v) => h('option', { value: v, text: v, selected: v === u.status })));
  const role = h('select', { class: 'select' },
    ...['buyer', 'shop_admin', 'moderator', 'arbiter', 'superadmin'].map((v) => h('option', { value: v, text: v, selected: v === u.role })));
  const reason = h('textarea', { class: 'textarea', placeholder: 'Причина изменения (пишется в аудит и уведомление)' });
  modal({
    title: `@${u.nickname}`,
    sub: `${u.id} · ${u.email_masked} · регистрация ${dateTime(u.created_at)}`,
    body: h('div', {},
      h('dl', { class: 'kv' },
        h('dt', { text: 'Статус' }), h('dd', { text: u.status }),
        h('dt', { text: 'Роль' }), h('dd', { text: ROLE_LABEL[u.role] ?? u.role }),
        h('dt', { text: '2FA' }), h('dd', { text: `вход ${u.factors?.login ?? '—'} · операции ${u.factors?.ops ?? '—'}` }),
        h('dt', { text: 'Баланс' }), h('dd', { text: `${u.balances?.sol ?? '0'} ◎ · ${u.balances?.stars ?? 0} ⭐` }),
        h('dt', { text: 'Риск-скор' }), h('dd', { text: String(u.risk_score ?? 0) }),
        h('dt', { text: 'Последний вход' }), h('dd', { text: dateTime(u.last_login_at) }),
        h('dt', { text: 'Магазины' }), h('dd', { text: (u.shops ?? []).map((s) => s.name ?? s.id).join(', ') || 'нет' })),
      h('div', { class: 'divider' }),
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Новый статус' }), status),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Новая роль (superadmin)' }), role)),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Причина' }), reason)),
    actions: [
      { label: 'Закрыть' },
      {
        label: 'Применить', kind: 'danger',
        onClick: async (close) => {
          try {
            const body = { reason: reason.value.trim() };
            if (status.value !== u.status) body.status = status.value;
            if (role.value !== u.role) body.role = role.value;
            if (Object.keys(body).length === 1) {
              toast('Выберите изменение статуса или роли', 'warn');
              return true;
            }
            await postWithOps(`/api/v1/admin/users/${u.id}`, body, 'изменение пользователя');
            close(true);
            toast('Изменения сохранены и записаны в аудит', 'ok');
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

// ---------------------------------------------------------------------------
async function shops(box, navigate) {
  const q = h('input', { class: 'input', placeholder: 'название или slug' });
  const rentStatus = h('select', { class: 'select' },
    h('option', { value: '', text: 'все статусы аренды' }),
    ...['trial', 'active', 'expiring', 'grace', 'suspended'].map((v) => h('option', { value: v, text: v })));
  const list = h('div', {});
  mount(box,
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, q), rentStatus,
        h('button', { class: 'btn btn--primary', type: 'button', text: 'Найти', onclick: () => load() }))),
    list);
  load();

  async function load() {
    mount(list, spinner());
    try {
      const params = new URLSearchParams({ limit: '30' });
      if (q.value.trim()) params.set('q', q.value.trim());
      if (rentStatus.value) params.set('rent_status', rentStatus.value);
      const res = await api.get(`/api/v1/admin/shops?${params.toString()}`);
      if (!(res.items ?? []).length) {
        mount(list, empty('🏪', 'Магазинов нет'));
        return;
      }
      mount(list, h('div', { class: 'list' }, res.items.map((s) => h('div', { class: 'list-row', style: 'cursor:default' },
        h('div', { class: 'list-row__avatar', style: `background:${s.accent ?? '#2c3244'}`, text: s.crown ? '👑' : '🏪' }),
        h('div', { class: 'list-row__body' },
          h('div', { class: 'list-row__title', text: `${s.name} · ${s.slug}` }),
          h('div', { class: 'list-row__sub small dim', text: `владелец @${s.admin_nickname ?? s.admin_user_id} · тариф ${s.plan ?? '—'} · ★ ${s.rating} (${s.rating_count}) · продаж ${s.sales_count}` }),
          h('div', { class: 'list-row__sub small dim', text: `выручка ${s.revenue_sol ?? '0'} ◎ · споры ${(Number(s.dispute_rate ?? 0) * 100).toFixed(1)} % · санкция ${s.sanction_level ?? 'none'} · аренда до ${dateTime(s.period_end)}` })),
        h('div', { class: 'list-row__aside' },
          statusChip(s.rent_status, s.rent_status),
          s.verified ? h('span', { class: 'chip chip--ok', text: '✔' }) : null,
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Открыть', onclick: () => navigate(`#/shop/${s.id}`) }),
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Действия', onclick: () => shopModal(s, load) }))))));
    } catch (err) {
      mount(list, empty('⚠️', 'Список недоступен', describeError(err)));
    }
  }
}

function shopModal(s, reload) {
  const level = h('select', { class: 'select' },
    ...['none', 'warning', 'restrict', 'shadow', 'block'].map((v) => h('option', { value: v, text: v, selected: v === (s.sanction_level ?? 'none') })));
  const reason = h('textarea', { class: 'textarea', placeholder: 'Причина (минимум 5 символов)' });
  const days = h('input', { class: 'input', type: 'number', value: '30', min: '1', max: '365' });
  modal({
    title: `${s.name}`,
    sub: `${s.id} · владелец ${s.admin_user_id}`,
    body: h('div', {},
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Санкция' }), level),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Причина' }), reason),
      h('div', { class: 'divider' }),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Продлить аренду на, дней' }), days),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn btn--sm', type: 'button', text: 'Продлить аренду',
          onclick: async () => {
            try {
              const res = await postWithOps(`/api/v1/admin/shops/${s.id}/rent/extend`, { days: Number(days.value) || 30 }, 'продление аренды');
              toast(`Аренда продлена до ${dateTime(res.period_end)}`, 'ok');
              reload();
            } catch (err) {
              toast(describeError(err), 'err');
            }
          },
        }),
        h('button', {
          class: 'btn btn--sm', type: 'button', text: s.is_verified ? 'Снять верификацию' : 'Верифицировать',
          onclick: async () => {
            try {
              await postWithOps(`/api/v1/admin/shops/${s.id}/verified`, { verified: !s.is_verified }, 'верификация магазина');
              toast('Статус верификации обновлён', 'ok');
              reload();
            } catch (err) {
              toast(describeError(err), 'err');
            }
          },
        }))),
    actions: [
      { label: 'Закрыть' },
      {
        label: 'Применить санкцию', kind: 'danger',
        onClick: async (close) => {
          try {
            const res = await postWithOps(`/api/v1/admin/shops/${s.id}/sanction`, {
              level: level.value, reason: reason.value.trim(),
            }, 'санкция магазина');
            close(true);
            toast(`Санкция: ${res.sanction_level}`, 'ok');
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

// ---------------------------------------------------------------------------
async function moderation(box, navigate) {
  const status = h('select', { class: 'select' },
    ...['pending_moderation', 'published', 'rejected', 'draft', 'all'].map((v) => h('option', { value: v, text: v, selected: v === 'pending_moderation' })));
  const list = h('div', {});
  mount(box,
    h('div', { class: 'card' },
      h('div', { class: 'row' }, status,
        h('button', { class: 'btn btn--primary', type: 'button', text: 'Обновить', onclick: () => load() })),
      h('p', { class: 'small dim', style: 'margin:8px 0 0', text: 'Новые товары публикуются только после модерации. Отклонение требует причину (минимум 5 символов) — она уходит продавцу и в аудит.' })),
    list);
  load();

  async function load() {
    mount(list, spinner());
    try {
      const res = await api.get(`/api/v1/admin/moderation/products?status=${encodeURIComponent(status.value)}&limit=40`);
      if (!(res.items ?? []).length) {
        mount(list, empty('🧹', 'Очередь пуста', 'Нет товаров в этом статусе.'));
        return;
      }
      mount(list, h('div', { class: 'list' }, res.items.map((p) => h('div', { class: 'list-row', style: 'cursor:default' },
        h('div', { class: 'list-row__avatar', style: 'background:#2c3244', text: p.restricted ? '🔞' : '📦' }),
        h('div', { class: 'list-row__body' },
          h('div', { class: 'list-row__title', text: p.title }),
          h('div', { class: 'list-row__sub small dim', text: `${p.shop_name} · ${p.category} · ${p.kind} · сток ${p.stock_free}` }),
          h('div', { class: 'list-row__sub small dim', text: `${p.price_sol} ◎${p.price_stars ? ` / ${p.price_stars} ⭐` : ''}${p.moderation_note ? ` · заметка: ${p.moderation_note}` : ''}` })),
        h('div', { class: 'list-row__aside' },
          statusChip(p.status, p.status),
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Открыть', onclick: () => navigate(`#/product/${p.id}`) }),
          p.status !== 'published'
            ? h('button', { class: 'btn btn--sm btn--ok', type: 'button', text: 'Одобрить', onclick: () => approve(p.id, load) })
            : null,
          p.status !== 'rejected'
            ? h('button', { class: 'btn btn--sm btn--danger', type: 'button', text: 'Отклонить', onclick: () => reject(p, load) })
            : null)))));
    } catch (err) {
      mount(list, empty('⚠️', 'Очередь недоступна', describeError(err)));
    }
  }
}

async function approve(productId, reload) {
  try {
    await postWithOps(`/api/v1/admin/moderation/products/${productId}/approve`, { note: 'соответствует правилам площадки' }, 'модерация товара');
    toast('Товар опубликован', 'ok');
    reload();
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

function reject(p, reload) {
  const reason = h('textarea', { class: 'textarea', placeholder: 'Причина отклонения (минимум 5 символов)' });
  modal({
    title: `Отклонить «${p.title}»`,
    sub: p.shop_name,
    body: h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Причина' }), reason),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Отклонить', kind: 'danger',
        onClick: async (close) => {
          try {
            await postWithOps(`/api/v1/admin/moderation/products/${p.id}/reject`, { reason: reason.value.trim() }, 'модерация товара');
            close(true);
            toast('Товар отклонён', 'ok');
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

// ---------------------------------------------------------------------------
async function orders(box, navigate) {
  const q = h('input', { class: 'input', placeholder: 'номер заказа (SITEE-1001) или ID' });
  const status = h('select', { class: 'select' },
    h('option', { value: '', text: 'все статусы' }),
    ...['created', 'awaiting_payment', 'paid_escrow', 'processing', 'delivered', 'completed', 'dispute_opened', 'refunded', 'cancelled', 'expired']
      .map((v) => h('option', { value: v, text: v })));
  const list = h('div', {});
  mount(box,
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, q), status,
        h('button', { class: 'btn btn--primary', type: 'button', text: 'Найти', onclick: () => load() }))),
    list);
  load();

  async function load() {
    mount(list, spinner());
    try {
      const params = new URLSearchParams({ limit: '30' });
      if (q.value.trim()) params.set('q', q.value.trim());
      if (status.value) params.set('status', status.value);
      const res = await api.get(`/api/v1/admin/orders?${params.toString()}`);
      if (!(res.items ?? []).length) {
        mount(list, empty('🧾', 'Заказов нет'));
        return;
      }
      mount(list,
        h('p', { class: 'small dim', text: `Всего: ${res.total}` }),
        h('div', { class: 'list' }, res.items.map((o) => h('div', { class: 'list-row', style: 'cursor:default' },
          h('div', { class: 'list-row__avatar', style: 'background:#2c3244', text: '🧾' }),
          h('div', { class: 'list-row__body' },
            h('div', { class: 'list-row__title', text: `${o.number} · ${o.shop_name}` }),
            h('div', { class: 'list-row__sub small dim', text: `покупатель @${o.buyer_nickname} · ${o.pay_asset} · комиссия ${o.fee_bps / 100} %` }),
            h('div', { class: 'list-row__sub small dim', text: `${dateTime(o.created_at)}${o.paid_at ? ` · оплачен ${dateTime(o.paid_at)}` : ''}${o.completed_at ? ` · завершён ${dateTime(o.completed_at)}` : ''}` })),
          h('div', { class: 'list-row__aside' },
            statusChip(o.status, o.status_title),
            h('strong', { text: o.total }),
            h('button', { class: 'btn btn--sm', type: 'button', text: 'Открыть', onclick: () => navigate(`#/order/${o.id}`) }),
            h('button', { class: 'btn btn--sm', type: 'button', text: 'Сменить статус', onclick: () => statusModal(o, load) }))))));
    } catch (err) {
      mount(list, empty('⚠️', 'Список недоступен', describeError(err)));
    }
  }
}

function statusModal(o, reload) {
  const to = h('select', { class: 'select' },
    ...['awaiting_payment', 'paid_escrow', 'processing', 'delivered', 'completed', 'cancelled', 'refunded', 'dispute_opened']
      .map((v) => h('option', { value: v, text: v })));
  const reason = h('textarea', { class: 'textarea', placeholder: 'Причина вмешательства (минимум 5 символов)' });
  modal({
    title: `Статус заказа ${o.number}`,
    sub: `текущий: ${o.status}. Переходы ограничены машиной состояний (docs/orders-disputes.md).`,
    body: h('div', {},
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Новый статус' }), to),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Причина' }), reason)),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Применить', kind: 'primary',
        onClick: async (close) => {
          try {
            await postWithOps(`/api/v1/admin/orders/${o.id}/status`, { status: to.value, reason: reason.value.trim() }, 'смена статуса заказа');
            close(true);
            toast('Статус изменён', 'ok');
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

// ---------------------------------------------------------------------------
async function disputes(box, navigate) {
  const status = h('select', { class: 'select' },
    h('option', { value: '', text: 'все' }),
    ...['open', 'awaiting_reply', 'in_arbitration', 'resolved', 'dismissed', 'closed'].map((v) => h('option', { value: v, text: v })));
  const list = h('div', {});
  mount(box,
    h('div', { class: 'card' },
      h('div', { class: 'row' }, status,
        h('button', { class: 'btn btn--primary', type: 'button', text: 'Обновить', onclick: () => load() })),
      h('p', { class: 'small dim', style: 'margin:8px 0 0', text: 'Арбитр назначается автоматически по минимальной загрузке (кроме сторон спора). Назначенный арбитр видит реальные ID; каждое раскрытие пишется в аудит.' })),
    list);
  load();

  async function load() {
    mount(list, spinner());
    try {
      const params = new URLSearchParams({ limit: '30' });
      if (status.value) params.set('status', status.value);
      const res = await api.get(`/api/v1/admin/disputes?${params.toString()}`);
      if (!(res.items ?? []).length) {
        mount(list, empty('⚖️', 'Споров нет'));
        return;
      }
      mount(list, h('div', { class: 'list' }, res.items.map((d) => h('div', { class: 'list-row', style: 'cursor:default' },
        h('div', { class: 'list-row__avatar', style: 'background:#3a2b3f', text: '⚖️' }),
        h('div', { class: 'list-row__body' },
          h('div', { class: 'list-row__title', text: `${d.order_number} · ${d.shop_name}` }),
          h('div', { class: 'list-row__sub small dim', text: `${d.reason_code} · сумма ${d.amount} · доказательств ${d.evidence_count}` }),
          h('div', { class: 'list-row__sub small dim', text: `арбитр: ${d.arbiter_nickname ? `@${d.arbiter_nickname}` : 'не назначен'} · открыт ${dateTime(d.created_at)}${d.sla_breach ? ' · SLA нарушен' : ''}` })),
        h('div', { class: 'list-row__aside' },
          statusChip(d.status, d.status),
          d.reply_deadline ? h('span', { class: 'small dim', text: `ответ: ${countdown(d.reply_deadline)}` }) : null,
          d.resolve_deadline ? h('span', { class: 'small dim', text: `решение: ${countdown(d.resolve_deadline)}` }) : null,
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Открыть', onclick: () => navigate(`#/dispute/${d.id}`) }),
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Назначить арбитра', onclick: () => assignModal(d, load) }))))));
    } catch (err) {
      mount(list, empty('⚠️', 'Список недоступен', describeError(err)));
    }
  }
}

function assignModal(d, reload) {
  const arbiterId = h('input', { class: 'input mono', placeholder: 'usr_… (ID арбитра)' });
  const pick = h('select', { class: 'select' }, h('option', { value: '', text: '— загрузка сотрудников —' }));
  modal({
    title: `Назначение арбитра · ${d.order_number}`,
    sub: `${d.reason_code} · ${d.amount}`,
    body: h('div', {},
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Сотрудник' }), pick),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Или ID вручную' }), arbiterId)),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Назначить', kind: 'primary',
        onClick: async (close) => {
          const id = arbiterId.value.trim() || pick.value;
          if (!id) {
            toast('Выберите арбитра', 'warn');
            return true;
          }
          try {
            await postWithOps(`/api/v1/admin/disputes/${d.id}/assign`, { arbiter_id: id }, 'назначение арбитра');
            close(true);
            toast('Арбитр назначен', 'ok');
            reload();
          } catch (err) {
            toast(describeError(err), 'err');
          }
          return true;
        },
      },
    ],
  });
  api.get('/api/v1/admin/users?role=arbiter&limit=20')
    .then((res) => {
      const staff = (res.items ?? []).filter((u) => ['arbiter', 'moderator', 'superadmin'].includes(u.role));
      mount(pick, h('option', { value: '', text: '— выберите —' }),
        staff.map((u) => h('option', { value: u.id, text: `@${u.nickname} (${ROLE_LABEL[u.role] ?? u.role})` })));
    })
    .catch(() => mount(pick, h('option', { value: '', text: '— введите ID вручную —' })));
}

// ---------------------------------------------------------------------------
async function gifts(box, navigate) {
  const list = h('div', {});
  const form = h('div', {});
  mount(box,
    h('div', { class: 'section__head' },
      h('h2', { class: 'section__title', text: 'Подарки' }),
      h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: '+ Новый подарок', onclick: () => giftForm(form, null, () => { mount(form, null); load(); }) })),
    form, list);
  load();

  async function load() {
    mount(list, spinner());
    try {
      const res = await api.get('/api/v1/admin/gifts?limit=50');
      if (!(res.items ?? []).length) {
        mount(list, empty('🎁', 'Подарков нет', 'Добавьте подарок — он сразу появится у всех пользователей.'));
        return;
      }
      mount(list, h('div', { class: 'grid' }, res.items.map((g) => h('div', { class: 'shop-card', style: 'cursor:default' },
        h('div', { class: 'shop-card__cover', style: '--cover-a:#7c6cff;--cover-b:#332a70;font-size:34px', text: g.emoji || '🎁' },
          h('span', { class: 'shop-card__crown', text: rarityIcon(g.rarity) })),
        h('div', { class: 'shop-card__name', text: g.title_ru }),
        h('div', { class: 'shop-card__meta' },
          h('span', { class: 'chip chip--gold', text: `${g.price_stars} ⭐` }),
          h('span', { class: 'chip', text: `${g.price_sol} ◎` })),
        h('div', { class: 'small dim', text: g.boosts_shop ? `буст +${Math.round(g.boost_value * 100)} % на ${g.boost_days} дн.` : g.collectible ? 'коллекционный' : 'без буста' }),
        h('div', { class: 'small dim', text: `продано ${g.purchases ?? 0} · выручка ${g.revenue_stars ?? 0} ⭐ / ${g.revenue_sol ?? '0'} ◎` }),
        h('div', { class: 'row row--wrap', style: 'margin-top:8px' },
          statusChip(g.status, g.status),
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Изменить', onclick: () => giftForm(form, g, () => { mount(form, null); load(); }) }),
          h('button', {
            class: 'btn btn--sm', type: 'button', text: g.status === 'published' ? 'Снять с продажи' : 'Опубликовать',
            onclick: async () => {
              try {
                await postWithOps(`/api/v1/admin/gifts/${g.id}`, { status: g.status === 'published' ? 'archived' : 'published' }, 'изменение подарка');
                toast('Статус обновлён', 'ok');
                load();
              } catch (err) {
                toast(describeError(err), 'err');
              }
            },
          }))))));
    } catch (err) {
      mount(list, empty('⚠️', 'Подарки недоступны', describeError(err)));
    }
  }
}

function rarityIcon(rarity) {
  return { common: '•', rare: '💎', epic: '🔮', legendary: '👑' }[rarity] ?? '•';
}

function giftForm(target, gift, onSaved) {
  const sku = h('input', { class: 'input mono', value: gift?.sku ?? `gift-${Date.now().toString(36)}`, placeholder: 'gift-rocket' });
  const titleRu = h('input', { class: 'input', value: gift?.title_ru ?? '', placeholder: 'Космический кот' });
  const titleEn = h('input', { class: 'input', value: gift?.title_en ?? '', placeholder: 'Space cat' });
  const emoji = h('input', { class: 'input', value: gift?.emoji ?? '🎁', maxlength: 8 });
  const description = h('textarea', { class: 'textarea', placeholder: 'Описание подарка' });
  description.value = gift?.description ?? '';
  const rarity = h('select', { class: 'select' },
    ['common', 'rare', 'epic', 'legendary'].map((r) => h('option', { value: r, text: r, selected: (gift?.rarity ?? 'common') === r })));
  const priceStars = h('input', { class: 'input', type: 'number', value: String(gift?.price_stars ?? 100) });
  const priceSol = h('input', { class: 'input', value: gift?.price_sol ?? '0.5' });
  const boosts = h('input', { type: 'checkbox', checked: gift?.boosts_shop ?? true });
  const boostValue = h('input', { class: 'input', type: 'number', step: '0.05', value: String(gift?.boost_value ?? 0.3) });
  const boostDays = h('input', { class: 'input', type: 'number', value: String(gift?.boost_days ?? 7) });
  const collectible = h('input', { type: 'checkbox', checked: gift?.collectible ?? false });

  mount(target,
    h('div', { class: 'card' },
      h('h3', { class: 'card__title', text: gift ? `Редактирование: ${gift.title_ru}` : 'Новый подарок' }),
      h('div', { class: 'row row--wrap' },
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'SKU' }), sku),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Название (RU)' }), titleRu),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Название (EN)' }), titleEn),
        h('div', { style: 'width:90px' }, h('label', { class: 'field__label', text: 'Эмодзи' }), emoji)),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Описание' }), description),
      h('div', { class: 'row row--wrap' },
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Редкость' }), rarity),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Цена, Stars' }), priceStars),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Цена, SOL' }), priceSol)),
      h('label', { class: 'switch' }, boosts, 'Даёт буст магазину в ленте'),
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Значение буста (0.6 = +60 %)' }), boostValue),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Дней буста' }), boostDays)),
      h('label', { class: 'switch' }, collectible, 'Коллекционный предмет'),
      h('div', { class: 'btn-row', style: 'margin-top:10px' },
        h('button', {
          class: 'btn btn--primary', type: 'button', text: gift ? 'Сохранить' : 'Создать',
          onclick: async () => {
            const payload = {
              sku: sku.value.trim(),
              title_ru: titleRu.value.trim(),
              title_en: titleEn.value.trim(),
              emoji: emoji.value.trim() || '🎁',
              description: description.value.trim(),
              rarity: rarity.value,
              price_stars: Number(priceStars.value) || 0,
              price_sol: priceSol.value.trim() || '0',
              boosts_shop: boosts.checked,
              boost_value: Number(boostValue.value) || 0,
              boost_days: Number(boostDays.value) || 0,
              collectible: collectible.checked,
              status: 'published',
            };
            try {
              if (gift) await postWithOps(`/api/v1/admin/gifts/${gift.id}`, payload, 'изменение подарка');
              else await postWithOps('/api/v1/admin/gifts', payload, 'создание подарка');
              toast(gift ? 'Подарок обновлён' : 'Подарок создан', 'ok');
              onSaved();
            } catch (err) {
              toast(describeError(err), 'err');
            }
          },
        }),
        h('button', { class: 'btn', type: 'button', text: 'Отмена', onclick: () => mount(target, null) }))));
}

// ---------------------------------------------------------------------------
async function rent(box, navigate) {
  mount(box, spinner());
  try {
    const res = await api.get('/api/v1/admin/rent/plans');
    mount(box,
      h('div', { class: 'notice', text: 'Аренда — ежемесячная плата за место в ленте. Статусы: trial (7 дн) → active → expiring (T-7) → grace (72 ч) → suspended. Crown добавляет корону при рейтинге ≥ 4.0 и отсутствии санкций.' }),
      h('div', { class: 'grid' }, (res.items ?? []).map((p) => h('div', { class: 'card card--flat' },
        h('div', { class: 'row' },
          h('strong', { class: 'grow', text: `${p.name_ru} (${p.code})` }),
          p.crown ? h('span', { text: '👑' }) : null),
        h('p', { class: 'small dim', text: p.description }),
        h('dl', { class: 'kv' },
          h('dt', { text: 'Цена' }), h('dd', { text: `${p.price_sol} ◎ / ${p.price_stars} ⭐ в месяц` }),
          h('dt', { text: 'Комиссия' }), h('dd', { text: `${p.fee_bps / 100} %` }),
          h('dt', { text: 'Буст ленты' }), h('dd', { text: p.boost ? `+${Math.round(p.boost * 100)} %` : 'нет' }),
          h('dt', { text: 'Лимит товаров' }), h('dd', { text: String(p.products ?? '—') }),
          h('dt', { text: 'Операторов' }), h('dd', { text: String(p.operators ?? '—') }),
          h('dt', { text: 'SLA поддержки' }), h('dd', { text: `${p.sla ?? '—'} ч` }),
          h('dt', { text: 'Подписчиков' }), h('dd', { text: String(p.subscribers ?? 0) }),
          h('dt', { text: 'Активен' }), h('dd', { text: p.active ? 'да' : 'нет' })),
        h('button', { class: 'btn btn--sm', type: 'button', text: 'Изменить тариф', onclick: () => planForm(p, () => rent(box, navigate)) })))));
  } catch (err) {
    mount(box, empty('⚠️', 'Тарифы недоступны', describeError(err)));
  }
}

function planForm(p, reload) {
  const priceSol = h('input', { class: 'input', value: String(p.price_sol) });
  const priceStars = h('input', { class: 'input', type: 'number', value: String(p.price_stars) });
  const feeBps = h('input', { class: 'input', type: 'number', value: String(p.fee_bps) });
  const boost = h('input', { class: 'input', type: 'number', step: '0.05', value: String(p.boost ?? 0) });
  const crown = h('input', { type: 'checkbox', checked: !!p.crown });
  modal({
    title: `Тариф «${p.name_ru}»`,
    sub: 'Изменение доступно только superadmin. Действующие периоды не пересчитываются.',
    body: h('div', {},
      h('div', { class: 'row row--wrap' },
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Цена, SOL' }), priceSol),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Цена, Stars' }), priceStars),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Комиссия, bps' }), feeBps),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Буст' }), boost)),
      h('label', { class: 'switch' }, crown, 'Даёт корону в ленте')),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Сохранить', kind: 'primary',
        onClick: async (close) => {
          try {
            await api.patch(`/api/v1/admin/rent/plans/${p.id}`, {
              price_sol: priceSol.value.trim(),
              price_stars: Number(priceStars.value) || 0,
              fee_bps: Number(feeBps.value) || 0,
              boost: Number(boost.value) || 0,
              crown: crown.checked,
            });
            close(true);
            toast('Тариф обновлён', 'ok');
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

// ---------------------------------------------------------------------------
async function finance(box, navigate) {
  mount(box, spinner());
  try {
    const res = await api.get('/api/v1/admin/finance/reconciliation');
    const sol = res.summary?.SOL ?? {};
    const stars = res.summary?.STARS ?? {};
    mount(box,
      h('div', { class: 'stat-grid' },
        h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${sol.custody ?? '—'} ◎` }), h('div', { class: 'stat__label', text: 'кастодия (hot + cold)' })),
        h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${sol.liabilities ?? '—'} ◎` }), h('div', { class: 'stat__label', text: 'обязательства перед клиентами' })),
        h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${sol.escrow ?? '—'} ◎` }), h('div', { class: 'stat__label', text: `в эскроу · Stars ${stars.escrow ?? 0}` })),
        h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${sol.fees ?? '—'} ◎` }), h('div', { class: 'stat__label', text: `комиссии · аренда ${sol.rent ?? '—'} ◎` }))),
      h('div', { class: 'card' },
        h('h3', { class: 'card__title', text: 'Сверка кастодии и обязательств' }),
        h('p', { class: 'card__sub', text: `Проводок: ${res.entries_total} · счетов: ${res.accounts_total} · сформировано ${dateTime(res.generated_at)}` }),
        h('dl', { class: 'kv' },
          h('dt', { text: 'Пользователи (SOL)' }), h('dd', { text: `${sol.users ?? '—'} ◎` }),
          h('dt', { text: 'Магазины (SOL)' }), h('dd', { text: `${sol.shops ?? '—'} ◎` }),
          h('dt', { text: 'Платформа (SOL)' }), h('dd', { text: `${sol.platform ?? '—'} ◎` }),
          h('dt', { text: 'Выводы в ожидании' }), h('dd', { text: `${sol.withdrawals_pending ?? '—'} ◎` }),
          h('dt', { text: 'Резерв Stars' }), h('dd', { text: `${stars.reserve ?? 0} ⭐` }),
          h('dt', { text: 'Выручка от подарков' }), h('dd', { text: `${stars.gift_revenue ?? 0} ⭐` }),
          h('dt', { text: 'Дельта' }), h('dd', { text: `${sol.delta ?? '—'} ◎` })),
        res.breach
          ? h('div', { class: 'notice notice--err', text: res.alert ?? 'Обнаружено расхождение кастодии и обязательств.' })
          : h('div', { class: 'notice notice--ok', text: 'Кастодия покрывает обязательства: расхождений нет.' }),
        h('p', { class: 'field__hint', text: 'На демо-стенде стартовые балансы сидируются без депозитов в блокчейне, поэтому дельта отрицательная — это ожидаемо (docs/solana.md §6). В prod сканер блокчейна сверяет hot/cold кошельки с ledger каждые 5 минут.' })),
      h('div', { class: 'section' },
        h('div', { class: 'section__head' },
          h('h2', { class: 'section__title', text: `Счета (${(res.accounts ?? []).length})` }),
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Скопировать JSON', onclick: () => copyText(JSON.stringify(res.summary ?? {}, null, 2), 'Сводка скопирована') })),
        h('div', { class: 'list' }, (res.accounts ?? []).slice(0, 40).map((acc) => h('div', { class: 'list-row', style: 'cursor:default' },
          h('div', { class: 'list-row__body' },
            h('div', { class: 'list-row__title mono small', text: acc.id }),
            h('div', { class: 'list-row__sub small dim', text: `${acc.owner_type} · версия ${acc.version}` })),
          h('div', { class: 'list-row__aside' },
            h('strong', { text: `${acc.balance} ${acc.asset === 'SOL' ? '◎' : '⭐'}` })))))));
  } catch (err) {
    mount(box, empty('⚠️', 'Финансы недоступны', describeError(err)));
  }
}

// ---------------------------------------------------------------------------
async function audit(box, navigate) {
  const action = h('input', { class: 'input', placeholder: 'фильтр: dispute.resolve, admin.gift_create…' });
  const list = h('div', {});
  mount(box,
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, action),
        h('button', { class: 'btn btn--primary', type: 'button', text: 'Найти', onclick: () => load() })),
      h('p', { class: 'small dim', style: 'margin:8px 0 0', text: 'Каждая запись содержит HMAC-SHA256 от предыдущей (hash-chained audit log). Изменить историю задним числом нельзя: проверка целостности возвращает chain_verified.' })),
    list);
  load();

  async function load() {
    mount(list, spinner());
    try {
      const params = new URLSearchParams({ limit: '40' });
      if (action.value.trim()) params.set('action', action.value.trim());
      const res = await api.get(`/api/v1/admin/audit?${params.toString()}`);
      mount(list,
        res.chain_verified
          ? h('div', { class: 'notice notice--ok', text: `${res.chain_notice ?? 'Цепочка цела'} · записей: ${res.total ?? (res.items ?? []).length}` })
          : h('div', { class: 'notice notice--err', text: '⚠️ Целостность цепочки не подтверждена' }),
        h('div', { class: 'list' }, (res.items ?? []).map((ev) => h('div', { class: 'list-row', style: 'cursor:default' },
          h('div', { class: 'list-row__avatar', style: 'background:#2c3244;font-size:13px', text: auditIcon(ev.action) }),
          h('div', { class: 'list-row__body' },
            h('div', { class: 'list-row__title', text: ev.action }),
            h('div', { class: 'list-row__sub small dim', text: `${ev.actor_role ?? 'system'} · ${ev.object_type} ${String(ev.object_id).slice(0, 18)} · ${ev.ip}${ev.totp_factor ? ` · 2FA ${ev.totp_factor}` : ''}` }),
            h('div', { class: 'list-row__sub mono small dim', text: `${String(ev.record_hash).slice(0, 26)}… ← ${String(ev.prev_hash ?? '').slice(0, 16)}…` }),
            ev.reason ? h('div', { class: 'list-row__sub small dim', text: `причина: ${ev.reason}` }) : null),
          h('div', { class: 'list-row__aside' }, h('span', { text: dateTime(ev.ts) }))))));
    } catch (err) {
      mount(list, empty('⚠️', 'Аудит недоступен', describeError(err)));
    }
  }
}

// ---------------------------------------------------------------------------
async function security(box, navigate) {
  mount(box, spinner());
  try {
    const [events, authEvents] = await Promise.all([
      api.get('/api/v1/admin/security/events'),
      api.get('/api/v1/auth/events').catch(() => ({ items: [] })),
    ]);
    mount(box,
      h('div', { class: 'stat-grid' },
        h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: String(events.total ?? 0) }), h('div', { class: 'stat__label', text: 'событий безопасности' })),
        h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: String((events.ip_bans ?? []).length) }), h('div', { class: 'stat__label', text: 'активных IP-банов' })),
        h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: String((events.guards ?? []).length) }), h('div', { class: 'stat__label', text: 'идентификаторов под защитой (captcha/лок)' })),
        h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: String((authEvents.items ?? []).length) }), h('div', { class: 'stat__label', text: 'событий входа' }))),
      h('div', { class: 'card' },
        h('h3', { class: 'card__title', text: 'Активные блокировки и баны' }),
        (events.guards ?? []).length || (events.ip_bans ?? []).length
          ? h('div', { class: 'list' },
            (events.guards ?? []).map((g) => miniRow('🧩', String(g.identifier ?? g.key ?? 'идентификатор'),
              `ошибок: ${g.fails ?? '—'} · captcha: ${g.captcha_required ? 'да' : 'нет'} · блокировка до ${g.locked_until ? dateTime(g.locked_until) : '—'}`)),
            (events.ip_bans ?? []).map((b) => miniRow('🌐', String(b.ip), `${b.reason ?? ''} · до ${dateTime(b.until ?? b.expires_at)}`)))
          : empty('✅', 'Блокировок нет'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn--sm', type: 'button', text: '+ Забанить IP', onclick: () => banModal(navigate) }),
          h('button', { class: 'btn btn--sm btn--danger', type: 'button', text: 'Сбросить лимитеры (демо)', onclick: () => resetGuards(navigate) }))),
      h('div', { class: 'section' },
        h('div', { class: 'section__head' }, h('h2', { class: 'section__title', text: 'События безопасности' })),
        (events.items ?? []).length
          ? h('div', { class: 'list' }, events.items.map((ev) => h('div', { class: 'list-row', style: 'cursor:default' },
            h('div', { class: 'list-row__avatar', style: `background:${(ev.score ?? 0) >= 700 ? '#3a2530' : '#2c3244'}`, text: kindIcon(ev.kind) }),
            h('div', { class: 'list-row__body' },
              h('div', { class: 'list-row__title', text: `${ev.kind} · score ${ev.score ?? '—'}` }),
              h('div', { class: 'list-row__sub mono small dim', text: `${ev.ip} · ${ev.path ?? ''} · ${ev.code ?? ''}` })),
            h('div', { class: 'list-row__aside' },
              h('span', { text: dateTime(ev.ts) }),
              h('button', { class: 'btn btn--sm', type: 'button', text: 'Бан IP', onclick: () => banModal(navigate, ev.ip) })))))
          : empty('🛡', 'Событий нет')),
      h('div', { class: 'section' },
        h('div', { class: 'section__head' }, h('h2', { class: 'section__title', text: 'Журнал входов' })),
        (authEvents.items ?? []).length
          ? h('div', { class: 'list' }, authEvents.items.slice(0, 25).map((ev) => h('div', { class: 'list-row', style: 'cursor:default' },
            h('div', { class: 'list-row__avatar', style: `background:${ev.event.includes('fail') || ev.event.includes('lock') ? '#3a2530' : '#2c3244'}`, text: ev.event.includes('fail') ? '⚠️' : '🔐' }),
            h('div', { class: 'list-row__body' },
              h('div', { class: 'list-row__title', text: ev.event }),
              h('div', { class: 'list-row__sub small dim', text: `${ev.user_id} · ${ev.ip} · ${ev.ua} · риск ${ev.risk_score}${ev.reason ? ` · ${ev.reason}` : ''}` })),
            h('div', { class: 'list-row__aside' }, h('span', { text: dateTime(ev.ts) })))))
          : empty('🔐', 'Журнал пуст')));
  } catch (err) {
    mount(box, empty('⚠️', 'Раздел недоступен', describeError(err)));
  }
}

function kindIcon(kind) {
  return {
    rate_limit: '🚦', login_failed: '🔓', '2fa_failed': '🧩', fraud: '🤖',
    ws_abuse: '🔌', ip_ban: '🌐', captcha: '🧩', api_error: '⚠️',
  }[kind] ?? '•';
}

async function resetGuards(navigate) {
  const ok = await confirmDialog('Сбросить лимитеры?',
    'Очистит блокировки входа, требования captcha, корзины рейт-лимитов и счётчики безопасности. Только для демо-стенда (в prod возвращает 403).',
    'Сбросить', true);
  if (!ok) return;
  try {
    await api.post('/api/v1/dev/reset-guards', {});
    toast('Лимитеры сброшены', 'ok');
    navigate('#/admin/security', true);
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

function banModal(navigate, ip = '') {
  const address = h('input', { class: 'input mono', value: ip, placeholder: '203.0.113.7' });
  const hours = h('input', { class: 'input', type: 'number', value: '24', min: '1', max: '720' });
  const reason = h('textarea', { class: 'textarea', placeholder: 'Причина блокировки (минимум 5 символов)' });
  modal({
    title: 'Блокировка IP',
    sub: 'Бан применяется к DDoS/брутфорс-активности и пишется в аудит (admin.ip_ban).',
    body: h('div', {},
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'IP-адрес' }), address),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Срок, часов' }), hours),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Причина' }), reason)),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Забанить', kind: 'danger',
        onClick: async (close) => {
          try {
            await postWithOps('/api/v1/admin/security/ip-ban', {
              ip: address.value.trim(), hours: Number(hours.value) || 24, reason: reason.value.trim(),
            }, 'бан IP');
            close(true);
            toast('IP заблокирован', 'ok');
            navigate('#/admin/security', true);
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
async function settings(box, navigate) {
  mount(box, spinner());
  try {
    const res = await api.get('/api/v1/admin/settings');
    const schema = res.schema ?? {};
    const list = h('div', { class: 'list' }, (res.items ?? []).map((item) => {
      const input = typeof item.value === 'boolean'
        ? h('input', { type: 'checkbox', checked: item.value })
        : h('input', { class: 'input mono', value: String(item.value) });
      return h('div', { class: 'list-row', style: 'cursor:default' },
        h('div', { class: 'list-row__body' },
          h('div', { class: 'list-row__title mono small', text: item.key }),
          h('div', { class: 'list-row__sub small dim', text: `${schema[item.key] ?? typeof item.value} · ${describeSetting(item.key)}` })),
        h('div', { class: 'list-row__aside', style: 'width:190px' },
          input,
          h('button', {
            class: 'btn btn--sm btn--primary', type: 'button', text: 'Сохранить', style: 'margin-top:6px',
            onclick: async () => {
              const raw = typeof item.value === 'boolean' ? input.checked : input.value.trim();
              const value = schema[item.key] === 'int' || schema[item.key] === 'float' ? Number(raw) : raw;
              const reasonText = window.prompt('Причина изменения (пишется в аудит)', 'настройка площадки');
              if (reasonText === null) return;
              try {
                await postWithOps(`/api/v1/admin/settings/${item.key}`, { value, reason: reasonText }, 'изменение настройки');
                toast(`${item.key} = ${String(value)}`, 'ok');
                navigate('#/admin/settings', true);
              } catch (err) {
                toast(describeError(err), 'err');
              }
            },
          })));
    }));
    mount(box,
      h('div', { class: 'notice', text: 'Настройки применяются к живому процессу и переживают рестарт через снапшот. Каждое изменение требует фактор «операции» и пишется в аудит.' }),
      h('div', { class: 'card' },
        h('h3', { class: 'card__title', text: 'Параметры платформы' }),
        list));
  } catch (err) {
    mount(box, empty('⚠️', 'Настройки недоступны', describeError(err)));
  }
}

function describeSetting(key) {
  const map = {
    registration_open: 'открыта ли регистрация',
    rent_trial_days: 'длительность триала аренды',
    max_shops_per_account: 'сколько магазинов можно создать на аккаунт',
    default_fee_bps: 'комиссия площадки по умолчанию, базисные пункты',
    gift_boost_max: 'максимальный буст в ленте от подарков',
    promoted_slots_per_page: 'сколько продвигаемых карточек на страницу ленты',
    maintenance_mode: 'режим обслуживания (все ответы 503, кроме healthz)',
    withdrawals_frozen: 'заморозка выводов (включается при расхождении кастодии)',
  };
  return map[key] ?? 'параметр платформы';
}
