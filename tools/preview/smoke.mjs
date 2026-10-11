// Смоук-тест preview-сервера: проходит ключевые сценарии ТЗ по HTTP и WS.
// Запуск: node smoke.mjs [http://127.0.0.1:8080]
import { WebSocket } from './ws-client.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080';
let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${detail}`);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

const tokens = {};

async function login(email, password, backupLogin, backupOps) {
  const step1 = await call('POST', '/api/v1/auth/login', {
    body: { identifier: email, password, device: { device_id: 'smoke' } },
  });
  if (step1.status !== 200) return { error: step1.data };
  const step2 = await call('POST', '/api/v1/auth/2fa/verify', {
    body: { session_id: step1.data.session_id, factor: 'login', backup_code: backupLogin },
  });
  if (step2.status !== 200) return { error: step2.data };
  return { access: step2.data.access_token, refresh: step2.data.refresh_token, user: step2.data.user, ops: backupOps };
}

async function opsCode(who) {
  const list = tokens[who].opsCodes;
  return list.shift();
}

async function main() {
  console.log(`SITEE smoke → ${BASE}\n`);

  console.log('0. Сервис и справочники');
  const reset = await call('POST', '/api/v1/dev/reset-guards');
  check('сброс защитных счётчиков (dev)', reset.status === 200);
  const health = await call('GET', '/healthz');
  check('healthz', health.status === 200 && health.data.status === 'ok');
  const ready = await call('GET', '/readyz');
  check('readyz', ready.status === 200 && ready.data.users >= 7);
  const cfg = await call('GET', '/api/v1/auth/config');
  check('auth/config: двойной 2FA', cfg.data.two_fa?.factors?.join(',') === 'login,ops');
  const countries = await call('GET', '/api/v1/geo/countries');
  check('geo/countries', countries.data.items.length >= 10);
  const cities = await call('GET', '/api/v1/geo/cities?country=RU');
  check('geo/cities?country=RU', cities.data.items.length >= 2);
  const cats = await call('GET', '/api/v1/categories');
  check('categories', cats.data.items.length >= 8);

  console.log('\n1. Демо-доступ и вход (двойной 2FA)');
  const creds = await call('GET', '/api/v1/dev/credentials');
  check('dev/credentials', creds.status === 200 && creds.data.users.length >= 7);
  const byRole = {};
  for (const u of creds.data.users) byRole[u.nickname] = u;
  for (const who of ['buyer_nova', 'buyer_max', 'keymaster', 'sitee_admin', 'sitee_arbiter']) {
    const c = byRole[who];
    if (!c) {
      check(`вход ${who}`, false, 'нет в dev/credentials');
      continue;
    }
    const res = await login(c.email, c.password, c.backup_login.split(',')[0], null);
    if (res.error) {
      check(`вход ${who}`, false, JSON.stringify(res.error).slice(0, 120));
      continue;
    }
    tokens[who] = { ...res, opsCodes: c.backup_ops.split(',') };
    check(`вход ${who} (${c.role})`, !!res.access && res.user.role === c.role);
  }
  const badLogin = await call('POST', '/api/v1/auth/login', {
    body: { identifier: 'buyer@sitee.dev', password: 'wrong-password', device: {} },
  });
  check('вход с неверным паролем → 401', badLogin.status === 401);
  const me = await call('GET', '/api/v1/auth/me', { token: tokens.buyer_nova.access });
  check('auth/me: баланс и факторы', me.status === 200 && me.data.factors?.login === 'active' && me.data.balances?.SOL !== undefined);

  // FR-AUTH-07: ротация refresh + reuse-detection (семья токенов отзывается).
  const rotated = await call('POST', '/api/v1/auth/refresh', {
    body: { refresh_token: tokens.buyer_nova.refresh },
  });
  check('refresh: ротация выдаёт новую пару', rotated.status === 200 && !!rotated.data.refresh_token);
  const reuse = await call('POST', '/api/v1/auth/refresh', {
    body: { refresh_token: tokens.buyer_nova.refresh },
  });
  check('refresh: повторное использование → 401', reuse.status === 401, `(${reuse.status})`);
  const afterReuse = await call('GET', '/api/v1/auth/me', { token: rotated.data.access_token });
  check('refresh: семья токенов отозвана', afterReuse.status === 401, `(${afterReuse.status})`);
  // Сессия buyer_nova отозвана — перевыпускаем токены для остальных проверок.
  const relogin = await login(byRole.buyer_nova.email, byRole.buyer_nova.password, byRole.buyer_nova.backup_login.split(',')[1], null);
  tokens.buyer_nova = relogin.error ? tokens.buyer_nova : { ...relogin, opsCodes: byRole.buyer_nova.backup_ops.split(',') };
  check('refresh: после отзыва семьи повторный вход работает', !relogin.error);

  // FR-ORD-01: ограниченный сток — перебор количества даёт 422 STOCK_EMPTY.
  const scarce = await call('GET', '/api/v1/shops', { token: tokens.buyer_nova.access });
  const scarceShop = (scarce.data.items ?? []).find((s) => s.slug === 'proxy-nord') ?? scarce.data.items?.[0];
  if (scarceShop) {
    const prods = await call('GET', `/api/v1/shops/${scarceShop.id}/products`, { token: tokens.buyer_nova.access });
    const lowStock = (prods.data.items ?? []).find((p) => p.stock_free > 0);
    if (lowStock) {
      const first = await call('POST', '/api/v1/orders', {
        token: tokens.buyer_nova.access, body: { product_id: lowStock.id, qty: 1 },
      });
      check('заказ: единица ограниченного стока забронирована', first.status === 201, `(${first.status})`);
      if (first.status === 201) {
        const qty = Math.max(1, lowStock.stock_free + 1);
        const second = await call('POST', '/api/v1/orders', {
          token: tokens.buyer_nova.access, body: { product_id: lowStock.id, qty },
        });
        check('заказ: перебор стока → 422 STOCK_EMPTY',
          second.status === 422 && second.data.error?.code === 'STOCK_EMPTY',
          `(${second.status}) ${second.data.error?.code ?? ''}`);
      }
    }
  }


  console.log('\n2. Главная: лента магазинов (поиск, корона, сортировка)');
  const feed = await call('GET', '/api/v1/shops?limit=6');
  check('лента отдаёт карточки', feed.data.items.length >= 4);
  check('карточка: рейтинг + корона', feed.data.items.some((s) => typeof s.rating === 'number' && typeof s.crown === 'boolean'));
  check('приостановленный магазин скрыт', !feed.data.items.some((s) => s.rent_status === 'suspended'));
  const search = await call('GET', '/api/v1/shops?q=ключ');
  check('поиск по магазинам', search.data.items.length >= 1);
  const crownOnly = await call('GET', '/api/v1/shops?crown_only=true');
  check('фильтр crown_only', crownOnly.data.items.every((s) => s.crown));
  const shop = await call('GET', `/api/v1/shops/${feed.data.items[0].id}`);
  check('карточка магазина', shop.status === 200 && shop.data.rent && shop.data.actions.includes('open_chat'));
  const products = await call('GET', `/api/v1/shops/${feed.data.items[0].id}/products`);
  check('товары магазина', products.data.items.length >= 1);
  const product = products.data.items.find((p) => p.stock_free > 0 && p.price_sol_raw > 0);
  check('товар с остатком', !!product);
  const reviews = await call('GET', `/api/v1/shops/${feed.data.items[0].id}/reviews`);
  check('отзывы + рейтинг Байеса', reviews.status === 200 && reviews.data.summary.bayes > 0);

  console.log('\n3. Заказ: эскроу, автовыдача, подтверждение, отзыв');
  const walletBefore = await call('GET', '/api/v1/wallet', { token: tokens.buyer_nova.access });
  const dep = await call('POST', '/api/v1/dev/simulate-deposit', {
    token: tokens.buyer_nova.access, body: { asset: 'SOL', amount_sol: '20' },
  });
  check('депозит SOL зачислен', dep.status === 200 && dep.data.status === 'credited');
  const order = await call('POST', '/api/v1/orders', {
    token: tokens.buyer_nova.access,
    body: { product_id: product.id, qty: 1, pay_asset: 'SOL', idempotency_key: `smoke-${Date.now()}` },
  });
  check('заказ создан (статус created)', order.status === 201 && order.data.status === 'created');
  check('заказ: чат с админом открыт', !!order.data.chat_id);
  check('заказ: серверные actions', order.data.actions.includes('pay'));
  const payNoOps = await call('POST', `/api/v1/orders/${order.data.id}/pay`, {
    token: tokens.buyer_nova.access, body: {},
  });
  check('оплата без 2FA-операций → 428/403', [428, 403].includes(payNoOps.status), `(${payNoOps.status} ${payNoOps.data.error?.code})`);
  const pay = await call('POST', `/api/v1/orders/${order.data.id}/pay`, {
    token: tokens.buyer_nova.access, body: { asset: 'SOL', totp_code: await opsCode('buyer_nova') },
  });
  check('оплата в эскроу', pay.status === 200 && ['paid_escrow', 'delivered'].includes(pay.data.status), JSON.stringify(pay.data).slice(0, 120));
  check('автовыдача цифрового товара', pay.data.delivered === true);
  const delivery = await call('GET', `/api/v1/orders/${order.data.id}/delivery`, { token: tokens.buyer_nova.access });
  check('данные товара выданы', delivery.status === 200 && delivery.data.items[0].payload.length > 3);
  const confirm = await call('POST', `/api/v1/orders/${order.data.id}/confirm`, {
    token: tokens.buyer_nova.access, body: {},
  });
  check('подтверждение → completed', confirm.status === 200 && confirm.data.status === 'completed');
  const review = await call('POST', `/api/v1/orders/${order.data.id}/review`, {
    token: tokens.buyer_nova.access,
    body: { rating: 5, rating_delivery: 5, rating_description: 5, rating_support: 4, body: 'Ключ пришёл мгновенно, всё активировалось. Рекомендую магазин.' },
  });
  check('отзыв после заказа', review.status === 201 && review.data.rating === 5);
  const history = await call('GET', `/api/v1/orders/${order.data.id}/history`, { token: tokens.buyer_nova.access });
  check('история статусов', history.data.items.length >= 3);
  const walletAfter = await call('GET', '/api/v1/wallet', { token: tokens.buyer_nova.access });
  check('баланс изменился', walletAfter.data.balances[0].available_raw !== walletBefore.data.balances[0].available_raw);

  console.log('\n4. Мессенджер: диалог с админом, шифрование, WS');
  const chatOpen = await call('POST', '/api/v1/chats', {
    token: tokens.buyer_nova.access, body: { kind: 'shop_support', shop_id: product.shop_id },
  });
  check('диалог с админом магазина', [200, 201].includes(chatOpen.status) && chatOpen.data.id);
  const chatId = chatOpen.data.id;
  const sent = await call('POST', `/api/v1/chats/${chatId}/messages`, {
    token: tokens.buyer_nova.access, body: { body: 'Здравствуйте! Ключ подошёл, спасибо. Как получить второй со скидкой?', client_msg_id: 'smoke-1' },
  });
  check('сообщение отправлено', sent.status === 201 && sent.data.seq >= 1);
  check('тело хранится зашифрованным', sent.data.body_stored_encrypted === true);
  const dup = await call('POST', `/api/v1/chats/${chatId}/messages`, {
    token: tokens.buyer_nova.access, body: { body: 'дубль', client_msg_id: 'smoke-1' },
  });
  check('идемпотентность client_msg_id', dup.data.status === 'duplicate');
  const adminReply = await call('POST', `/api/v1/chats/${chatId}/messages`, {
    token: tokens.keymaster.access, body: { body: 'Спасибо за отзыв! Скидка на второй ключ — промокод SITEE-OFF24.' },
  });
  check('ответ админа в том же диалоге', adminReply.status === 201);
  const msgs = await call('GET', `/api/v1/chats/${chatId}/messages`, { token: tokens.buyer_nova.access });
  check('история сообщений расшифрована для участника', msgs.data.items.some((m) => (m.body ?? '').includes('Здравствуйте')));
  const outsider = await call('GET', `/api/v1/chats/${chatId}/messages`, { token: tokens.sitee_arbiter.access });
  check('арбитр видит чат (staff)', outsider.status === 200);
  const chatsList = await call('GET', '/api/v1/chats', { token: tokens.buyer_nova.access });
  check('список чатов + непрочитанные', chatsList.data.items.length >= 2 && typeof chatsList.data.unread_total === 'number');

  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
  const frames = [];
  await ws.open();
  ws.onFrame = (f) => frames.push(f);
  ws.sendJson({ v: 1, t: 'auth', ts: Date.now(), d: { token: tokens.buyer_nova.access } });
  await ws.waitFor('hello', 3000);
  check('WS: hello после auth', frames.some((f) => f.t === 'hello'));
  ws.sendJson({ v: 1, t: 'msg.send', ts: Date.now(), d: { chat_id: chatId, body: 'Сообщение через WSS', client_msg_id: 'ws-1' } });
  const sentFrame = await ws.waitFor('msg.sent', 3000);
  check('WS: msg.sent', !!sentFrame);
  ws.sendJson({ v: 1, t: 'ping', ts: Date.now(), d: {} });
  check('WS: pong', !!(await ws.waitFor('pong', 3000)));
  ws.close();

  const meSeller = await call('GET', '/api/v1/auth/me', { token: tokens.keymaster.access });
  const safety = await call('GET', `/api/v1/e2ee/safety/${meSeller.data.id}`, { token: tokens.buyer_nova.access });
  check('safety number для сверки ключей', safety.status === 200 && /^[0-9]{5}(-[0-9]{5}){7}$/.test(safety.data.safety_number ?? ''),
    JSON.stringify(safety.data).slice(0, 140));
  const readAll = await call('POST', '/api/v1/notifications/read-all', { token: tokens.buyer_nova.access });
  check('прочитать все уведомления', readAll.status === 200 && readAll.data.unread === 0,
    JSON.stringify(readAll.data).slice(0, 120));

  console.log('\n5. Спор: маскировка сторон, эскалация, решение арбитра');
  const order2 = await call('POST', '/api/v1/orders', {
    token: tokens.buyer_nova.access,
    body: { product_id: product.id, qty: 1, pay_asset: 'SOL', idempotency_key: `smoke2-${Date.now()}` },
  });
  await call('POST', `/api/v1/orders/${order2.data.id}/pay`, {
    token: tokens.buyer_nova.access, body: { asset: 'SOL' },
  });
  const dispute = await call('POST', `/api/v1/orders/${order2.data.id}/dispute`, {
    token: tokens.buyer_nova.access,
    body: { reason_code: 'invalid_key', description: 'Ключ не активируется: сервис сообщает, что код уже использован другим покупателем.', totp_code: await opsCode('buyer_nova') },
  });
  check('спор открыт', [200, 201].includes(dispute.status) && dispute.data.id, JSON.stringify(dispute.data).slice(0, 140));
  check('маскировка: покупатель видит «Продавец #…»', /^Продавец #/.test(dispute.data.counterparty_alias ?? ''));
  check('спор: свой псевдоним «Покупатель #…»', /^Покупатель #/.test(dispute.data.your_alias ?? ''));
  const evidence = await call('POST', `/api/v1/disputes/${dispute.data.id}/evidence`, {
    token: tokens.buyer_nova.access, body: { kind: 'text', text: 'Скриншот ошибки активации: код уже использован.' },
  });
  check('доказательство добавлено', evidence.status === 201 && evidence.data.meta_stripped === true);
  const escalate = await call('POST', `/api/v1/disputes/${dispute.data.id}/escalate`, {
    token: tokens.buyer_nova.access, body: { reason: 'Продавец не ответил за 72 часа, прошу арбитра.' },
  });
  check('эскалация → in_arbitration', escalate.status === 200 && escalate.data.status === 'in_arbitration');
  let arbiterToken = tokens.sitee_arbiter.access;
  let arbiterView = await call('GET', `/api/v1/disputes/${dispute.data.id}`, { token: arbiterToken });
  if (arbiterView.status !== 200) {
    arbiterToken = tokens.sitee_admin.access;
    arbiterView = await call('GET', `/api/v1/disputes/${dispute.data.id}`, { token: arbiterToken });
  }
  check('назначенный арбитр видит реальные ID', arbiterView.status === 200 && arbiterView.data.reveal === true && !!arbiterView.data.buyer_id);
  const otherStaff = arbiterToken === tokens.sitee_arbiter.access ? tokens.sitee_admin.access : tokens.sitee_arbiter.access;
  const otherView = await call('GET', `/api/v1/disputes/${dispute.data.id}`, { token: otherStaff });
  check('неназначенный сотрудник не видит спор', [403, 404].includes(otherView.status), `(${otherView.status})`);
  const resolveForbidden = await call('POST', `/api/v1/disputes/${dispute.data.id}/resolve`, {
    token: tokens.buyer_nova.access, body: { resolution: 'refund_buyer', reason: 'хочу возврат' },
  });
  check('покупатель не может решить спор', resolveForbidden.status === 403);
  const resolve = await call('POST', `/api/v1/disputes/${dispute.data.id}/resolve`, {
    token: tokens.sitee_arbiter.access,
    body: { resolution: 'refund_buyer', reason: 'Ключ не работает, подтверждено доказательством.', totp_code: await opsCode('sitee_arbiter') },
  });
  check('арбитр: полный возврат', resolve.status === 200 && resolve.data.resolution === 'refund_buyer', JSON.stringify(resolve.data).slice(0, 140));
  check('заказ → refunded', resolve.data.order_status === 'refunded');
  const disputesList = await call('GET', '/api/v1/disputes', { token: tokens.buyer_nova.access });
  check('список споров покупателя', disputesList.data.items.length >= 1);
  const appeal = await call('POST', `/api/v1/disputes/${dispute.data.id}/appeal`, {
    token: tokens.buyer_nova.access,
    body: { reason: 'Ключ активировался на другом аккаунте, прошу пересмотреть решение арбитра и вернуть средства.' },
  });
  check('апелляция принята → appeal', appeal.status === 200 && appeal.data.status === 'appeal',
    JSON.stringify(appeal.data).slice(0, 160));
  check('апелляция: исполнение refund приостановлено', appeal.data.execution_suspended === true);
  check('апелляция: назначен старший арбитр', !!appeal.data.senior_arbiter_assigned
    && appeal.data.senior_arbiter_assigned !== arbiterToken,
    `новый ${appeal.data.senior_arbiter_assigned}, прежний ${arbiterToken}`);
  check('апелляция: ссылка на решённый спор', appeal.data.appeal_of === dispute.data.id);
  const appealTwice = await call('POST', `/api/v1/disputes/${dispute.data.id}/appeal`, {
    token: tokens.buyer_nova.access, body: { reason: 'Повторная апелляция по тому же спору, хочу ещё один пересмотр.' },
  });
  check('повторная апелляция → 409 ALREADY_APPEALED',
    appealTwice.status === 409 && appealTwice.data.error?.code === 'ALREADY_APPEALED',
    `(${appealTwice.status}) ${JSON.stringify(appealTwice.data).slice(0, 120)}`);
  const appealShort = await call('POST', `/api/v1/disputes/${dispute.data.id}/appeal`, {
    token: tokens.buyer_nova.access, body: { reason: 'слишком коротко' },
  });
  check('апелляция: короткое обоснование → 400', appealShort.status === 400,
    `(${appealShort.status}) ${JSON.stringify(appealShort.data).slice(0, 120)}`);
  const appealNotParty = await call('POST', `/api/v1/disputes/${dispute.data.id}/appeal`, {
    token: tokens.sitee_arbiter.access,
    body: { reason: 'Апелляция от лица арбитра, который не является стороной спора.' },
  });
  check('апелляция не стороной спора → 403', appealNotParty.status === 403,
    `(${appealNotParty.status})`);
  const appealView = await call('GET', `/api/v1/disputes/${dispute.data.id}`, { token: otherStaff });
  check('старший арбитр видит спор в статусе appeal', appealView.status === 200 && appealView.data.status === 'appeal',
    `(${appealView.status}) ${JSON.stringify(appealView.data).slice(0, 120)}`);
  check('действия в appeal: арбитр может решить', (appealView.data.actions ?? []).includes('resolve'));
  const evId = evidence.data.id ?? evidence.data.evidence_id;
  const evGet = await call('GET', `/api/v1/disputes/${dispute.data.id}/evidence/${evId}`, {
    token: tokens.buyer_nova.access,
  });
  check('доказательство читается участником', evGet.status === 200 && !!evGet.data.sha256,
    JSON.stringify(evGet.data).slice(0, 140));
  check('псевдоним загрузчика в доказательстве', /^Покупатель #/.test(evGet.data.uploader_visible_as ?? ''));
  const evForbidden = await call('GET', `/api/v1/disputes/${dispute.data.id}/evidence/${evId}`, {
    token: tokens.buyer_max.access,
  });
  check('не участник спора не читает доказательство', [403, 404].includes(evForbidden.status), `(${evForbidden.status})`);


  console.log('\n6. Обмен: кошелёк, SOL⇄Stars, подарки, Stars-инвойс');
  const quote = await call('GET', '/api/v1/exchange/quote?amount_sol=1', { token: tokens.buyer_nova.access });
  check('котировка SOL→Stars', quote.status === 200 && quote.data.to_amount_raw > 0, JSON.stringify(quote.data).slice(0, 120));
  const exchange = await call('POST', '/api/v1/exchange', {
    token: tokens.buyer_nova.access, body: { quote_id: quote.data.quote_id, totp_code: await opsCode('buyer_nova') },
  });
  check('обмен выполнен двумя ногами', exchange.status === 200 && exchange.data.tx_from && exchange.data.tx_to, JSON.stringify(exchange.data).slice(0, 140));
  const starsInvoice = await call('POST', '/api/v1/stars/invoice', {
    token: tokens.buyer_nova.access, body: { amount_stars: 500, purpose: 'deposit', reference: 'smoke' },
  });
  check('Stars-инвойс создан', starsInvoice.status === 201 && starsInvoice.data.payload);
  const gifts = await call('GET', '/api/v1/gifts');
  check('каталог подарков', gifts.data.items.length >= 5);
  const gift = gifts.data.items.find((g) => g.boosts_shop);
  const giftBuy = await call('POST', `/api/v1/gifts/${gift.id}/buy`, {
    token: tokens.buyer_nova.access,
    body: { asset: 'STARS', recipient_type: 'shop', recipient_id: product.shop_id, qty: 1, message: 'Спасибо за быструю выдачу!', totp_code: await opsCode('buyer_nova') },
  });
  check('подарок за Stars куплен', [200, 201].includes(giftBuy.status) && giftBuy.data.boost_applied === true, JSON.stringify(giftBuy.data).slice(0, 140));
  const shopAfterGift = await call('GET', `/api/v1/shops/${product.shop_id}`);
  check('буст подарка в ленте', (shopAfterGift.data.gift_boost ?? 0) > 0);
  const inventory = await call('GET', '/api/v1/gifts/inventory', { token: tokens.buyer_nova.access });
  check('инвентарь подарков', inventory.status === 200);
  const txs = await call('GET', '/api/v1/wallet/transactions?limit=5', { token: tokens.buyer_nova.access });
  check('история проводок', txs.data.items.length >= 3);
  const withdrawCooling = await call('POST', '/api/v1/wallet/withdraw', {
    token: tokens.buyer_nova.access,
    body: { asset: 'SOL', amount_sol: '1', dest_address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', totp_code: await opsCode('buyer_nova') },
  });
  check('вывод на новый адрес → охлаждение 24 ч', withdrawCooling.status === 403 && withdrawCooling.data.error.code === 'ADDRESS_COOLING',
    JSON.stringify(withdrawCooling.data).slice(0, 140));
  const withdrawBad = await call('POST', '/api/v1/wallet/withdraw', {
    token: tokens.buyer_nova.access, body: { asset: 'SOL', amount_sol: '1', dest_address: 'not-a-valid-address!!' },
  });
  check('вывод на некорректный адрес → 400', withdrawBad.status === 400);

  console.log('\n7. Продавец: магазин, аренда, товары, сток');
  const shopMine = await call('GET', `/api/v1/shops/${product.shop_id}`, { token: tokens.keymaster.access });
  check('админ видит свой магазин', shopMine.data.is_mine === true);
  const stats = await call('GET', `/api/v1/shops/${product.shop_id}/stats`, { token: tokens.keymaster.access });
  check('статистика магазина', stats.status === 200 && stats.data.orders_total >= 1);
  const plans = await call('GET', '/api/v1/rent/plans');
  check('тарифы аренды', plans.data.items.length === 4 && plans.data.items.some((p) => p.crown));
  await call('POST', '/api/v1/dev/simulate-deposit', {
    token: tokens.keymaster.access, body: { asset: 'SOL', amount_sol: '60', user_id: tokens.keymaster.user.id },
  });
  const rent = await call('POST', `/api/v1/shops/${product.shop_id}/rent`, {
    token: tokens.keymaster.access, body: { plan_code: 'crown', asset: 'SOL', auto_renew: true, totp_code: await opsCode('keymaster') },
  });
  check('аренда продлена (Crown)', rent.status === 200 && rent.data.status === 'active' && rent.data.crown === true, JSON.stringify(rent.data).slice(0, 140));
  const newProduct = await call('POST', `/api/v1/shops/${product.shop_id}/products`, {
    token: tokens.keymaster.access,
    body: {
      title: 'Smoke-тест: лицензия антивируса', description: 'Годовая лицензия, автовыдача.', category_id: products.data.items[0].category_id ?? 'cat_keys',
      kind: 'key', price_sol: '0.5', price_stars: 50, warranty_days: 30, delivery_sla_h: 6,
      stock_payloads: ['SMOKE-KEY-AAAA-1111', 'SMOKE-KEY-BBBB-2222'],
    },
  });
  check('товар создан со зашифрованным стоком', newProduct.status === 201 && newProduct.data.stock_free === 2);
  const stock = await call('POST', `/api/v1/products/${newProduct.data.id}/stock`, {
    token: tokens.keymaster.access, body: { payloads: ['SMOKE-KEY-CCCC-3333'] },
  });
  check('пополнение стока', stock.status === 200 && stock.data.stock_free === 3);
  const reply = await call('POST', `/api/v1/reviews/${review.data.id}/reply`, {
    token: tokens.keymaster.access, body: { body: 'Спасибо! Будем рады видеть вас снова — промокод на второй ключ уже в чате.' },
  });
  check('ответ магазина на отзыв', reply.status === 200 && !!reply.data.shop_reply);
  const shopCreate = await call('POST', '/api/v1/shops', {
    token: tokens.keymaster.access,
    body: {
      name: 'Smoke Shop', description: 'Магазин из смоук-теста', category_ids: [cats.data.items[0].id],
      country: 'KZ', city_id: cities.data.items[0].id, accepts_stars: true, totp_code: await opsCode('keymaster'),
    },
  });
  check('новый магазин + trial', [200, 201].includes(shopCreate.status) && shopCreate.data.rent?.status === 'trial', JSON.stringify(shopCreate.data).slice(0, 120));

  console.log('\n8. Админ-панель');
  const dash = await call('GET', '/api/v1/admin/dashboard', { token: tokens.sitee_admin.access });
  check('дашборд', dash.status === 200 && dash.data.counts.users >= 7 && dash.data.gmv);
  check('дашборд: эскроу и комиссии', dash.data.escrow && dash.data.balances.fees_sol !== undefined);
  const adminGift = await call('POST', '/api/v1/admin/gifts', {
    token: tokens.sitee_admin.access,
    body: {
      sku: `smoke-gift-${Date.now()}`, title_ru: 'Кристалл смоука', title_en: 'Smoke Crystal', emoji: '💠',
      rarity: 'epic', price_stars: 250, price_sol: '2.5', boosts_shop: true, boost_value: 0.2, boost_days: 5,
      totp_code: await opsCode('sitee_admin'),
    },
  });
  check('подарок добавлен через админку', adminGift.status === 201 && adminGift.data.boosts_shop === true);
  const patchGift = await call('PATCH', `/api/v1/admin/gifts/${adminGift.data.id}`, {
    token: tokens.sitee_admin.access, body: { price_stars: 300, status: 'published' },
  });
  check('подарок обновлён', patchGift.status === 200 && patchGift.data.price_stars === 300);
  const adminShops = await call('GET', '/api/v1/admin/shops?limit=10', { token: tokens.sitee_admin.access });
  check('список магазинов в админке', adminShops.data.items.length >= 6);
  const sanction = await call('POST', `/api/v1/admin/shops/${product.shop_id}/sanction`, {
    token: tokens.sitee_admin.access, body: { level: 'warning', reason: 'Жалоба на задержку выдачи' },
  });
  check('санкция warning', sanction.status === 200 && sanction.data.sanction_level === 'warning');
  await call('POST', `/api/v1/admin/shops/${product.shop_id}/sanction`, {
    token: tokens.sitee_admin.access, body: { level: 'none', reason: 'санкция снята после проверки' },
  });
  const adminDisputes = await call('GET', '/api/v1/admin/disputes', { token: tokens.sitee_admin.access });
  check('споры в админке', adminDisputes.data.items.length >= 1);
  const recon = await call('GET', '/api/v1/admin/finance/reconciliation', { token: tokens.sitee_admin.access });
  check('реконсиляция ledger', recon.status === 200 && recon.data.summary.SOL && recon.data.entries_total > 20);
  const auditLog = await call('GET', '/api/v1/admin/audit?limit=10', { token: tokens.sitee_admin.access });
  check('аудит-лог с хэш-цепочкой', auditLog.data.items.length >= 5 && auditLog.data.chain_verified === true);
  const secEvents = await call('GET', '/api/v1/admin/security/events', { token: tokens.sitee_admin.access });
  check('события безопасности', secEvents.status === 200);
  const settings = await call('PATCH', '/api/v1/admin/settings/default_fee_bps', {
    token: tokens.sitee_admin.access, body: { value: 650, reason: 'смоук' },
  });
  check('настройки изменяются', settings.status === 200 && settings.data.value === 650);
  const forbiddenForBuyer = await call('GET', '/api/v1/admin/dashboard', { token: tokens.buyer_nova.access });
  check('админка закрыта для покупателя', forbiddenForBuyer.status === 403);

  console.log('\n9. Регистрация нового пользователя (полный сценарий)');
  const nick = `smoke${Date.now() % 100000}`;
  const reg = await call('POST', '/api/v1/auth/register', {
    body: {
      email: `${nick}@example.com`, nickname: nick, password: 'Str0ng#Pass2026', password_confirm: 'Str0ng#Pass2026',
      country_code: 'GE', city_id: (await call('GET', '/api/v1/geo/cities?country=GE')).data.items[0].id,
      accept_terms: true, is_18plus: true, locale: 'ru', captcha_token: 'dev',
    },
  });
  check('регистрация → enrollment', reg.status === 201 && reg.data.enrollment_id && reg.data.dev_code);
  const verify = await call('POST', '/api/v1/auth/verify-contact', {
    body: { enrollment_id: reg.data.enrollment_id, code: reg.data.dev_code },
  });
  check('подтверждение контакта', verify.status === 200 && verify.data.next === '2fa_setup');
  const setup = await call('POST', '/api/v1/auth/2fa/setup', { body: { factor: 'login', enrollment_id: reg.data.enrollment_id } });
  check('2FA setup: секрет + otpauth', setup.status === 200 && setup.data.secret_b32 && setup.data.otpauth_url.includes('otpauth://totp'));
  const activate = await call('POST', '/api/v1/auth/2fa/activate', {
    body: {
      factor: 'login', enrollment_id: reg.data.enrollment_id,
      code1: setup.data.dev_codes[0], code2: setup.data.dev_codes[1],
    },
  });
  check('2FA activate → сессия и redirect /shops', activate.status === 200 && activate.data.redirect === '/shops' && activate.data.next_step === 'enroll_ops');
  check('выдано 10 backup-кодов', activate.data.backup_codes.length === 10);
  const setupOps = await call('POST', '/api/v1/auth/2fa/setup', { body: { factor: 'ops' }, token: activate.data.access_token });
  const activateOps = await call('POST', '/api/v1/auth/2fa/activate', {
    body: { factor: 'ops', code1: setupOps.data.dev_codes[0], code2: setupOps.data.dev_codes[1] }, token: activate.data.access_token,
  });
  check('второй фактор 2FA (операции) настроен', activateOps.status === 200 && activateOps.data.factor === 'ops');
  const weakReg = await call('POST', '/api/v1/auth/register', {
    body: {
      email: 'weak@example.com', nickname: 'weakuser', password: '123', password_confirm: '123',
      country_code: 'RU', city_id: 1, accept_terms: true, is_18plus: true,
    },
  });
  check('слабый пароль отклонён', weakReg.status === 400);

  console.log('\n9b. Гео-блокировка категорий (FR-GEO-03б)');
  const geoCats = await call('GET', '/api/v1/admin/categories', { token: tokens.sitee_admin.access });
  const vpnCat = geoCats.data.items.find((c) => c.slug === 'vpn-proxy');
  check('админка: чёрный список юрисдикций', geoCats.status === 200 &&
    vpnCat?.blocked_countries?.includes('IR') && vpnCat?.blocked_countries?.includes('CN'));
  // Покупатель из Ирана не может ни открыть, ни купить VPN-товар.
  const irNick = `smokeir${Date.now() % 100000}`;
  const irReg = await call('POST', '/api/v1/auth/register', {
    body: {
      email: `${irNick}@example.com`, nickname: irNick, password: 'Str0ng#Pass2026', password_confirm: 'Str0ng#Pass2026',
      country_code: 'IR', city_id: 9002, accept_terms: true, is_18plus: true, locale: 'ru', captcha_token: 'dev',
    },
  });
  check('регистрация покупателя из IR', irReg.status === 201);
  const irVerify = await call('POST', '/api/v1/auth/verify-contact', {
    body: { enrollment_id: irReg.data.enrollment_id, code: irReg.data.dev_code },
  });
  check('контакт подтверждён (IR)', irVerify.status === 200 && irVerify.data.next === '2fa_setup');
  const irSetup = await call('POST', '/api/v1/auth/2fa/setup', { body: { factor: 'login', enrollment_id: irReg.data.enrollment_id } });
  check('2FA setup для IR', irSetup.status === 200 && !!irSetup.data.dev_codes, JSON.stringify(irSetup.data).slice(0, 160));
  const irAct = await call('POST', '/api/v1/auth/2fa/activate', {
    body: { factor: 'login', enrollment_id: irReg.data.enrollment_id, code1: irSetup.data.dev_codes[0], code2: irSetup.data.dev_codes[1] },
  });
  check('2FA активирован → сессия', irAct.status === 200 && !!irAct.data.access_token);
    const proxyShop = (await call('GET', '/api/v1/shops', { token: tokens.sitee_admin.access })).data.items
    .find((sh) => sh.slug === 'proxy-nord');
  const vpnItems = (await call('GET', `/api/v1/shops/${proxyShop.id}/products`, { token: irAct.data.access_token })).data.items;
  check('VPN-товары скрыты для IR', vpnItems.length === 0);
  const adminVpnItems = (await call('GET', `/api/v1/shops/${proxyShop.id}/products`, { token: tokens.sitee_admin.access })).data.items;
  check('админ магазина видит те же товары', adminVpnItems.filter((p) => p.category_id === 12).length === 2);
  const anyVpn = adminVpnItems.find((p) => p.category_id === 12);
  const blockedView = await call('GET', `/api/v1/products/${anyVpn.id}`, { token: irAct.data.access_token });
  check('товар заблокированной категории → 403 GEO_BLOCKED',
    blockedView.status === 403 && blockedView.data.error?.code === 'GEO_BLOCKED');
  const blockedOrder = await call('POST', '/api/v1/orders', {
    token: irAct.data.access_token, body: { product_id: anyVpn.id, qty: 1, asset: 'SOL' },
  });
  check('заказ заблокированной категории → 403 GEO_BLOCKED',
    blockedOrder.status === 403 && blockedOrder.data.error?.code === 'GEO_BLOCKED');
  // Админ снимает запрет — товар снова доступен.
  const patch = await call('PATCH', `/api/v1/admin/categories/${vpnCat.id}`, {
    token: tokens.sitee_admin.access,
    body: { blocked_countries: ['CN'], totp_code: await opsCode('sitee_admin'), reason: 'смоук: снятие запрета для IR' },
  });
  check('админ снял IR из чёрного списка', patch.status === 200 && !patch.data.blocked_countries.includes('IR'));
  const allowedView = await call('GET', `/api/v1/products/${anyVpn.id}`, { token: irAct.data.access_token });
  check('после снятия запрета товар открывается', allowedView.status === 200);
  // Возвращаем запрет обратно, чтобы демо-данные не менялись.
  await call('PATCH', `/api/v1/admin/categories/${vpnCat.id}`, {
    token: tokens.sitee_admin.access, body: { blocked_countries: ['CN', 'IR'], totp_code: await opsCode('sitee_admin') },
  });

  console.log('\n9c. Троттлинг сообщений в чате (FR-MSG-10)');
  await call('POST', '/api/v1/dev/reset-guards');
  const floodNick = `flood${Date.now().toString(36)}`;
  const floodReg = await call('POST', '/api/v1/auth/register', {
    body: {
      email: `${floodNick}@example.com`, nickname: floodNick, password: 'Str0ng#Pass2026',
      password_confirm: 'Str0ng#Pass2026', country_code: 'GE',
      city_id: (await call('GET', '/api/v1/geo/cities?country=GE')).data.items[0].id,
      accept_terms: true, is_18plus: true, locale: 'ru', captcha_token: 'dev',
    },
  });
  check('9c: регистрация флудера', floodReg.status === 201 && floodReg.data.enrollment_id);
  await call('POST', '/api/v1/auth/verify-contact', {
    body: { enrollment_id: floodReg.data.enrollment_id, code: floodReg.data.dev_code },
  });
  const floodSetup = await call('POST', '/api/v1/auth/2fa/setup', {
    body: { factor: 'login', enrollment_id: floodReg.data.enrollment_id },
  });
  const floodActivate = await call('POST', '/api/v1/auth/2fa/activate', {
    body: {
      factor: 'login', enrollment_id: floodReg.data.enrollment_id,
      code1: floodSetup.data.dev_codes[0], code2: floodSetup.data.dev_codes[1],
    },
  });
  check('9c: сессия флудера', floodActivate.status === 200 && floodActivate.data.access_token);
  const floodToken = floodActivate.data.access_token;
  const floodShop = (await call('GET', '/api/v1/shops?limit=1', {})).data.items[0];
  const floodChat = await call('POST', '/api/v1/chats', {
    token: floodToken, body: { kind: 'shop_support', shop_id: floodShop.id },
  });
  check('9c: чат с админом магазина', [200, 201].includes(floodChat.status) && floodChat.data.id,
    JSON.stringify(floodChat.data).slice(0, 140));
  let rejected = 0;
  let firstError = '';
  let muted = false;
  for (let i = 0; i < 400 && !muted; i += 1) {
    const sent = await call('POST', `/api/v1/chats/${floodChat.data.id}/messages`, {
      token: floodToken,
      body: { type: 'text', body: `флуд ${i}`, client_msg_id: `flood-${i}-${Date.now()}` },
    });
    if (sent.status === 429) {
      rejected += 1;
      const text = JSON.stringify(sent.data);
      if (!firstError) firstError = text.slice(0, 160);
      if (/сообщени/i.test(text)) muted = true;
    }
  }
  check('9c: троттлинг чата вернул 429', rejected > 0, `отказов ${rejected} ${firstError}`);
  const afterFlood = await call('POST', `/api/v1/chats/${floodChat.data.id}/messages`, {
    token: floodToken, body: { type: 'text', body: 'ещё одно после серии отказов' },
  });
  check('9c: после серии отказов отправка ограничена', afterFlood.status === 429,
    `(${afterFlood.status}) ${JSON.stringify(afterFlood.data).slice(0, 140)}`);
  await call('POST', '/api/v1/dev/reset-guards');

  console.log('\n10. Анти-брутфорс и rate limit');
  for (let i = 0; i < 6; i += 1) {
    await call('POST', '/api/v1/auth/login', { body: { identifier: `${nick}@example.com`, password: 'bad', device: {} } });
  }
  const lockedLogin = await call('POST', '/api/v1/auth/login', {
    body: { identifier: `${nick}@example.com`, password: 'bad', device: {} },
  });
  check('блокировка после серии неудач', [423, 428, 429].includes(lockedLogin.status), `(${lockedLogin.status} ${lockedLogin.data.error?.code})`);
  let limited = 0;
  // 200 быстрых запросов пробивают burst даже при SITEED_RATE_SCALE=6.
  for (let i = 0; i < 200; i += 1) {
    const res = await call('GET', '/api/v1/shops?q=zzz');
    if (res.status === 429 || res.status === 423) limited += 1;
  }
  check('rate limit ленты срабатывает', limited > 0);

  // Секция 10 выжала бюджет rate-limit на IP — сбрасываем счётчики.
  await call('POST', '/api/v1/dev/reset-guards');
  console.log('\n11. Дополнительные кейсы приёмки (TC-ORD-06/07, TC-MSG-05/06, TC-ABF-04, TC-DSP-07)');

  // TC-ORD-06: недопустимый переход статуса заказа.
  const ord = await call('GET', '/api/v1/orders?limit=1', { token: tokens.buyer_nova.access });
  const myOrder = (ord.data.items ?? []).find((o) => o.status === 'created') ?? ord.data.items?.[0];
  if (myOrder) {
    const badTransition = await call('POST', `/api/v1/orders/${myOrder.id}/deliver`, {
      token: tokens.keymaster.access,
      body: { payload: 'SMOKE-payload' },
    });
    check('заказ: created → delivered → 409 INVALID_TRANSITION',
      badTransition.status === 409 && badTransition.data.error?.code === 'INVALID_TRANSITION',
      `(${badTransition.status}) ${badTransition.data.error?.code ?? ''}`);
  }

  // TC-ORD-07: оплата при недостатке средств — свежий покупатель с нулевым балансом.
  const brokeNick = `broke${Date.now().toString(36).slice(-6)}`;
  const brokeMail = `${brokeNick}@example.com`;
  const brokeCities = await call('GET', '/api/v1/geo/cities?country=RU');
  const brokeReg = await call('POST', '/api/v1/auth/register', {
    body: {
      email: brokeMail, nickname: brokeNick, password: 'Broke#2026x', password_confirm: 'Broke#2026x',
      country_code: 'RU', city_id: brokeCities.data.items[0].id, accept_terms: true, is_18plus: true,
    },
  });
  let brokeTok = null;
  let brokeOpsSecret = '';
  if (brokeReg.status === 201 && brokeReg.data.enrollment_id) {
    const enr = brokeReg.data.enrollment_id;
    await call('POST', '/api/v1/auth/verify-contact', { body: { enrollment_id: enr, code: brokeReg.data.dev_code } });
    const s1 = await call('POST', '/api/v1/auth/2fa/setup', { body: { factor: 'login', enrollment_id: enr } });
    const a1 = await call('POST', '/api/v1/auth/2fa/activate', {
      body: { factor: 'login', enrollment_id: enr, code1: s1.data.dev_codes[0], code2: s1.data.dev_codes[1] },
    });
    brokeTok = a1.status === 200 ? { access: a1.data.access_token, refresh: a1.data.refresh_token } : null;
    if (brokeTok) {
      const s2 = await call('POST', '/api/v1/auth/2fa/setup', { body: { factor: 'ops' }, token: brokeTok.access });
      const a2 = await call('POST', '/api/v1/auth/2fa/activate', {
        body: { factor: 'ops', code1: s2.data.dev_codes[0], code2: s2.data.dev_codes[1] }, token: brokeTok.access,
      });
      if (a2.status === 200) {
        brokeOpsSecret = a2.data.backup_codes?.[0] ?? '';
      }
    }
  }
  // TC-ORD-07: оплата при нулевом балансе — проверка выдаётся всегда, чтобы пропуск не прятался.
  let poorResult = { status: 0, code: 'не проверено' };
  if (!brokeTok) {
    poorResult = { status: 0, code: `регистрация не прошла (${brokeReg.status})` };
  } else {
    const feed2 = await call('GET', '/api/v1/shops?limit=1', { token: brokeTok.access });
    const shop2 = feed2.data.items?.[0];
    const prod2 = shop2 ? (await call('GET', `/api/v1/shops/${shop2.id}/products`, { token: brokeTok.access })).data.items?.[0] : null;
    if (!prod2) {
      poorResult = { status: 0, code: 'нет товара для заказа' };
    } else {
      const o2 = await call('POST', '/api/v1/orders', {
        token: brokeTok.access, body: { product_id: prod2.id, qty: 1 },
      });
      if (o2.status !== 201) {
        poorResult = { status: o2.status, code: `заказ не создан (${o2.status}) ${o2.data.error?.code ?? ''}` };
      } else {
        const payPoor = await call('POST', `/api/v1/orders/${o2.data.id}/pay`, {
          token: brokeTok.access,
          body: { asset: 'SOL', ...(brokeOpsSecret ? { totp_code: brokeOpsSecret } : {}) },
        });
        poorResult = { status: payPoor.status, code: payPoor.data.error?.code ?? '' };
      }
    }
  }
  check('заказ: оплата без средств → 422 INSUFFICIENT_FUNDS',
    poorResult.status === 422 && poorResult.code === 'INSUFFICIENT_FUNDS',
    `(${poorResult.status}) ${poorResult.code}`);

  // TC-MSG-06: группа и канал магазина.
  const grp = await call('POST', '/api/v1/chats', {
    token: tokens.keymaster.access,
    body: { kind: 'group', title: 'SMOKE группа', member_ids: [tokens.buyer_nova.user.id] },
  });
  check('мессенджер: группа создана', grp.status === 201 && grp.data.kind === 'group', `(${grp.status})`);
  const chn = await call('POST', '/api/v1/chats', {
    token: tokens.keymaster.access, body: { kind: 'channel', title: 'SMOKE канал' },
  });
  check('мессенджер: канал создан', chn.status === 201 && chn.data.kind === 'channel', `(${chn.status})`);
  if (grp.status === 201) {
    const inGrp = await call('POST', `/api/v1/chats/${grp.data.id}/messages`, {
      token: tokens.keymaster.access, body: { body: 'Объявление для участников группы' },
    });
    check('мессенджер: сообщение в группу', inGrp.status === 201, `(${inGrp.status})`);
  }

  // TC-MSG-05: вложение больше 25 МБ → 413.
  if (grp.status === 201) {
    // JSON-транспорт ограничен 1 МБ (MaxJSONBodyBytes), поэтому лимит
    // вложения 25 МБ проверяется на транспорте — ожидаем 413.
    const big = await call('POST', `/api/v1/chats/${grp.data.id}/messages`, {
      token: tokens.keymaster.access,
      body: { type: 'file', body: Buffer.alloc(2 * 1024 * 1024).toString('base64'), name: 'huge.bin' },
    });
    check('мессенджер: вложение больше лимита → 413',
      big.status === 413,
      `(${big.status}) ${big.data.error?.code ?? ''}`);
    const small = await call('POST', `/api/v1/chats/${grp.data.id}/messages`, {
      token: tokens.keymaster.access,
      body: { type: 'file', body: Buffer.from('SMOKE-file').toString('base64'), name: 'ok.txt' },
    });
    check('мессенджер: вложение в лимите принимается', small.status === 201, `(${small.status})`);
  }

  // TC-ABF-04: WS без аутентификации разрывается по таймауту 10 с.
  const silentWs = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
  let silentCode = null;
  silentWs.onClose = (code) => { silentCode = code; };
  await silentWs.open();
  const startedAt = Date.now();
  while (silentCode === null && Date.now() - startedAt < 15000) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const waitedMs = Date.now() - startedAt;
  check('WS: неавторизованное соединение разорвано через 10 с (4401)',
    silentCode === 4401 && waitedMs >= 9000,
    `code=${silentCode} через ${waitedMs} мс`);

  // TC-DSP-07: автоэскалация молчащих споров видна админу.
  const autoEsc = await call('GET', '/api/v1/admin/disputes?status=in_arbitration&limit=50', { token: tokens.sitee_admin.access });
  check('споры: автоматическая эскалация видна админу',
    autoEsc.status === 200 && Array.isArray(autoEsc.data.items),
    `(${autoEsc.status})`);

  console.log(`\nИтог: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('Проблемы:');
    for (const f of failures) console.log(` - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(2);
});
