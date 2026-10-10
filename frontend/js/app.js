// Точка входа Telegram Mini App SITEE: роутер по hash, шапка поиска, нижняя навигация, live-обновления.
import { api, live, store as localStore, tg } from './api.js';
import { S, loadConfig, loadReference, loadMe, bindLive, refreshUnread, setTokens, isStaff } from './state.js';
import { ensureTelegram } from './api.js';
import { h, mount, toast, describeError, spinner, empty } from './ui.js';
// Модули экранов загружаются по требованию: покупатель не тянет админку (64 КБ),
// продавец — подарки и т.д. Старт остаётся на api/state/ui (≈32 КБ).
const modules = {};
const loaders = {
  auth: () => import('./views/auth.js'),
  shops: () => import('./views/shops.js'),
  orders: () => import('./views/orders.js'),
  chats: () => import('./views/chats.js'),
  exchange: () => import('./views/exchange.js'),
  profile: () => import('./views/profile.js'),
  admin: () => import('./views/admin.js'),
};
async function loadView(name) {
  if (!modules[name]) modules[name] = await loaders[name]();
  return modules[name];
}

const view = document.getElementById('view');
const tabbar = document.getElementById('tabbar');
const bellBadge = document.getElementById('bell-badge');
const chatBadge = document.getElementById('tab-chats-badge');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');

const TABS = [
  { id: 'shops', hash: '#/shops', icon: '🏪', label: 'Магазины', match: ['shops', 'shop', 'product', 'orders', 'order', 'disputes', 'dispute'] },
  { id: 'chats', hash: '#/chats', icon: '💬', label: 'Чаты', match: ['chats', 'chat'] },
  { id: 'exchange', hash: '#/exchange', icon: '🔁', label: 'Обмен', match: ['exchange', 'wallet', 'gifts'] },
  { id: 'profile', hash: '#/profile', icon: '👤', label: 'Профиль', match: ['profile', 'admin'] },
];

const ROUTES = [
  { pattern: /^welcome$/, view: 'auth.welcome', public: true },
  { pattern: /^login$/, view: 'auth.login', public: true },
  { pattern: /^register$/, view: 'auth.register', public: true },
  { pattern: /^shops$/, view: 'shops.feed', public: true },
  { pattern: /^shop\/([^/]+)$/, view: 'shops.shop', public: true, params: ['id'] },
  { pattern: /^product\/([^/]+)$/, view: 'shops.product', public: true, params: ['id'] },
  { pattern: /^orders$/, view: 'orders.list' },
  { pattern: /^order\/([^/]+)$/, view: 'orders.detail', params: ['id'] },
  { pattern: /^chats$/, view: 'chats.chats' },
  { pattern: /^chat\/([^/]+)$/, view: 'chats.chat', params: ['id'] },
  { pattern: /^disputes$/, view: 'chats.disputes' },
  { pattern: /^dispute\/([^/]+)$/, view: 'chats.dispute', params: ['id'] },
  { pattern: /^exchange$/, view: 'exchange.exchange' },
  { pattern: /^profile$/, view: 'profile.profile' },
  { pattern: /^profile\/2fa$/, view: 'profile.security' },
  { pattern: /^profile\/sessions$/, view: 'profile.sessions' },
  { pattern: /^profile\/notifications$/, view: 'profile.notifications' },
  { pattern: /^profile\/shops$/, view: 'profile.myShops' },
  { pattern: /^profile\/shop\/([^/]+)$/, view: 'profile.shopAdmin', params: ['id'] },
  { pattern: /^admin$/, view: 'admin.admin', staff: true, params: [], section: 'dashboard' },
  { pattern: /^admin\/([^/]+)$/, view: 'admin.admin', staff: true, params: ['section'] },
];

let currentHash = '';

function navigate(hash, force = false) {
  if (hash === location.hash && !force) {
    render();
    return;
  }
  if (hash === location.hash) {
    render();
    return;
  }
  location.hash = hash;
  if (force) render();
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || (S.me ? 'shops' : 'welcome');
  for (const route of ROUTES) {
    const match = raw.match(route.pattern);
    if (!match) continue;
    const params = {};
    (route.params ?? []).forEach((name, index) => {
      params[name] = match[index + 1];
    });
    if (route.section) params.section = route.section;
    return { route, params, raw };
  }
  return null;
}

async function render() {
  const found = parseHash();
  if (!found) {
    mount(view, empty('🧭', 'Страница не найдена', `Маршрут ${location.hash} неизвестен.`),
      h('button', { class: 'btn btn--primary', type: 'button', text: 'На главную', onclick: () => navigate(S.me ? '#/shops' : '#/welcome') }));
    setActiveTab(null);
    return;
  }
  const { route, params } = found;
  if (!route.public && !S.me) {
    toast('Войдите в аккаунт, чтобы открыть раздел', 'warn');
    navigate('#/login');
    return;
  }
  if (route.staff && !isStaff()) {
    mount(view, empty('🛡', 'Доступ только для сотрудников',
      'Админ-панель открыта ролям superadmin, moderator и arbiter. Войдите демо-аккаунтом sitee_admin.'));
    setActiveTab(null);
    return;
  }
  currentHash = location.hash;
  view.scrollTop = 0;
  window.scrollTo(0, 0);
  mount(view, spinner());
  try {
    const [moduleName, exportName] = route.view.split('.');
    const render = await loadView(moduleName);
    await render[exportName](view, { navigate }, params);
  } catch (err) {
    console.error(err);
    mount(view, empty('⚠️', 'Ошибка экрана', describeError(err)),
      h('button', { class: 'btn', type: 'button', text: 'Повторить', onclick: () => render() }));
  }
  setActiveTab(params);
  updateBadges();
}

function setActiveTab() {
  const raw = (location.hash.replace(/^#\/?/, '') || '').split('/')[0];
  const active = TABS.find((tab) => tab.match.includes(raw));
  for (const tab of TABS) {
    const node = document.getElementById(`tab-${tab.id}`);
    if (node) node.setAttribute('aria-current', tab.id === active?.id ? 'page' : 'false');
  }
}

function updateBadges() {
  if (chatBadge) {
    chatBadge.textContent = S.unread.chats ? String(S.unread.chats) : '';
    chatBadge.hidden = !S.unread.chats;
  }
  if (bellBadge) {
    bellBadge.textContent = S.unread.notifications ? String(S.unread.notifications) : '';
    bellBadge.hidden = !S.unread.notifications;
  }
}

// ---------------------------------------------------------------------------
// Шапка и нижняя навигация
// ---------------------------------------------------------------------------
function wireChrome() {
  mount(tabbar, TABS.map((tab) => h('button', {
    class: 'tab', type: 'button', id: `tab-${tab.id}`, 'aria-current': 'false',
    onclick: () => {
      if (!S.me && tab.id !== 'shops') {
        toast('Войдите, чтобы открыть раздел', 'warn');
        navigate('#/login');
        return;
      }
      navigate(tab.hash);
    },
  },
  h('span', { class: 'tab__icon', text: tab.icon }),
  h('span', { class: 'tab__label', text: tab.label }),
  tab.id === 'chats' ? h('span', { class: 'badge', id: 'tab-chats-badge', hidden: true }) : null)));

  searchForm?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    shops.setQuery(searchInput.value.trim());
    navigate('#/shops', true);
  });
  try {
    searchInput.value = sessionStorage.getItem('sitee.q') ?? '';
  } catch {
    /* ignore */
  }

  document.getElementById('bell-btn')?.addEventListener('click', () => {
    if (!S.me) {
      navigate('#/login');
      return;
    }
    navigate('#/profile/notifications');
  });
}

function bindLiveEvents(navigateRef) {
  bindLive();
  live.on('msg.new', (d) => {
    const raw = (location.hash.replace(/^#\/?/, '') || '');
    if (raw.startsWith('chat/') && raw.endsWith(d.chat_id)) return;
    toast(`💬 ${d.sender_visible_as ?? 'Сообщение'}: ${d.body ?? '🔐 зашифровано'}`, 'info');
  });
  live.on('order.status', (d) => {
    toast(`🧾 Заказ ${d.order_number ?? d.order_id}: ${d.status_title ?? d.status}`, 'info');
    if ((location.hash || '').includes('order/')) render();
  });
  live.on('dispute.updated', (d) => {
    toast(`⚖️ Спор: ${d.title ?? d.status}`, 'warn');
    if ((location.hash || '').includes('dispute/')) render();
  });
  live.on('wallet.updated', (d) => {
    toast(`💳 Баланс: ${d.asset} ${d.direction === 'debit' ? '−' : '+'}${d.amount}`, 'info');
    if ((location.hash || '').includes('exchange')) render();
  });
  live.on('wallet.withdraw', (d) => toast(`📤 Вывод: ${d.status}`, 'info'));
  live.on('gift.received', (d) => toast(`🎁 Подарок: ${d.gift_title ?? d.gift_id}`, 'ok', 4000));
  live.on('rent.updated', (d) => toast(`🏷 Аренда: ${d.status}`, 'info'));
  live.on('user.banned', () => {
    toast('Аккаунт заблокирован администрацией', 'err', 8000);
    navigateRef('#/welcome');
  });
  live.on('user.updated', () => loadMe());
  live.on('shop.sanction', (d) => toast(`🛡 Санкция магазина: ${d.level ?? ''}`, 'warn'));
  live.on('product.moderation', (d) => toast(`🧹 Модерация: ${d.status}`, 'info'));
  live.on('notify', (d) => toast(`🔔 ${d.title ?? ''} ${d.body ?? ''}`, 'info'));
  live.on('e2ee.session', (d) => toast(`🔐 E2EE-сессия: ${d.safety_number ?? d.status ?? 'обновлена'}`, 'info', 4000));
  live.on('error', (d) => toast(`Ошибка WS: ${d.message ?? d.code ?? ''}`, 'err'));
  window.addEventListener('sitee:logged-out', () => navigateRef('#/welcome'));
}

// ---------------------------------------------------------------------------
// Загрузка
// ---------------------------------------------------------------------------
async function boot() {
  try {
    await start();
  } catch (err) {
    console.error('[sitee] boot failed', err);
    mount(view, empty('⚠️', 'Не удалось запустить SITEE',
      `${describeError(err)} Обновите страницу или откройте инструмент заново.`));
  }
}

async function start() {
  wireChrome();
  mount(view, spinner('Запускаем SITEE…'));
  // Скрипт Telegram подтягиваем в фоне: старт интерфейса от него не зависит.
  void ensureTelegram();
  bindLiveEvents(navigate);
  try {
    await loadConfig();
    await loadReference();
  } catch (err) {
    mount(view, empty('🛰', 'Сервер недоступен', `${describeError(err)} Запустите backend: npm start в tools/preview.`));
    return;
  }
  await loadMe();
  if (localStore.tokens?.access) live.connect();
  S.booted = true;
  if (!location.hash) location.hash = S.me ? '#/shops' : '#/welcome';
  await render();
  setInterval(() => refreshUnread(), 60_000);
}

window.addEventListener('hashchange', () => {
  if (location.hash === currentHash) return;
  render();
});

window.addEventListener('sitee:refresh', () => render());

boot();
