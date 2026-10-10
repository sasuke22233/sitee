// Демо-данные preview-сервера: зеркало backend/internal/seed (тот же набор
// пользователей, магазинов, товаров, подарков и статусов заказов), но на JS и
// с шифрованием через node:crypto в том же формате Envelope v1.
import * as C from './crypto.mjs';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const DEMO_PASSWORDS = {
  admin: 'Admin#2026',
  arbiter: 'Arbiter#2026',
  shop: 'Shop#2026',
  buyer: 'Buyer#2026',
};

const USERS = [
  { nick: 'sitee_admin', email: 'admin@sitee.dev', password: 'Admin#2026', role: 'superadmin', country: 'NO', city_id: 9001, sol: 100, stars: 5000 },
  { nick: 'sitee_arbiter', email: 'arbiter@sitee.dev', password: 'Arbiter#2026', role: 'arbiter', country: 'RU', city_id: 1001, sol: 5, stars: 200 },
  { nick: 'keymaster', email: 'shop@sitee.dev', password: 'Shop#2026', role: 'shop_admin', country: 'RU', city_id: 1002, sol: 12, stars: 1200 },
  { nick: 'lena_digital', email: 'lena@sitee.dev', password: 'Shop#2026', role: 'shop_admin', country: 'RU', city_id: 1001, sol: 6, stars: 400 },
  { nick: 'viktor_keys', email: 'viktor@sitee.dev', password: 'Shop#2026', role: 'shop_admin', country: 'KZ', city_id: 3001, sol: 4, stars: 300 },
  { nick: 'buyer_nova', email: 'buyer@sitee.dev', password: 'Buyer#2026', role: 'buyer', country: 'NO', city_id: 9003, sol: 25, stars: 3000 },
  { nick: 'buyer_max', email: 'max@sitee.dev', password: 'Buyer#2026', role: 'buyer', country: 'RU', city_id: 1003, sol: 9, stars: 900 },
];

const SHOPS = [
  {
    slug: 'key-master', name: 'КлючМастер', admin: 'keymaster', plan: 'crown', rent: 'active', rent_days: 24,
    description: 'Лицензионные ключи Windows, Office, антивирусов и VPN. Мгновенная выдача, гарантия замены 30 дней.',
    categories: [1, 3, 12], country: 'RU', city_id: 1002, verified: true, accent: '#6c5ce7',
  },
  {
    slug: 'cifra-nord', name: 'Цифра Норд', admin: 'lena_digital', plan: 'pro', rent: 'active', rent_days: 18,
    description: 'Подписки на стриминги, музыку и облачные сервисы. Официальные регионы, продление от 1 месяца.',
    categories: [4, 8, 3], country: 'RU', city_id: 1001, verified: true, accent: '#00b894',
  },
  {
    slug: 'almaty-keys', name: 'Almaty Keys', admin: 'viktor_keys', plan: 'starter', rent: 'trial', rent_days: 4,
    description: 'Игровые аккаунты и цифровые подарки Steam/Epic. Быстрая поддержка на русском и казахском.',
    categories: [5, 2, 1], country: 'KZ', city_id: 3001, verified: false, accent: '#0984e3',
  },
  {
    slug: 'game-vault', name: 'GameVault', admin: 'keymaster', plan: 'pro', rent: 'expiring', rent_days: 5,
    description: 'Ключи активации игр, внутриигровая валюта, сезонные пропуска. Автовыдача 24/7.',
    categories: [5, 1, 10], country: 'RU', city_id: 1002, verified: false, accent: '#e17055',
  },
  {
    slug: 'soft-license', name: 'SoftLicense', admin: 'lena_digital', plan: 'starter', rent: 'suspended', rent_days: -3,
    description: 'Профессиональное ПО для дизайна, 3D и разработки. Корпоративные лицензии.',
    categories: [3, 7, 6], country: 'RU', city_id: 1001, verified: false, accent: '#636e72',
  },
  {
    slug: 'proxy-nord', name: 'ProxyNord', admin: 'viktor_keys', plan: 'crown', rent: 'active', rent_days: 30,
    description: 'Персональные прокси и VPN-подписки для работы и путешествий. Замена узла в течение часа.',
    categories: [12, 4, 10], country: 'KZ', city_id: 3002, verified: true, accent: '#a29bfe',
  },
];

const PRODUCTS = [
  { shop: 'key-master', title: 'Windows 11 Pro — цифровой ключ', kind: 'key', cat: 1, sol: 1.2, stars: 120, warranty: 30, sla: 1,
    description: 'Оригинальный ключ активации Windows 11 Pro. Привязка к учётной записи Microsoft, пожизненная лицензия.',
    stock: ['SITEE-W11P-7QK2-M9XD-4RTV-88HN', 'SITEE-W11P-3LMQ-77ZC-P2KD-10YX', 'SITEE-W11P-9WBN-44HT-Q8LM-27ZD'] },
  { shop: 'key-master', title: 'Office 2024 Home & Business', kind: 'key', cat: 3, sol: 2.4, stars: 240, warranty: 30, sla: 1,
    description: 'Лицензия Office 2024 (Word, Excel, PowerPoint, Outlook) на 1 ПК, активация через аккаунт Microsoft.',
    stock: ['SITEE-OFF24-HB-2210-KL87-MN34-QW12', 'SITEE-OFF24-HB-7781-ZX90-PQ23-LM65'] },
  { shop: 'key-master', title: 'Антивирус Total Security, 1 год / 3 устройства', kind: 'subscription', cat: 3, sol: 0.9, stars: 90, warranty: 60, sla: 2,
    description: 'Годовая подписка на комплексную защиту: антивирус, файрвол, антифишинг, защита платежей.',
    stock: ['Промокод: AV-TS-2026-8842-KLMQ\nСрок: 12 месяцев, 3 устройства', 'Промокод: AV-TS-2026-1190-ZXCV\nСрок: 12 месяцев', 'Промокод: AV-TS-2026-5533-QWER\nСрок: 12 месяцев'] },
  { shop: 'cifra-nord', title: 'Подписка на музыкальный стриминг, 3 месяца', kind: 'subscription', cat: 8, sol: 1.5, stars: 150, warranty: 14, sla: 3,
    description: 'Премиум-доступ к музыкальному сервису: без рекламы, офлайн-режим, высокое качество звука.',
    stock: ['Логин: music.nova.77@mail.dev\nПароль: Tr#9mKq2Lz\nРегион: EU', 'Логин: music.beat.14@mail.dev\nПароль: Qw!8XcV3pL\nРегион: EU'] },
  { shop: 'cifra-nord', title: 'Облачное хранилище 2 ТБ, 12 месяцев', kind: 'subscription', cat: 3, sol: 3.2, stars: 320, warranty: 30, sla: 6,
    description: 'Годовая подписка на облако: 2 ТБ, совместная работа, версионирование файлов.',
    stock: ['Код активации: CLD-2TB-9921-MKQA-7712', 'Код активации: CLD-2TB-3390-ZXPL-1188'] },
  { shop: 'cifra-nord', title: 'Курс «Цифровой маркетинг 2026»', kind: 'file', cat: 6, sol: 4.5, stars: 450, warranty: 7, sla: 12,
    description: 'Доступ к 42 урокам, шаблонам и чату курса. Пожизненный доступ после активации.',
    stock: ['Архив: https://cdn.sitee.dev/dl/mkt-2026.zip\nПароль: 8Hd2-LmQ9-Xz41'] },
  { shop: 'almaty-keys', title: 'Аккаунт игрового сервиса (уровень 30+)', kind: 'account', cat: 2, sol: 2.8, stars: 280, warranty: 14, sla: 4,
    description: 'Прокачанный аккаунт с библиотекой из 12 игр, полная смена почты и пароля на ваши.',
    stock: ['Логин: gamer.almaty.07\nПароль: Kz#72mQp9L\nПочта: reserve.07@mail.dev / Pass!8821', 'Логин: gamer.almaty.19\nПароль: Rt%41xNq7B\nПочта: reserve.19@mail.dev / Pass!3390'] },
  { shop: 'almaty-keys', title: 'Пополнение игрового кошелька 1000 монет', kind: 'service_code', cat: 5, sol: 0.6, stars: 60, warranty: 3, sla: 2,
    description: 'Зачисление 1000 внутриигровых монет на ваш аккаунт. Нужен только ID профиля.',
    stock: ['Код услуги: SVC-1000-7731-XX', 'Код услуги: SVC-1000-2290-QM', 'Код услуги: SVC-1000-8812-LP'] },
  { shop: 'game-vault', title: 'Ключ активации RPG-новинки (PC)', kind: 'key', cat: 5, sol: 5.5, stars: 550, warranty: 30, sla: 1,
    description: 'Цифровой ключ PC-версии, активация в лаунчере, региональных ограничений нет.',
    stock: ['RPG26-PC-A71M-99QX-2KL0-77HD', 'RPG26-PC-B22N-10LM-88PQ-33ZK'] },
  { shop: 'game-vault', title: 'Сезонный пропуск, 3 месяц', kind: 'subscription', cat: 5, sol: 1.1, stars: 110, warranty: 7, sla: 2,
    description: 'Пропуск на сезон: эксклюзивные награды, ускоренная прокачка, бонусные задания.',
    stock: ['PASS-S3-9912-MKQA-7781', 'PASS-S3-3390-ZXPL-1122', 'PASS-S3-5581-QWRT-9903'] },
  { shop: 'soft-license', title: 'Профессиональный графический пакет, 1 год', kind: 'subscription', cat: 7, sol: 8.9, stars: 890, warranty: 30, sla: 24,
    description: 'Годовая лицензия на профессиональный графический редактор: коммерческое использование разрешено.',
    stock: ['Лицензия: GFX-PRO-2026-88121-KLMQ9'] },
  { shop: 'proxy-nord', title: 'Персональный прокси, 1 месяц (10 локаций)', kind: 'custom', cat: 12, sol: 1.8, stars: 180, warranty: 30, sla: 2,
    description: 'Выделенный прокси с 10 локациями, безлимитный трафик, замена узла по запросу.',
    stock: ['Логин: sitee_proxy_8842\nПароль: Px#9921mK\nСерверы: NL, DE, SE, NO, FI, PL, TR, US, GB, JP', 'Логин: sitee_proxy_1190\nПароль: Qz!7712pL'] },
  { shop: 'proxy-nord', title: 'VPN-подписка Premium, 6 месяцев', kind: 'subscription', cat: 12, sol: 2.2, stars: 220, warranty: 30, sla: 1,
    description: '6 месяцев VPN: 60+ стран, WireGuard, kill switch, 5 устройств одновременно.',
    stock: ['VPN-PREM-6M-7712-KLMQ-9981', 'VPN-PREM-6M-3390-ZXPL-1102'] },
  { shop: 'key-master', title: 'Готовый аккаунт стриминга (EU, премиум)', kind: 'account', cat: 2, sol: 3.4, stars: 340, warranty: 14, sla: 3,
    description: 'Аккаунт стримингового сервиса с премиум-подпиской до конца года, регион EU.',
    stock: ['Логин: stream.eu.44@mail.dev\nПароль: Nm!2287Qx\nПодписка: Premium до 2026-12-31'] },
];

const GIFTS = [
  { sku: 'gift-rocket', title: 'Ракета', en: 'Rocket', rarity: 'common', emoji: '🚀', stars: 50, sol: 0.5, boost: 0.05, days: 3, desc: 'Ускорьте магазин: небольшой буст в ленте.' },
  { sku: 'gift-fire', title: 'Огонь', en: 'Fire', rarity: 'common', emoji: '🔥', stars: 30, sol: 0.3, boost: 0, days: 0, desc: 'Знак горячей поддержки покупателей.' },
  { sku: 'gift-headphones', title: 'Наушники', en: 'Headphones', rarity: 'common', emoji: '🎧', stars: 75, sol: 0.75, boost: 0, days: 0, desc: 'Для магазинов с музыкой и аудио-товарами.' },
  { sku: 'gift-chest', title: 'Сундук', en: 'Chest', rarity: 'rare', emoji: '🎁', stars: 200, sol: 2, boost: 0.12, days: 7, desc: 'Сундук с бонусами: заметный буст в выдаче.' },
  { sku: 'gift-diamond', title: 'Бриллиант', en: 'Diamond', rarity: 'rare', emoji: '💎', stars: 250, sol: 2.5, boost: 0.15, days: 7, desc: 'Редкий подарок для проверенных продавцов.', collectible: true },
  { sku: 'gift-trophy', title: 'Кубок', en: 'Trophy', rarity: 'epic', emoji: '🏆', stars: 500, sol: 5, boost: 0.25, days: 10, desc: 'Эпический кубок: сильный буст и статус.' },
  { sku: 'gift-superstar', title: 'Суперзвезда', en: 'Superstar', rarity: 'epic', emoji: '🌟', stars: 900, sol: 9, boost: 0.35, days: 14, desc: 'Магазин сияет в ленте 14 дней.', collectible: true },
  { sku: 'gift-crown', title: 'Корона', en: 'Crown', rarity: 'legendary', emoji: '👑', stars: 1500, sol: 15, boost: 0.6, days: 14, desc: 'Легендарная корона: максимум внимания покупателей.', collectible: true, limit: 3 },
];

const REVIEWS = [
  { shop: 'key-master', author: 'buyer_nova', rating: 5, d: 5, desc: 5, s: 5, days: 4, helpful: 12,
    body: 'Ключ пришёл через минуту после оплаты, активировался без проблем. Продавец ответил в чате за 10 минут.',
    reply: 'Спасибо за отзыв! Обращайтесь — продлим и настроим.' },
  { shop: 'key-master', author: 'buyer_max', rating: 5, d: 5, desc: 5, s: 4, days: 9, helpful: 7,
    body: 'Второй заказ, всё чётко. Автовыдача работает ночью — это главное.' },
  { shop: 'key-master', author: 'buyer_nova', rating: 4, d: 4, desc: 5, s: 4, days: 16, helpful: 3,
    body: 'Office встал с первой попытки, но ответа в чате ждал около часа.' },
  { shop: 'cifra-nord', author: 'buyer_max', rating: 5, d: 5, desc: 4, s: 5, days: 3, helpful: 9,
    body: 'Подписка на музыку работает, регион EU как и обещали. Помогли с входом.',
    reply: 'Рады помочь! Если смените устройство — пишите.' },
  { shop: 'cifra-nord', author: 'buyer_nova', rating: 4, d: 4, desc: 4, s: 5, days: 11, helpful: 2,
    body: 'Облако 2 ТБ активировалось, инструкция понятная. Хотелось бы быстрее выдачу.' },
  { shop: 'almaty-keys', author: 'buyer_nova', rating: 5, d: 5, desc: 5, s: 5, days: 2, helpful: 5,
    body: 'Аккаунт передали с полной сменой почты, всё по инструкции. Поддержка на русском.' },
  { shop: 'game-vault', author: 'buyer_max', rating: 4, d: 5, desc: 4, s: 4, days: 6, helpful: 4,
    body: 'Ключ игры пришёл мгновенно, активировался. Минус балл за скудное описание региона.' },
  { shop: 'proxy-nord', author: 'buyer_nova', rating: 5, d: 5, desc: 5, s: 5, days: 5, helpful: 11,
    body: 'Прокси работают стабильно, локаций реально 10. Узел заменили за 40 минут по запросу.',
    reply: 'Спасибо! Держим SLA.' },
  { shop: 'proxy-nord', author: 'buyer_max', rating: 3, d: 3, desc: 4, s: 3, days: 13, helpful: 1,
    body: 'VPN неплохой, но выдача заняла почти сутки вместо обещанных часов.' },
  { shop: 'soft-license', author: 'buyer_max', rating: 2, d: 2, desc: 3, s: 2, days: 20, helpful: 0,
    body: 'Лицензию ждал два дня, магазин сейчас недоступен из-за аренды.' },
];

const COUNTRIES = [
  ['RU', 'Россия', 'Russia'], ['BY', 'Беларусь', 'Belarus'], ['KZ', 'Казахстан', 'Kazakhstan'],
  ['GE', 'Грузия', 'Georgia'], ['AM', 'Армения', 'Armenia'], ['UZ', 'Узбекистан', 'Uzbekistan'],
  ['TR', 'Турция', 'Turkey'], ['AE', 'ОАЭ', 'United Arab Emirates'], ['DE', 'Германия', 'Germany'],
  ['NL', 'Нидерланды', 'Netherlands'], ['NO', 'Норвегия', 'Norway'], ['SE', 'Швеция', 'Sweden'],
  ['FI', 'Финляндия', 'Finland'], ['PL', 'Польша', 'Poland'], ['GB', 'Великобритания', 'United Kingdom'],
  ['US', 'США', 'United States'], ['IN', 'Индия', 'India'], ['BR', 'Бразилия', 'Brazil'],
  ['CN', 'Китай', 'China'], ['IR', 'Иран', 'Iran'],
];

const CITIES = [
  [1001, 'RU', 'Москва', 'Moscow', 'Europe/Moscow'], [1002, 'RU', 'Санкт-Петербург', 'Saint Petersburg', 'Europe/Moscow'],
  [1003, 'RU', 'Новосибирск', 'Novosibirsk', 'Asia/Novosibirsk'], [1004, 'RU', 'Екатеринбург', 'Yekaterinburg', 'Asia/Yekaterinburg'],
  [1005, 'RU', 'Казань', 'Kazan', 'Europe/Moscow'], [1006, 'RU', 'Сочи', 'Sochi', 'Europe/Moscow'],
  [2001, 'BY', 'Минск', 'Minsk', 'Europe/Minsk'], [3001, 'KZ', 'Алматы', 'Almaty', 'Asia/Almaty'],
  [3002, 'KZ', 'Астана', 'Astana', 'Asia/Almaty'], [4001, 'GE', 'Тбилиси', 'Tbilisi', 'Asia/Tbilisi'],
  [7001, 'TR', 'Стамбул', 'Istanbul', 'Europe/Istanbul'], [8001, 'AE', 'Дубай', 'Dubai', 'Asia/Dubai'],
  [8501, 'DE', 'Берлин', 'Berlin', 'Europe/Berlin'], [8601, 'NL', 'Амстердам', 'Amsterdam', 'Europe/Amsterdam'],
  [9001, 'NO', 'Осло', 'Oslo', 'Europe/Oslo'], [9002, 'NO', 'Берген', 'Bergen', 'Europe/Oslo'],
  [9003, 'NO', 'Саннефьорд', 'Sandefjord', 'Europe/Oslo'], [9004, 'NO', 'Тронхейм', 'Trondheim', 'Europe/Oslo'],
  [9101, 'SE', 'Стокгольм', 'Stockholm', 'Europe/Stockholm'], [9201, 'FI', 'Хельсинки', 'Helsinki', 'Europe/Helsinki'],
  [9301, 'PL', 'Варшава', 'Warsaw', 'Europe/Warsaw'], [9401, 'GB', 'Лондон', 'London', 'Europe/London'],
  [9501, 'US', 'Нью-Йорк', 'New York', 'America/New_York'],
  [9001, 'CN', 'Пекин', 'Beijing', 'Asia/Shanghai'], [9002, 'IR', 'Тегеран', 'Tehran', 'Asia/Tehran'],
];

// [id, slug, ru, en, restricted(18+), blocked_countries] — FR-GEO-03(б):
// чёрный список юрисдикций настраивается в админке.
const CATEGORIES = [
  [1, 'keys', 'Ключи и активации', 'Keys & activations', false, []],
  [2, 'accounts', 'Аккаунты', 'Accounts', true, []],
  [3, 'software', 'Программы', 'Software', false, []],
  [4, 'subscriptions', 'Подписки', 'Subscriptions', false, []],
  [5, 'gaming', 'Игровые товары', 'Gaming', false, []],
  [6, 'education', 'Обучение и курсы', 'Education', false, []],
  [7, 'design', 'Дизайн и графика', 'Design & graphics', false, []],
  [8, 'music', 'Музыка и аудио', 'Music & audio', false, []],
  [9, 'crypto-tools', 'Крипто-инструменты', 'Crypto tools', true, ['US']],
  [10, 'services', 'Услуги', 'Services', false, []],
  [11, 'files', 'Файлы и шаблоны', 'Files & templates', false, []],
  [12, 'vpn-proxy', 'VPN и прокси', 'VPN & proxy', false, ['CN', 'IR']],
];

const RENT_PLANS = [
  { code: 'starter', name_ru: 'Стартовый', name_en: 'Starter', sol: 5, stars: 500, products: 5, operators: 1, fee_bps: 700, boost: 0, crown: false, sla: 48,
    description: 'Для первого магазина: до 5 товаров, комиссия 7 %, пробный период 7 дней.' },
  { code: 'pro', name_ru: 'Профи', name_en: 'Pro', sol: 19, stars: 1900, products: 25, operators: 3, fee_bps: 500, boost: 0.15, crown: false, sla: 24,
    description: 'До 25 товаров, комиссия 5 %, буст в ленте, поддержка 24 ч.' },
  { code: 'crown', name_ru: 'Корона', name_en: 'Crown', sol: 49, stars: 4900, products: 100, operators: 10, fee_bps: 350, boost: 0.3, crown: true, sla: 12,
    description: 'Коронка в ленте при рейтинге ≥ 4.0, до 100 товаров, комиссия 3.5 %.' },
  { code: 'enterprise', name_ru: 'Бизнес', name_en: 'Enterprise', sol: 149, stars: 14900, products: 500, operators: 25, fee_bps: 250, boost: 0.35, crown: true, sla: 6,
    description: 'Максимум возможностей: 500 товаров, комиссия 2.5 %, верификация, SLA 6 ч.' },
];

const ALIAS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function aliasFor(salt, userId, role) {
  const mac = C.hmacSha256(Buffer.from('sitee-dispute-alias-v1:' + salt), Buffer.from(userId));
  let code = '';
  for (let i = 0; i < 3; i += 1) code += ALIAS_ALPHABET[mac[i] % ALIAS_ALPHABET.length];
  if (role === 'buyer') return `Покупатель #${code}`;
  if (role === 'shop') return `Продавец #${code}`;
  return `Участник #${code}`;
}

// ---------------------------------------------------------------------------
// Ledger двойной записи (docs/economy.md §2)
// ---------------------------------------------------------------------------
const account = (owner, id, asset) => `${owner}:${id}:${asset}`;

export const ACC = {
  user: (id, asset) => account('user', id, asset),
  shop: (id, asset) => account('shop', id, asset),
  escrow: (id, asset) => account('escrow', id, asset),
  platform: (name, asset) => account('platform', name, asset),
};

export class Ledger {
  constructor() {
    this.accounts = new Map();
    this.entries = [];
    this.seen = new Set();
  }

  ensure(owner, id, asset) {
    const key = account(owner, id, asset);
    if (!this.accounts.has(key)) {
      this.accounts.set(key, { id: key, owner_type: owner, owner_id: id, asset, balance: 0, version: 0 });
    }
    return this.accounts.get(key);
  }

  balance(key) {
    return this.accounts.get(key)?.balance ?? 0;
  }

  userBalance(userId, asset) {
    return this.balance(ACC.user(userId, asset));
  }

  post(idem, asset, kind, refType, refId, actorId, postings) {
    if (!idem) return { error: 'EMPTY_IDEMPOTENCY_KEY' };
    if (this.seen.has(idem)) return { error: 'ALREADY_USED' };
    let debits = 0;
    let credits = 0;
    for (const p of postings) {
      if (!(p.amount > 0)) return { error: 'BAD_AMOUNT' };
      const acc = this.accounts.get(p.account);
      if (!acc) return { error: 'UNKNOWN_ACCOUNT', detail: p.account };
      if (acc.asset !== asset) return { error: 'ASSET_MISMATCH' };
      if (p.direction === 'debit') {
        debits += p.amount;
        if (acc.owner_type !== 'platform' && acc.balance < p.amount) return { error: 'INSUFFICIENT_FUNDS' };
      } else credits += p.amount;
    }
    if (debits !== credits) return { error: 'UNBALANCED' };
    const txId = C.newId('tx');
    const ts = new Date().toISOString();
    for (const p of postings) {
      const acc = this.accounts.get(p.account);
      acc.balance += p.direction === 'debit' ? -p.amount : p.amount;
      acc.version += 1;
      this.entries.push({
        id: C.newId('led'), tx_id: txId, idempotency_key: idem, ts, account_id: acc.id,
        direction: p.direction, amount: p.amount, asset, kind, ref_type: refType,
        ref_id: refId, actor_id: actorId,
      });
    }
    this.seen.add(idem);
    return { tx_id: txId };
  }

  // external — зачисление извне двойной записи (депозит из блокчейна, покупка Stars).
  external(key, amount) {
    const acc = this.accounts.get(key);
    if (!acc) return false;
    acc.balance += amount;
    acc.version += 1;
    return true;
  }

  debit(a, amount) { return { account: a, direction: 'debit', amount }; }
  credit(a, amount) { return { account: a, direction: 'credit', amount }; }

  userEntries(userId, limit = 50) {
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const e = this.entries[i];
      if (e.account_id.startsWith(`user:${userId}:`)) out.push(e);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Создание БД
// ---------------------------------------------------------------------------
export function createDb() {
  const now = Date.now();
  const db = {
    createdAt: new Date().toISOString(),
    ledger: new Ledger(),
    countries: new Map(), cities: new Map(), categories: new Map(), rentPlans: new Map(),
    users: new Map(), usersByNick: new Map(), usersByMail: new Map(),
    shops: new Map(), shopsBySlug: new Map(), subs: new Map(),
    products: new Map(), stock: new Map(),
    orders: new Map(), ordersByNumber: new Map(), orderStatuses: [],
    chats: new Map(), members: new Map(), messages: new Map(),
    prekeys: new Map(), e2eeSessions: new Map(),
    disputes: new Map(), gifts: new Map(), giftPurchases: new Map(),
    reviews: new Map(), reports: new Map(),
    withdrawals: new Map(), solTxs: new Map(), quotes: new Map(),
    notifications: new Map(), authEvents: [], audit: [], auditHead: '',
    sessions: new Map(), refresh: new Map(), enrollments: new Map(),
    settings: new Map(), idempotency: new Map(), userSeq: 0,
  };

  for (const [code, ru, en] of COUNTRIES) db.countries.set(code, { code, name_ru: ru, name_en: en });
  for (const [id, country, ru, en, tz] of CITIES) db.cities.set(id, { id, country, name_ru: ru, name_en: en, tz });
  for (const [id, slug, ru, en, restricted, blocked] of CATEGORIES) {
    db.categories.set(id, { id, slug, name_ru: ru, name_en: en, restricted, blocked_countries: [...blocked] });
  }
  for (const p of RENT_PLANS) {
    const plan = { ...p, id: C.newId('pln'), price_sol: Math.round(p.sol * C.LAMPORTS_PER_SOL), price_stars: p.stars, active: true };
    db.rentPlans.set(plan.id, plan);
    db.rentPlans.set(plan.code, plan); // удобный поиск по коду
  }
  for (const [k, v] of Object.entries({
    registration_open: true, rent_trial_days: 7, max_shops_per_account: 3,
    default_fee_bps: 700, gift_boost_max: 0.6, promoted_slots_per_page: 1,
    maintenance_mode: false, withdrawals_frozen: false,
  })) db.settings.set(k, v);

  // Пользователи + двойной 2FA.
  const usersByNick = {};
  USERS.forEach((spec, i) => {
    const id = C.newId('usr');
    db.userSeq += 1;
    const loginSecret = C.newTotpSecret();
    const opsSecret = C.newTotpSecret();
    const loginBackup = C.backupCodes(10);
    const opsBackup = C.backupCodes(10);
    const path = C.depositPath(db.userSeq);
    const user = {
      id, email_ct: C.encrypt(C.DOMAINS.pii, id, spec.email), email_idx: C.blindIndex(spec.email),
      email: spec.email, // для демо-выдачи (в prod не хранится открытым)
      nickname: spec.nick, password_hash: C.hashPassword(spec.password), role: spec.role,
      country: spec.country, city_id: spec.city_id, locale: 'ru', theme: 'dark', status: 'active',
      seq: db.userSeq, deposit_path: path, deposit_address: C.addressForPath(path),
      is_18plus: true, risk_score: 0, unread_chats: 0,
      created_at: new Date(now - (40 + i * 3) * DAY).toISOString(),
      last_login_at: new Date(now - i * HOUR).toISOString(),
      warmup_until: null,
      factors: {
        login: {
          name: 'login', status: 'active', secret_ct: C.encrypt(C.DOMAINS.totp, `${id}:login`, loginSecret.toString('base64')),
          secret_b32: C.secretBase32(loginSecret), backup_hashes: loginBackup.hashes, backup_used: {},
          used_codes: {}, otpauth_url: C.otpAuthUrl('SITEE', spec.nick, C.secretBase32(loginSecret), 'SITEE (вход)'),
          enrolled_at: new Date(now - 30 * DAY).toISOString(),
        },
        ops: {
          name: 'ops', status: 'active', secret_ct: C.encrypt(C.DOMAINS.totp, `${id}:ops`, opsSecret.toString('base64')),
          secret_b32: C.secretBase32(opsSecret), backup_hashes: opsBackup.hashes, backup_used: {},
          used_codes: {}, otpauth_url: C.otpAuthUrl('SITEE', spec.nick, C.secretBase32(opsSecret), 'SITEE (операции)'),
          enrolled_at: new Date(now - 30 * DAY).toISOString(),
        },
      },
      _demo: { password: spec.password, login_backup: loginBackup.codes, ops_backup: opsBackup.codes },
    };
    db.users.set(id, user);
    db.usersByNick.set(spec.nick, id);
    db.usersByMail.set(user.email_idx, id);
    usersByNick[spec.nick] = user;
    db.ledger.ensure('user', id, 'SOL');
    db.ledger.ensure('user', id, 'STARS');
    db.notifications.set(id, []);
  });
  db.ledger.ensure('platform', 'custody', 'SOL');
  db.ledger.ensure('platform', 'stars_reserve', 'STARS');
  db.ledger.ensure('platform', 'fees', 'SOL');
  db.ledger.ensure('platform', 'fees', 'STARS');
  db.ledger.ensure('platform', 'rent', 'SOL');
  db.ledger.ensure('platform', 'withdrawals_pending', 'SOL');
  db.ledger.ensure('platform', 'gift_revenue', 'STARS');
  db.ledger.ensure('platform', 'gift_revenue', 'SOL');
  for (const spec of USERS) {
    const u = usersByNick[spec.nick];
    if (spec.sol > 0) {
      const lamports = Math.round(spec.sol * C.LAMPORTS_PER_SOL);
      db.ledger.post(`seed:balance:${u.id}:SOL`, 'SOL', 'seed', 'user', u.id, '', [
        db.ledger.debit(ACC.platform('custody', 'SOL'), lamports),
        db.ledger.credit(ACC.user(u.id, 'SOL'), lamports),
      ]);
    }
    if (spec.stars > 0) {
      db.ledger.post(`seed:balance:${u.id}:STARS`, 'STARS', 'seed', 'user', u.id, '', [
        db.ledger.debit(ACC.platform('stars_reserve', 'STARS'), spec.stars),
        db.ledger.credit(ACC.user(u.id, 'STARS'), spec.stars),
      ]);
    }
  }

  // Магазины + аренда.
  const shopsBySlug = {};
  SHOPS.forEach((spec, i) => {
    const admin = usersByNick[spec.admin];
    const id = C.newId('shp');
    const city = db.cities.get(spec.city_id);
    const shop = {
      id, admin_user_id: admin.id, slug: spec.slug, name: spec.name, description: spec.description,
      category_ids: spec.categories, country: spec.country, city_id: spec.city_id, tz: city?.tz ?? 'Europe/Moscow',
      status: spec.rent === 'suspended' ? 'suspended' : 'active', is_verified: spec.verified,
      accepts_stars: true, sanction_level: 'none', accent: spec.accent, cover_url: '', avatar_url: '',
      rating_sum: 0, rating_count: 0, rating_bayes: 3.8, sales_count: 0, sales_volume_sol: 0,
      response_p50_s: 600 + i * 120, dispute_rate: 0, gift_boost: 0, gift_boost_until: null,
      complaint_penalty: 0, dispute_loss_penalty: 0, feed_score: 0, operators: [],
      created_at: new Date(now - (30 + i * 2) * DAY).toISOString(), updated_at: new Date(now).toISOString(),
    };
    db.shops.set(id, shop);
    db.shopsBySlug.set(spec.slug, id);
    shopsBySlug[spec.slug] = shop;
    const plan = db.rentPlans.get(spec.plan);
    const periodStart = new Date(now - (20 + i * 4) * DAY);
    const periodEnd = new Date(now + spec.rent_days * DAY);
    db.subs.set(id, {
      id: C.newId('sub'), shop_id: id, plan_id: plan.id, status: spec.rent, asset: 'SOL',
      price_sol: plan.price_sol, price_stars: plan.price_stars,
      period_start: periodStart.toISOString(), period_end: periodEnd.toISOString(),
      grace_end: spec.rent === 'suspended' ? new Date(now - DAY).toISOString() : null,
      auto_renew: spec.rent === 'active', renew_attempts: 0,
      created_at: periodStart.toISOString(), updated_at: new Date(now).toISOString(),
    });
    db.ledger.post(`seed:rent:${id}`, 'SOL', 'seed', 'shop', id, '', [
      db.ledger.debit(ACC.platform('custody', 'SOL'), plan.price_sol),
      db.ledger.credit(ACC.platform('rent', 'SOL'), plan.price_sol),
    ]);
  });

  // Товары + зашифрованный сток.
  const products = [];
  PRODUCTS.forEach((spec, i) => {
    const shop = shopsBySlug[spec.shop];
    const id = C.newId('prd');
    const product = {
      id, shop_id: shop.id, title: spec.title, description: spec.description, kind: spec.kind,
      category_id: spec.cat, price_sol: Math.round(spec.sol * C.LAMPORTS_PER_SOL), price_stars: spec.stars,
      warranty_days: spec.warranty, delivery_sla_h: spec.sla, status: 'published',
      stock_total: spec.stock.length, stock_free: spec.stock.length, media_urls: [],
      rating_sum: 0, rating_count: 0, moderation_note: '',
      created_at: new Date(now - (10 + i) * DAY).toISOString(), updated_at: new Date(now).toISOString(),
    };
    db.products.set(id, product);
    products.push(product);
    db.stock.set(id, spec.stock.map((payload) => {
      const itemId = C.newId('stk');
      return {
        id: itemId, product_id: id, status: 'free',
        payload_ct: C.encrypt(C.DOMAINS.stock, itemId, payload),
        created_at: product.created_at,
      };
    }));
  });

  // Подарки.
  GIFTS.forEach((spec, i) => {
    const id = C.newId('gft');
    db.gifts.set(id, {
      id, sku: spec.sku, title_ru: spec.title, title_en: spec.en, description: spec.desc,
      rarity: spec.rarity, emoji: spec.emoji, media_url: '', media_kind: 'emoji',
      price_stars: spec.stars, price_sol: Math.round(spec.sol * C.LAMPORTS_PER_SOL),
      per_user_limit: spec.limit ?? 0, boosts_shop: spec.boost > 0, boost_value: spec.boost,
      boost_days: spec.days, collectible: !!spec.collectible, status: 'published', sort: i + 1,
      created_by: usersByNick.sitee_admin.id,
      created_at: new Date(now - 30 * DAY).toISOString(), updated_at: new Date(now).toISOString(),
    });
  });

  // Отзывы + рейтинг по Байесу (C=10, m=3.8).
  REVIEWS.forEach((spec) => {
    const shop = shopsBySlug[spec.shop];
    const author = usersByNick[spec.author];
    const created = new Date(now - spec.days * DAY);
    const id = C.newId('rev');
    db.reviews.set(id, {
      id, order_id: '', shop_id: shop.id, product_id: '', author_id: author.id,
      rating: spec.rating, rating_delivery: spec.d, rating_description: spec.desc,
      rating_support: spec.s, body: spec.body, is_verified_purchase: true,
      shop_reply: spec.reply ?? '', shop_reply_at: spec.reply ? new Date(created.getTime() + 6 * HOUR).toISOString() : null,
      status: 'published', helpful_count: spec.helpful, created_at: created.toISOString(),
    });
  });
  for (const shop of db.shops.values()) {
    let sum = 0;
    let count = 0;
    for (const rv of db.reviews.values()) {
      if (rv.shop_id !== shop.id) continue;
      sum += rv.rating;
      count += 1;
    }
    shop.rating_sum = sum;
    shop.rating_count = count;
    shop.rating_bayes = (10 * 3.8 + sum) / (10 + count);
  }

  // Диалоги: канал + поддержка для каждого магазина.
  const addMessage = (chat, sender, text, at, type = 'text', system = null) => {
    chat.last_seq += 1;
    const id = C.newId('msg');
    const msg = {
      id, chat_id: chat.id, seq: chat.last_seq, sender_id: sender?.id ?? '',
      sender_visible_as: sender?.nickname ?? 'Система', type,
      body_ct: C.encrypt(C.DOMAINS.message, id, text), body_size: text.length,
      e2ee: false, client_msg_id: '', created_at: at.toISOString(), system,
    };
    if (!db.messages.has(chat.id)) db.messages.set(chat.id, []);
    db.messages.get(chat.id).push(msg);
    chat.last_message_at = at.toISOString();
    chat.last_preview = text.slice(0, 80);
    return msg;
  };
  const channelPosts = [
    'Скидка 15 % на ключи Windows до конца недели — промо применяется автоматически при оплате.',
    'Добавили годовые подписки на облако 2 ТБ: выдача в течение 6 часов, гарантия 30 дней.',
    'Новые игровые аккаунты с полной сменой почты. Поддержка отвечает на русском и казахском.',
    'Сезонные пропуска в наличии: автовыдача круглосуточно, гарантия замены 7 дней.',
    'Магазин на паузе: продлеваем аренду, скоро вернёмся с новыми лицензиями.',
    'Персональные прокси: 10 локаций, замена узла по запросу в течение часа.',
  ];
  const questions = [
    'Здравствуйте! Ключ Windows подходит для активации на уже установленной системе?',
    'Добрый день. Подписка на музыку — какой регион и можно ли менять устройство?',
    'Привет! Аккаунт передаёте с полной сменой почты? Сколько занимает выдача?',
    'Здравствуйте, сезонный пропуск активируется в любом регионе?',
    'Добрый день! Лицензия графического пакета допускает коммерческое использование?',
    'Привет! Прокси поддерживает WireGuard и сколько устройств можно подключить?',
  ];
  const answers = [
    'Да, ключ активирует уже установленную систему. После оплаты код придёт автоматически в чат заказа.',
    'Регион EU, устройство можно менять — привязка к аккаунту. Инструкция придёт вместе с данными.',
    'Да, меняем почту и пароль на ваши, выдача обычно в течение 4 часов. Все данные — в зашифрованном сообщении.',
    'Пропуск без региональных ограничений, активация в лаунчере. Гарантия замены 7 дней.',
    'Да, коммерческое использование разрешено в течение срока лицензии.',
    'WireGuard поддерживается, до 5 устройств одновременно. Узел заменим по запросу.',
  ];
  const member = (chatId, userId, role, visibleAs = '') => ({
    chat_id: chatId, user_id: userId, role, visible_as: visibleAs,
    joined_at: new Date(now).toISOString(), left_at: null, last_read_seq: 0, muted: false, blocked: false,
  });

  const supportChats = new Map();
  SHOPS.forEach((spec, i) => {
    const shop = shopsBySlug[spec.slug];
    const admin = db.users.get(shop.admin_user_id);
    const channel = {
      id: C.newId('cht'), kind: 'channel', title: `${shop.name} · анонсы`, shop_id: shop.id,
      admin_user_id: shop.admin_user_id, e2ee: false, last_seq: 0, created_at: new Date(now - (20 + i) * DAY).toISOString(),
    };
    db.chats.set(channel.id, channel);
    db.members.set(channel.id, [member(channel.id, admin.id, 'owner')]);
    for (const nick of ['buyer_nova', 'buyer_max']) {
      db.members.get(channel.id).push(member(channel.id, usersByNick[nick].id, 'subscriber'));
    }
    db.messages.set(channel.id, []);
    addMessage(channel, admin, `Добро пожаловать в канал «${shop.name}»! Здесь — акции и новые товары.`, new Date(now - 3 * DAY));
    addMessage(channel, admin, channelPosts[i % channelPosts.length], new Date(now - 12 * HOUR));

    const buyer = usersByNick[i % 2 === 1 ? 'buyer_max' : 'buyer_nova'];
    const support = {
      id: C.newId('cht'), kind: 'shop_support', title: `${shop.name} · поддержка`, shop_id: shop.id,
      admin_user_id: shop.admin_user_id, e2ee: false, last_seq: 0,
      created_at: new Date(now - (5 + i) * DAY).toISOString(),
    };
    db.chats.set(support.id, support);
    db.members.set(support.id, [
      member(support.id, admin.id, 'admin', 'Админ магазина'),
      member(support.id, buyer.id, 'member'),
    ]);
    db.messages.set(support.id, []);
    addMessage(support, buyer, questions[i % questions.length], new Date(now - 5 * HOUR));
    addMessage(support, admin, answers[i % answers.length], new Date(now - 4 * HOUR - 20 * 60000));
    supportChats.set(shop.id, support.id);
  });

  // Заказы в разных статусах + спор с маскировкой.
  const orderSpecs = [
    { number: 'SITEE-1001', buyer: 'buyer_nova', shop: 'key-master', product: 0, qty: 1, status: 'completed', asset: 'SOL', minutesAgo: 4 * 24 * 60, delivered: true },
    { number: 'SITEE-1002', buyer: 'buyer_nova', shop: 'cifra-nord', product: 3, qty: 1, status: 'delivered', asset: 'STARS', minutesAgo: 20 * 60, delivered: true },
    { number: 'SITEE-1003', buyer: 'buyer_max', shop: 'game-vault', product: 8, qty: 1, status: 'processing', asset: 'SOL', minutesAgo: 3 * 60 },
    { number: 'SITEE-1004', buyer: 'buyer_max', shop: 'key-master', product: 1, qty: 1, status: 'dispute_opened', asset: 'SOL', minutesAgo: 30 * 60, delivered: true, dispute: true },
    { number: 'SITEE-1005', buyer: 'buyer_nova', shop: 'almaty-keys', product: 6, qty: 1, status: 'awaiting_payment', asset: 'STARS', minutesAgo: 8 },
    { number: 'SITEE-1006', buyer: 'buyer_max', shop: 'proxy-nord', product: 11, qty: 2, status: 'paid_escrow', asset: 'SOL', minutesAgo: 2 * 60 },
  ];
  for (const spec of orderSpecs) {
    const shop = shopsBySlug[spec.shop];
    const buyer = usersByNick[spec.buyer];
    const product = products[spec.product];
    const created = new Date(now - spec.minutesAgo * 60000);
    const id = C.newId('ord');
    const feeBps = db.rentPlans.get(db.subs.get(shop.id)?.plan_id)?.fee_bps ?? 700;
    const order = {
      id, number: spec.number, buyer_id: buyer.id, shop_id: shop.id, status: spec.status,
      items: [], pay_asset: spec.asset, delivery_kind: 'auto', fee_bps: feeBps,
      created_at: created.toISOString(), updated_at: created.toISOString(),
      extend_used: false, paid_at: null, delivered_at: null, completed_at: null, cancelled_at: null,
      pay_deadline: null, delivery_deadline: null, confirm_deadline: null, dispute_id: '', review_id: '',
    };
    const unitSol = product.price_sol;
    const unitStars = product.price_stars;
    const item = {
      id: C.newId('oit'), product_id: product.id, title: product.title, qty: spec.qty,
      unit_price_sol: unitSol, unit_price_stars: unitStars, stock_item_ids: [],
      delivered_payload_ct: '', delivered_at: null, download_count: 0,
    };
    order.items = [item];
    if (spec.asset === 'STARS') {
      order.subtotal_stars = unitStars * spec.qty;
      order.fee_stars = Math.round((order.subtotal_stars * feeBps) / 10000);
      order.total_stars = order.subtotal_stars + order.fee_stars;
      order.subtotal_sol = 0; order.fee_sol = 0; order.total_sol = 0;
    } else {
      order.subtotal_sol = unitSol * spec.qty;
      order.fee_sol = Math.round((order.subtotal_sol * feeBps) / 10000);
      order.total_sol = order.subtotal_sol + order.fee_sol;
      order.subtotal_stars = 0; order.fee_stars = 0; order.total_stars = 0;
    }
    const total = spec.asset === 'STARS' ? order.total_stars : order.total_sol;

    const chat = {
      id: C.newId('cht'), kind: 'order', title: `Заказ ${order.number}`, shop_id: shop.id,
      order_id: id, admin_user_id: shop.admin_user_id, e2ee: false, last_seq: 0,
      created_at: created.toISOString(),
    };
    order.chat_id = chat.id;
    db.chats.set(chat.id, chat);
    db.members.set(chat.id, [
      member(chat.id, shop.admin_user_id, 'admin', 'Админ магазина'),
      member(chat.id, buyer.id, 'member'),
    ]);
    db.messages.set(chat.id, []);
    const sys = (text, at, status = order.status) => addMessage(chat, null, text, at, 'system',
      { kind: 'order_status', order_id: id, status, title: text });
    sys(`Заказ ${order.number} создан. Все вопросы — админу магазина.`, created, 'created');

    db.orderStatuses.push({ order_id: id, from: '', to: 'created', actor_kind: 'system', ts: created.toISOString() });

    if (spec.status !== 'awaiting_payment') {
      order.paid_at = new Date(created.getTime() + 2 * 60000).toISOString();
      db.ledger.ensure('escrow', id, spec.asset);
      db.ledger.post(`seed:hold:${id}`, spec.asset, 'order_hold', 'order', id, buyer.id, [
        db.ledger.debit(ACC.user(buyer.id, spec.asset), total),
        db.ledger.credit(ACC.escrow(id, spec.asset), total),
      ]);
      sys('Оплата получена, средства в эскроу до подтверждения.', new Date(order.paid_at), 'paid_escrow');
      db.orderStatuses.push({ order_id: id, from: 'created', to: 'paid_escrow', actor_kind: 'buyer', ts: order.paid_at });
    } else {
      order.pay_deadline = new Date(created.getTime() + 30 * 60000).toISOString();
    }
    if (spec.status === 'processing') {
      order.delivery_deadline = new Date(new Date(order.paid_at).getTime() + product.delivery_sla_h * HOUR).toISOString();
      db.orderStatuses.push({ order_id: id, from: 'paid_escrow', to: 'processing', actor_kind: 'shop', ts: order.paid_at });
    }
    if (spec.delivered) {
      const items = db.stock.get(product.id);
      const payload = [];
      for (let k = 0; k < spec.qty && k < items.length; k += 1) {
        const si = items[k];
        si.status = 'sold';
        si.reserved_by = id;
        si.sold_at = new Date(new Date(order.paid_at).getTime() + 15 * 60000).toISOString();
        item.stock_item_ids.push(si.id);
        payload.push(C.tryDecrypt(C.DOMAINS.stock, si.id, si.payload_ct) ?? '');
      }
      product.stock_free = items.filter((x) => x.status === 'free').length;
      order.delivered_at = new Date(new Date(order.paid_at).getTime() + 15 * 60000).toISOString();
      order.confirm_deadline = new Date(new Date(order.delivered_at).getTime() + 72 * HOUR).toISOString();
      item.delivered_at = order.delivered_at;
      item.delivered_payload_ct = C.encrypt(C.DOMAINS.message, item.id, payload.join('\n---\n'));
      sys('Товар выдан автоматически. Проверьте данные и подтвердите заказ.', new Date(order.delivered_at), 'delivered');
      db.orderStatuses.push({ order_id: id, from: 'processing', to: 'delivered', actor_kind: 'system', ts: order.delivered_at });
    }
    if (spec.status === 'completed') {
      order.completed_at = new Date(new Date(order.delivered_at).getTime() + 3 * HOUR).toISOString();
      order.confirm_deadline = null;
      const fee = spec.asset === 'STARS' ? order.fee_stars : order.fee_sol;
      db.ledger.ensure('shop', shop.id, spec.asset);
      db.ledger.post(`seed:release:${id}`, spec.asset, 'order_release', 'order', id, buyer.id, [
        db.ledger.debit(ACC.escrow(id, spec.asset), total),
        db.ledger.credit(ACC.shop(shop.id, spec.asset), total - fee),
        db.ledger.credit(ACC.platform('fees', spec.asset), fee),
      ]);
      addMessage(chat, buyer, 'Всё работает, спасибо! Подтверждаю заказ.', new Date(order.completed_at));
      db.orderStatuses.push({ order_id: id, from: 'delivered', to: 'completed', actor_kind: 'buyer', ts: order.completed_at });
      shop.sales_count += spec.qty;
      shop.sales_volume_sol += order.total_sol;
    }
    if (spec.dispute) {
      const salt = C.hex(16);
      const disputeId = C.newId('dsp');
      const admin = db.users.get(shop.admin_user_id);
      const dchat = {
        id: C.newId('cht'), kind: 'dispute', title: `Спор по заказу ${order.number}`, shop_id: shop.id,
        order_id: id, dispute_id: disputeId, admin_user_id: shop.admin_user_id, e2ee: false, last_seq: 0,
        created_at: new Date(now - 2 * HOUR).toISOString(),
      };
      const buyerAlias = aliasFor(salt, buyer.id, 'buyer');
      const sellerAlias = aliasFor(salt, admin.id, 'shop');
      db.chats.set(dchat.id, dchat);
      db.members.set(dchat.id, [
        member(dchat.id, buyer.id, 'member', buyerAlias),
        member(dchat.id, admin.id, 'admin', sellerAlias),
      ]);
      db.messages.set(dchat.id, []);
      addMessage(dchat, null, 'Спор открыт: ключ не работает. Личные данные скрыты, стороны видят псевдонимы.',
        new Date(now - 2 * HOUR), 'system', { kind: 'dispute', order_id: id, title: 'Спор открыт' });
      addMessage(dchat, { id: buyer.id, nickname: buyerAlias },
        'Код SITEE-OFF24 уже использован — сервис выдаёт ошибку активации.', new Date(now - 115 * 60000));
      addMessage(dchat, { id: admin.id, nickname: sellerAlias },
        'Проверяю партию, готов заменить ключ в течение 24 часов.', new Date(now - 80 * 60000));
      const dispute = {
        id: disputeId, order_id: id, shop_id: shop.id, opened_by: buyer.id, reason_code: 'invalid_key',
        description: 'Ключ из заказа не активируется: сервис сообщает, что код уже использован. Прошу замену или возврат.',
        status: 'open', buyer_id: buyer.id, seller_id: admin.id, buyer_alias: buyerAlias,
        seller_alias: sellerAlias, arbiter_id: '', assigned_at: null,
        reply_deadline: new Date(now + 72 * HOUR).toISOString(), resolve_deadline: null,
        resolution: '', resolution_reason: '', resolved_at: null, chat_id: dchat.id, salt,
        evidence: [{
          id: C.newId('evd'), kind: 'image', uploader_id: buyer.id, sha256: C.hex(32), size: 20480,
          name: 'activation_error.png', meta_stripped: true, created_at: new Date(now - 114 * 60000).toISOString(),
          data_ct: C.encrypt(C.DOMAINS.dispute, 'evd', 'seed:demo-evidence'),
        }],
        timeline: [{ ts: new Date(now - 2 * HOUR).toISOString(), kind: 'opened', actor_id: buyer.id, actor_visible_as: buyerAlias, note: 'Ключ/аккаунт не работает' }],
        created_at: new Date(now - 2 * HOUR).toISOString(), updated_at: new Date(now - 2 * HOUR).toISOString(),
      };
      db.disputes.set(disputeId, dispute);
      order.dispute_id = disputeId;
      order.status = 'dispute_opened';
      db.orderStatuses.push({ order_id: id, from: 'delivered', to: 'dispute_opened', actor_kind: 'buyer', ts: dispute.created_at });
      shop.dispute_rate = 0.1;
    }
    db.orders.set(id, order);
    db.ordersByNumber.set(order.number, id);
  }

  // Уведомления.
  const notify = (userId, kind, title, body, dedup, minutesAgo, data = null) => {
    const n = {
      id: C.newId('ntf'), user_id: userId, channel: 'inapp', kind, title, body,
      dedup_key: dedup, data, read: false, created_at: new Date(now - minutesAgo * 60000).toISOString(),
    };
    if (!db.notifications.has(userId)) db.notifications.set(userId, []);
    db.notifications.get(userId).push(n);
  };
  notify(usersByNick.keymaster.id, 'rent_expiring', 'Аренда магазина истекает',
    'GameVault: период заканчивается через 5 дней. Продлите, чтобы сохранить место в ленте.', 'seed:rent:game-vault', 300);
  notify(usersByNick.lena_digital.id, 'shop_suspended', 'Магазин приостановлен',
    'SoftLicense скрыт из ленты: аренда не продлена. Оплатите тариф, чтобы вернуть магазин.', 'seed:rent:soft-license', 1560);
  notify(usersByNick.viktor_keys.id, 'gift_received', 'Вам подарили «Ракета» 🚀',
    'Покупатель поддержал магазин ProxyNord — буст в ленте 3 дня.', 'seed:gift:proxy-nord', 480);
  for (const order of db.orders.values()) {
    if (order.status === 'delivered') notify(order.buyer_id, 'order_delivered', `Товар выдан: заказ ${order.number}`, 'Подтвердите заказ — после этого средства уйдут продавцу.', `seed:order:${order.id}`, 1200);
    if (order.status === 'dispute_opened') notify(order.buyer_id, 'dispute_opened', `Спор по заказу ${order.number}`, 'Ответ продавца ожидается в течение 72 часов.', `seed:order:${order.id}:d`, 120);
    if (order.status === 'awaiting_payment') notify(order.buyer_id, 'order_payment_pending', `Ожидается оплата заказа ${order.number}`, 'Оплатите в течение 30 минут, иначе заказ будет отменён.', `seed:order:${order.id}:p`, 8);
  }

  db.supportChats = supportChats;
  db.usersByNickRef = usersByNick;
  db.shopsBySlugRef = shopsBySlug;
  db.productsRef = products;
  db.addMessage = addMessage;
  db.member = member;
  return db;
}

export function demoCredentials(db) {
  return USERS.map((spec) => {
    const u = db.users.get(db.usersByNick.get(spec.nick));
    return {
      role: spec.role, email: spec.email, password: spec.password, nickname: spec.nick,
      country: spec.country, balance_sol: C.formatSol(db.ledger.userBalance(u.id, 'SOL')),
      balance_stars: db.ledger.userBalance(u.id, 'STARS'),
      totp_login: u.factors.login.secret_b32, totp_ops: u.factors.ops.secret_b32,
      otpauth_login: u.factors.login.otpauth_url, otpauth_ops: u.factors.ops.otpauth_url,
      backup_login: u._demo.login_backup.join(','), backup_ops: u._demo.ops_backup.join(','),
      deposit_address: u.deposit_address,
    };
  });
}
