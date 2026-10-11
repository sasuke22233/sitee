// Роуты: аутентификация, двойной 2FA, гео, профиль, уведомления.
// Соответствует docs/api.md §2–3 и backend/internal/api/auth.go.
import * as C from './crypto.mjs';
import {
  CONFIG, ApiError, bad, conflict, forbidden, locked, notFound, tooMany, unauthorized,
  ok, created, allow, clientIp, issueSession, rotateSession, requireAuth, requireOps, requireRole,
  audit, notify, recordAuthEvent, userDto, maskEmail,
} from './lib.mjs';

const MINUTE = 60_000;

function findUserByIdentifier(ctx, identifier) {
  const value = String(identifier ?? '').trim();
  if (!value) return null;
  if (value.includes('@')) {
    const id = ctx.db.usersByMail.get(C.blindIndex(value));
    return id ? ctx.db.users.get(id) : null;
  }
  const byNick = ctx.db.usersByNick.get(value.toLowerCase());
  if (byNick) return ctx.db.users.get(byNick);
  for (const user of ctx.db.users.values()) {
    if (user.nickname.toLowerCase() === value.toLowerCase()) return user;
  }
  return null;
}

// verifyFactor — RFC 6238 + replay-защита + backup-коды (docs/security.md §6).
function verifyFactor(ctx, user, factorName, rawCode) {
  const factor = user.factors?.[factorName];
  if (!factor || factor.status !== 'active') throw forbidden('2FA_NOT_ENROLLED', 'фактор 2FA не настроен');
  const code = String(rawCode ?? '').trim().toUpperCase();
  if (!code) throw bad('укажите код 2FA');
  const secret = C.decodeBase32(factor.secret_b32 ?? '');
  if (secret.length !== 20) throw new ApiError(500, 'INTERNAL', 'секрет 2FA недоступен');
  factor.used_codes ??= {};
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [k, until] of Object.entries(factor.used_codes)) {
    if (until < nowSec) delete factor.used_codes[k];
  }
  if (factor.used_codes[code]) throw unauthorized('код уже использован, дождитесь следующего');
  const res = C.validateTotp(secret, code);
  if (res.ok) {
    factor.used_codes[code] = nowSec + 120;
    return { ok: true, method: 'totp' };
  }
  const idx = C.verifyBackupCode(code, factor.backup_hashes ?? []);
  if (idx >= 0 && !(factor.backup_used ?? {})[idx]) {
    factor.backup_used ??= {};
    factor.backup_used[idx] = true;
    return { ok: true, method: 'backup' };
  }
  return { ok: false, method: res.ok ? 'totp' : 'backup' };
}

// verifyPendingCode — проверка кода при активации фактора (статус pending).
function verifyPendingCode(factor, code) {
  const secret = C.decodeBase32(factor.secret_b32 ?? '');
  if (secret.length !== 20) return false;
  return C.validateTotp(secret, String(code ?? '').trim()).ok;
}

// guard — анти-брутфорс: captcha после 3, блокировка 15 мин после 5, 24 ч после 15.
function guardFail(ctx, key, ip) {
  const g = ctx.guards.get(key) ?? { fails: 0, until: 0, hard: 0 };
  g.fails += 1;
  const now = Date.now();
  if (g.fails >= 15) {
    g.hard = now + 24 * 3600_000;
    g.fails = 0;
  } else if (g.fails >= 5) {
    g.until = now + 15 * MINUTE;
    g.fails = 0;
  }
  g.captcha = g.fails >= 3;
  ctx.guards.set(key, g);
  return g;
}

function guardOk(ctx, key) {
  ctx.guards.delete(key);
}

function guardCheck(ctx, key) {
  const g = ctx.guards.get(key);
  if (!g) return null;
  const now = Date.now();
  if (g.hard > now) return locked('слишком много попыток, вход заблокирован на 24 часа', Math.ceil((g.hard - now) / 1000));
  if (g.until > now) return locked('слишком много попыток, попробуйте позже', Math.ceil((g.until - now) / 1000));
  return null;
}

export function authRoutes(ctx) {
  const routes = [];

  routes.push(['GET', '/api/v1/auth/config', () => ok({
    env: CONFIG.env,
    app: { name: 'SITEE', version: ctx.version, tagline: 'Маркетплейс цифровых товаров на Solana' },
    telegram: { bot_username: CONFIG.tgBotUsername, mini_app: true, stars_enabled: true },
    captcha: { site_key: CONFIG.captchaSiteKey, provider: 'hcaptcha', required_after_fails: 3 },
    password_policy: { min_length: 12, require_digits: true, require_symbols: true, require_case_mix: true, breached_check: true },
    two_fa: { factors: ['login', 'ops'], algorithm: 'SHA1', digits: C.TOTP_DIGITS, period: C.TOTP_PERIOD, backup_codes: 10, activation_codes: 2 },
    geo: { countries_required: true, city_required: true },
    payments: {
      assets: ['SOL', 'STARS'], solana_network: CONFIG.solanaNetwork,
      min_deposit_sol: C.formatSol(Math.round(CONFIG.minDepositSol * C.LAMPORTS_PER_SOL)),
      confirmations_required: CONFIG.confirmations,
      exchange_fee_bps: CONFIG.exchangeFeeBps, sol_stars_rate: CONFIG.solStarsRate,
    },
    limits: {
      order_pay_timeout_min: CONFIG.payTimeoutMinutes, order_auto_confirm_h: CONFIG.autoConfirmHours,
      dispute_reply_h: CONFIG.disputeReplyHours, dispute_window_days: CONFIG.disputeWindowDays,
      review_window_days: CONFIG.reviewWindowDays, withdraw_daily_sol: CONFIG.withdrawDailySol,
      four_eyes_sol: CONFIG.fourEyesSol, address_cooling_h: 24,
      ops_totp_threshold_sol: CONFIG.opsThresholdSol, ops_totp_threshold_stars: CONFIG.opsThresholdStars,
    },
    ws: { url: '/ws', auth_window_s: 10, ping_interval_s: 25, max_frame_bytes: 65536, max_conn_per_user: 10 },
    crypto: { kek_fingerprint: C.KEK_FINGERPRINT, envelope_version: 1, aes: 'AES-256-GCM', kdf: 'HKDF-SHA256' },
    maintenance_mode: !!ctx.db.settings.get('maintenance_mode'),
    registration_open: ctx.db.settings.get('registration_open') !== false,
  }), { rate: 'public' }]);

  routes.push(['GET', '/api/v1/geo/countries', () => ok({
    items: [...ctx.db.countries.values()].sort((a, b) => a.name_ru.localeCompare(b.name_ru, 'ru')),
  }), { rate: 'public' }]);

  routes.push(['GET', '/api/v1/geo/cities', (r) => {
    const country = String(r.query.country ?? '').toUpperCase();
    const q = String(r.query.q ?? '').toLowerCase();
    let items = [...ctx.db.cities.values()];
    if (country) items = items.filter((c) => c.country === country);
    if (q) items = items.filter((c) => c.name_ru.toLowerCase().includes(q) || c.name_en.toLowerCase().includes(q));
    items.sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
    return ok({ items: items.slice(0, 50) });
  }, { rate: 'public' }]);

  routes.push(['GET', '/api/v1/categories', () => ok({
    items: [...ctx.db.categories.values()].sort((a, b) => Number(a.id) - Number(b.id)),
  }), { rate: 'public' }]);

  // ------------------------------------------------------------------
  // Регистрация (FR-AUTH-02…05)
  // ------------------------------------------------------------------
  routes.push(['POST', '/api/v1/auth/register', (r) => {
    const b = r.body ?? {};
    if (ctx.db.settings.get('registration_open') === false) throw forbidden('REGISTRATION_CLOSED', 'регистрация временно закрыта');
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!/^[\w.+-]+@[\w-]+\.[\w.-]{2,}$/.test(email)) throw bad('некорректный email');
    const nickname = String(b.nickname ?? '').trim();
    if (!/^[A-Za-z0-9_]{3,32}$/.test(nickname)) throw bad('никнейм: 3–32 символа, латиница/цифры/подчёркивание');
    const policyProblem = C.passwordPolicy(String(b.password ?? ''));
    if (policyProblem) throw bad('слабый пароль', { problems: [policyProblem] });
    if (b.password !== b.password_confirm) throw bad('пароли не совпадают');
    if (!b.accept_terms) throw bad('необходимо принять условия сервиса');
    if (!b.is_18plus) throw bad('сервис доступен только пользователям 18+');
    const country = String(b.country_code ?? '').toUpperCase();
    const countryRow = ctx.db.countries.get(country);
    if (!countryRow) throw bad('выберите страну');
    const cityId = Number(b.city_id ?? 0);
    const city = ctx.db.cities.get(cityId);
    if (!city || city.country !== country) throw bad('выберите город в указанной стране');
    if (ctx.db.usersByMail.has(C.blindIndex(email))) throw conflict('EMAIL_TAKEN', 'email уже зарегистрирован');
    if (ctx.db.usersByNick.has(nickname.toLowerCase())) throw conflict('NICKNAME_TAKEN', 'никнейм занят');

    const id = C.newId('usr');
    ctx.db.userSeq += 1;
    const path = C.depositPath(ctx.db.userSeq);
    const now = new Date().toISOString();
    const user = {
      id, email_ct: C.encrypt(C.DOMAINS.pii, id, email), email_idx: C.blindIndex(email), email,
      nickname, password_hash: C.hashPassword(String(b.password)), role: 'buyer',
      country, city_id: cityId, locale: b.locale || 'ru', theme: 'dark',
      status: 'pending_contact', seq: ctx.db.userSeq, deposit_path: path,
      deposit_address: C.addressForPath(path), is_18plus: true, risk_score: 0,
      tg_id: null, tg_username: null, referral_code: String(b.referral_code ?? '') || null,
      created_at: now, last_login_at: null, warmup_until: null, factors: {},
    };
    ctx.db.users.set(id, user);
    ctx.db.usersByNick.set(nickname.toLowerCase(), id);
    ctx.db.usersByMail.set(user.email_idx, id);
    ctx.db.ledger.ensure('user', id, 'SOL');
    ctx.db.ledger.ensure('user', id, 'STARS');
    ctx.db.notifications.set(id, []);

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const enrollment = {
      id: C.newId('enr'), user_id: id, step: 'contact_sent',
      code_hash: C.tokenHash(code), attempts: 0,
      created_at: now, expires_at: new Date(Date.now() + 10 * MINUTE).toISOString(),
    };
    ctx.db.enrollments.set(enrollment.id, enrollment);
    recordAuthEvent(ctx, id, 'register', r.req, `country=${country}`, 0);
    audit(ctx, r.req, user, 'user.register', 'user', id, '', '', null,
      { nickname, country, city_id: cityId });
    notify(ctx, id, 'security.register', 'Регистрация SITEE',
      'Подтвердите контактные данные кодом из сообщения. Код действителен 10 минут.',
      `register:${enrollment.id}`, { enrollment_id: enrollment.id });

    return created({
      enrollment_id: enrollment.id, status: enrollment.step, expires_at: enrollment.expires_at,
      delivery: { channel: 'telegram_bot', ttl_min: 10, attempts_left: 3 },
      ...(CONFIG.env !== 'prod' ? { dev_code: code } : {}),
    });
  }, { rate: 'register' }]);

  routes.push(['POST', '/api/v1/auth/verify-contact', (r) => {
    const b = r.body ?? {};
    const enrollment = ctx.db.enrollments.get(String(b.enrollment_id ?? ''));
    if (!enrollment) throw notFound('заявка на регистрацию не найдена');
    if (new Date(enrollment.expires_at) < new Date()) throw conflict('ENROLLMENT_EXPIRED', 'заявка истекла, зарегистрируйтесь заново');
    if (enrollment.step !== 'contact_sent') throw conflict('INVALID_STATE', 'контакт уже подтверждён');
    enrollment.attempts += 1;
    if (enrollment.attempts > 5) throw tooMany('превышено число попыток подтверждения', 900);
    if (C.tokenHash(String(b.code ?? '').trim()) !== enrollment.code_hash) throw bad('код подтверждения неверен');
    const user = ctx.db.users.get(enrollment.user_id);
    enrollment.step = 'contact_verified';
    user.status = 'pending_2fa';
    recordAuthEvent(ctx, user.id, 'contact_verified', r.req, '', 0);
    return ok({ enrollment_id: enrollment.id, status: enrollment.step, next: '2fa_setup', factor: 'login' });
  }, { rate: 'auth' }]);

  routes.push(['POST', '/api/v1/auth/2fa/setup', (r) => {
    const b = r.body ?? {};
    const factorName = String(b.factor ?? 'login');
    if (!['login', 'ops'].includes(factorName)) throw bad('factor должен быть login или ops');
    let user = null;
    let enrollment = null;
    if (b.enrollment_id) {
      enrollment = ctx.db.enrollments.get(String(b.enrollment_id));
      if (!enrollment) throw notFound('заявка не найдена');
      user = ctx.db.users.get(enrollment.user_id);
      if (!user || user.status !== 'pending_2fa') throw conflict('INVALID_STATE', 'сначала подтвердите контакт');
    } else {
      const auth = requireAuth(ctx, r.req);
      user = auth.user;
    }
    if (user.factors?.[factorName]?.status === 'active') throw conflict('ALREADY_ENROLLED', 'фактор уже активен');
    const secret = C.newTotpSecret();
    const secretB32 = C.secretBase32(secret);
    const label = factorName === 'ops' ? 'операции' : 'вход';
    const otpURL = C.otpAuthUrl('SITEE', user.nickname, secretB32, `SITEE (${label})`);
    user.factors ??= {};
    user.factors[factorName] = {
      name: factorName, status: 'pending',
      secret_ct: C.encrypt(C.DOMAINS.totp, `${user.id}:${factorName}`, secret.toString('base64')),
      secret_b32: secretB32, backup_hashes: [], backup_used: {}, used_codes: {},
      otpauth_url: otpURL, enrolled_at: null, pending_codes: [],
    };
    audit(ctx, r.req, user, '2fa.setup', 'user', user.id, `factor=${factorName}`, '', null, { factor: factorName });
    return ok({
      factor: factorName, secret_b32: secretB32, otpauth_url: otpURL,
      label: `SITEE (${label})`, issuer: 'SITEE', algorithm: 'SHA1',
      digits: C.TOTP_DIGITS, period: C.TOTP_PERIOD,
      expires_at: new Date(Date.now() + 15 * MINUTE).toISOString(),
      hint: 'Отсканируйте QR в Google Authenticator или введите секрет вручную. Для активации потребуется два верных кода подряд.',
      ...(CONFIG.env !== 'prod' ? { dev_codes: [C.generateTotp(secret), C.generateTotp(secret, new Date(Date.now() + 30000))] } : {}),
    });
  }, { rate: '2fa' }]);

  routes.push(['POST', '/api/v1/auth/2fa/activate', (r) => {
    const b = r.body ?? {};
    const factorName = String(b.factor ?? 'login');
    let user = null;
    if (b.enrollment_id) {
      const enrollment = ctx.db.enrollments.get(String(b.enrollment_id));
      if (!enrollment) throw notFound('заявка не найдена');
      user = ctx.db.users.get(enrollment.user_id);
      if (enrollment.step === 'contact_verified' && factorName === 'login') enrollment.step = 'complete';
    } else {
      const auth = requireAuth(ctx, r.req);
      user = auth.user;
    }
    const factor = user.factors?.[factorName];
    if (!factor || factor.status === 'active') throw conflict('INVALID_STATE', 'фактор не ожидает активации');
    const code1 = String(b.code1 ?? b.code ?? '').trim();
    let code2 = String(b.code2 ?? '').trim();
    if (!code1) throw bad('укажите код из приложения 2FA');
    if (!code2) code2 = code1; // один код в пределах окна допустим
    // Фактор ещё в статусе pending — проверяем коды напрямую по секрету.
    if (!verifyPendingCode(factor, code1)) throw bad('первый код неверен');
    if (code2 !== code1 && !verifyPendingCode(factor, code2)) {
      throw bad('второй код неверен (дождитесь следующего периода)');
    }
    const backup = C.backupCodes(10);
    factor.status = 'active';
    factor.enrolled_at = new Date().toISOString();
    factor.backup_hashes = backup.hashes;
    factor.backup_used = {};
    factor.pending_codes = [];
    if (factorName === 'login' && user.status !== 'active') user.status = 'active';
    guardOk(ctx, `2fa-enroll:${user.id}:${factorName}`);
    recordAuthEvent(ctx, user.id, '2fa_enrolled', r.req, `factor=${factorName}`, 0);
    audit(ctx, r.req, user, '2fa.activate', 'user', user.id, `factor=${factorName}`, factorName, null,
      { factor: factorName, backup_codes: backup.codes.length });
    const label = factorName === 'ops' ? 'операции' : 'вход';
    const resp = {
      status: 'active', factor: factorName, backup_codes: backup.codes,
      warning: 'Сохраните backup-коды: они показываются один раз.',
    };
    if (factorName === 'login' && user.status === 'active') {
      const sess = issueSession(ctx, user, { ip: clientIp(r.req), ua: r.req.headers['user-agent'] ?? '' });
      resp.access_token = sess.access_token;
      resp.refresh_token = sess.refresh_token;
      resp.expires_in = sess.expires_in;
      resp.user = userDto(ctx, user);
      resp.redirect = ['superadmin', 'arbiter', 'moderator'].includes(user.role) ? '/admin' : '/shops';
      resp.next_step = user.factors?.ops?.status === 'active' ? 'complete' : 'enroll_ops';
    }
    notify(ctx, user.id, 'security.2fa_enrolled', '2FA настроен',
      `Фактор «${label}» активирован. Если это были не вы — немедленно смените пароль.`,
      `2fa:${factorName}:${user.id}`);
    return ok(resp);
  }, { rate: '2fa' }]);

  // ------------------------------------------------------------------
  // Вход
  // ------------------------------------------------------------------
  routes.push(['POST', '/api/v1/auth/login', (r) => {
    const b = r.body ?? {};
    const identifier = String(b.identifier ?? b.email ?? b.nickname ?? '').trim();
    const ip = clientIp(r.req);
    if (!identifier) throw bad('укажите email или никнейм');
    const guardErr = guardCheck(ctx, `login:${identifier}`) ?? guardCheck(ctx, `login:ip:${ip}`);
    if (guardErr) {
      recordAuthEvent(ctx, '', 'login_blocked', r.req, guardErr.message, 800);
      throw guardErr;
    }
    const limit = allow(`rl:auth:${ip}`, 'auth');
    if (!limit.allowed) throw tooMany('слишком много попыток входа', limit.retryAfter);

    const user = findUserByIdentifier(ctx, identifier);
    const captchaNeeded = (ctx.guards.get(`login:${identifier}`)?.captcha) || (ctx.guards.get(`login:ip:${ip}`)?.captcha);
    if (captchaNeeded && !b.captcha_token) {
      throw new ApiError(428, 'CAPTCHA_REQUIRED', 'требуется подтверждение captcha', { captcha_site_key: CONFIG.captchaSiteKey });
    }
    if (!user || !C.verifyPassword(String(b.password ?? ''), user.password_hash)) {
      guardFail(ctx, `login:${identifier}`, ip);
      guardFail(ctx, `login:ip:${ip}`, ip);
      recordAuthEvent(ctx, user?.id ?? '', 'login_failed', r.req, 'bad_credentials', 400);
      audit(ctx, r.req, user ?? null, 'auth.login_failed', 'user', user?.id ?? '', 'bad_credentials', '', null, null);
      throw unauthorized('неверный email/никнейм или пароль');
    }
    if (user.status === 'banned' || user.status === 'suspended') {
      recordAuthEvent(ctx, user.id, 'login_denied', r.req, `status=${user.status}`, 700);
      throw forbidden('ACCOUNT_RESTRICTED', `аккаунт ${user.status === 'banned' ? 'заблокирован' : 'ограничен'}`);
    }
    if (user.status === 'pending_contact' || user.status === 'pending_2fa') {
      const enrollment = [...ctx.db.enrollments.values()].find((e) => e.user_id === user.id);
      throw conflict('ENROLLMENT_INCOMPLETE', 'регистрация не завершена: подтвердите контакт и настройте 2FA',
        { enrollment_id: enrollment?.id ?? null, step: enrollment?.step ?? null });
    }
    guardOk(ctx, `login:${identifier}`);
    guardOk(ctx, `login:ip:${ip}`);

    const sessionId = C.newId('ses');
    ctx.db.sessions.set(sessionId, {
      id: sessionId, user_id: user.id, device_id: b.device?.device_id ?? '',
      status: 'pending_2fa_login', factor_ops_ok: false, factor_ops_at: null,
      ip, geo: user.country, ua: r.req.headers['user-agent'] ?? '',
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 10 * MINUTE).toISOString(),
    });
    recordAuthEvent(ctx, user.id, 'login_challenge', r.req, 'factor=login', 0);
    return ok({
      session_id: sessionId, challenge: 'totp_login', factor: 'login', trusted_device: false,
      expires_at: new Date(Date.now() + 10 * MINUTE).toISOString(),
      enrollment_hint: user.factors?.login?.status === 'active',
      ...(CONFIG.env !== 'prod' ? { dev_hint: 'код доступен в /api/v1/dev/credentials' } : {}),
    });
  }, { rate: 'auth' }]);

  routes.push(['POST', '/api/v1/auth/2fa/verify', (r) => {
    const b = r.body ?? {};
    const code = String(b.code ?? b.backup_code ?? '').trim();
    const session = ctx.db.sessions.get(String(b.session_id ?? ''));
    if (!session || !code) throw bad('укажите session_id и код');
    const user = ctx.db.users.get(session.user_id);
    if (!user) throw notFound('пользователь не найден');
    if (!['pending_2fa_login', 'pending_2fa_ops'].includes(session.status)) {
      throw conflict('INVALID_STATE', 'сессия не ожидает подтверждения 2FA');
    }
    if (new Date(session.expires_at) < new Date()) throw unauthorized('сессия истекла, войдите заново');
    const factorName = b.factor || (session.status === 'pending_2fa_ops' ? 'ops' : 'login');
    const res = verifyFactor(ctx, user, factorName, code);
    if (!res.ok) {
      const g = guardFail(ctx, `2fa:${user.id}:${factorName}`, clientIp(r.req));
      recordAuthEvent(ctx, user.id, '2fa_failed', r.req, `factor=${factorName}`, 500);
      throw new ApiError(401, 'TOTP_INVALID', 'неверный код 2FA', { factor: factorName, fails: g.fails, captcha: !!g.captcha });
    }
    guardOk(ctx, `2fa:${user.id}:${factorName}`);
    session.status = 'active';
    session.expires_at = new Date(Date.now() + CONFIG.refreshTtl * 1000).toISOString();
    if (factorName === 'ops') {
      session.factor_ops_ok = true;
      session.factor_ops_at = new Date().toISOString();
    }
    user.last_login_at = new Date().toISOString();
    const issued = issueSession(ctx, user, {
      factorOps: factorName === 'ops', deviceId: session.device_id, ip: session.ip, ua: session.ua,
    });
    ctx.db.sessions.delete(session.id);
    recordAuthEvent(ctx, user.id, 'login_ok', r.req, `factor=${factorName}`, 0);
    audit(ctx, r.req, user, 'auth.login', 'session', issued.session_id, '', factorName, null,
      { factor: factorName, ip: session.ip });
    return ok({
      access_token: issued.access_token, refresh_token: issued.refresh_token, expires_in: issued.expires_in,
      user: userDto(ctx, user),
      redirect: ['superadmin', 'arbiter', 'moderator'].includes(user.role) ? '/admin' : '/shops',
      session_id: issued.session_id,
    });
  }, { rate: '2fa' }]);

  routes.push(['POST', '/api/v1/auth/refresh', (r) => {
    const token = String(r.body?.refresh_token ?? '');
    if (!token) throw bad('укажите refresh_token');
    const hash = C.tokenHash(token);
    const stored = ctx.db.refresh.get(hash);
    if (!stored) throw unauthorized('refresh_token недействителен');
    if (new Date(stored.expires_at) < new Date()) {
      ctx.db.refresh.delete(hash);
      throw unauthorized('refresh_token истёк');
    }
    // FR-AUTH-07: повторное использование refresh-токена отзывает всю семью + сессию.
    if (stored.used_at) {
      for (const [h, row] of ctx.db.refresh) {
        if (row.family_id === stored.family_id) ctx.db.refresh.delete(h);
      }
      const familySession = ctx.db.sessions.get(stored.session_id);
      if (familySession) {
        familySession.status = 'revoked';
        familySession.revoke_reason = 'refresh token reuse';
        ctx.db.sessions.delete(familySession.id);
      }
      recordAuthEvent(ctx, familySession?.user_id ?? '', 'refresh_reuse', r.req,
        'семья токенов отозвана', 500);
      ctx.securityEvent('refresh_reuse', { ip: clientIp(r.req) }, 500);
      throw unauthorized('refresh-токен уже использован; сессии отозваны');
    }
    const session = ctx.db.sessions.get(stored.session_id);
    const user = session ? ctx.db.users.get(session.user_id) : null;
    if (!user || user.status !== 'active' || !session || session.status !== 'active') {
      ctx.db.refresh.delete(hash);
      throw unauthorized('сессия закрыта');
    }
    // Ротация: старая ссылка помечается использованной, новая — та же сессия и семья.
    stored.used_at = new Date().toISOString();
    const issued = rotateSession(ctx, session, user, { familyId: stored.family_id });
    return ok({
      access_token: issued.access_token, refresh_token: issued.refresh_token,
      expires_in: issued.expires_in, token_type: 'Bearer',
    });
  }, { rate: 'auth' }]);

  routes.push(['POST', '/api/v1/auth/logout', (r) => {
    const auth = requireAuth(ctx, r.req);
    auth.session.status = 'revoked';
    for (const [hash, row] of ctx.db.refresh) {
      if (row.session_id === auth.session.id) ctx.db.refresh.delete(hash);
    }
    ctx.db.sessions.delete(auth.session.id);
    recordAuthEvent(ctx, auth.user.id, 'logout', r.req, '', 0);
    return ok({ status: 'ok' });
  }, { rate: 'auth' }]);

  routes.push(['POST', '/api/v1/auth/telegram/init-data', (r) => {
    // Telegram Mini App: в preview проверяем HMAC только если задан токен бота,
    // иначе принимаем dev-формат {id, username, first_name}.
    const raw = String(r.body?.init_data ?? '');
    const botToken = process.env.TG_BOT_TOKEN ?? '';
    let tg = null;
    if (botToken) {
      const params = new URLSearchParams(raw);
      const hash = params.get('hash');
      params.delete('hash');
      const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
      const secret = C.hmacSha256(Buffer.from('WebAppData'), botToken);
      const calc = C.hmacSha256(secret, dataCheck).toString('hex');
      if (!hash || calc !== hash) throw forbidden('TG_SIGNATURE_INVALID', 'подпись Telegram недействительна');
      tg = JSON.parse(params.get('user') ?? 'null');
    } else {
      try {
        tg = JSON.parse(raw);
      } catch {
        throw bad('в dev-режиме init_data — это JSON: {"id":123,"username":"nick","first_name":"Имя"}');
      }
      if (!tg?.id) throw bad('укажите id пользователя Telegram');
    }
    if (!tg?.id) throw bad('не удалось разобрать данные Telegram');
    let user = [...ctx.db.users.values()].find((u) => u.tg_id === Number(tg.id));
    if (!user) {
      const nickname = String(tg.username ?? `tg${tg.id}`).slice(0, 32);
      const id = C.newId('usr');
      ctx.db.userSeq += 1;
      const path = C.depositPath(ctx.db.userSeq);
      const email = `tg${tg.id}@telegram.local`;
      user = {
        id, email_ct: C.encrypt(C.DOMAINS.pii, id, email), email_idx: C.blindIndex(email), email,
        nickname, password_hash: '', role: 'buyer', country: 'RU', city_id: 1, locale: 'ru', theme: 'dark',
        status: 'active', seq: ctx.db.userSeq, deposit_path: path, deposit_address: C.addressForPath(path),
        is_18plus: true, risk_score: 0, tg_id: Number(tg.id), tg_username: tg.username ?? null,
        created_at: new Date().toISOString(), last_login_at: new Date().toISOString(), warmup_until: null,
        factors: {},
      };
      ctx.db.users.set(id, user);
      ctx.db.usersByNick.set(nickname.toLowerCase(), id);
      ctx.db.usersByMail.set(user.email_idx, id);
      ctx.db.ledger.ensure('user', id, 'SOL');
      ctx.db.ledger.ensure('user', id, 'STARS');
      ctx.db.notifications.set(id, []);
      audit(ctx, r.req, user, 'user.register_tg', 'user', id, '', '', null, { tg_id: tg.id });
    } else {
      user.last_login_at = new Date().toISOString();
    }
    const issued = issueSession(ctx, user, { ip: clientIp(r.req), ua: r.req.headers['user-agent'] ?? '' });
    recordAuthEvent(ctx, user.id, 'login_tg', r.req, '', 0);
    return ok({
      access_token: issued.access_token, refresh_token: issued.refresh_token, expires_in: issued.expires_in,
      user: userDto(ctx, user), redirect: '/shops', session_id: issued.session_id,
      two_fa_required: user.factors?.login?.status !== 'active',
      hint: 'Аккаунт Telegram привязан. Настройте двойной 2FA для платежей и вывода.',
    });
  }, { rate: 'auth' }]);

  routes.push(['GET', '/api/v1/auth/me', (r) => {
    const auth = requireAuth(ctx, r.req);
    return ok(userDto(ctx, auth.user));
  }, { rate: 'public' }]);

  routes.push(['GET', '/api/v1/auth/sessions', (r) => {
    const auth = requireAuth(ctx, r.req);
    const items = [...ctx.db.sessions.values()]
      .filter((s) => s.user_id === auth.user.id)
      .map((s) => ({
        id: s.id, status: s.status, ip: s.ip.replace(/(\d+)\.\d+$/, '$1.*'), geo: s.geo ?? '',
        ua: s.ua ?? '', device_id: s.device_id ?? '', created_at: s.created_at, expires_at: s.expires_at,
        current: s.id === auth.session.id, active: s.status === 'active' && new Date(s.expires_at) > new Date(),
        factor_ops_ok: !!s.factor_ops_ok,
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return ok({ items });
  }, { rate: 'public' }]);

  routes.push(['DELETE', '/api/v1/auth/sessions/:id', (r) => {
    const auth = requireAuth(ctx, r.req);
    const session = ctx.db.sessions.get(r.params.id);
    if (!session || session.user_id !== auth.user.id) throw notFound('сессия не найдена');
    session.status = 'revoked';
    for (const [hash, row] of ctx.db.refresh) {
      if (row.session_id === session.id) ctx.db.refresh.delete(hash);
    }
    ctx.db.sessions.delete(session.id);
    audit(ctx, r.req, auth.user, 'session.revoke', 'session', session.id, '', '', null, null);
    notify(ctx, auth.user.id, 'security.session_revoked', 'Сессия завершена',
      'Устройство удалено из списка активных сессий', `session:${session.id}:${Date.now()}`);
    return ok({ status: 'ok' });
  }, { rate: 'write' }]);

  routes.push(['POST', '/api/v1/auth/password/change', (r) => {
    const auth = requireAuth(ctx, r.req);
    const b = r.body ?? {};
    requireOps(ctx, r.req, auth, 'password_change', { totpCode: String(b.totp_code ?? '') });
    if (!C.verifyPassword(String(b.current_password ?? ''), auth.user.password_hash)) throw forbidden('PASSWORD_MISMATCH', 'текущий пароль неверен');
    const changeProblem = C.passwordPolicy(String(b.new_password ?? ''));
    if (changeProblem) throw bad('слабый пароль', { problems: [changeProblem] });
    if (b.new_password !== b.new_password_confirm) throw bad('пароли не совпадают');
    auth.user.password_hash = C.hashPassword(String(b.new_password));
    // Все прочие сессии отзываются (docs/security.md §5.4).
    let revoked = 0;
    for (const [id, s] of ctx.db.sessions) {
      if (s.user_id === auth.user.id && id !== auth.session.id) {
        s.status = 'revoked';
        ctx.db.sessions.delete(id);
        revoked += 1;
      }
    }
    audit(ctx, r.req, auth.user, 'user.password_change', 'user', auth.user.id, '', 'ops', null, { sessions_revoked: revoked });
    notify(ctx, auth.user.id, 'security.password_changed', 'Пароль изменён',
      `Другие сессии завершены (${revoked}). Если это были не вы — обратитесь в поддержку.`,
      `pwd:${Date.now()}`);
    return ok({ status: 'ok', sessions_revoked: revoked });
  }, { rate: 'auth' }]);

  routes.push(['GET', '/api/v1/auth/events', (r) => {
    const auth = requireRole(ctx, r.req, 'superadmin', 'moderator', 'arbiter');
    const limit = Math.min(200, Number(r.query.limit ?? 50));
    const items = ctx.db.authEvents.slice(-limit).reverse();
    return ok({ items, total: ctx.db.authEvents.length });
  }, { rate: 'admin' }]);

  routes.push(['GET', '/api/v1/notifications', (r) => {
    const auth = requireAuth(ctx, r.req);
    const list = (ctx.db.notifications.get(auth.user.id) ?? []).slice().reverse();
    const unread = list.filter((n) => !n.read).length;
    return ok({ items: list.slice(0, 100), unread, total: list.length });
  }, { rate: 'public' }]);

  routes.push(['POST', '/api/v1/notifications/:id/read', (r) => {
    const auth = requireAuth(ctx, r.req);
    const list = ctx.db.notifications.get(auth.user.id) ?? [];
    const target = list.find((n) => n.id === r.params.id);
    if (!target) throw notFound('уведомление не найдено');
    target.read = true;
    return ok({ id: target.id, read: true, unread: list.filter((n) => !n.read).length });
  }, { rate: 'write' }]);

  routes.push(['POST', '/api/v1/notifications/read-all', (r) => {
    const auth = requireAuth(ctx, r.req);
    const list = ctx.db.notifications.get(auth.user.id) ?? [];
    for (const n of list) n.read = true;
    return ok({ read: list.length, unread: 0 });
  }, { rate: 'write' }]);

  return routes;
}
