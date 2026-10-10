// Клиент API SITEE: относительные URL (работает и в Telegram Mini App, и в preview-прокси),
// хранение токенов, авто-refresh, WebSocket-подписка.
const TOKEN_KEY = 'sitee.tokens.v1';
const GEO_KEY = 'sitee.geo.v1';

export const store = {
  get tokens() {
    try {
      return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    } catch {
      return null;
    }
  },
  set tokens(value) {
    // В iframe/sandbox localStorage может быть недоступен: падать нельзя,
    // иначе boot останавливается на сплэше («превью как будто не загружено»).
    try {
      if (value) localStorage.setItem(TOKEN_KEY, JSON.stringify(value));
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
  get geo() {
    try {
      return JSON.parse(localStorage.getItem(GEO_KEY) || 'null');
    } catch {
      return null;
    }
  },
  set geo(value) {
    try {
      if (value) localStorage.setItem(GEO_KEY, JSON.stringify(value));
      else localStorage.removeItem(GEO_KEY);
    } catch {
      /* ignore */
    }
  },
};

export class ApiError extends Error {
  constructor(status, code, message, details, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details ?? null;
    this.retryAfter = retryAfter ?? 0;
  }
}

let refreshing = null;

async function raw(method, path, body, { retry = true } = {}) {
  const tokens = store.tokens;
  const headers = { 'Content-Type': 'application/json' };
  if (tokens?.access) headers.Authorization = `Bearer ${tokens.access}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && retry && tokens?.refresh) {
    if (!refreshing) refreshing = doRefresh(tokens.refresh);
    const okRefresh = await refreshing;
    refreshing = null;
    if (okRefresh) return raw(method, path, body, { retry: false });
    store.tokens = null;
    window.dispatchEvent(new CustomEvent('sitee:logout', { detail: { reason: 'refresh_failed' } }));
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'ERROR', err.message ?? res.statusText, err.details, err.retry_after);
  }
  return data;
}

async function doRefresh(refresh) {
  try {
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    store.tokens = { access: data.access_token, refresh: data.refresh_token, expires_in: data.expires_in };
    return true;
  } catch {
    return false;
  }
}

export const api = {
  get: (path) => raw('GET', path),
  post: (path, body) => raw('POST', path, body ?? {}),
  patch: (path, body) => raw('PATCH', path, body ?? {}),
  del: (path, body) => raw('DELETE', path, body ?? {}),
};

// ---------------------------------------------------------------------------
// Telegram WebApp
// ---------------------------------------------------------------------------
// Скрипт telegram.org НЕ подключён в index.html: если Telegram недоступен из
// сети пользователя (или открыт обычный браузер), браузер висел бы на нём
// десятками секунд и не запускал приложение. Грузим его в фоне с таймаутом,
// а до его появления работаем на безопасных заглушках.
const TELEGRAM_SRC = 'https://telegram.org/js/telegram-web-app.js';
const TELEGRAM_TIMEOUT_MS = 3000;

let telegramWebApp = window.Telegram?.WebApp ?? null;
let telegramReady = Promise.resolve(telegramWebApp);

export function ensureTelegram(timeoutMs = TELEGRAM_TIMEOUT_MS) {
  if (telegramWebApp || document.querySelector(`script[src="${TELEGRAM_SRC}"]`)) return telegramReady;
  telegramReady = new Promise((resolve) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      script.remove();
      resolve(null);
    }, timeoutMs);
    script.src = TELEGRAM_SRC;
    script.async = true;
    script.onload = () => {
      clearTimeout(timer);
      telegramWebApp = window.Telegram?.WebApp ?? null;
      if (telegramWebApp) {
        try {
          telegramWebApp.ready();
          telegramWebApp.expand();
        } catch { /* вне Telegram */ }
      }
      resolve(telegramWebApp);
    };
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      resolve(null);
    };
    document.head.appendChild(script);
  });
  return telegramReady;
}

// Прокси к WebApp: если он ещё не загружен, методы тихо выходят в заглушки,
// поэтому интерфейс работает и без Telegram (preview, обычный браузер).
function webApp() {
  return telegramWebApp;
}

export const tg = {
  get available() {
    return !!webApp();
  },
  get raw() {
    return webApp();
  },
  get user() {
    return webApp()?.initDataUnsafe?.user ?? null;
  },
  get initData() {
    return webApp()?.initData ?? '';
  },
  haptic(kind = 'light') {
    try {
      webApp()?.HapticFeedback?.impactOccurred(kind);
    } catch { /* игнорируем */ }
  },
  openInvoice(payload) {
    const w = webApp();
    if (!w) return Promise.resolve('failed');
    return new Promise((resolve) => {
      try {
        w.openInvoice(payload, (status) => resolve(status));
      } catch {
        resolve('failed');
      }
    });
  },
  // Принудительно подтянуть WebApp (например, перед открытием Stars-инвойса).
  load: ensureTelegram,
};

// ---------------------------------------------------------------------------
// WebSocket (WSS): live-обновления чатов, заказов, кошелька
// ---------------------------------------------------------------------------
export class Live {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.connected = false;
    this.retry = 0;
    this.queue = [];
  }

  url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = store.tokens?.access ?? '';
    return `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;
  }

  connect() {
    if (!store.tokens?.access) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    try {
      this.ws = new WebSocket(this.url());
    } catch {
      return;
    }
    this.ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.ws.send(JSON.stringify({ v: 1, t: 'auth', ts: Date.now(), d: { token: store.tokens.access } }));
      for (const frame of this.queue.splice(0)) this.send(frame.t, frame.d);
      window.dispatchEvent(new CustomEvent('sitee:ws', { detail: { connected: true } }));
      this.pingTimer = setInterval(() => this.send('ping', {}), 25_000);
    };
    this.ws.onmessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }
      const list = this.listeners.get(frame.t) ?? [];
      for (const fn of list) fn(frame.d ?? {}, frame);
      const any = this.listeners.get('*') ?? [];
      for (const fn of any) fn(frame.d ?? {}, frame);
    };
    this.ws.onclose = () => {
      this.connected = false;
      clearInterval(this.pingTimer);
      window.dispatchEvent(new CustomEvent('sitee:ws', { detail: { connected: false } }));
      if (!store.tokens?.access) return;
      this.retry = Math.min(5, this.retry + 1);
      setTimeout(() => this.connect(), 1000 * this.retry);
    };
    this.ws.onerror = () => {
      try {
        this.ws.close();
      } catch { /* уже закрыт */ }
    };
  }

  disconnect() {
    clearInterval(this.pingTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch { /* уже закрыт */ }
    }
    this.ws = null;
    this.connected = false;
  }

  send(type, data = {}) {
    const frame = { v: 1, t: type, ts: Date.now(), d: data };
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
    else this.queue.push(frame);
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((f) => f !== fn));
  }
}

export const live = new Live();
