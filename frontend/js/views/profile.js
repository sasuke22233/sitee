// Вкладка «Профиль»: аккаунт, регион, безопасность и двойной 2FA, сессии, уведомления, мои магазины.
// Все формы ответов сверены с preview-API (docs/api.md): userDto, walletDto, rent/plans, shops/:id/rent.
import { api } from '../api.js';
import { S, setGeo, loadCities, loadMe, logout, isStaff } from '../state.js';
import {
  h, mount, toast, describeError, spinner, empty, statusChip, dateTime,
  countdown, initials, accentFor, modal, copyText, qrCanvas, postWithOps,
} from '../ui.js';

const ROLE_LABEL = {
  superadmin: 'супер-админ', arbiter: 'арбитр', moderator: 'модератор',
  shop_admin: 'продавец', buyer: 'покупатель',
};

export async function profile(container, { navigate }) {
  mount(container, spinner());
  let me;
  try {
    me = await api.get('/api/v1/auth/me');
  } catch (err) {
    mount(container, empty('⚠️', 'Профиль недоступен', `${describeError(err)} — войдите заново.`));
    return;
  }
  const balances = me.balances ?? {};
  const factors = me.factors ?? {};
  const region = await regionCard(me, navigate);

  mount(container,
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('div', {
          class: 'list-row__avatar',
          style: `width:52px;height:52px;flex-basis:52px;font-size:19px;background:${accentFor(me.id)}`,
          text: initials(me.nickname),
        }),
        h('div', { class: 'grow' },
          h('h2', { style: 'margin:0;font-size:18px', text: `@${me.nickname}` }),
          h('div', { class: 'small dim', text: me.email_masked }),
          h('div', { class: 'row row--wrap', style: 'margin-top:6px' },
            statusChip(me.status, me.status),
            h('span', { class: 'chip chip--info', text: ROLE_LABEL[me.role] ?? me.role }),
            me.is_18plus
              ? h('span', { class: 'chip chip--ok', text: '18+' })
              : h('span', { class: 'chip chip--warn', text: '18+ не подтверждено' }),
            me.warmup_until
              ? h('span', { class: 'chip chip--warn', text: `прогрев до ${dateTime(me.warmup_until)}` })
              : null))),
      h('div', { class: 'stat-grid', style: 'margin-top:12px' },
        h('div', { class: 'stat' },
          h('div', { class: 'stat__value', text: `${balances.SOL ?? '0'} ◎` }),
          h('div', { class: 'stat__label', text: 'баланс SOL' })),
        h('div', { class: 'stat' },
          h('div', { class: 'stat__value', text: `${balances.STARS ?? 0} ⭐` }),
          h('div', { class: 'stat__label', text: 'Telegram Stars' })),
        h('div', { class: 'stat' },
          h('div', { class: 'stat__value', text: String((me.shops ?? []).length) }),
          h('div', { class: 'stat__label', text: 'магазинов' })),
        h('div', { class: 'stat' },
          h('div', { class: 'stat__value', text: `${factors.login ?? '—'}/${factors.ops ?? '—'}` }),
          h('div', { class: 'stat__label', text: '2FA вход / операции' }))),
      h('div', { class: 'divider' }),
      h('dl', { class: 'kv' },
        h('dt', { text: 'Регион' }), h('dd', { text: `${me.country_name || me.country} · ${me.city_name || '—'}` }),
        h('dt', { text: 'Непрочитанных чатов' }), h('dd', { text: String(me.unread?.chats ?? 0) }),
        h('dt', { text: 'Подарков получено' }), h('dd', { text: String(me.gifts_count ?? 0) }),
        h('dt', { text: 'Депозитный адрес' }), h('dd', { class: 'mono small', text: me.deposit_address ?? '—' }),
        h('dt', { text: 'Аккаунт создан' }), h('dd', { text: dateTime(me.created_at) }),
        h('dt', { text: 'Последний вход' }), h('dd', { text: dateTime(me.last_login_at) })),
      me.deposit_address
        ? h('button', {
          class: 'btn btn--sm', type: 'button', text: 'Скопировать депозитный адрес',
          onclick: () => copyText(me.deposit_address, 'Адрес скопирован'),
        })
        : null),
    region,
    h('div', { class: 'card' },
      h('h3', { class: 'card__title', text: 'Разделы профиля' }),
      h('div', { class: 'list' },
        navRow('🔐', 'Безопасность и двойной 2FA', `вход: ${factors.login ?? '—'} · операции: ${factors.ops ?? '—'}`, () => navigate('#/profile/2fa')),
        navRow('🖥', 'Сессии и устройства', 'активные сессии', () => navigate('#/profile/sessions')),
        navRow('🔔', 'Уведомления', `${me.unread?.chats ?? 0} непрочитанных в чатах`, () => navigate('#/profile/notifications')),
        navRow('🏪', 'Мои магазины', String((me.shops ?? []).length), () => navigate('#/profile/shops')),
        navRow('🧾', 'Заказы', '', () => navigate('#/orders')),
        navRow('⚖️', 'Споры', '', () => navigate('#/disputes')),
        navRow('💳', 'Кошелёк и обмен', '', () => navigate('#/exchange')),
        isStaff() ? navRow('🛡', 'Админ-панель', ROLE_LABEL[me.role] ?? me.role, () => navigate('#/admin')) : null)),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn--danger btn--block', type: 'button', text: 'Выйти', onclick: () => doLogout(navigate) })));
}

async function regionCard(me, navigate) {
  const country = h('select', { class: 'select' },
    h('option', { value: '', text: '— страна —' }),
    S.countries.map((c) => h('option', { value: c.code, text: c.name_ru, selected: c.code === me.country })));
  const city = h('select', { class: 'select' }, h('option', { value: '', text: '— город —' }));
  const fillCities = () => mount(city,
    h('option', { value: '', text: '— город —' }),
    S.cities.map((c) => h('option', { value: c.id, text: c.name_ru, selected: c.id === me.city_id })));
  country.addEventListener('change', async () => {
    await loadCities(country.value);
    fillCities();
  });
  if (me.country) {
    await loadCities(me.country);
  }
  fillCities();
  return h('div', { class: 'card' },
    h('h3', { class: 'card__title', text: 'Регион ленты' }),
    h('p', { class: 'card__sub', text: 'Регион аккаунта задаётся при регистрации (FR-GEO-01…03). Здесь можно выбрать страну и город для локальной ленты — фильтр применяется сразу.' }),
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Страна' }), country),
      h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Город' }), city)),
    h('div', { class: 'btn-row', style: 'margin-top:10px' },
      h('button', {
        class: 'btn btn--primary', type: 'button', text: 'Применить к ленте',
        onclick: () => {
          const cityId = Number(city.value) || null;
          const found = S.cities.find((c) => c.id === cityId);
          setGeo(country.value, cityId, found?.name_ru ?? '');
          toast('Регион ленты обновлён', 'ok');
          navigate('#/shops');
        },
      })));
}

function navRow(icon, title, sub, onclick) {
  return h('div', { class: 'list-row', onclick },
    h('div', { class: 'list-row__avatar', style: 'background:#2c3244;font-size:16px', text: icon }),
    h('div', { class: 'list-row__body' },
      h('div', { class: 'list-row__title', text: title }),
      sub ? h('div', { class: 'list-row__sub small dim', text: sub }) : null),
    h('div', { class: 'list-row__aside' }, h('span', { text: '›' })));
}

async function doLogout(navigate) {
  try {
    await api.post('/api/v1/auth/logout', {});
  } catch { /* токен мог истечь */ }
  logout('manual');
  toast('Вы вышли из аккаунта', 'info');
  navigate('#/welcome');
}

// ---------------------------------------------------------------------------
// Безопасность: факторы 2FA, пароль, safety number, события (для staff)
// ---------------------------------------------------------------------------
export async function security(container, { navigate }) {
  mount(container, spinner());
  const [me, sessions, safety] = await Promise.all([
    api.get('/api/v1/auth/me'),
    api.get('/api/v1/auth/sessions').catch(() => ({ items: [] })),
    api.get(`/api/v1/e2ee/safety/${S.me?.id ?? ''}`).catch(() => null),
  ]);
  const events = isStaff()
    ? await api.get('/api/v1/auth/events').catch(() => ({ items: [] }))
    : { items: [] };

  mount(container,
    h('div', { class: 'back', onclick: () => navigate('#/profile') }, '← Профиль'),
    h('div', { class: 'card' },
      h('h2', { class: 'card__title', text: 'Безопасность и двойной 2FA' }),
      h('p', { class: 'card__sub', text: 'Фактор «вход» обязателен для логина. Фактор «операции» дополнительно запрашивается для платежей, вывода, аренды, споров и админ-действий (FR-2FA-01…09).' }),
      h('div', { class: 'list' },
        factorCard('login', me.factors?.login, sessions.items ?? [], navigate),
        factorCard('ops', me.factors?.ops, sessions.items ?? [], navigate))),
    h('div', { class: 'card' },
      h('h3', { class: 'card__title', text: 'Пароль' }),
      h('p', { class: 'small dim', text: 'PBKDF2-HMAC-SHA256, 210 000 итераций. Смена пароля завершает прочие сессии и требует фактор «операции».' }),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', type: 'button', text: 'Сменить пароль', onclick: () => passwordModal(navigate) }))),
    safety
      ? h('div', { class: 'card' },
        h('h3', { class: 'card__title', text: 'Проверка сквозного шифрования' }),
        h('p', { class: 'small dim', text: safety.instruction ?? 'Сравните номер с собеседником.' }),
        h('p', { class: 'mono small', text: safety.safety_number }),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn btn--sm', type: 'button', text: 'Скопировать safety number',
            onclick: () => copyText(String(safety.safety_number).replace(/\s/g, ''), 'Safety number скопирован'),
          }),
          h('span', { class: 'small dim', text: `E2EE-сессий: ${(safety.sessions ?? []).length}` })))
      : null,
    h('div', { class: 'section' },
      h('div', { class: 'section__head' },
        h('h2', { class: 'section__title', text: isStaff() ? 'События входа (журнал staff)' : 'События безопасности' }),
        h('span', { class: 'section__hint', text: isStaff() ? `${events.items?.length ?? 0} записей` : 'журнал доступен администрации' })),
      (events.items ?? []).length
        ? h('div', { class: 'list' }, events.items.slice(0, 15).map((ev) => h('div', { class: 'list-row', style: 'cursor:default' },
          h('div', { class: 'list-row__avatar', style: `background:${ev.event.includes('fail') || ev.event.includes('lock') ? '#3a2530' : '#2c3244'}`, text: ev.event.includes('fail') ? '⚠️' : 'ℹ️' }),
          h('div', { class: 'list-row__body' },
            h('div', { class: 'list-row__title', text: ev.event }),
            h('div', { class: 'list-row__sub small dim', text: `${ev.ip} · ${ev.ua} · риск ${ev.risk_score}${ev.reason ? ` · ${ev.reason}` : ''}` })),
          h('div', { class: 'list-row__aside' }, h('span', { text: dateTime(ev.ts) })))))
        : empty('🛡', 'Событий нет', isStaff() ? '' : 'Журнал событий входа доступен ролям superadmin/moderator/arbiter.')));
}

function factorCard(factor, status, sessions, navigate) {
  const label = factor === 'ops' ? 'SITEE (операции)' : 'SITEE (вход)';
  const active = status === 'active';
  const opsOk = sessions.filter((s) => s.factor_ops_ok).length;
  return h('div', { class: 'card card--flat' },
    h('div', { class: 'row' },
      h('strong', { class: 'grow', text: label }),
      statusChip(active ? 'active' : 'pending', active ? 'активен' : status === 'pending' ? 'ожидает активации' : status ?? '—')),
    h('p', { class: 'small dim', text: active
      ? `RFC 6238 · SHA-1 · 30 с · 6 цифр. Подтверждённых операций в сессиях: ${opsOk}.`
      : 'Отсканируйте QR в Google Authenticator и введите два кода подряд — после этого выдадим 10 backup-кодов.' }),
    active
      ? h('p', { class: 'small dim', text: 'Фактор уже активен: повторная настройка выполняется только через сброс администрацией (POST /admin/users/{id}).' })
      : h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn--primary btn--sm', type: 'button', text: 'Настроить фактор', onclick: () => factorSetup(factor, navigate) })));
}

function factorSetup(factor, navigate) {
  const code1 = h('input', { class: 'input mono', placeholder: 'первый код' });
  const code2 = h('input', { class: 'input mono', placeholder: 'второй код' });
  const body = h('div', {}, spinner('Готовим секрет 2FA…'));
  modal({
    title: factor === 'ops' ? 'Фактор «операции»' : 'Фактор «вход»',
    sub: 'RFC 6238 · SHA-1 · 30 с · 6 цифр',
    body,
    actions: [
      { label: 'Закрыть' },
      {
        label: 'Активировать', kind: 'primary',
        onClick: async (close) => {
          try {
            const res = await postWithOps('/api/v1/auth/2fa/activate', {
              factor, code1: code1.value.trim(), code2: code2.value.trim(),
            }, `активация 2FA (${factor})`);
            close(true);
            await loadMe();
            backupModal(res.backup_codes ?? [], () => navigate('#/profile/2fa', true));
          } catch (err) {
            toast(describeError(err), 'err');
          }
          return true;
        },
      },
    ],
  });
  api.post('/api/v1/auth/2fa/setup', { factor })
    .then((setup) => {
      mount(body,
        h('div', { class: 'qr' }, qrCanvas(setup.otpauth_url)),
        h('div', { class: 'field', style: 'margin-top:8px' },
          h('label', { class: 'field__label', text: 'Секрет для ручного ввода' }),
          h('div', { class: 'mono', text: setup.secret_b32 }),
          h('div', { class: 'row', style: 'margin-top:6px' },
            h('button', { class: 'btn btn--sm', type: 'button', text: 'Скопировать секрет', onclick: () => copyText(setup.secret_b32, 'Секрет скопирован') }),
            h('button', { class: 'btn btn--sm', type: 'button', text: 'Скопировать otpauth', onclick: () => copyText(setup.otpauth_url, 'Ссылка скопирована') }))),
        setup.dev_codes
          ? h('div', { class: 'notice notice--ok', text: `Демо-стенд: коды сейчас — ${setup.dev_codes[0]} и ${setup.dev_codes[1] ?? setup.dev_codes[0]}` })
          : null,
        h('div', { class: 'field' },
          h('label', { class: 'field__label', text: 'Два кода подряд' }),
          h('div', { class: 'row' }, code1, code2)));
      if (setup.dev_codes) {
        code1.value = setup.dev_codes[0];
        code2.value = setup.dev_codes[1] ?? setup.dev_codes[0];
      }
    })
    .catch((err) => mount(body, h('div', { class: 'notice notice--err', text: describeError(err) })));
}

function backupModal(codes, onClose) {
  modal({
    title: 'Backup-коды',
    sub: 'Показываются один раз. Каждый код одноразовый — храните их вне сервиса.',
    body: h('div', {},
      h('div', { class: 'code-list' }, codes.map((c) => h('span', { text: c }))),
      h('button', { class: 'btn btn--block', type: 'button', text: 'Скопировать все', onclick: () => copyText(codes.join('\n'), 'Коды скопированы') })),
    actions: [{ label: 'Готово', kind: 'primary' }],
    onClose,
  });
}

function passwordModal(navigate) {
  const current = h('input', { class: 'input', type: 'password', placeholder: 'текущий пароль' });
  const next = h('input', { class: 'input', type: 'password', placeholder: 'новый пароль (12+ символов)' });
  const confirm = h('input', { class: 'input', type: 'password', placeholder: 'повторите новый пароль' });
  modal({
    title: 'Смена пароля',
    sub: 'Операция требует код фактора «операции». После смены прочие сессии завершаются.',
    body: h('div', {},
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Текущий пароль' }), current),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Новый пароль' }), next),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Повторите' }), confirm)),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Сменить', kind: 'primary',
        onClick: async (close) => {
          try {
            await postWithOps('/api/v1/auth/password/change', {
              current_password: current.value,
              new_password: next.value,
              new_password_confirm: confirm.value,
            }, 'смена пароля');
            close(true);
            toast('Пароль изменён', 'ok');
            navigate('#/profile', true);
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
// Сессии
// ---------------------------------------------------------------------------
export async function sessions(container, { navigate }) {
  mount(container, spinner());
  const res = await api.get('/api/v1/auth/sessions').catch(() => ({ items: [] }));
  const items = res.items ?? [];
  mount(container,
    h('div', { class: 'back', onclick: () => navigate('#/profile') }, '← Профиль'),
    h('div', { class: 'section__head' },
      h('h2', { class: 'section__title', text: 'Сессии и устройства' }),
      h('span', { class: 'section__hint', text: 'refresh 30 дней · сессия хранит признак фактора «операции»' })),
    items.length
      ? h('div', { class: 'list' }, items.map((s) => h('div', { class: 'list-row', style: 'cursor:default' },
        h('div', { class: 'list-row__avatar', style: 'background:#2c3244', text: s.current ? '🟢' : '🖥' }),
        h('div', { class: 'list-row__body' },
          h('div', { class: 'list-row__title', text: `${s.device_id || 'устройство'}${s.current ? ' (эта сессия)' : ''}` }),
          h('div', { class: 'list-row__sub small dim', text: `${s.ip}${s.geo ? ` · ${s.geo}` : ''} · ${s.ua}` }),
          h('div', { class: 'list-row__sub small dim', text: `создана ${dateTime(s.created_at)} · до ${dateTime(s.expires_at)}` })),
        h('div', { class: 'list-row__aside' },
          statusChip(s.status, s.status),
          s.factor_ops_ok ? h('span', { class: 'chip chip--ok', text: '2FA операции ✓' }) : null,
          s.current
            ? null
            : h('button', {
              class: 'btn btn--sm btn--danger', type: 'button', text: 'Завершить',
              onclick: async () => {
                try {
                  await api.del(`/api/v1/auth/sessions/${s.id}`, {});
                  toast('Сессия завершена', 'ok');
                  navigate('#/profile/sessions', true);
                } catch (err) {
                  toast(describeError(err), 'err');
                }
              },
            })))))
      : empty('🖥', 'Сессий нет'),
    h('div', { class: 'btn-row' },
      h('button', {
        class: 'btn btn--danger btn--block', type: 'button', text: 'Завершить все прочие сессии',
        onclick: async () => {
          const others = items.filter((s) => !s.current);
          if (!others.length) {
            toast('Прочих сессий нет', 'info');
            return;
          }
          let done = 0;
          for (const s of others) {
            try {
              await api.del(`/api/v1/auth/sessions/${s.id}`, {});
              done += 1;
            } catch { /* пропускаем */ }
          }
          toast(`Завершено сессий: ${done}`, 'ok');
          navigate('#/profile/sessions', true);
        },
      })));
}

// ---------------------------------------------------------------------------
// Уведомления
// ---------------------------------------------------------------------------
export async function notifications(container, { navigate }) {
  mount(container, spinner());
  const list = await api.get('/api/v1/notifications').catch(() => ({ items: [], unread: 0 }));
  const items = list.items ?? [];
  mount(container,
    h('div', { class: 'back', onclick: () => navigate('#/profile') }, '← Профиль'),
    h('div', { class: 'section__head' },
      h('h2', { class: 'section__title', text: 'Уведомления' }),
      list.unread
        ? h('button', {
          class: 'btn btn--sm', type: 'button', text: 'Прочитать все',
          onclick: async () => {
            try {
              await api.post('/api/v1/notifications/read-all', {});
              toast('Все уведомления прочитаны', 'ok');
              navigate('#/profile/notifications', true);
            } catch (err) {
              toast(describeError(err), 'err');
            }
          },
        })
        : h('span', { class: 'section__hint', text: 'непрочитанных нет' })),
    h('div', { class: 'notice', text: 'Каналы доставки: in-app (этот список), push через WebSocket и Telegram-бот. Дубли не создаются — у каждого уведомления есть dedup_key.' }),
    items.length
      ? h('div', { class: 'list' }, items.map((n) => notificationRow(n, navigate)))
      : empty('🔔', 'Уведомлений нет'));
}

function notificationRow(n, navigate) {
  const route = n.data?.order_id ? `#/order/${n.data.order_id}`
    : n.data?.dispute_id ? `#/dispute/${n.data.dispute_id}`
      : n.data?.chat_id ? `#/chat/${n.data.chat_id}`
        : n.data?.shop_id ? `#/shop/${n.data.shop_id}` : null;
  return h('div', {
    class: 'list-row',
    style: route ? 'cursor:pointer' : 'cursor:default',
    onclick: async () => {
      if (!n.read) {
        try {
          await api.post(`/api/v1/notifications/${n.id}/read`, {});
        } catch { /* не критично */ }
      }
      if (route) navigate(route);
      else navigate('#/profile/notifications', true);
    },
  },
  h('div', { class: 'list-row__avatar', style: `background:${n.read ? '#2c3244' : '#332a70'}`, text: notifyIcon(n.kind) }),
  h('div', { class: 'list-row__body' },
    h('div', { class: 'list-row__title', text: n.title }),
    h('div', { class: 'list-row__sub', text: n.body }),
    h('div', { class: 'list-row__sub small dim', text: `${n.kind} · ${n.channel} · ${dateTime(n.created_at)}` })),
  h('div', { class: 'list-row__aside' },
    n.read ? null : h('span', { class: 'badge', style: 'position:static;border:0', text: 'new' })));
}

function notifyIcon(kind) {
  const key = String(kind ?? '');
  if (key.startsWith('order')) return '🧾';
  if (key.startsWith('chat') || key.startsWith('message')) return '💬';
  if (key.startsWith('dispute')) return '⚖️';
  if (key.startsWith('rent') || key.startsWith('shop')) return '🏷';
  if (key.startsWith('wallet') || key.startsWith('withdraw') || key.startsWith('stars')) return '💳';
  if (key.startsWith('security') || key.startsWith('auth') || key.startsWith('2fa')) return '🔐';
  if (key.startsWith('review')) return '✍️';
  if (key.startsWith('gift')) return '🎁';
  return '🔔';
}

// ---------------------------------------------------------------------------
// Мои магазины
// ---------------------------------------------------------------------------
export async function myShops(container, { navigate }) {
  mount(container, spinner());
  const me = await api.get('/api/v1/auth/me');
  const plans = await api.get('/api/v1/rent/plans').catch(() => ({ items: [] }));
  const shops = me.shops ?? [];
  mount(container,
    h('div', { class: 'back', onclick: () => navigate('#/profile') }, '← Профиль'),
    h('div', { class: 'section__head' },
      h('h2', { class: 'section__title', text: 'Мои магазины' }),
      h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: '+ Новый магазин', onclick: () => createShopModal(me, plans.items ?? [], navigate) })),
    shops.length
      ? h('div', { class: 'list' }, shops.map((shop) => h('div', { class: 'list-row', onclick: () => navigate(`#/profile/shop/${shop.id}`) },
        h('div', { class: 'list-row__avatar', style: `background:${accentFor(shop.id)}`, text: initials(shop.name) }),
        h('div', { class: 'list-row__body' },
          h('div', { class: 'list-row__title', text: shop.name }),
          h('div', { class: 'list-row__sub', text: `★ ${shop.rating} · ${shop.slug}` }),
          h('div', { class: 'list-row__sub small dim', text: shop.is_crowned ? '👑 корона активна' : 'корона не активна' })),
        h('div', { class: 'list-row__aside' },
          statusChip(shop.rent_status, `аренда: ${shop.rent_status}`),
          statusChip(shop.status, shop.status)))))
      : empty('🏪', 'У вас пока нет магазинов', 'Создайте магазин: 7 дней триала, затем ежемесячная аренда.'),
    h('div', { class: 'section' },
      h('div', { class: 'section__head' }, h('h2', { class: 'section__title', text: 'Тарифы аренды' })),
      h('div', { class: 'grid' }, (plans.items ?? []).map((p) => h('div', { class: 'card card--flat' },
        h('div', { class: 'row' },
          h('strong', { class: 'grow', text: p.name_ru }),
          p.crown ? h('span', { text: '👑' }) : null),
        h('p', { class: 'small dim', text: p.description }),
        h('dl', { class: 'kv' },
          h('dt', { text: 'Цена' }), h('dd', { text: `${p.price_sol} ◎ / ${p.price_stars} ⭐ в месяц` }),
          h('dt', { text: 'Комиссия' }), h('dd', { text: `${p.fee_bps / 100} %` }),
          h('dt', { text: 'Буст в ленте' }), h('dd', { text: p.boost ? `+${Math.round(p.boost * 100)} %` : 'нет' }),
          h('dt', { text: 'Код тарифа' }), h('dd', { class: 'mono', text: p.code })))))));
}

function createShopModal(me, plans, navigate) {
  const name = h('input', { class: 'input', placeholder: 'Название магазина (3–60 символов)' });
  const slug = h('input', { class: 'input mono', placeholder: 'slug: my-digital-store' });
  const description = h('textarea', { class: 'textarea', placeholder: 'Что продаёте и как выдаёте товар' });
  const country = h('select', { class: 'select' },
    S.countries.map((c) => h('option', { value: c.code, text: c.name_ru, selected: c.code === (me.country || S.geo.country) })));
  const city = h('select', { class: 'select' }, h('option', { value: '', text: '— город —' }));
  const categories = h('div', { class: 'row row--wrap' });
  const chosen = new Set();
  const acceptsStars = h('input', { type: 'checkbox', checked: true });

  const fillCities = (code) => {
    loadCities(code).then(() => {
      mount(city, h('option', { value: '', text: '— город —' }),
        S.cities.map((c) => h('option', { value: c.id, text: c.name_ru, selected: c.id === me.city_id })));
    });
  };
  country.addEventListener('change', () => fillCities(country.value));
  fillCities(me.country || S.geo.country);

  mount(categories, S.categories.map((c) => {
    const box = h('input', { type: 'checkbox' });
    box.addEventListener('change', () => {
      if (box.checked) chosen.add(c.id);
      else chosen.delete(c.id);
    });
    return h('label', { class: 'chip', style: 'cursor:pointer;display:inline-flex;align-items:center;gap:4px' }, box, c.name_ru, c.restricted ? ' (18+)' : '');
  }));

  modal({
    title: 'Новый магазин',
    sub: 'Триал 7 дней, затем ежемесячная аренда. Все обращения покупателей идут админу магазина.',
    body: h('div', {},
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Название *' }), name),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Slug (латиница)' }), slug),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Описание' }), description),
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Страна *' }), country),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Город *' }), city)),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Категории * (минимум одна)' }), categories),
      h('label', { class: 'switch' }, acceptsStars, 'Принимать оплату Telegram Stars'),
      h('p', { class: 'field__hint', text: `Тариф выбирается после создания: ${plans.map((p) => `${p.code} (${p.price_sol} ◎)`).join(', ')}.` })),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Создать магазин', kind: 'primary',
        onClick: async (close) => {
          if (!chosen.size) {
            toast('Выберите хотя бы одну категорию', 'warn');
            return true;
          }
          try {
            const res = await postWithOps('/api/v1/shops', {
              name: name.value.trim(),
              slug: slug.value.trim() || undefined,
              description: description.value.trim(),
              country: country.value,
              city_id: Number(city.value) || 0,
              category_ids: [...chosen],
              accepts_stars: acceptsStars.checked,
            }, 'создание магазина');
            close(true);
            toast(`Магазин создан: аренда ${res.rent?.status ?? 'trial'}`, 'ok');
            await loadMe();
            navigate(`#/profile/shop/${res.id}`);
          } catch (err) {
            toast(describeError(err), 'err');
          }
          return true;
        },
      },
    ],
  });
}

export async function shopAdmin(container, { navigate }, params) {
  mount(container, spinner());
  let shop;
  try {
    shop = await api.get(`/api/v1/shops/${params.id}`);
  } catch (err) {
    mount(container, empty('⚠️', 'Магазин не найден', describeError(err)));
    return;
  }
  const [rent, products, stats] = await Promise.all([
    api.get(`/api/v1/shops/${params.id}/rent`).catch(() => null),
    api.get(`/api/v1/shops/${params.id}/products?limit=50`).catch(() => ({ items: [] })),
    api.get(`/api/v1/shops/${params.id}/stats`).catch(() => null),
  ]);
  const plans = await api.get('/api/v1/rent/plans').catch(() => ({ items: [] }));
  const reload = () => shopAdmin(container, { navigate }, params);

  mount(container,
    h('div', { class: 'back', onclick: () => navigate('#/profile/shops') }, '← Мои магазины'),
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('div', { class: 'list-row__avatar', style: `background:${shop.accent ?? accentFor(shop.id)}`, text: initials(shop.name) }),
        h('div', { class: 'grow' },
          h('h2', { style: 'margin:0;font-size:18px', text: shop.name }),
          h('div', { class: 'small dim mono', text: `${shop.slug} · ${shop.id}` }))),
      h('div', { class: 'row row--wrap', style: 'margin-top:8px' },
        statusChip(rent?.status ?? shop.rent_status, `аренда: ${rent?.status ?? shop.rent_status}`),
        rent?.plan ? h('span', { class: 'chip chip--info', text: `${rent.plan.name_ru} · комиссия ${rent.plan.fee_bps / 100} %` }) : null,
        rent?.crown ? h('span', { class: 'chip chip--gold', text: '👑 корона активна' }) : null,
        shop.verified ? h('span', { class: 'chip chip--ok', text: '✔ верифицирован' }) : null,
        h('button', { class: 'chip', type: 'button', text: 'Открыть в ленте', onclick: () => navigate(`#/shop/${shop.id}`) }),
        h('button', { class: 'chip', type: 'button', text: '💬 Чаты магазина', onclick: () => navigate('#/chats') })),
      rent
        ? h('dl', { class: 'kv', style: 'margin-top:10px' },
          h('dt', { text: 'Период' }), h('dd', { text: `${dateTime(rent.period_start)} → ${dateTime(rent.period_end)}` }),
          h('dt', { text: 'Осталось' }), h('dd', { text: `${rent.days_left} дн. (${countdown(rent.period_end) ?? '—'})` }),
          h('dt', { text: 'Цена' }), h('dd', { text: `${rent.price_sol} ◎ / ${rent.price_stars} ⭐` }),
          h('dt', { text: 'Автопродление' }), h('dd', { text: rent.auto_renew ? 'включено' : 'выключено' }),
          rent.grace_end ? [h('dt', { text: 'Грейс до' }), h('dd', { text: dateTime(rent.grace_end) })] : null,
          rent.notice ? [h('dt', { text: 'Уведомление' }), h('dd', { text: rent.notice })] : null)
        : null,
      stats
        ? h('div', { class: 'stat-grid', style: 'margin-top:10px' },
          h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: String(stats.orders_completed) }), h('div', { class: 'stat__label', text: `завершено из ${stats.orders_total}` })),
          h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${stats.revenue_sol} ◎` }), h('div', { class: 'stat__label', text: `выручка · Stars ${stats.revenue_stars}` })),
          h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: String(stats.orders_disputed) }), h('div', { class: 'stat__label', text: `споров (${(stats.dispute_rate * 100).toFixed(1)} %)` })),
          h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: String(stats.feed_score) }), h('div', { class: 'stat__label', text: `очки ленты · комиссия ${stats.fee_paid_sol} ◎` })))
        : null,
      h('div', { class: 'btn-row', style: 'margin-top:10px' },
        h('button', { class: 'btn btn--primary', type: 'button', text: '🏷 Продлить аренду', onclick: () => renewModal(shop, rent, plans.items ?? [], reload) }),
        h('button', { class: 'btn', type: 'button', text: '+ Товар', onclick: () => productModal(shop, reload) }),
        h('button', { class: 'btn', type: 'button', text: '📊 Статистика', onclick: () => statsModal(shop, stats, navigate) }))),
    h('div', { class: 'section' },
      h('div', { class: 'section__head' },
        h('h2', { class: 'section__title', text: `Товары (${(products.items ?? []).length})` }),
        h('span', { class: 'section__hint', text: 'сток зашифрован AES-256-GCM (домен product_stock)' })),
      (products.items ?? []).length
        ? h('div', { class: 'list' }, products.items.map((p) => h('div', { class: 'list-row', style: 'cursor:default' },
          h('div', { class: 'list-row__avatar', style: `background:${accentFor(p.id)}`, text: '📦' }),
          h('div', { class: 'list-row__body', onclick: () => navigate(`#/product/${p.id}`), style: 'cursor:pointer' },
            h('div', { class: 'list-row__title', text: p.title }),
            h('div', { class: 'list-row__sub small dim', text: `${p.category ?? ''} · сток ${p.stock_free}/${p.stock_total} · ${p.delivery_kind === 'auto' ? 'автовыдача' : 'выдача вручную'}` })),
          h('div', { class: 'list-row__aside' },
            statusChip(p.status, p.status),
            h('strong', { text: p.price_stars ? `${p.price_stars} ⭐` : `${p.price_sol} ◎` }),
            h('button', { class: 'btn btn--sm', type: 'button', text: '+ Сток', onclick: () => stockModal(p, reload) })))))
        : empty('📦', 'Товаров нет', 'Добавьте товар и загрузите ключи — они зашифруются при сохранении.')));
}

function renewModal(shop, rent, plans, reload) {
  const current = rent?.plan?.code ?? 'starter';
  const planCode = h('select', { class: 'select' },
    plans.map((p) => h('option', {
      value: p.code,
      text: `${p.name_ru} — ${p.price_sol} ◎ / ${p.price_stars} ⭐ · комиссия ${p.fee_bps / 100} %${p.crown ? ' · 👑' : ''}`,
      selected: p.code === current,
    })));
  const asset = h('select', { class: 'select' },
    h('option', { value: 'SOL', text: '◎ SOL' }),
    h('option', { value: 'STARS', text: '⭐ Telegram Stars' }));
  const autoRenew = h('input', { type: 'checkbox', checked: !!rent?.auto_renew });
  modal({
    title: 'Аренда магазина',
    sub: `${shop.name} · ежемесячная плата списывается с внутреннего баланса (двойная запись в ledger).`,
    body: h('div', {},
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Тариф' }), planCode),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Актив' }), asset),
      h('label', { class: 'switch' }, autoRenew, 'Автопродление'),
      h('div', { class: 'notice', text: 'Статусы: trial → active → expiring (T-7 дней) → grace (72 ч) → suspended. В suspended магазин скрыт из ленты и не принимает заказы.' })),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Оплатить аренду', kind: 'primary',
        onClick: async (close) => {
          try {
            const res = await postWithOps(`/api/v1/shops/${shop.id}/rent`, {
              plan_code: planCode.value,
              asset: asset.value,
              auto_renew: autoRenew.checked,
            }, 'оплата аренды');
            close(true);
            toast(`Аренда: ${res.status}${res.crown ? ' · 👑 корона активна' : ''} до ${dateTime(res.period_end)}`, 'ok');
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

function productModal(shop, reload) {
  const title = h('input', { class: 'input', placeholder: 'Название товара (3–120 символов)' });
  const description = h('textarea', { class: 'textarea', placeholder: 'Описание: что входит, как выдаётся' });
  const category = h('select', { class: 'select' },
    S.categories.map((c) => h('option', { value: c.id, text: `${c.name_ru}${c.restricted ? ' (18+)' : ''}` })));
  const priceSol = h('input', { class: 'input', placeholder: '1.5' });
  const priceStars = h('input', { class: 'input', placeholder: '1500 (опционально)' });
  const kind = h('select', { class: 'select' },
    ['key', 'account', 'subscription', 'software', 'game_item', 'file', 'service', 'vpn']
      .map((k) => h('option', { value: k, text: k })));
  const warranty = h('input', { class: 'input', type: 'number', value: '14', min: '0' });
  const sla = h('input', { class: 'input', type: 'number', value: '1', min: '1' });
  const stockText = h('textarea', { class: 'textarea mono', placeholder: 'KEY-AAAA-1111\nKEY-BBBB-2222\n(строка = единица стока)' });

  modal({
    title: 'Новый товар',
    sub: `${shop.name} · сток шифруется в домене product_stock`,
    body: h('div', {},
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Название *' }), title),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Описание' }), description),
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Категория *' }), category),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Тип товара' }), kind)),
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Цена, SOL' }), priceSol),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Цена, Stars' }), priceStars)),
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Гарантия, дней' }), warranty),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'SLA выдачи, часов' }), sla)),
      h('div', { class: 'field' },
        h('label', { class: 'field__label', text: 'Сток (по строке на единицу) *' }), stockText,
        h('div', { class: 'field__hint', text: 'Ключи шифруются AES-256-GCM при сохранении; в API возвращается только свободное количество.' }))),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Сохранить товар', kind: 'primary',
        onClick: async (close) => {
          const payloads = stockText.value.split('\n').map((s) => s.trim()).filter(Boolean);
          if (!payloads.length) {
            toast('Добавьте хотя бы одну единицу стока', 'warn');
            return true;
          }
          try {
            const res = await api.post(`/api/v1/shops/${shop.id}/products`, {
              title: title.value.trim(),
              description: description.value.trim(),
              category_id: Number(category.value),
              kind: kind.value,
              price_sol: priceSol.value.trim() || '0',
              price_stars: priceStars.value.trim() ? Number(priceStars.value) : 0,
              warranty_days: Number(warranty.value) || 0,
              delivery_sla_h: Number(sla.value) || 1,
              stock_payloads: payloads,
            });
            close(true);
            toast(`Товар создан: сток ${res.stock_free ?? payloads.length} шт. (зашифрован)`, 'ok');
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

function stockModal(product, reload) {
  const text = h('textarea', { class: 'textarea mono', placeholder: 'KEY-CCCC-3333\nKEY-DDDD-4444' });
  modal({
    title: `Пополнение стока · ${product.title}`,
    sub: `Сейчас свободно ${product.stock_free} из ${product.stock_total}. Новые строки шифруются сразу.`,
    body: h('div', { class: 'field' }, text),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Загрузить ключи', kind: 'primary',
        onClick: async (close) => {
          const payloads = text.value.split('\n').map((s) => s.trim()).filter(Boolean);
          if (!payloads.length) {
            toast('Введите ключи', 'warn');
            return true;
          }
          try {
            const res = await api.post(`/api/v1/products/${product.id}/stock`, { payloads });
            close(true);
            toast(`Сток пополнен: свободно ${res.stock_free}`, 'ok');
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

function statsModal(shop, stats, navigate) {
  if (!stats) {
    toast('Статистика недоступна', 'warn');
    return;
  }
  modal({
    title: `Статистика · ${shop.name}`,
    sub: `Период ${stats.period_days} дней · тариф ${stats.rent?.plan ?? '—'} (${stats.rent?.status ?? '—'})`,
    body: h('div', {},
      h('div', { class: 'stat-grid' },
        h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: String(stats.orders_total) }), h('div', { class: 'stat__label', text: 'заказов' })),
        h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${stats.revenue_sol} ◎` }), h('div', { class: 'stat__label', text: 'выручка SOL' })),
        h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${stats.revenue_stars} ⭐` }), h('div', { class: 'stat__label', text: 'выручка Stars' })),
        h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${stats.rating?.bayes ?? '—'}` }), h('div', { class: 'stat__label', text: `рейтинг (${stats.rating?.count ?? 0} отзывов)` }))),
      h('dl', { class: 'kv' },
        h('dt', { text: 'Комиссия площадке' }), h('dd', { text: `${stats.fee_paid_sol} ◎ (${stats.fee_bps / 100} %)` }),
        h('dt', { text: 'Споры' }), h('dd', { text: `${stats.orders_disputed} (${(stats.dispute_rate * 100).toFixed(1)} %)` }),
        h('dt', { text: 'Медиана ответа' }), h('dd', { text: `${Math.round(stats.response_p50_s / 60)} мин` }),
        h('dt', { text: 'Товары' }), h('dd', { text: `${stats.products?.published ?? 0} опубликовано · сток ${stats.products?.stock_free ?? 0} шт.` }),
        h('dt', { text: 'Корона' }), h('dd', { text: stats.crown ? '👑 активна' : 'не активна' }),
        h('dt', { text: 'Очки ленты' }), h('dd', { text: String(stats.feed_score) })),
      h('div', { class: 'divider' }),
      h('p', { class: 'small dim', text: 'Продажи по дням:' }),
      (stats.sales_by_day ?? []).length
        ? h('div', { class: 'list' }, stats.sales_by_day.map((d) => h('div', { class: 'row small' },
          h('span', { class: 'mono', text: d.date }), h('span', { class: 'grow' }), h('strong', { text: `${d.sol} ◎` }))))
        : h('p', { class: 'small dim', text: 'Продаж за период нет.' })),
    actions: [
      { label: 'Закрыть' },
      { label: 'Отзывы магазина', kind: 'primary', onClick: () => navigate(`#/shop/${shop.id}`) },
    ],
  });
}
