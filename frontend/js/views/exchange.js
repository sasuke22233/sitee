// Вкладка «Обмен»: кошелёк, депозит SOL, обмен SOL⇄Stars, вывод, подарки и Telegram Stars.
import { api, live, tg } from '../api.js';
import { S } from '../state.js';
import {
  h, mount, toast, describeError, spinner, empty, statusChip, dateTime, money,
  postWithOps, modal, copyText, countdown,
} from '../ui.js';

export async function exchange(container, { navigate }) {
  mount(container, spinner());
  let wallet;
  try {
    wallet = await api.get('/api/v1/wallet');
  } catch (err) {
    mount(container, empty('⚠️', 'Кошелёк недоступен', `${describeError(err)} — войдите в аккаунт.`));
    return;
  }
  const sol = wallet.balances.find((b) => b.asset === 'SOL');
  const stars = wallet.balances.find((b) => b.asset === 'STARS');
  const tabs = h('div', { class: 'tabs-inline' });
  const body = h('div', {});
  const sections = ['wallet', 'exchange', 'gifts', 'withdraw'];
  const labels = { wallet: '💳 Кошелёк', exchange: '🔁 Обмен', gifts: '🎁 Подарки', withdraw: '📤 Вывод' };

  const show = (key) => {
    [...tabs.children].forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.key === key)));
    if (key === 'wallet') return walletSection(body, wallet, navigate, show);
    if (key === 'exchange') return exchangeSection(body, wallet, show);
    if (key === 'gifts') return giftsSection(body, navigate);
    return withdrawSection(body, wallet, navigate);
  };

  mount(container,
    h('div', { class: 'section__head' },
      h('h2', { class: 'section__title', text: 'Обмен и кошелёк' }),
      h('span', { class: 'section__hint' }, h('span', { class: `ws-dot ${S.ws ? 'ws-dot--on' : ''}` }), ' ', S.ws ? 'live' : 'offline')),
    h('div', { class: 'stat-grid', style: 'margin-bottom:10px' },
      h('div', { class: 'stat' },
        h('div', { class: 'stat__value', text: `${sol.available} ◎` }),
        h('div', { class: 'stat__label', text: `SOL · в эскроу/холде ${sol.locked}` })),
      h('div', { class: 'stat' },
        h('div', { class: 'stat__value', text: `${stars.available} ⭐` }),
        h('div', { class: 'stat__label', text: 'Telegram Stars' }),
        h('button', { class: 'btn btn--sm', type: 'button', text: '+ Купить Stars', style: 'margin-top:6px', onclick: () => starsModal(show) })),
      h('div', { class: 'stat' },
        h('div', { class: 'stat__value', text: `${wallet.exchange_rate.stars_per_sol.toFixed(0)} ⭐` }),
        h('div', { class: 'stat__label', text: `за 1 SOL · комиссия ${wallet.exchange_rate.fee_bps / 100} %` })),
      h('div', { class: 'stat' },
        h('div', { class: 'stat__value', text: wallet.network }),
        h('div', { class: 'stat__label', text: `подтверждений: ${wallet.deposit.confirmations_required}` }))),
    tabs, body);

  mount(tabs, sections.map((key) => h('button', {
    class: 'filter', type: 'button', dataset: { key }, text: labels[key], 'aria-pressed': 'false',
    onclick: () => show(key),
  })));
  show('wallet');
}

function walletSection(box, wallet, navigate, show) {
  const txList = h('div', {});
  mount(box,
    h('div', { class: 'card' },
      h('h3', { class: 'card__title', text: 'Депозит SOL' }),
      h('p', { class: 'card__sub', text: 'Отправьте SOL на ваш персональный адрес (HD-путь SLIP-0010). Зачисление после подтверждений сети.' }),
      h('div', { class: 'field' },
        h('label', { class: 'field__label', text: 'Ваш депозитный адрес' }),
        h('div', { class: 'mono', text: wallet.deposit.address }),
        h('div', { class: 'row', style: 'margin-top:6px' },
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Скопировать адрес', onclick: () => copyText(wallet.deposit.address, 'Адрес скопирован') }),
          h('span', { class: 'small dim', text: `путь ${wallet.deposit.path} · мин. ${wallet.deposit.min} SOL` }))),
      h('div', { class: 'notice', text: 'Кастодиальная модель: площадка хранит средства в горячем/холодном кошельках, вывод — с лимитами, охлаждением адреса 24 ч и правилом четырёх глаз от 100 SOL (docs/solana.md).' }),
      h('button', { class: 'btn btn--primary btn--block', type: 'button', text: 'Симулировать депозит (демо)', onclick: () => depositModal(navigate) })),
    h('div', { class: 'section' },
      h('div', { class: 'section__head' },
        h('h2', { class: 'section__title', text: 'Операции' }),
        h('button', { class: 'btn btn--sm', type: 'button', text: 'Обмен', onclick: () => show('exchange') })),
      txList));
  loadTx(txList);
}

async function loadTx(box) {
  mount(box, spinner());
  try {
    const res = await api.get('/api/v1/wallet/transactions?limit=20');
    if (!res.items.length) {
      mount(box, empty('🧾', 'Проводок пока нет'));
      return;
    }
    mount(box, h('div', { class: 'list' }, res.items.map((tx) => h('div', { class: 'list-row', style: 'cursor:default' },
      h('div', { class: 'list-row__avatar', style: `background:${tx.direction === 'debit' ? '#3a2530' : '#1f3327'}`, text: tx.direction === 'debit' ? '−' : '+' }),
      h('div', { class: 'list-row__body' },
        h('div', { class: 'list-row__title', text: tx.title }),
        h('div', { class: 'list-row__sub small dim', text: `${tx.kind} · ${tx.ref_type} ${String(tx.ref_id).slice(0, 12)}` })),
      h('div', { class: 'list-row__aside' },
        h('strong', { style: `color:${tx.direction === 'debit' ? 'var(--err)' : 'var(--ok)'}`, text: `${tx.direction === 'debit' ? '−' : '+'}${tx.amount}${tx.asset === 'SOL' ? ' ◎' : ' ⭐'}` }),
        h('span', { text: dateTime(tx.ts) }))))));
  } catch (err) {
    mount(box, empty('⚠️', 'История недоступна', describeError(err)));
  }
}

function depositModal(navigate) {
  const asset = h('select', { class: 'select' },
    h('option', { value: 'SOL', text: '◎ SOL' }),
    h('option', { value: 'STARS', text: '⭐ Stars' }));
  const amount = h('input', { class: 'input', type: 'text', value: '5', placeholder: '5.0' });
  modal({
    title: 'Депозит (демо-стенд)',
    sub: 'В prod зачисление выполняет сканер блокчейна после 32 подтверждений; Stars приходят через Telegram Bot API.',
    body: h('div', {},
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Актив' }), asset),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Сумма' }), amount,
        h('div', { class: 'field__hint', text: 'Для SOL — в целых/дробных SOL, для Stars — целое число.' }))),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Зачислить', kind: 'primary',
        onClick: async (close) => {
          try {
            const value = asset.value;
            const body = value === 'SOL' ? { asset: 'SOL', amount_sol: amount.value.trim() } : { asset: 'STARS', amount_stars: Number(amount.value) };
            const res = await api.post('/api/v1/dev/simulate-deposit', body);
            close(true);
            toast(`Зачислено ${res.amount} (${res.confirmations} подтверждений)`, 'ok');
            navigate('#/exchange', true);
          } catch (err) {
            toast(describeError(err), 'err');
          }
          return true;
        },
      },
    ],
  });
}

function exchangeSection(box, wallet, show) {
  const from = h('select', { class: 'select' },
    h('option', { value: 'STARS', text: `⭐ Stars (${wallet.balances.find((b) => b.asset === 'STARS').available})` }),
    h('option', { value: 'SOL', text: `◎ SOL (${wallet.balances.find((b) => b.asset === 'SOL').available})` }));
  const amount = h('input', { class: 'input', type: 'text', value: '100', placeholder: 'сумма' });
  const quoteBox = h('div', { class: 'card card--flat' }, h('p', { class: 'small dim', text: 'Запросите котировку — она действует 60 секунд.' }));
  let quote = null;

  const getQuote = async () => {
    mount(quoteBox, spinner('Считаем котировку…'));
    try {
      const params = from.value === 'SOL'
        ? `amount_sol=${encodeURIComponent(amount.value.trim())}`
        : `amount_stars=${encodeURIComponent(amount.value.trim())}&from=STARS&to=SOL`;
      quote = await api.get(`/api/v1/exchange/quote?${params}`);
      mount(quoteBox,
        h('dl', { class: 'kv' },
          h('dt', { text: 'Отдаёте' }), h('dd', { class: 'pill-price', text: `${quote.from_amount} ${quote.from_asset === 'SOL' ? '◎' : '⭐'}` }),
          h('dt', { text: 'Получаете' }), h('dd', { class: 'pill-price', text: `${quote.to_amount} ${quote.to_asset === 'SOL' ? '◎' : '⭐'}` }),
          h('dt', { text: 'Комиссия' }), h('dd', { text: `${quote.fee} (${quote.fee_bps / 100} %)` }),
          h('dt', { text: 'Курс' }), h('dd', { text: `1 SOL = ${(1 / quote.rate).toFixed(0)} ⭐` }),
          h('dt', { text: 'Действительна до' }), h('dd', { text: dateTime(quote.valid_until) })));
    } catch (err) {
      quote = null;
      mount(quoteBox, h('div', { class: 'notice notice--err', text: describeError(err) }));
    }
  };

  mount(box,
    h('div', { class: 'card' },
      h('h3', { class: 'card__title', text: 'Обмен SOL ⇄ Stars' }),
      h('p', { class: 'card__sub', text: 'Две сбалансированные проводки: пользователь → резерв платформы и резерв → пользователь. Комиссия площадки идёт на счёт platform:fees.' }),
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Из актива' }), from),
        h('div', { class: 'grow' }, h('label', { class: 'field__label', text: 'Сумма' }), amount)),
      h('button', { class: 'btn btn--block', type: 'button', text: 'Рассчитать', onclick: getQuote })),
    quoteBox,
    h('button', {
      class: 'btn btn--primary btn--block', type: 'button', text: 'Обменять',
      onclick: async () => {
        if (!quote) {
          toast('Сначала получите котировку', 'warn');
          return;
        }
        try {
          const res = await postWithOps('/api/v1/exchange', { quote_id: quote.quote_id }, 'обмен активов');
          toast(`Обмен выполнен: ${res.from_amount} → ${res.to_amount}`, 'ok');
          quote = null;
          show('wallet');
        } catch (err) {
          toast(describeError(err), 'err');
        }
      },
    }),
    h('p', { class: 'field__hint', text: 'Обмен относится к привилегированным операциям и требует код фактора «операции».' }));
}

function withdrawSection(box, wallet, navigate) {
  const address = h('input', { class: 'input mono', type: 'text', placeholder: 'адрес Solana (base58, 32–44 символа)' });
  const amount = h('input', { class: 'input', type: 'text', placeholder: '0.5', value: '0.5' });
  const withdrawals = wallet.withdrawals ?? [];
  mount(box,
    h('div', { class: 'card' },
      h('h3', { class: 'card__title', text: 'Вывод SOL' }),
      h('p', { class: 'card__sub', text: `Доступно: ${wallet.balances.find((b) => b.asset === 'SOL').available} SOL. Суточный лимит ${wallet.limits.withdraw_daily_sol} SOL, комиссия сети 0.000005 SOL.` }),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Адрес получателя' }), address,
        h('div', { class: 'field__hint', text: 'Новый адрес попадает в белый список и становится доступен для вывода через 24 часа.' })),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Сумма, SOL' }), amount),
      h('div', { class: 'notice notice--warn', text: `Правило четырёх глаз: от ${wallet.limits.withdraw_four_eyes_sol} SOL заявку подтверждает второй сотрудник. Порог 2FA «операции»: ${wallet.limits.ops_totp_threshold_sol} SOL / ${wallet.limits.ops_totp_threshold_stars} ⭐.` }),
      h('button', {
        class: 'btn btn--danger btn--block', type: 'button', text: 'Вывести',
        onclick: async () => {
          try {
            const res = await postWithOps('/api/v1/wallet/withdraw', {
              asset: 'SOL', amount_sol: amount.value.trim(), dest_address: address.value.trim(),
            }, 'вывод средств');
            toast(res.four_eyes_required ? 'Заявка создана: требуется второе подтверждение' : 'Вывод одобрен, подпись формируется', 'ok');
            navigate('#/exchange', true);
          } catch (err) {
            modal({
              title: 'Вывод отклонён',
              sub: describeError(err),
              body: err.details?.address
                ? h('div', {},
                  h('div', { class: 'notice', text: `Адрес ${err.details.address} добавлен в белый список. Повторите вывод, когда охлаждение закончится.` }),
                  h('p', { class: 'small dim', text: `Повторить через: ${Math.ceil((err.retryAfter ?? 86400) / 3600)} ч` }))
                : h('p', { class: 'small muted', text: 'Проверьте сумму, адрес и наличие кода фактора «операции».' }),
              actions: [{ label: 'Понятно' }],
            });
          }
        },
      })),
    h('div', { class: 'section' },
      h('div', { class: 'section__head' }, h('h2', { class: 'section__title', text: 'Заявки на вывод' })),
      withdrawals.length
        ? h('div', { class: 'list' }, withdrawals.map((w) => h('div', { class: 'list-row', style: 'cursor:default' },
          h('div', { class: 'list-row__avatar', style: 'background:#2c3244', text: '📤' }),
          h('div', { class: 'list-row__body' },
            h('div', { class: 'list-row__title', text: `${w.amount} на ${w.dest_address}` }),
            h('div', { class: 'list-row__sub small dim', text: `${dateTime(w.created_at)} · комиссия ${w.fee} SOL` })),
          h('div', { class: 'list-row__aside' }, statusChip(w.status, w.status)))))
        : empty('📤', 'Заявок на вывод нет')));
}

function starsModal(show) {
  const amount = h('input', { class: 'input', type: 'number', min: '1', value: '500' });
  const purpose = h('select', { class: 'select' },
    h('option', { value: 'deposit', text: 'Пополнение баланса' }),
    h('option', { value: 'gift', text: 'Покупка подарка' }),
    h('option', { value: 'rent', text: 'Оплата аренды' }),
    h('option', { value: 'order', text: 'Оплата заказа' }));
  modal({
    title: 'Telegram Stars',
    sub: 'Инвойс создаётся на сервере, оплата проходит через Telegram.WebApp.openInvoice.',
    body: h('div', {},
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Количество Stars' }), amount),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Цель' }), purpose),
      h('p', { class: 'field__hint', text: 'На демо-стенде оплату можно завершить кнопкой «Симулировать оплату» — она зачислит Stars через dev-эндпоинт.' })),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Создать инвойс', kind: 'primary',
        onClick: async (close) => {
          try {
            const res = await api.post('/api/v1/stars/invoice', {
              amount_stars: Number(amount.value), purpose: purpose.value, reference: 'ui',
            });
            close(true);
            const paid = await confirmStars(res, purpose.value);
            if (paid) {
              toast('Stars зачислены', 'ok');
              show('wallet');
            }
          } catch (err) {
            toast(describeError(err), 'err');
          }
          return true;
        },
      },
    ],
  });
}

async function confirmStars(invoice, purpose) {
  if (tg.available && invoice.payload) {
    const status = await tg.openInvoice(invoice.payload);
    if (status === 'paid') return true;
  }
  return new Promise((resolve) => {
    modal({
      title: `Инвойс ${invoice.invoice_id}`,
      sub: `${invoice.amount_stars} ⭐ · ${purpose}`,
      body: h('div', {},
        h('dl', { class: 'kv' },
          h('dt', { text: 'Payload' }), h('dd', { class: 'mono', text: invoice.payload }),
          h('dt', { text: 'Действителен' }), h('dd', { text: countdown(invoice.expires_at) ?? '—' })),
        invoice.dev_notice ? h('div', { class: 'notice', text: invoice.dev_notice }) : null),
      actions: [
        { label: 'Отмена', value: false },
        {
          label: 'Симулировать оплату', kind: 'primary', value: true,
          onClick: async (close) => {
            try {
              await api.post('/api/v1/dev/simulate-deposit', {
                asset: 'STARS', amount_stars: invoice.amount_stars, invoice_id: invoice.invoice_id,
              });
              close(true);
              resolve(true);
            } catch (err) {
              toast(describeError(err), 'err');
              resolve(false);
            }
            return false;
          },
        },
      ],
      onClose: (v) => resolve(v === true),
    });
  });
}

async function giftsSection(box, navigate) {
  mount(box, spinner());
  try {
    const [gifts, inventory] = await Promise.all([
      api.get('/api/v1/gifts?limit=24'),
      api.get('/api/v1/gifts/inventory').catch(() => ({ items: [] })),
    ]);
    const shopCards = (S.me?.shops ?? []);
    mount(box,
      h('div', { class: 'card' },
        h('h3', { class: 'card__title', text: 'Подарки' }),
        h('p', { class: 'card__sub', text: 'Подарок магазину даёт буст в ленте (до +60 %, до 14 дней), подарок пользователю — коллекционный предмет. Оплата Stars или SOL.' }),
        shopCards.length
          ? h('p', { class: 'small dim', text: `Ваши магазины: ${shopCards.map((s) => s.name).join(', ')}` })
          : null),
      h('div', { class: 'grid' }, gifts.items.map((gift) => h('div', { class: 'shop-card', style: 'cursor:default' },
        h('div', { class: 'shop-card__cover', style: '--cover-a:#7c6cff;--cover-b:#332a70;font-size:34px', text: gift.emoji || '🎁' },
          h('span', { class: 'shop-card__crown', text: rarityIcon(gift.rarity) })),
        h('div', { class: 'shop-card__name', text: gift.title_ru }),
        h('div', { class: 'shop-card__meta' },
          h('span', { class: 'chip chip--gold', text: `${gift.price_stars} ⭐` }),
          h('span', { class: 'chip', text: `${gift.price_sol} ◎` })),
        h('div', { class: 'small dim', text: gift.boosts_shop ? `буст +${Math.round(gift.boost_value * 100)} % на ${gift.boost_days} дн.` : gift.collectible ? 'коллекционный' : 'без буста' }),
        h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: 'Подарить', onclick: () => giftModal(gift, shopCards, navigate) })))),
      h('div', { class: 'section', style: 'margin-top:14px' },
        h('div', { class: 'section__head' }, h('h2', { class: 'section__title', text: 'Моя коллекция' })),
        inventory.items?.length
          ? h('div', { class: 'list' }, inventory.items.map((item) => h('div', { class: 'list-row', style: 'cursor:default' },
            h('div', { class: 'list-row__avatar', style: 'background:#332a70', text: item.gift?.emoji ?? '🎁' })),
            h('div', { class: 'list-row__body' },
              h('div', { class: 'list-row__title', text: `${item.gift?.title_ru ?? ''} ×${item.qty}` }),
              h('div', { class: 'list-row__sub small dim', text: `от ${item.from} · ${dateTime(item.created_at)}` }))))
          : empty('🎁', 'Подарков пока нет')));
  } catch (err) {
    mount(box, empty('⚠️', 'Подарки недоступны', describeError(err)));
  }
}

function rarityIcon(rarity) {
  return { common: '•', rare: '💎', epic: '🔮', legendary: '👑' }[rarity] ?? '•';
}

function giftModal(gift, shopCards, navigate) {
  const recipientType = h('select', { class: 'select' },
    h('option', { value: 'shop', text: 'Магазину (буст в ленте)' }),
    h('option', { value: 'user', text: 'Пользователю (коллекция)' }),
    h('option', { value: 'self', text: 'Себе (коллекция)' }));
  const shopSelect = h('select', { class: 'select' },
    shopCards.map((s) => h('option', { value: s.id, text: s.name })));
  const userId = h('input', { class: 'input mono', placeholder: 'usr_… (ID пользователя)' });
  const asset = h('select', { class: 'select' },
    gift.price_stars ? h('option', { value: 'STARS', text: `⭐ Stars — ${gift.price_stars}` }) : null,
    gift.price_sol !== '0' ? h('option', { value: 'SOL', text: `◎ SOL — ${gift.price_sol}` }) : null);
  const message = h('input', { class: 'input', placeholder: 'сообщение получателю' });

  const sync = () => {
    const type = recipientType.value;
    shopSelect.hidden = type !== 'shop';
    userId.hidden = type !== 'user';
    if (type === 'shop' && !shopCards.length) {
      shopSelect.append(h('option', { value: '', text: '— у вас нет магазинов: выберите магазин в ленте —' }));
    }
  };
  recipientType.addEventListener('change', sync);
  sync();

  modal({
    title: `Подарок «${gift.title_ru}» ${gift.emoji ?? ''}`,
    sub: `${gift.description || gift.title_en}`,
    body: h('div', {},
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Получатель' }), recipientType),
      h('div', { class: 'field', hidden: false }, shopSelect),
      h('div', { class: 'field', hidden: true }, userId),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Оплата' }), asset),
      h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Сообщение' }), message)),
    actions: [
      { label: 'Отмена' },
      {
        label: 'Купить подарок', kind: 'primary',
        onClick: async (close) => {
          try {
            const type = recipientType.value;
            let recipientId = '';
            if (type === 'shop') {
              recipientId = shopSelect.value;
              if (!recipientId) {
                const picked = window.prompt('Введите ID магазина (shp_…) или slug', '');
                if (!picked) return true;
                const shop = await api.get(`/api/v1/shops/${picked}`);
                recipientId = shop.id;
              }
            } else if (type === 'user') recipientId = userId.value.trim();
            const res = await postWithOps(`/api/v1/gifts/${gift.id}/buy`, {
              asset: asset.value, recipient_type: type, recipient_id: recipientId,
              message: message.value.trim(), qty: 1,
            }, 'покупка подарка');
            close(true);
            toast(res.boost_applied ? 'Подарок отправлен: магазин получил буст в ленте' : 'Подарок отправлен', 'ok');
            navigate('#/exchange', true);
          } catch (err) {
            toast(describeError(err), 'err');
          }
          return true;
        },
      },
    ],
  });
}
