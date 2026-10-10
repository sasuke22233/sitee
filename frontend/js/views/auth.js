// Экраны входа и регистрации: страна/город, двойной Google 2FA, backup-коды.
import { api, tg, store as localStore } from '../api.js';
import { S, setGeo, setTokens, loadMe, loadCities, emit } from '../state.js';
import { h, mount, toast, describeError, modal, qrCanvas, copyText, askOps, spinner, empty, totpNow } from '../ui.js';

const flow = { step: null, enrollment: null, session: null, setup: null, tokens: null };

function geoBlock({ required = false, onPick } = {}) {
  const countrySelect = h('select', {
    class: 'select', 'aria-label': 'Страна',
    onchange: async (ev) => {
      const country = ev.target.value;
      await loadCities(country);
      fillCities(citySelect, country);
      setGeo(country, null, '');
      if (onPick) onPick({ country, city_id: null });
    },
  }, h('option', { value: '', text: '— выберите страну —' }),
  S.countries.map((c) => h('option', { value: c.code, text: c.name_ru, selected: c.code === S.geo.country })));

  const citySelect = h('select', {
    class: 'select', 'aria-label': 'Город',
    onchange: (ev) => {
      const cityId = Number(ev.target.value) || null;
      const city = S.cities.find((c) => c.id === cityId);
      setGeo(S.geo.country, cityId, city?.name_ru ?? '');
      if (onPick) onPick({ country: S.geo.country, city_id: cityId });
    },
  }, h('option', { value: '', text: '— выберите город —' }));

  fillCities(citySelect, S.geo.country);

  return h('div', { class: 'row' },
    h('div', { class: 'grow' }, h('label', { class: 'field__label', text: required ? 'Страна *' : 'Страна' }), countrySelect),
    h('div', { class: 'grow' }, h('label', { class: 'field__label', text: required ? 'Город *' : 'Город' }), citySelect));
}

function fillCities(select, country) {
  mount(select, h('option', { value: '', text: '— выберите город —' }),
    S.cities.filter((c) => !country || c.country === country)
      .map((c) => h('option', { value: c.id, text: c.name_ru, selected: c.id === S.geo.city_id })));
}

// ---------------------------------------------------------------------------
// Приветственный экран (FR-AUTH-01)
// ---------------------------------------------------------------------------
export function welcome(container, { navigate }) {
  const demoWrap = h('div', {}, spinner('Готовим демо-доступ…'));

  const loginBtn = h('button', {
    class: 'btn btn--primary btn--block', type: 'button',
    onclick: () => navigate('#/login'),
  }, 'Войти');
  const registerBtn = h('button', {
    class: 'btn btn--block', type: 'button',
    onclick: () => navigate('#/register'),
  }, 'Создать аккаунт');

  const tgBtn = tg.available && tg.initData
    ? h('button', {
      class: 'btn btn--block', type: 'button',
      onclick: async () => {
        try {
          const res = await api.post('/api/v1/auth/telegram/init-data', { init_data: tg.initData, device: { device_id: 'tma' } });
          setTokens({ access: res.access_token, refresh: res.refresh_token, expires_in: res.expires_in });
          await loadMe();
          toast('Вход через Telegram выполнен', 'ok');
          navigate(res.redirect === '/admin' ? '#/admin' : '#/shops');
        } catch (err) {
          toast(describeError(err), 'err');
        }
      },
    }, 'Войти через Telegram')
    : null;

  mount(container,
    h('div', { class: 'hero' },
      h('h1', { class: 'hero__title', text: 'Маркетплейс цифровых товаров на Solana' }),
      h('p', { class: 'hero__text', text: 'Магазины с ежемесячной арендой, эскроу в SOL и Telegram Stars, диалог с админом магазина, споры с арбитром и сквозное шифрование переписки.' }),
      h('div', { class: 'row row--wrap' },
        h('span', { class: 'chip chip--gold', text: '👑 Crown-магазины' }),
        h('span', { class: 'chip chip--ok', text: '🔐 Двойной 2FA' }),
        h('span', { class: 'chip chip--info', text: '⭐ Telegram Stars' }),
        h('span', { class: 'chip', text: '◎ SOL-эскроу' })),
      h('div', { class: 'divider' }),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Ваш регион (влияет на ленту)' }), geoBlock({ onPick: () => navigate('#/welcome', true) }))),
    h('div', { class: 'btn-row', style: 'margin-bottom:12px' }, loginBtn, registerBtn),
    tgBtn,
    h('div', { class: 'section', style: 'margin-top:14px' },
      h('div', { class: 'section__head' },
        h('h2', { class: 'section__title', text: 'Демо-доступ' }),
        h('span', { class: 'section__hint', text: 'стенд preview' })),
      demoWrap));

  loadDemo(demoWrap, navigate);
}

async function loadDemo(wrap, navigate) {
  try {
    const res = await api.get('/api/v1/dev/credentials');
    const rows = res.users.map((cred) => h('div', { class: 'list-row' },
      h('div', { class: 'list-row__avatar', style: `background:${avatarColor(cred.role)}`, text: roleEmoji(cred.role) }),
      h('div', { class: 'list-row__body' },
        h('div', { class: 'list-row__title', text: `${roleLabel(cred.role)} · ${cred.nickname}` }),
        h('div', { class: 'list-row__sub mono', text: `${cred.email} / ${cred.password}` }),
        h('div', { class: 'list-row__sub small dim', text: `Баланс: ${cred.balance_sol} SOL · ${cred.balance_stars} ⭐` })),
      h('div', { class: 'list-row__aside' },
        h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: 'Войти', onclick: () => quickLogin(cred, navigate) }),
        h('button', { class: 'btn btn--sm', type: 'button', text: '2FA', onclick: () => showTwoFa(cred) }))));
    mount(wrap,
      h('div', { class: 'notice', text: 'На демо-стенде коды 2FA выдаются вместе с аккаунтом: вход подтверждается фактором «вход», платежи и вывод — фактором «операции».' }),
      h('div', { class: 'list' }, rows));
  } catch (err) {
    mount(wrap, empty('🔒', 'Демо-доступ недоступен', describeError(err)));
  }
}

function avatarColor(role) {
  return { superadmin: '#ef5b5b', arbiter: '#f0a92c', moderator: '#4aa8ef', shop_admin: '#7c6cff', buyer: '#35c46a' }[role] ?? '#7c6cff';
}
function roleEmoji(role) {
  return { superadmin: '🛡', arbiter: '⚖️', moderator: '🧹', shop_admin: '🏪', buyer: '🧑' }[role] ?? '👤';
}
function roleLabel(role) {
  return { superadmin: 'Супер-админ', arbiter: 'Арбитр', moderator: 'Модератор', shop_admin: 'Продавец', buyer: 'Покупатель' }[role] ?? role;
}

function showTwoFa(cred) {
  modal({
    title: `Двойной 2FA · ${cred.nickname}`,
    sub: 'Секреты факторов и backup-коды демо-аккаунта',
    body: h('div', {},
      h('p', { class: 'small muted', text: 'Фактор «вход» — для логина. Фактор «операции» — для платежей, вывода, аренды, споров и админ-действий.' }),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'SITEE (вход): секрет TOTP' }),
        h('div', { class: 'mono', text: cred.totp_login }),
        h('button', { class: 'btn btn--sm', type: 'button', text: 'Скопировать', onclick: () => copyText(cred.totp_login, 'Секрет входа скопирован') })),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'SITEE (операции): секрет TOTP' }),
        h('div', { class: 'mono', text: cred.totp_ops }),
        h('button', { class: 'btn btn--sm', type: 'button', text: 'Скопировать', onclick: () => copyText(cred.totp_ops, 'Секрет операций скопирован') })),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Backup-коды входа (одноразовые)' }),
        h('div', { class: 'mono small', text: cred.backup_login })),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Backup-коды операций' }),
        h('div', { class: 'mono small', text: cred.backup_ops })),
      h('p', { class: 'field__hint', text: `otpauth: ${cred.otpauth_login}` })),
    actions: [{ label: 'Закрыть', value: null }],
  });
}

async function quickLogin(cred, navigate) {
  try {
    const step1 = await api.post('/api/v1/auth/login', { identifier: cred.email, password: cred.password, device: { device_id: 'tma-demo' } });
    // Демо-стенд: код «входа» считаем из опубликованного секрета (backup-коды одноразовые).
    const body = { session_id: step1.session_id, factor: 'login' };
    if (cred.totp_login) body.code = await totpNow(cred.totp_login);
    else body.backup_code = cred.backup_login.split(',')[0];
    const step2 = await api.post('/api/v1/auth/2fa/verify', body);
    setTokens({ access: step2.access_token, refresh: step2.refresh_token, expires_in: step2.expires_in });
    await loadMe();
    toast(`Вход выполнен: ${step2.user.nickname}`, 'ok');
    navigate(step2.redirect === '/admin' ? '#/admin' : '#/shops');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

// ---------------------------------------------------------------------------
// Вход (FR-AUTH-03, FR-2FA-02)
// ---------------------------------------------------------------------------
export function login(container, { navigate }) {
  const identifier = h('input', { class: 'input', type: 'text', placeholder: 'email или никнейм', autocomplete: 'username', value: '' });
  const password = h('input', { class: 'input', type: 'password', placeholder: 'пароль', autocomplete: 'current-password' });
  const code = h('input', { class: 'input mono', type: 'text', placeholder: '6 цифр или backup-код', inputmode: 'numeric', autocomplete: 'one-time-code' });
  const captcha = h('input', { class: 'input', type: 'text', placeholder: 'captcha-токен (dev: любое значение)' });
  const captchaWrap = h('div', { class: 'field', hidden: true },
    h('label', { class: 'field__label', text: 'Подтверждение captcha' }), captcha);
  const status = h('div', { class: 'small dim', text: '' });
  let sessionId = '';

  const submit = h('button', {
    class: 'btn btn--primary btn--block', type: 'button', text: 'Продолжить',
    onclick: async () => {
      status.textContent = '';
      try {
        if (!sessionId) {
          const res = await api.post('/api/v1/auth/login', {
            identifier: identifier.value.trim(), password: password.value,
            device: { device_id: 'tma' }, captcha_token: captcha.value.trim() || undefined,
          });
          sessionId = res.session_id;
          toast('Введите код 2FA (фактор «вход»)', 'info');
          submit.textContent = 'Войти';
          status.textContent = `Сессия ${res.session_id} ожидает код 2FA · фактор: ${res.factor}`;
          code.focus();
          return;
        }
        const body = { session_id: sessionId, factor: 'login' };
        if (/^\d{6}$/.test(code.value.trim())) body.code = code.value.trim();
        else body.backup_code = code.value.trim();
        const res = await api.post('/api/v1/auth/2fa/verify', body);
        setTokens({ access: res.access_token, refresh: res.refresh_token, expires_in: res.expires_in });
        await loadMe();
        toast('Добро пожаловать в SITEE', 'ok');
        navigate(res.redirect === '/admin' ? '#/admin' : '#/shops');
      } catch (err) {
        sessionId = '';
        submit.textContent = 'Продолжить';
        if (err.code === 'CAPTCHA_REQUIRED') {
          captchaWrap.hidden = false;
          status.textContent = 'Требуется captcha: введите токен (в dev подойдёт любое значение).';
        } else if (err.code === 'TOTP_INVALID') {
          status.textContent = `Неверный код 2FA (попыток: ${err.details?.fails ?? '—'}). Можно использовать backup-код.`;
        } else if (err.status === 423 || err.code === 'LOCKED') {
          status.textContent = `${err.message} (повторить через ${Math.ceil((err.retryAfter ?? 900) / 60)} мин)`;
        } else {
          status.textContent = describeError(err);
        }
        toast(describeError(err), 'err');
      }
    },
  });

  mount(container,
    h('div', { class: 'back', onclick: () => navigate('#/welcome') }, '← Назад'),
    h('div', { class: 'card' },
      h('h2', { class: 'card__title', text: 'Вход в SITEE' }),
      h('p', { class: 'card__sub', text: 'Пароль + два фактора 2FA: «вход» и «операции».' }),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Email или никнейм' }), identifier),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Пароль' }), password),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Код 2FA (фактор «вход»)' }), code,
        h('div', { class: 'field__hint', text: '6 цифр из Google Authenticator (SITEE (вход)) или одноразовый backup-код.' })),
      captchaWrap,
      status,
      h('div', { class: 'divider' }),
      submit,
      h('button', { class: 'btn btn--ghost btn--block', type: 'button', text: 'Нет аккаунта? Регистрация', onclick: () => navigate('#/register') })),
    h('div', { class: 'notice', text: 'После 3 неудачных попыток потребуется captcha, после 5 — блокировка на 15 минут, после 15 — на 24 часа.' }));

  password.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit.click(); });
  code.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit.click(); });
}

// ---------------------------------------------------------------------------
// Регистрация: контакт → 2FA «вход» → 2FA «операции» → главная (FR-AUTH-02…05)
// ---------------------------------------------------------------------------
export function register(container, { navigate }) {
  const wrap = h('div', {});
  mount(container,
    h('div', { class: 'back', onclick: () => navigate('#/welcome') }, '← Назад'),
    wrap);
  if (flow.step === 'contact') return stepContact(wrap, navigate);
  if (flow.step === '2fa_login') return stepFactor(wrap, navigate, 'login');
  if (flow.step === '2fa_ops') return stepFactor(wrap, navigate, 'ops');
  if (flow.step === 'backup') return stepBackup(wrap, navigate);
  return stepForm(wrap, navigate);
}

function stepForm(wrap, navigate) {
  const email = h('input', { class: 'input', type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
  const nickname = h('input', { class: 'input', type: 'text', placeholder: 'nickname (3–32, латиница)', autocomplete: 'nickname' });
  const password = h('input', { class: 'input', type: 'password', placeholder: 'минимум 12 символов', autocomplete: 'new-password' });
  const confirm = h('input', { class: 'input', type: 'password', placeholder: 'повторите пароль', autocomplete: 'new-password' });
  const terms = h('input', { type: 'checkbox' });
  const adult = h('input', { type: 'checkbox' });
  const status = h('div', { class: 'field__error', text: '' });
  let picked = { country: S.geo.country, city_id: S.geo.city_id };

  const submit = h('button', {
    class: 'btn btn--primary btn--block', type: 'button', text: 'Зарегистрироваться',
    onclick: async () => {
      status.textContent = '';
      if (!picked.country || !picked.city_id) {
        status.textContent = 'Выберите страну и город';
        return;
      }
      try {
        const res = await api.post('/api/v1/auth/register', {
          email: email.value.trim(), nickname: nickname.value.trim(),
          password: password.value, password_confirm: confirm.value,
          country_code: picked.country, city_id: picked.city_id,
          accept_terms: terms.checked, is_18plus: adult.checked,
          locale: 'ru', captcha_token: 'dev',
        });
        flow.enrollment = res;
        flow.step = 'contact';
        navigate('#/register', true);
      } catch (err) {
        status.textContent = describeError(err);
        toast(describeError(err), 'err');
      }
    },
  });

  mount(wrap,
    h('div', { class: 'card' },
      h('h2', { class: 'card__title', text: 'Регистрация' }),
      h('p', { class: 'card__sub', text: 'Шаг 1 из 4: аккаунт, регион и пароль.' }),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Email *' }), email),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Никнейм *' }), nickname),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Пароль *' }), password,
        h('div', { class: 'field__hint', text: '12+ символов, буквы в обоих регистрах, цифра и спецсимвол; слабые слова запрещены.' })),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Повторите пароль *' }), confirm),
      h('div', { class: 'field' }, geoBlock({ required: true, onPick: (v) => { picked = v; } })),
      h('label', { class: 'switch' }, terms, 'Принимаю условия сервиса и политику конфиденциальности'),
      h('label', { class: 'switch', style: 'margin:6px 0 10px' }, adult, 'Мне есть 18 лет'),
      status,
      submit));
}

function stepContact(wrap, navigate) {
  const code = h('input', { class: 'input mono', type: 'text', placeholder: '6 цифр', inputmode: 'numeric', maxlength: 6 });
  const dev = flow.enrollment?.dev_code;
  mount(wrap,
    h('div', { class: 'card' },
      h('h2', { class: 'card__title', text: 'Подтверждение контакта' }),
      h('p', { class: 'card__sub', text: 'Шаг 2 из 4: код отправлен в Telegram-бот SITEE и действует 10 минут.' }),
      dev ? h('div', { class: 'notice notice--ok' }, `Демо-стенд: код подтверждения — ${dev}`) : null,
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Код из сообщения' }), code),
      h('button', {
        class: 'btn btn--primary btn--block', type: 'button', text: 'Подтвердить',
        onclick: async () => {
          try {
            const res = await api.post('/api/v1/auth/verify-contact', {
              enrollment_id: flow.enrollment.enrollment_id, code: code.value.trim(),
            });
            flow.step = '2fa_login';
            flow.factor = res.factor;
            navigate('#/register', true);
          } catch (err) {
            toast(describeError(err), 'err');
          }
        },
      })));
  if (dev) code.value = dev;
  code.focus();
}

function stepFactor(wrap, navigate, factor) {
  const box = h('div', {}, spinner('Готовим секрет 2FA…'));
  mount(wrap, box);
  const code1 = h('input', { class: 'input mono', type: 'text', placeholder: 'первый код', inputmode: 'numeric' });
  const code2 = h('input', { class: 'input mono', type: 'text', placeholder: 'второй код', inputmode: 'numeric' });
  const status = h('div', { class: 'field__error', text: '' });

  api.post('/api/v1/auth/2fa/setup', { factor, enrollment_id: flow.enrollment?.enrollment_id })
    .then((setup) => {
      flow.setup = setup;
      const label = factor === 'ops' ? 'SITEE (операции)' : 'SITEE (вход)';
      mount(box,
        h('div', { class: 'card' },
          h('h2', { class: 'card__title', text: `Фактор «${factor === 'ops' ? 'операции' : 'вход'}»` }),
          h('p', { class: 'card__sub', text: `Шаг ${factor === 'ops' ? '4' : '3'} из 4: ${label}. RFC 6238, SHA-1, 30 с, 6 цифр.` }),
          h('div', { class: 'qr' }, qrCanvas(setup.otpauth_url)),
          h('div', { class: 'field', style: 'margin-top:10px' },
            h('label', { class: 'field__label', text: 'Секрет для ручного ввода' }),
            h('div', { class: 'mono', text: setup.secret_b32 }),
            h('button', { class: 'btn btn--sm', type: 'button', text: 'Скопировать секрет', onclick: () => copyText(setup.secret_b32, 'Секрет скопирован') }),
            h('button', { class: 'btn btn--sm', type: 'button', text: 'Скопировать otpauth', onclick: () => copyText(setup.otpauth_url, 'Ссылка скопирована') })),
          setup.dev_codes
            ? h('div', { class: 'notice notice--ok' }, `Демо-стенд: коды сейчас — ${setup.dev_codes[0]} и ${setup.dev_codes[1]} (второй действует через 30 с).`)
            : null,
          h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Два кода подряд' }),
            h('div', { class: 'row' }, code1, code2)),
          status,
          h('button', {
            class: 'btn btn--primary btn--block', type: 'button', text: 'Активировать фактор',
            onclick: async () => {
              status.textContent = '';
              try {
                const res = await api.post('/api/v1/auth/2fa/activate', {
                  factor, enrollment_id: flow.enrollment?.enrollment_id,
                  code1: code1.value.trim(), code2: code2.value.trim(),
                });
                if (factor === 'login') {
                  flow.backup = res;
                  if (res.access_token) {
                    setTokens({ access: res.access_token, refresh: res.refresh_token, expires_in: res.expires_in });
                    await loadMe();
                  }
                  flow.step = 'backup';
                  navigate('#/register', true);
                } else {
                  flow.backupOps = res;
                  toast('Фактор «операции» активирован', 'ok');
                  finishRegistration(navigate);
                }
              } catch (err) {
                status.textContent = describeError(err);
                toast(describeError(err), 'err');
              }
            },
          }),
          h('p', { class: 'field__hint', text: setup.hint ?? '' })));
      if (setup.dev_codes) {
        code1.value = setup.dev_codes[0];
        code2.value = setup.dev_codes[1] ?? setup.dev_codes[0];
      }
    })
    .catch((err) => mount(box, empty('⚠️', 'Не удалось получить секрет', describeError(err))));
}

function stepBackup(wrap, navigate) {
  const res = flow.backup ?? {};
  mount(wrap,
    h('div', { class: 'card' },
      h('h2', { class: 'card__title', text: 'Backup-коды фактора «вход»' }),
      h('p', { class: 'card__sub', text: res.warning ?? 'Сохраните коды: они показываются один раз.' }),
      h('div', { class: 'code-list' }, (res.backup_codes ?? []).map((c) => h('span', { text: c }))),
      h('div', { class: 'divider' }),
      h('button', { class: 'btn btn--block', type: 'button', text: 'Скопировать все коды', onclick: () => copyText((res.backup_codes ?? []).join('\n'), 'Коды скопированы') }),
      h('button', {
        class: 'btn btn--primary btn--block', type: 'button', text: 'Дальше: фактор «операции»',
        onclick: () => {
          flow.step = '2fa_ops';
          navigate('#/register', true);
        },
      })));
}

function finishRegistration(navigate) {
  const codes = flow.backupOps?.backup_codes ?? [];
  modal({
    title: 'Регистрация завершена',
    sub: 'Оба фактора 2FA активны. Сохраните backup-коды фактора «операции».',
    body: h('div', {},
      h('div', { class: 'code-list' }, codes.map((c) => h('span', { text: c }))),
      h('p', { class: 'field__hint', text: 'Переходим на главную страницу с магазинами цифровых товаров.' })),
    actions: [{
      label: 'На главную', kind: 'primary', value: true,
      onClick: () => {
        flow.step = null;
        flow.enrollment = null;
        flow.backup = null;
        flow.backupOps = null;
        navigate('#/shops');
      },
    }],
  });
}
