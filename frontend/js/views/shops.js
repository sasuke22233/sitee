// Главная: лента магазинов (сетка карточек с короной), страница магазина, товар, покупка.
import { api } from '../api.js';
import { S, setGeo, loadCities, emit } from '../state.js';
import {
  h, mount, toast, describeError, spinner, empty, statusChip, money, dateTime,
  countdown, initials, accentFor, stars, postWithOps, modal, copyText, askOps,
} from '../ui.js';

const state = {
  q: sessionStorage.getItem('sitee.q') ?? '',
  sort: 'feed',
  crownOnly: false,
  verifiedOnly: false,
  starsOnly: false,
  country: '',
  city: '',
  cursor: null,
  items: [],
  total: 0,
};

export function setQuery(q) {
  state.q = q ?? '';
  state.cursor = null;
  state.items = [];
  sessionStorage.setItem('sitee.q', state.q);
}

// ---------------------------------------------------------------------------
// Лента магазинов
// ---------------------------------------------------------------------------
export function feed(container, { navigate }) {
  const listBox = h('div', {});
  const filters = h('div', { class: 'filters' });
  const countrySelect = h('select', {
    class: 'filter', onchange: async (ev) => {
      state.country = ev.target.value;
      state.city = '';
      state.cursor = null;
      state.items = [];
      await loadCities(state.country);
      mount(countryWrap, h('select', {
        class: 'filter',
        onchange: (e2) => {
          state.city = e2.target.value;
          state.cursor = null;
          state.items = [];
          load();
        },
      }, h('option', { value: '', text: 'Все города' }),
      S.cities.map((c) => h('option', { value: c.id, text: c.name_ru }))));
      load();
    },
  }, h('option', { value: '', text: '🌍 Все страны' }),
  S.countries.map((c) => h('option', { value: c.code, text: c.name_ru, selected: c.code === state.country })));
  const countryWrap = h('div', { class: 'row', style: 'gap:6px;margin-bottom:8px' }, countrySelect);

  const chip = (label, key) => h('button', {
    class: 'filter', type: 'button', 'aria-pressed': String(!!state[key]), text: label,
    onclick: (ev) => {
      state[key] = !state[key];
      ev.target.setAttribute('aria-pressed', String(state[key]));
      state.cursor = null;
      state.items = [];
      load();
    },
  });

  mount(filters,
    ...[['feed', '🔥 Лента'], ['rating', '★ Рейтинг'], ['sales', '📈 Продажи'], ['new', '🆕 Новые']].map(([value, label]) => h('button', {
      class: 'filter', type: 'button', 'aria-pressed': String(state.sort === value), text: label,
      onclick: () => {
        state.sort = value;
        state.cursor = null;
        state.items = [];
        [...filters.children].forEach((c) => c.setAttribute('aria-pressed', 'false'));
        mount(filters, ...[...filters.children]);
        load();
      },
    })),
    chip('👑 Только Crown', 'crownOnly'),
    chip('✔ Верифицированные', 'verifiedOnly'),
    chip('⭐ Принимают Stars', 'starsOnly'));

  mount(container,
    state.q
      ? h('div', { class: 'notice' }, `Поиск по магазинам: «${state.q}» · `,
        h('a', { href: '#', style: 'color:var(--accent);font-weight:700', text: 'сбросить', onclick: (ev) => { ev.preventDefault(); setQuery(''); navigate('#/shops', true); } }))
      : h('div', { class: 'hero' },
        h('h1', { class: 'hero__title', text: 'Магазины цифровых товаров' }),
        h('p', { class: 'hero__text', text: 'Аренда места, эскроу в SOL и Stars, выдача ключей в чат заказа. Карточка с короной — магазин на тарифе Crown с рейтингом ≥ 4.0.' }),
        h('div', { class: 'row row--wrap' },
          h('span', { class: 'chip', text: `Регион: ${S.geo.city_name || S.geo.country || 'не выбран'}` }),
          h('button', { class: 'chip', type: 'button', text: 'Изменить регион', onclick: () => regionModal(navigate) }))),
    filters,
    countryWrap,
    listBox);

  const more = h('button', { class: 'btn btn--block', type: 'button', text: 'Показать ещё', hidden: true, onclick: () => load(true) });

  async function load(append = false) {
    if (!append) mount(listBox, spinner('Обновляем ленту…'));
    try {
      const params = new URLSearchParams({ limit: '12', sort: state.sort });
      if (state.q) params.set('q', state.q);
      if (state.country) params.set('country', state.country);
      if (state.city) params.set('city', state.city);
      if (state.crownOnly) params.set('crown_only', 'true');
      if (state.verifiedOnly) params.set('verified_only', 'true');
      if (state.starsOnly) params.set('stars_only', 'true');
      if (state.cursor) params.set('cursor', state.cursor);
      const res = await api.get(`/api/v1/shops?${params.toString()}`);
      state.items = append ? [...state.items, ...(res.items ?? [])] : (res.items ?? []);
      state.cursor = res.next_cursor;
      state.total = res.total;
      render();
    } catch (err) {
      mount(listBox, empty('⚠️', 'Лента недоступна', describeError(err)));
    }
  }

  function render() {
    if (!state.items.length) {
      mount(listBox, empty('🏪', state.q ? 'Ничего не найдено' : 'Пока нет магазинов в ленте',
        state.q ? 'Попробуйте другой запрос или сбросьте фильтры.' : 'Магазины появляются после оплаты аренды.'));
      return;
    }
    const grid = h('div', { class: 'grid' }, state.items.map((shop) => card(shop, navigate)));
    mount(listBox,
      h('div', { class: 'section__head' },
        h('h2', { class: 'section__title', text: `Найдено: ${state.total}` }),
        h('span', { class: 'section__hint', text: state.q ? `запрос «${state.q}»` : `сортировка: ${state.sort}` })),
      grid, more);
    more.hidden = !state.cursor;
  }

  load();
}

function card(shop, navigate) {
  const accent = shop.accent ?? accentFor(shop.id);
  return h('article', {
    class: 'shop-card', role: 'button', tabindex: '0',
    onclick: () => navigate(`#/shop/${shop.id}`),
    onkeydown: (ev) => { if (ev.key === 'Enter') navigate(`#/shop/${shop.id}`); },
  },
  h('div', {
    class: 'shop-card__cover',
    style: shop.cover_url
      ? `background-image:url('${shop.cover_url}');background-size:cover;background-position:center;--cover-a:${accent};--cover-b:${shade(accent)}`
      : `--cover-a:${accent};--cover-b:${shade(accent)}`,
  },
    shop.crown ? h('span', { class: 'shop-card__crown', title: 'Crown-магазин', text: '👑' }) : null,
    shop.verified ? h('span', { class: 'shop-card__verified', title: 'Верифицирован', text: '✔' }) : null,
    shop.cover_url ? null : h('span', { text: initials(shop.name) }),
    shop.gift_boost > 0 ? h('span', { class: 'shop-card__boost chip chip--gold', text: `🎁 буст +${Math.round(shop.gift_boost * 100)} %` }) : null),
  h('div', { class: 'shop-card__body' },
  h('div', { class: 'shop-card__name', text: shop.name, title: shop.name }),
  h('div', { class: 'shop-card__meta' },
    h('span', { class: 'shop-card__rating', text: `★ ${shop.rating.toFixed(1)}` }),
    h('span', { class: 'dim', text: `(${shop.rating_count})` }),
    h('span', { class: 'spacer' }),
    h('span', { class: 'small dim', text: shop.city || shop.country })),
  h('div', { class: 'shop-card__tags' },
    h('span', { class: 'chip chip--muted', text: `${shop.products_total} тов.` }),
    shop.price_from_sol ? h('span', { class: 'chip chip--muted', text: `от ${shop.price_from_sol} SOL` }) : null,
    shop.rent_status === 'trial' ? h('span', { class: 'chip chip--info', text: 'trial' }) : null,
    shop.same_country ? h('span', { class: 'chip chip--ok', text: 'рядом' }) : null,
    shop.promoted ? h('span', { class: 'chip chip--warn', text: 'продвижение' }) : null)));
}

function shade(hex) {
  const value = String(hex).replace('#', '');
  const num = parseInt(value.length === 3 ? value.split('').map((c) => c + c).join('') : value, 16);
  const r = Math.max(0, ((num >> 16) & 255) - 60);
  const g = Math.max(0, ((num >> 8) & 255) - 60);
  const b = Math.max(0, (num & 255) - 40);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function regionModal(navigate) {
  const country = h('select', { class: 'select' },
    h('option', { value: '', text: '— страна —' }),
    S.countries.map((c) => h('option', { value: c.code, text: c.name_ru, selected: c.code === S.geo.country })));
  const city = h('select', { class: 'select' }, h('option', { value: '', text: '— город —' }));
  const fill = () => mount(city, h('option', { value: '', text: '— город —' }),
    S.cities.map((c) => h('option', { value: c.id, text: c.name_ru, selected: c.id === S.geo.city_id })));
  country.addEventListener('change', async () => {
    await loadCities(country.value);
    fill();
  });
  fill();
  modal({
    title: 'Страна и город',
    sub: 'Регион влияет на порядок магазинов в ленте (FR-GEO-01…03).',
    body: h('div', {},
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Страна' }), country),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Город' }), city)),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Сохранить', kind: 'primary',
        onClick: () => {
          const cityId = Number(city.value) || null;
          const found = S.cities.find((c) => c.id === cityId);
          setGeo(country.value, cityId, found?.name_ru ?? '');
          toast('Регион сохранён', 'ok');
          navigate('#/shops', true);
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Страница магазина
// ---------------------------------------------------------------------------
export async function shop(container, { navigate }, params) {
  mount(container, spinner());
  let data;
  try {
    data = await api.get(`/api/v1/shops/${params.id}`);
  } catch (err) {
    mount(container, empty('⚠️', 'Магазин не найден', describeError(err)));
    return;
  }
  const products = h('div', {});
  const reviews = h('div', {});

  const accent = data.accent ?? accentFor(data.id);
  mount(container,
    h('div', { class: 'back', onclick: () => navigate('#/shops') }, '← К ленте магазинов'),
    h('div', { class: 'card' },
      h('div', {
        class: 'shop-card__cover',
        style: shop.cover_url
          ? `height:110px;background-image:url('${shop.cover_url}');background-size:cover;background-position:center;--cover-a:${accent};--cover-b:${shade(accent)};margin-bottom:10px`
          : `height:110px;--cover-a:${accent};--cover-b:${shade(accent)};margin-bottom:10px`,
      },
        data.crown ? h('span', { class: 'shop-card__crown', text: '👑' }) : null,
        data.verified ? h('span', { class: 'shop-card__verified', text: '✔' }) : null,
        h('span', { style: 'font-size:34px', text: initials(data.name) })),
      h('h2', { style: 'margin:0 0 4px', text: data.name }),
      h('p', { class: 'card__sub', text: data.description || 'Описание магазина не заполнено.' }),
      h('div', { class: 'row row--wrap', style: 'margin-bottom:8px' },
        h('span', { class: 'chip chip--gold', text: `★ ${data.rating.toFixed(2)} (${data.rating_count})` }),
        h('span', { class: 'chip', text: `${data.sales_count} продаж` }),
        h('span', { class: 'chip', text: `📍 ${data.city || data.country}` }),
        statusChip(data.rent_status, `аренда: ${data.rent_status}`),
        data.plan ? h('span', { class: 'chip chip--info', text: `тариф ${data.plan}` }) : null,
        data.crown ? h('span', { class: 'chip chip--gold', text: '👑 Crown' }) : null,
        data.gift_boost > 0 ? h('span', { class: 'chip chip--gold', text: `🎁 буст +${Math.round(data.gift_boost * 100)} %` }) : null),
      data.rent_status === 'suspended'
        ? h('div', { class: 'notice notice--warn', text: 'Магазин скрыт из ленты: аренда не продлена. Покупки недоступны.' })
        : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn--primary', type: 'button', text: '💬 Написать админу', onclick: () => openChat(data.id, navigate) }),
        data.is_mine ? h('button', { class: 'btn', type: 'button', text: '📊 Статистика', onclick: () => shopStats(data, navigate) }) : null,
        data.is_mine ? h('button', { class: 'btn', type: 'button', text: '🏷 Аренда', onclick: () => navigate(`#/profile/shop/${data.id}`) }) : null,
        data.actions?.includes('admin_panel') ? h('button', { class: 'btn', type: 'button', text: '🛡 Админка', onclick: () => navigate('#/admin') }) : null)),
    h('div', { class: 'section' },
      h('div', { class: 'section__head' }, h('h2', { class: 'section__title', text: 'Товары' }),
        h('span', { class: 'section__hint', text: `${data.products_preview?.length ?? 0} в ленте` })),
      products),
    h('div', { class: 'section' },
      h('div', { class: 'section__head' }, h('h2', { class: 'section__title', text: 'Отзывы' })),
      reviews));

  loadProducts(data.id, products, navigate);
  loadReviews(data.id, reviews, navigate);
}

async function openChat(shopId, navigate) {
  if (!S.me) {
    toast('Войдите, чтобы написать админу', 'warn');
    navigate('#/welcome');
    return;
  }
  try {
    const chat = await api.post('/api/v1/chats', { kind: 'shop_support', shop_id: shopId });
    navigate(`#/chat/${chat.id}`);
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function loadProducts(shopId, box, navigate) {
  mount(box, spinner('Загружаем товары…'));
  try {
    const res = await api.get(`/api/v1/shops/${shopId}/products?limit=20`);
    if (!res.items.length) {
      mount(box, empty('📦', 'Товаров пока нет'));
      return;
    }
    mount(box, h('div', { class: 'list' }, res.items.map((p) => productRow(p, navigate))));
  } catch (err) {
    mount(box, empty('⚠️', 'Не удалось загрузить товары', describeError(err)));
  }
}

function productRow(p, navigate) {
  return h('div', { class: 'list-row', onclick: () => navigate(`#/product/${p.id}`) },
    h('div', { class: 'list-row__avatar', style: `background:${accentFor(p.id)}`, text: kindEmoji(p.kind) }),
    h('div', { class: 'list-row__body' },
      h('div', { class: 'list-row__title', text: p.title }),
      h('div', { class: 'list-row__sub', text: `${p.category ?? ''} · ${p.delivery_kind === 'auto' ? 'автовыдача' : 'выдача вручную'} · гарантия ${p.warranty_days} дн.` }),
      h('div', { class: 'list-row__sub small dim', text: p.stock_free > 0 ? `в наличии ${p.stock_free} шт.` : 'нет в наличии' })),
    h('div', { class: 'list-row__aside' },
      h('div', { class: 'pill-price', text: p.price_stars && p.price_sol_raw ? `${p.price_sol} SOL` : p.price_stars ? `${p.price_stars} ⭐` : `${p.price_sol} SOL` }),
      p.price_stars && p.price_sol_raw ? h('div', { class: 'small dim', text: `или ${p.price_stars} ⭐` }) : null,
      p.can_buy ? h('span', { class: 'chip chip--ok', text: 'купить' }) : h('span', { class: 'chip chip--muted', text: 'недоступно' })));
}

function kindEmoji(kind) {
  return { key: '🔑', account: '👤', subscription: '🔁', software: '💿', game_item: '🎮', file: '📄', service: '🛠', vpn: '🛰' }[kind] ?? '📦';
}

async function loadReviews(shopId, box, navigate) {
  try {
    const res = await api.get(`/api/v1/shops/${shopId}/reviews?limit=10`);
    const s = res.summary ?? {};
    const rows = (res.items ?? []).map((rv) => h('div', { class: 'card card--flat' },
      h('div', { class: 'row' },
        h('strong', { class: 'stars', text: stars(rv.rating) }),
        h('span', { class: 'grow' }),
        h('span', { class: 'small dim', text: dateTime(rv.created_at) })),
      h('p', { class: 'small', style: 'margin:6px 0', text: rv.body }),
      h('div', { class: 'row small dim' },
        h('span', { text: rv.author }),
        rv.is_verified_purchase ? h('span', { class: 'chip chip--ok', text: 'покупка подтверждена' }) : null,
        h('span', { class: 'grow' }),
        h('span', { text: `доставка ${rv.rating_delivery} · описание ${rv.rating_description} · поддержка ${rv.rating_support}` })),
      rv.shop_reply
        ? h('div', { class: 'notice notice--ok', style: 'margin:8px 0 0' }, `Ответ магазина: ${rv.shop_reply}`)
        : null,
      S.me?.shops?.some((sh) => sh.id === shopId) && !rv.shop_reply
        ? h('button', {
          class: 'btn btn--sm', type: 'button', text: 'Ответить на отзыв', style: 'margin-top:8px',
          onclick: () => replyReview(rv, () => loadReviews(shopId, box, navigate)),
        })
        : null));
    mount(box,
      h('div', { class: 'card card--flat' },
        h('div', { class: 'stat-grid' },
          h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${s.bayes ?? '—'}` }), h('div', { class: 'stat__label', text: 'рейтинг (Байес)' })),
          h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${s.count ?? 0}` }), h('div', { class: 'stat__label', text: 'отзывов' })),
          h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${s.positive_pct ?? 0} %` }), h('div', { class: 'stat__label', text: 'положительных' })),
          h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${(s.distribution?.[5] ?? 0)}/${(s.distribution?.[1] ?? 0)}` }), h('div', { class: 'stat__label', text: '5★ / 1★' })))),
      rows.length ? h('div', { class: 'list' }, rows) : empty('✍️', 'Отзывов пока нет'));
  } catch (err) {
    mount(box, empty('⚠️', 'Отзывы недоступны', describeError(err)));
  }
}

function replyReview(rv, reload) {
  const text = h('textarea', { class: 'textarea', placeholder: 'Ваш ответ покупателю (виден всем)' });
  modal({
    title: 'Ответ на отзыв',
    sub: `${rv.author}: ${stars(rv.rating)}`,
    body: h('div', { class: 'field' }, text),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Опубликовать', kind: 'primary',
        onClick: async (close) => {
          try {
            await api.post(`/api/v1/reviews/${rv.id}/reply`, { body: text.value });
            toast('Ответ опубликован', 'ok');
            close(true);
            reload();
          } catch (err) {
            toast(describeError(err), 'err');
          }
          return true;
        },
      },
    ],
  });
}

async function shopStats(shop, navigate) {
  try {
    const stats = await api.get(`/api/v1/shops/${shop.id}/stats`);
    modal({
      title: `Статистика · ${shop.name}`,
      sub: `Тариф ${stats.rent?.plan ?? '—'} · аренда ${stats.rent?.status ?? '—'} · комиссия ${stats.fee_bps / 100} %`,
      body: h('div', {},
        h('div', { class: 'stat-grid' },
          h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${stats.orders_total}` }), h('div', { class: 'stat__label', text: 'заказов всего' })),
          h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${stats.orders_completed}` }), h('div', { class: 'stat__label', text: 'завершено' })),
          h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${stats.revenue_sol} SOL` }), h('div', { class: 'stat__label', text: 'выручка' })),
          h('div', { class: 'stat' }, h('div', { class: 'stat__value', text: `${stats.revenue_stars} ⭐` }), h('div', { class: 'stat__label', text: 'выручка Stars' }))),
        h('div', { class: 'divider' }),
        h('dl', { class: 'kv' },
          h('dt', { text: 'Споры' }), h('dd', { text: `${stats.orders_disputed} (${(stats.dispute_rate * 100).toFixed(1)} %)` }),
          h('dt', { text: 'Комиссия площадки' }), h('dd', { text: `${stats.fee_paid_sol} SOL` }),
          h('dt', { text: 'Товаров' }), h('dd', { text: `${stats.products.published} опубликовано / ${stats.products.stock_free} шт. на складе` }),
          h('dt', { text: 'Скорость ответа' }), h('dd', { text: `${Math.round(stats.response_p50_s / 60)} мин (медиана)` }),
          h('dt', { text: 'Корона' }), h('dd', { text: stats.crown ? '👑 активна' : 'не активна' }),
          h('dt', { text: 'Очки ленты' }), h('dd', { text: `${stats.feed_score}` })),
        h('div', { class: 'divider' }),
        h('p', { class: 'small dim', text: 'Динамика продаж за 30 дней:' }),
        stats.sales_by_day.length
          ? h('div', { class: 'list' }, stats.sales_by_day.map((d) => h('div', { class: 'row small' },
            h('span', { class: 'mono', text: d.date }), h('span', { class: 'grow' }), h('strong', { text: `${d.sol} SOL` }))))
          : h('p', { class: 'small dim', text: 'Продаж за период нет.' })),
      actions: [
        { label: 'Закрыть' },
        { label: 'Мои магазины', kind: 'primary', onClick: () => navigate('#/profile/shops') },
      ],
    });
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

// ---------------------------------------------------------------------------
// Страница товара и покупка
// ---------------------------------------------------------------------------
export async function product(container, { navigate }, params) {
  mount(container, spinner());
  let p;
  try {
    p = await api.get(`/api/v1/products/${params.id}`);
  } catch (err) {
    mount(container, empty('⚠️', 'Товар не найден', describeError(err)));
    return;
  }
  const qty = h('input', { class: 'input', type: 'number', min: '1', max: String(Math.max(1, p.stock.free)), value: '1', style: 'width:90px' });
  const asset = h('select', { class: 'select', style: 'width:150px' },
    h('option', { value: 'SOL', text: `◎ SOL — ${p.price_sol}` }),
    p.price_stars ? h('option', { value: 'STARS', text: `⭐ Stars — ${p.price_stars}` }) : null);

  mount(container,
    h('div', { class: 'back', onclick: () => navigate(`#/shop/${p.shop_id}`) }, `← ${p.shop_name ?? 'Магазин'}`),
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('div', { class: 'list-row__avatar', style: `width:52px;height:52px;flex-basis:52px;font-size:22px;background:${accentFor(p.id)}`, text: kindEmoji(p.kind) }),
        h('div', { class: 'grow' },
          h('h2', { style: 'margin:0 0 4px;font-size:17px', text: p.title }),
          h('div', { class: 'small dim', text: `${p.category ?? ''} · ${p.shop_name ?? ''}` }))),
      h('p', { class: 'card__sub', style: 'margin-top:10px', text: p.description || 'Описание не заполнено.' }),
      h('dl', { class: 'kv' },
        h('dt', { text: 'Цена' }), h('dd', { class: 'pill-price', text: `${p.price_sol} SOL${p.price_stars ? ` · ${p.price_stars} ⭐` : ''}` }),
        h('dt', { text: 'Выдача' }), h('dd', { text: p.delivery_kind === 'auto' ? `автоматически, SLA ${p.delivery_sla_h} ч` : 'вручную админом магазина' }),
        h('dt', { text: 'Гарантия' }), h('dd', { text: `${p.warranty_days} дней` }),
        h('dt', { text: 'В наличии' }), h('dd', { text: `${p.stock.free} из ${p.stock.total} (данные зашифрованы)` }),
        p.rating ? [h('dt', { text: 'Оценка товара' }), h('dd', { class: 'stars', text: stars(p.rating) })] : null),
      p.can_buy ? null : h('div', { class: 'notice notice--warn', text: 'Покупка недоступна: магазин приостановлен или товар снят с продажи.' }),
      h('div', { class: 'divider' }),
      h('div', { class: 'row', style: 'margin-bottom:10px' },
        h('div', {}, h('label', { class: 'field__label', text: 'Количество' }), qty),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Способ оплаты' }), asset)),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn btn--primary', type: 'button', text: 'Купить', disabled: !p.can_buy,
          onclick: () => buy(p, Number(qty.value) || 1, asset.value, navigate),
        }),
        h('button', { class: 'btn', type: 'button', text: '💬 Спросить админа', onclick: () => openChat(p.shop_id, navigate) })),
      h('p', { class: 'field__hint', text: 'Оплата уходит в эскроу. Деньги перечисляются продавцу только после подтверждения получения (или по решению арбитра).' })),
    p.shop ? h('div', { class: 'card card--flat' },
      h('div', { class: 'row', onclick: () => navigate(`#/shop/${p.shop.id}`), style: 'cursor:pointer' },
        h('div', { class: 'list-row__avatar', style: `background:${p.shop.accent ?? accentFor(p.shop.id)}`, text: initials(p.shop.name) }),
        h('div', { class: 'list-row__body' },
          h('div', { class: 'list-row__title', text: p.shop.name }),
          h('div', { class: 'list-row__sub', text: `★ ${p.shop.rating} · ${p.shop.sales_count} продаж · ${p.shop.city}` })),
        p.shop.crown ? h('span', { text: '👑' }) : null)) : null);
}

async function buy(p, qty, asset, navigate) {
  if (!S.me) {
    toast('Войдите, чтобы оформить заказ', 'warn');
    navigate('#/welcome');
    return;
  }
  try {
    const order = await api.post('/api/v1/orders', {
      product_id: p.id, qty, pay_asset: asset, idempotency_key: `ui-${Date.now()}-${p.id}`,
    });
    toast(`Заказ ${order.number} создан`, 'ok');
    navigate(`#/order/${order.id}`);
  } catch (err) {
    toast(describeError(err), 'err');
  }
}
