// Крипто-модуль preview-сервера.
//
// Форматы полностью совпадают с Go-бэкендом (backend/internal/cryptod) и
// Rust crypto-core (crypto-core/), поэтому снимок данных переносим между
// реализациями:
//   Envelope v1 = 0x01 || key_id(8) || nonce(12) || ciphertext+GCM tag(16), base64
//   AAD         = "<domain>:<object_id>"
//   DEK         = HKDF-SHA256(KEK, salt="sitee-dek-v1", info="domain:"+domain, 32)
//   key_id      = SHA-256("sitee-keyid-v1:" + domain + ":" + kekFP)[:8]
//   blind index = HMAC-SHA256(HKDF(KEK,"sitee-idx-v1","blind-index",32), lower(trim(v)))
//   пароль      = pbkdf2-sha256$210000$salt_b64raw$hash_b64raw
import crypto from 'node:crypto';

const KEK_HEX = process.env.SITEED_KEK_HEX || '';
export const KEK = KEK_HEX ? Buffer.from(KEK_HEX, 'hex') : crypto.randomBytes(32);
if (KEK.length !== 32) throw new Error('SITEED_KEK_HEX должен быть 32 байта (64 hex-символа)');
export const KEK_FINGERPRINT = crypto.createHash('sha256').update(KEK).digest('hex').slice(0, 16);

const JWT_SECRET = process.env.SITEED_JWT_SEED_HEX
  ? Buffer.from(process.env.SITEED_JWT_SEED_HEX, 'hex')
  : crypto.createHash('sha256').update(Buffer.concat([KEK, Buffer.from('sitee-jwt')])).digest();

export const DOMAINS = {
  pii: 'pii',
  totp: '2fa',
  message: 'msg',
  stock: 'product_stock',
  dispute: 'dispute',
  wallet: 'wallet',
};

function hkdf(secret, salt, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, salt, info, length));
}

const dekCache = new Map();
function domainKey(domain) {
  if (!dekCache.has(domain)) {
    dekCache.set(domain, hkdf(KEK, Buffer.from('sitee-dek-v1'), Buffer.from('domain:' + domain), 32));
  }
  return dekCache.get(domain);
}

function keyId(domain) {
  const fp = crypto.createHash('sha256')
    .update(Buffer.from('sitee-keyid-v1:' + domain + ':' + KEK_FINGERPRINT))
    .digest();
  return fp.subarray(0, 8);
}

// encrypt — AES-256-GCM в Envelope v1, возвращает base64.
export function encrypt(domain, objectId, plaintext) {
  const dek = domainKey(domain);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
  cipher.setAAD(Buffer.from(`${domain}:${objectId}`, 'utf8'));
  const ct = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([0x01]), keyId(domain), nonce, ct, tag]).toString('base64');
}

// decrypt — обратная операция; бросает исключение при повреждении AAD/tag.
export function decrypt(domain, objectId, blob) {
  const raw = Buffer.from(blob, 'base64');
  if (raw.length < 1 + 8 + 12 + 16 || raw[0] !== 0x01) throw new Error('envelope: неверная версия');
  const nonce = raw.subarray(9, 21);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(21, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', domainKey(domain), nonce);
  decipher.setAAD(Buffer.from(`${domain}:${objectId}`, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function tryDecrypt(domain, objectId, blob) {
  try {
    return decrypt(domain, objectId, blob);
  } catch {
    return null;
  }
}

export function blindIndex(value) {
  const key = hkdf(KEK, Buffer.from('sitee-idx-v1'), Buffer.from('blind-index'), 32);
  return crypto.createHmac('sha256', key).update(String(value).trim().toLowerCase()).digest('hex');
}

export function hmacSha256(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest();
}

// ---------------------------------------------------------------------------
// Пароли: PBKDF2-SHA256, 210 000 итераций (OWASP 2023)
// ---------------------------------------------------------------------------
const PBKDF2_ITER = 210000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITER, 32, 'sha256');
  return `pbkdf2-sha256$${PBKDF2_ITER}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, encoded) {
  const parts = String(encoded).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iter = Number(parts[1]);
  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  const actual = crypto.pbkdf2Sync(password, salt, iter, expected.length, 'sha256');
  return crypto.timingSafeEqual(actual, expected);
}

export function passwordPolicy(pw) {
  if (!pw || pw.length < 10) return 'пароль должен быть не короче 10 символов';
  if (pw.length > 128) return 'пароль длиннее 128 символов';
  if (!/[a-zа-я]/.test(pw)) return 'пароль должен содержать строчную букву';
  if (!/[A-ZА-Я]/.test(pw)) return 'пароль должен содержать заглавную букву';
  if (!/[0-9]/.test(pw)) return 'пароль должен содержать цифру';
  if (!/[^A-Za-z0-9А-Яа-я]/.test(pw)) return 'пароль должен содержать спецсимвол';
  const weak = ['password', 'qwerty', '123456', 'sitee', 'admin'];
  const lower = pw.toLowerCase();
  for (const w of weak) if (lower.includes(w)) return `пароль содержит слабое слово «${w}»`;
  return null;
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238): SHA-1, 30 с, 6 цифр — «двойной Google 2FA»
// ---------------------------------------------------------------------------
export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret(bytes = 20) {
  return crypto.randomBytes(bytes);
}

export function secretBase32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function decodeBase32(str) {
  const clean = String(str).replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('base32: недопустимый символ ' + ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret, counter, digits = TOTP_DIGITS) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function generateTotp(secret, at = new Date()) {
  return hotp(secret, Math.floor(at.getTime() / 1000 / TOTP_PERIOD));
}

// validateTotp — проверка с окном ±window шагов и защитой от replay.
export function validateTotp(secret, code, at = new Date(), window = 1) {
  const value = String(code ?? '').trim();
  // Backup-коды и мусор отсекаются до постоянного времени сравнения.
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(value)) return { ok: false, step: 0 };
  const step = Math.floor(at.getTime() / 1000 / TOTP_PERIOD);
  const given = Buffer.from(value);
  for (let i = -window; i <= window; i += 1) {
    const expected = Buffer.from(hotp(secret, step + i));
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) {
      return { ok: true, step: step + i };
    }
  }
  return { ok: false, step };
}

export function otpAuthUrl(issuer, account, secretB32, label) {
  const q = encodeURIComponent;
  return `otpauth://totp/${q(issuer)}:${q(account)}?secret=${secretB32}&issuer=${q(issuer)}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}&label=${q(label)}`;
}

export function backupCodes(n = 10) {
  const codes = [];
  const hashes = [];
  for (let i = 0; i < n; i += 1) {
    const code = crypto.randomBytes(5).toString('hex').replace(/(.{5})/, '$1-').toUpperCase();
    codes.push(code);
    hashes.push(crypto.createHash('sha256').update(code).digest('hex'));
  }
  return { codes, hashes };
}

export function verifyBackupCode(code, hashes) {
  const digest = crypto.createHash('sha256').update(String(code).toUpperCase()).digest('hex');
  const idx = hashes.indexOf(digest);
  return idx;
}

// ---------------------------------------------------------------------------
// Токены доступа (упрощённый JWT-подобный формат: base64url(payload).hmac)
// ---------------------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signToken(claims, ttlSeconds) {
  const payload = { ...claims, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', JWT_SECRET).update(body).digest());
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return { expired: true };
  return payload;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// Solana-подобная деривация адреса (SLIP-0010 ed25519 → base58 pubkey).
// В preview используется детерминированный HKDF-псевдоним приватного ключа;
// реальная подпись транзакций выполняется Rust crypto-core (crypto-core/).
// ---------------------------------------------------------------------------
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(buf) {
  let num = BigInt('0x' + buf.toString('hex'));
  let out = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    num /= 58n;
    out = B58_ALPHABET[rem] + out;
  }
  for (const b of buf) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out || '1';
}

export function depositPath(index) {
  return `m/44'/501'/${index}'/0'`;
}

export function addressForPath(path) {
  const seed = hkdf(KEK, Buffer.from('sitee-solana-v1'), Buffer.from('path:' + path), 32);
  return base58Encode(seed);
}

export function isValidAddress(addr) {
  return typeof addr === 'string' && addr.length >= 32 && addr.length <= 44 &&
    [...addr].every((ch) => B58_ALPHABET.includes(ch));
}

// ---------------------------------------------------------------------------
// Хэш-цепочка аудит-лога (docs/security.md §10)
// ---------------------------------------------------------------------------
export function auditHash(record) {
  const payload = JSON.stringify({
    id: record.id, ts: record.ts, actor_id: record.actor_id, actor_role: record.actor_role,
    action: record.action, object_type: record.object_type, object_id: record.object_id,
    reason: record.reason, ip: record.ip, totp_factor: record.totp_factor,
    before: record.before, after: record.after, prev_hash: record.prev_hash,
  });
  return hmacSha256(Buffer.from('sitee-audit-v1'), payload).toString('base64');
}

export const LAMPORTS_PER_SOL = 1_000_000_000;

export function parseSol(value) {
  const str = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,9})?$/.test(str)) return null;
  const [whole, frac = ''] = str.split('.');
  const lamports = BigInt(whole) * BigInt(LAMPORTS_PER_SOL) +
    BigInt((frac + '000000000').slice(0, 9));
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(lamports);
}

export function formatSol(lamports) {
  const sign = lamports < 0 ? '-' : '';
  const abs = Math.abs(lamports);
  const whole = Math.floor(abs / LAMPORTS_PER_SOL);
  const frac = String(abs % LAMPORTS_PER_SOL).padStart(9, '0').replace(/0+$/, '');
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`;
}

export function hex(n) {
  return crypto.randomBytes(n).toString('hex');
}
