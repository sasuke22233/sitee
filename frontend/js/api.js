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
    if (value) localStorage.setItem(TOKEN_KEY, JSON.stringify(value));
    else localStorage.removeItem(TOKEN_KEY);
  },
  get geo() {
    try {
      return JSON.parse(localStorage.getItem(GEO_KEY) || 'null');
    } catch {
      return null;
    }
  },
  set geo(value) {
    if (value) localStorage.setItem(GEO_KEY, JSON.stringify(value));
    else localStorage.removeItem(GEO_KEY);
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
export const tg = (() => {
  const w = window.Telegram?.WebApp;
  // Вне Telegram (обычный браузер, preview-стенд) все методы — безопасные заглушки:
  // иначе первый же toast упадёт с TypeError и приложение покажет пустой экран.
  if (!w) {
    return {
      available: false, raw: null, user: null, initData: '',
      haptic() {}, openInvoice: async () => 'failed',
    };
  }
  try {
    w.ready();
    w.expand();
  } catch { /* вне Telegram */ }
  return {
    available: true,
    raw: w,
    user: w.initDataUnsafe?.user ?? null,
    initData: w.initData ?? '',
    haptic(kind = 'light') {
      try {
        w.HapticFeedback?.impactOccurred(kind);
      } catch { /* игнорируем */ }
    },
    openInvoice(payload) {
      return new Promise((resolve) => {
        try {
          w.openInvoice(payload, (status) => resolve(status));
        } catch {
          resolve('failed');
        }
      });
    },
  };
})();

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
