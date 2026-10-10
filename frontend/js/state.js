// Глобальное состояние приложения и общие данные (конфиг, профиль, гео, непрочитанные).
import { api, store as localStore, live, tg } from './api.js';

export const S = {
  config: null,
  me: null,
  geo: localStore.geo ?? { country: '', city_id: null, city_name: '' },
  countries: [],
  cities: [],
  categories: [],
  unread: { chats: 0, notifications: 0 },
  ws: false,
  booted: false,
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) {
    try {
      fn(S);
    } catch (err) {
      console.error('state listener', err);
    }
  }
}

export function setGeo(country, cityId, cityName) {
  S.geo = { country, city_id: cityId, city_name: cityName };
  localStore.geo = S.geo;
  emit();
}

export async function loadConfig() {
  S.config = await api.get('/api/v1/auth/config');
  emit();
  return S.config;
}

export async function loadReference() {
  const [countries, categories] = await Promise.all([
    api.get('/api/v1/geo/countries'),
    api.get('/api/v1/categories'),
  ]);
  S.countries = countries.items ?? [];
  S.categories = categories.items ?? [];
  if (S.geo.country) await loadCities(S.geo.country);
  emit();
}

export async function loadCities(country) {
  if (!country) {
    S.cities = [];
    return [];
  }
  const res = await api.get(`/api/v1/geo/cities?country=${encodeURIComponent(country)}`);
  S.cities = res.items ?? [];
  emit();
  return S.cities;
}

export async function loadMe() {
  if (!localStore.tokens?.access) {
    S.me = null;
    emit();
    return null;
  }
  try {
    S.me = await api.get('/api/v1/auth/me');
  } catch {
    S.me = null;
    localStore.tokens = null;
  }
  emit();
  await refreshUnread();
  return S.me;
}

export async function refreshUnread() {
  if (!S.me) {
    S.unread = { chats: 0, notifications: 0 };
    emit();
    return;
  }
  try {
    const [chats, notes] = await Promise.all([
      api.get('/api/v1/chats?limit=1'),
      api.get('/api/v1/notifications'),
    ]);
    S.unread = { chats: chats.unread_total ?? 0, notifications: notes.unread ?? 0 };
  } catch {
    /* не критично */
  }
  emit();
}

export function setTokens(tokens) {
  localStore.tokens = tokens;
  if (tokens) live.connect();
  else live.disconnect();
}

export function logout(reason = '') {
  setTokens(null);
  S.me = null;
  S.unread = { chats: 0, notifications: 0 };
  emit();
  window.dispatchEvent(new CustomEvent('sitee:logged-out', { detail: { reason } }));
}

export function bindLive() {
  live.on('msg.new', () => refreshUnread());
  live.on('chat.read', () => refreshUnread());
  live.on('notify', () => refreshUnread());
  live.on('chat.new', () => refreshUnread());
  window.addEventListener('sitee:ws', (ev) => {
    S.ws = !!ev.detail.connected;
    emit();
  });
  window.addEventListener('sitee:logout', () => logout('token_expired'));
}

export function isStaff() {
  return ['superadmin', 'moderator', 'arbiter'].includes(S.me?.role);
}

export function isSeller() {
  return S.me?.role === 'shop_admin' || (S.me?.shops?.length ?? 0) > 0 || isStaff();
}

export async function telegramLogin() {
  if (!tg.available || !tg.initData) throw new Error('Telegram недоступен в этом окне');
  const res = await api.post('/api/v1/auth/telegram/init-data', { init_data: tg.initData, device: { device_id: 'tma' } });
  setTokens({ access: res.access_token, refresh: res.refresh_token, expires_in: res.expires_in });
  await loadMe();
  return res;
}
