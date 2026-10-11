// UI-хелперы: разметка, тосты, модалки, запрос второго фактора 2FA.
import { api, tg } from './api.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...nodes) {
  clear(el);
  for (const node of nodes.flat(4)) {
    if (node === null || node === undefined || node === false) continue;
    el.append(node.nodeType ? node : document.createTextNode(String(node)));
  }
  return el;
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function toast(message, kind = 'info', ms = 2600) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const node = h('div', { class: `toast toast--${kind}` }, message);
  root.append(node);
  try {
    tg.haptic?.(kind === 'err' ? 'heavy' : 'light');
  } catch { /* вибрация недоступна */ }
  setTimeout(() => node.remove(), ms);
}

export function spinner(text = 'Загружаем…') {
  return h('div', { class: 'splash' }, h('div', { class: 'spinner' }), h('p', { text }));
}

export function empty(icon, title, hint = '') {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty__icon', text: icon }),
    h('div', { text: title }),
    hint ? h('div', { class: 'small dim', text: hint }) : null);
}

// ---------------------------------------------------------------------------
// Модалки
// ---------------------------------------------------------------------------
export function modal({ title, sub, body, actions = [], onClose, dismissable = true }) {
  const root = document.getElementById('modal-root');
  root.hidden = false;
  const close = (result) => {
    root.hidden = true;
    clear(root);
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose(result);
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape' && dismissable) close(null);
  };
  document.addEventListener('keydown', onKey);
  const buttons = actions.map((action) => h('button', {
    class: `btn ${action.kind === 'primary' ? 'btn--primary' : action.kind === 'danger' ? 'btn--danger' : ''}`,
    type: 'button',
    onclick: () => {
      if (action.onClick) {
        const keepOpen = action.onClick(close);
        if (keepOpen === true) return;
      }
      close(action.value);
    },
  }, action.label));
  const box = h('div', { class: 'modal' },
    h('h3', { class: 'modal__title', text: title }),
    sub ? h('p', { class: 'modal__sub', text: sub }) : null,
    body ?? null,
    buttons.length ? h('div', { class: 'modal__actions' }, buttons) : null);
  if (dismissable) {
    root.addEventListener('click', (ev) => {
      if (ev.target === root) close(null);
    }, { once: true });
  }
  mount(root, box);
  return { close, box };
}

export function confirmDialog(title, text, okLabel = 'Подтвердить', danger = false) {
  return new Promise((resolve) => {
    modal({
      title, sub: text,
      actions: [
        { label: 'Отмена', value: false },
        { label: okLabel, value: true, kind: danger ? 'danger' : 'primary' },
      ],
      onClose: (result) => resolve(!!result),
    });
  });
}

// askOps — запрос кода второго фактора 2FA (SITEE (операции)).
export function askOps(operation, message) {
  return new Promise((resolve) => {
    const input = h('input', {
      class: 'input mono', placeholder: 'Код из SITEE (операции) или backup-код',
      inputmode: 'text', autocomplete: 'one-time-code', maxlength: 24,
    });
    const box = h('div', {},
      h('div', { class: 'notice notice--warn' }, '🔐 ', message ?? `Операция «${operation}» требует второй фактор 2FA.`),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Код 2FA (операции)' }), input),
      h('p', { class: 'field__hint', text: 'Демо-стенд: коды TOTP и backup-коды доступны на экране входа и в /api/v1/dev/credentials.' }));
    const m = modal({
      title: 'Подтверждение операции',
      sub: `Фактор «операции» · ${operation}`,
      body: box,
      actions: [
        { label: 'Отмена', value: null },
        {
          label: 'Подтвердить', kind: 'primary',
          onClick: (close) => {
            const code = input.value.trim();
            if (!code) {
              toast('Введите код 2FA', 'warn');
              return true;
            }
            close(code);
            return false;
          },
        },
      ],
      onClose: (code) => resolve(code ?? null),
    });
    setTimeout(() => input.focus(), 60);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && input.value.trim()) m.close(input.value.trim());
    });
  });
}

// post — вызов API с автоматическим повтором при TOTP_STEP2_REQUIRED.
export async function postWithOps(path, body = {}, operation = 'операция') {
  try {
    return await api.post(path, body);
  } catch (err) {
    if (err.code === 'TOTP_STEP2_REQUIRED' || err.status === 428) {
      const code = await askOps(operation, err.message);
      if (!code) throw err;
      return api.post(path, { ...body, totp_code: code });
    }
    throw err;
  }
}

export function describeError(err) {
  if (!err) return 'неизвестная ошибка';
  if (err.code === 'FAILED_FETCH' || err.message === 'Failed to fetch') return 'нет связи с сервером';
  if (err.details && typeof err.details === 'object') {
    const extra = err.details.problems ? ` (${err.details.problems.join('; ')})` : '';
    return `${err.message}${extra}`;
  }
  return err.message;
}

// ---------------------------------------------------------------------------
// Форматирование
// ---------------------------------------------------------------------------
export function money(value, asset) {
  if (asset === 'STARS') return `${Number(value ?? 0).toLocaleString('ru-RU')} ⭐`;
  return `${value} SOL`;
}

export function dateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function timeShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

export function countdown(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'истекло';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} мин`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} ч ${min % 60} мин`;
  return `${Math.floor(hours / 24)} дн`;
}

export function initials(name) {
  return String(name ?? '?').trim().slice(0, 2).toUpperCase();
}

export function accentFor(seed) {
  const palette = ['#7c6cff', '#4aa8ef', '#35c46a', '#f0a92c', '#ef5b5b', '#c86cff', '#2ec4b6', '#ff8a5b'];
  const text = String(seed ?? '');
  let sum = 0;
  for (const ch of text) sum += ch.codePointAt(0);
  return palette[sum % palette.length];
}

export function stars(count) {
  const n = Math.max(0, Math.min(5, Math.round(Number(count ?? 0))));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

export const STATUS_CHIP = {
  created: 'chip--warn', awaiting_payment: 'chip--warn', paid_escrow: 'chip--info', processing: 'chip--info',
  delivered: 'chip--ok', completed: 'chip--ok', dispute_opened: 'chip--err', in_arbitration: 'chip--err',
  refunded: 'chip--muted', cancelled: 'chip--muted', expired: 'chip--muted',
  active: 'chip--ok', trial: 'chip--info', expiring: 'chip--warn', grace: 'chip--warn', suspended: 'chip--err',
  open: 'chip--warn', awaiting_reply: 'chip--warn', resolved: 'chip--ok', dismissed: 'chip--muted', closed: 'chip--muted',
  published: 'chip--ok', draft: 'chip--muted', archived: 'chip--muted', rejected: 'chip--err',
  pending_moderation: 'chip--warn', approved: 'chip--ok', pending_approval: 'chip--warn',
};

export function statusChip(status, label) {
  return h('span', { class: `chip ${STATUS_CHIP[status] ?? ''}`, text: label ?? status });
}

// QR для otpauth:// — рисуем локально, без внешних сервисов (секрет не покидает устройство).
export function qrMatrix(text) {
  // Упрощённая визуализация: детерминированный паттерн по хэшу строки.
  // Настоящий QR генерирует приложение-аутентификатор по otpauth-ссылке;
  // здесь показываем «визуальный якорь» + ссылку и секрет для ручного ввода.
  const size = 21;
  let hash = 2166136261;
  for (const ch of text) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const cells = [];
  for (let y = 0; y < size; y += 1) {
    const row = [];
    for (let x = 0; x < size; x += 1) {
      hash = Math.imul(hash ^ (x + y * size), 2246822519) >>> 0;
      const finder = (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);
      if (finder) {
        const lx = x < 7 ? x : x - (size - 7);
        const ly = y < 7 ? y : y - (size - 7);
        const edge = lx === 0 || lx === 6 || ly === 0 || ly === 6;
        const core = lx >= 2 && lx <= 4 && ly >= 2 && ly <= 4;
        row.push(edge || core);
      } else {
        row.push((hash & 0x1) === 1);
      }
    }
    cells.push(row);
  }
  return cells;
}

export function qrCanvas(text) {
  const cells = qrMatrix(text);
  const scale = 8;
  const size = cells.length * scale;
  const canvas = h('canvas', { width: size, height: size, style: `width:168px;height:168px;image-rendering:pixelated` });
  const g = canvas.getContext?.('2d');
  if (!g) {
    // Среда без canvas (например, серверный рендер): показываем ссылку текстом.
    return h('div', { class: 'qr qr--text' },
      h('p', { class: 'small dim', text: 'QR недоступен в этом окружении — добавьте секрет вручную по ссылке:' }),
      h('div', { class: 'mono small', style: 'word-break:break-all', text }));
  }
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#0f1115';
  cells.forEach((row, y) => row.forEach((on, x) => {
    if (on) g.fillRect(x * scale, y * scale, scale, scale);
  }));
  return canvas;
}

export async function copyText(text, label = 'Скопировано') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'ok');
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(label, 'ok');
    } catch {
      toast('Не удалось скопировать', 'warn');
    }
    ta.remove();
  }
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) на устройстве — нужен демо-стенду, чтобы входить без расхода
// одноразовых backup-кодов. В prod секрет живёт только в приложении-аутентификаторе.
// ---------------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(secret) {
  const clean = String(secret).toUpperCase().replace(/=+$/g, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export async function totpNow(secret, { period = 30, digits = 6, offset = 0 } = {}) {
  const key = await crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const counter = Math.floor(Date.now() / 1000 / period) + offset;
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const o = sig[sig.length - 1] & 0x0f;
  const code = ((sig[o] & 0x7f) << 24) | ((sig[o + 1] & 0xff) << 16) | ((sig[o + 2] & 0xff) << 8) | (sig[o + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

export { api };
