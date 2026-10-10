// Package seed наполняет хранилище демонстрационными данными:
// справочники стран/городов/категорий, тарифы аренды, пользователи с двойным
// 2FA, магазины, товары с зашифрованным стоком, подарки, отзывы, диалоги,
// заказы во всех ключевых статусах и один спор с маскировкой сторон.
//
// Все секреты (пароли, TOTP-ключи, резервные коды) возвращаются в Result и
// печатаются в лог только при SITEED_ENV != prod.
package seed

import (
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/sasuke22233/sitee/backend/internal/config"
	"github.com/sasuke22233/sitee/backend/internal/cryptod"
	"github.com/sasuke22233/sitee/backend/internal/platform/ids"
	"github.com/sasuke22233/sitee/backend/internal/store"
)

// UserCredentials — данные входа демонстрационного пользователя.
type UserCredentials struct {
	UserID         string   `json:"user_id"`
	Role           string   `json:"role"`
	Nickname       string   `json:"nickname"`
	Email          string   `json:"email"`
	Password       string   `json:"password"`
	LoginSecret    string   `json:"login_secret_b32"`
	OpsSecret      string   `json:"ops_secret_b32"`
	LoginOTPURL    string   `json:"login_otpauth_url"`
	OpsOTPURL      string   `json:"ops_otpauth_url"`
	LoginBackup    []string `json:"login_backup_codes"`
	OpsBackup      []string `json:"ops_backup_codes"`
	BalanceSOL     string   `json:"balance_sol"`
	BalanceStars   int64    `json:"balance_stars"`
	Country        string   `json:"country"`
	ShopIDs        []string `json:"shop_ids,omitempty"`
}

// Result — итог наполнения.
type Result struct {
	Users       []UserCredentials `json:"users"`
	ShopIDs     []string          `json:"shop_ids"`
	ProductIDs  []string          `json:"product_ids"`
	OrderIDs    []string          `json:"order_ids"`
	DisputeIDs  []string          `json:"dispute_ids"`
	GiftIDs     []string          `json:"gift_ids"`
	ChatIDs     []string          `json:"chat_ids"`
	Counters    map[string]int    `json:"counters"`
}

// demoSpec — описание пользователя в демо-наборе.
type demoSpec struct {
	nickname string
	email    string
	password string
	role     string
	country  string
	cityID   int64
	sol      float64
	stars    int64
}

var demoUsersSpec = []demoSpec{
	{nickname: "sitee_admin", email: "admin@sitee.dev", password: "Admin#2026", role: store.RoleSuperAdmin, country: "NO", cityID: 9001, sol: 100, stars: 5000},
	{nickname: "sitee_arbiter", email: "arbiter@sitee.dev", password: "Arbiter#2026", role: store.RoleArbiter, country: "RU", cityID: 1001, sol: 5, stars: 200},
	{nickname: "keymaster", email: "shop@sitee.dev", password: "Shop#2026", role: store.RoleShopAdmin, country: "RU", cityID: 1002, sol: 12, stars: 1200},
	{nickname: "lena_digital", email: "lena@sitee.dev", password: "Shop#2026", role: store.RoleShopAdmin, country: "RU", cityID: 1001, sol: 6, stars: 400},
	{nickname: "viktor_keys", email: "viktor@sitee.dev", password: "Shop#2026", role: store.RoleShopAdmin, country: "KZ", cityID: 3001, sol: 4, stars: 300},
	{nickname: "buyer_nova", email: "buyer@sitee.dev", password: "Buyer#2026", role: store.RoleBuyer, country: "NO", cityID: 9003, sol: 25, stars: 3000},
	{nickname: "buyer_max", email: "max@sitee.dev", password: "Buyer#2026", role: store.RoleBuyer, country: "RU", cityID: 1003, sol: 9, stars: 900},
}

// shopSpec — описание магазина.
type shopSpec struct {
	slug        string
	name        string
	description string
	adminNick   string
	categoryIDs []int64
	country     string
	cityID      int64
	planCode    string
	rentStatus  string // trial|active|expiring|grace|suspended
	rentDays    int    // дней до конца периода (отрицательные — просрочка)
	verified    bool
	acceptStars bool
}

var demoShopsSpec = []shopSpec{
	{
		slug: "key-master", name: "КлючМастер",
		description: "Лицензионные ключи Windows, Office, антивирусов и VPN. Мгновенная выдача, гарантия замены 30 дней.",
		adminNick: "keymaster", categoryIDs: []int64{1, 3, 12}, country: "RU", cityID: 1002,
		planCode: "crown", rentStatus: store.RentActive, rentDays: 24, verified: true, acceptStars: true,
	},
	{
		slug: "cifra-nord", name: "Цифра Норд",
		description: "Подписки на стриминги, музыку и облачные сервисы. Официальные регионы, продление от 1 месяца.",
		adminNick: "lena_digital", categoryIDs: []int64{4, 8, 3}, country: "RU", cityID: 1001,
		planCode: "pro", rentStatus: store.RentActive, rentDays: 18, verified: true, acceptStars: true,
	},
	{
		slug: "almaty-keys", name: "Almaty Keys",
		description: "Игровые аккаунты и цифровые подарки Steam/Epic. Быстрая поддержка на русском и казахском.",
		adminNick: "viktor_keys", categoryIDs: []int64{5, 2, 1}, country: "KZ", cityID: 3001,
		planCode: "starter", rentStatus: store.RentTrial, rentDays: 4, acceptStars: true,
	},
	{
		slug: "game-vault", name: "GameVault",
		description: "Ключи активации игр, внутриигровая валюта, сезонные пропуска. Автовыдача 24/7.",
		adminNick: "keymaster", categoryIDs: []int64{5, 1, 10}, country: "RU", cityID: 1002,
		planCode: "pro", rentStatus: store.RentExpiring, rentDays: 5, acceptStars: true,
	},
	{
		slug: "soft-license", name: "SoftLicense",
		description: "Профессиональное ПО для дизайна, 3D и разработки. Корпоративные лицензии.",
		adminNick: "lena_digital", categoryIDs: []int64{3, 7, 6}, country: "RU", cityID: 1001,
		planCode: "starter", rentStatus: store.RentSuspended, rentDays: -3, acceptStars: false,
	},
	{
		slug: "proxy-nord", name: "ProxyNord",
		description: "Персональные прокси и VPN-подписки для работы и путешествий. Замена узла в течение часа.",
		adminNick: "viktor_keys", categoryIDs: []int64{12, 4, 10}, country: "KZ", cityID: 3002,
		planCode: "crown", rentStatus: store.RentActive, rentDays: 30, verified: true, acceptStars: true,
	},
}

// productSpec — описание товара и его стока.
type productSpec struct {
	shopSlug    string
	title       string
	description string
	kind        string
	categoryID  int64
	priceSOL    float64
	priceStars  int64
	warranty    int
	slaHours    int
	stock       []string
}

var demoProductsSpec = []productSpec{
	{
		shopSlug: "key-master", title: "Windows 11 Pro — цифровой ключ",
		description: "Оригинальный ключ активации Windows 11 Pro. Привязка к учётной записи Microsoft, пожизненная лицензия.",
		kind: "key", categoryID: 1, priceSOL: 1.2, priceStars: 120, warranty: 30, slaHours: 1,
		stock: []string{
			"SITEE-W11P-7QK2-M9XD-4RTV-88HN", "SITEE-W11P-3LMQ-77ZC-P2KD-10YX",
			"SITEE-W11P-9WBN-44HT-Q8LM-27ZD",
		},
	},
	{
		shopSlug: "key-master", title: "Office 2024 Home & Business",
		description: "Лицензия Office 2024 (Word, Excel, PowerPoint, Outlook) на 1 ПК, активация через аккаунт Microsoft.",
		kind: "key", categoryID: 3, priceSOL: 2.4, priceStars: 240, warranty: 30, slaHours: 1,
		stock: []string{
			"SITEE-OFF24-HB-2210-KL87-MN34-QW12", "SITEE-OFF24-HB-7781-ZX90-PQ23-LM65",
		},
	},
	{
		shopSlug: "key-master", title: "Антивирус Total Security, 1 год / 3 устройства",
		description: "Годовая подписка на комплексную защиту: антивирус, файрвол, антифишинг, защита платежей.",
		kind: "subscription", categoryID: 3, priceSOL: 0.9, priceStars: 90, warranty: 60, slaHours: 2,
		stock: []string{
			"Промокод активации: AV-TS-2026-8842-KLMQ\nСрок: 12 месяцев, 3 устройства\nАктивация: на сайте вендора → «Ввести код»",
			"Промокод активации: AV-TS-2026-1190-ZXCV\nСрок: 12 месяцев, 3 устройства",
			"Промокод активации: AV-TS-2026-5533-QWER\nСрок: 12 месяцев, 3 устройства",
		},
	},
	{
		shopSlug: "cifra-nord", title: "Подписка на музыкальный стриминг, 3 месяца",
		description: "Премиум-доступ к музыкальному сервису: без рекламы, офлайн-режим, высокое качество звука.",
		kind: "subscription", categoryID: 8, priceSOL: 1.5, priceStars: 150, warranty: 14, slaHours: 3,
		stock: []string{
			"Логин: music.nova.77@mail.dev\nПароль: Tr#9mKq2Lz\nРегион: EU\nПродление: до 2026-12-31",
			"Логин: music.beat.14@mail.dev\nПароль: Qw!8XcV3pL\nРегион: EU",
		},
	},
	{
		shopSlug: "cifra-nord", title: "Облачное хранилище 2 ТБ, 12 месяцев",
		description: "Годовая подписка на облако: 2 ТБ, совместная работа, версионирование файлов.",
		kind: "subscription", categoryID: 3, priceSOL: 3.2, priceStars: 320, warranty: 30, slaHours: 6,
		stock: []string{
			"Код активации: CLD-2TB-9921-MKQA-7712\nИнструкция: активировать в личном кабинете → «Подписки»",
			"Код активации: CLD-2TB-3390-ZXPL-1188",
		},
	},
	{
		shopSlug: "cifra-nord", title: "Курс «Цифровой маркетинг 2026»",
		description: "Доступ к 42 урокам, шаблонам и чату курса. Пожизненный доступ после активации.",
		kind: "file", categoryID: 6, priceSOL: 4.5, priceStars: 450, warranty: 7, slaHours: 12,
		stock: []string{
			"Ссылка на архив: https://cdn.sitee.dev/dl/mkt-2026-part1.zip\nПароль архива: 8Hd2-LmQ9-Xz41\nДоступ к чату: https://t.me/sitee_course_bot?start=mkt2026",
		},
	},
	{
		shopSlug: "almaty-keys", title: "Аккаунт игрового сервиса (уровень 30+)",
		description: "Прокачанный аккаунт с библиотекой из 12 игр, полная смена почты и пароля на ваши.",
		kind: "account", categoryID: 2, priceSOL: 2.8, priceStars: 280, warranty: 14, slaHours: 4,
		stock: []string{
			"Логин: gamer.almaty.07\nПароль: Kz#72mQp9L\nРезервная почта: reserve.07@mail.dev / Pass!8821\nУровень: 34, игр: 12",
			"Логин: gamer.almaty.19\nПароль: Rt%41xNq7B\nРезервная почта: reserve.19@mail.dev / Pass!3390\nУровень: 31, игр: 14",
		},
	},
	{
		shopSlug: "almaty-keys", title: "Пополнение игрового кошелька 1000 монет",
		description: "Зачисление 1000 внутриигровых монет на ваш аккаунт. Нужен только ID профиля.",
		kind: "service_code", categoryID: 5, priceSOL: 0.6, priceStars: 60, warranty: 3, slaHours: 2,
		stock: []string{
			"Код услуги: SVC-1000-7731-XX\nАктивация: в игре → Магазин → «Пополнить по коду»",
			"Код услуги: SVC-1000-2290-QM\nАктивация: в игре → Магазин → «Пополнить по коду»",
			"Код услуги: SVC-1000-8812-LP\nАктивация: в игре → Магазин → «Пополнить по коду»",
		},
	},
	{
		shopSlug: "game-vault", title: "Ключ активации RPG-новинки (PC)",
		description: "Цифровой ключ PC-версии, активация в лаунчере, региональных ограничений нет.",
		kind: "key", categoryID: 5, priceSOL: 5.5, priceStars: 550, warranty: 30, slaHours: 1,
		stock: []string{
			"RPG26-PC-A71M-99QX-2KL0-77HD", "RPG26-PC-B22N-10LM-88PQ-33ZK",
		},
	},
	{
		shopSlug: "game-vault", title: "Сезонный пропуск, 3 месяц",
		description: "Пропуск на сезон: эксклюзивные награды, ускоренная прокачка, бонусные задания.",
		kind: "subscription", categoryID: 5, priceSOL: 1.1, priceStars: 110, warranty: 7, slaHours: 2,
		stock: []string{
			"PASS-S3-9912-MKQA-7781", "PASS-S3-3390-ZXPL-1122", "PASS-S3-5581-QWRT-9903",
		},
	},
	{
		shopSlug: "soft-license", title: "Профессиональный графический пакет, 1 год",
		description: "Годовая лицензия на профессиональный графический редактор: коммерческое использование разрешено.",
		kind: "subscription", categoryID: 7, priceSOL: 8.9, priceStars: 890, warranty: 30, slaHours: 24,
		stock: []string{
			"Лицензия: GFX-PRO-2026-88121-KLMQ9\nАктивация: Help → Enter License\nПоддержка вендора: 12 месяцев",
		},
	},
	{
		shopSlug: "proxy-nord", title: "Персональный прокси, 1 месяц (10 локаций)",
		description: "Выделенный прокси с 10 локациями, безлимитный трафик, замена узла по запросу.",
		kind: "custom", categoryID: 12, priceSOL: 1.8, priceStars: 180, warranty: 30, slaHours: 2,
		stock: []string{
			"Логин: sitee_proxy_8842\nПароль: Px#9921mK\nСерверы: NL, DE, SE, NO, FI, PL, TR, US, GB, JP\nФормат: host:port:user:pass",
			"Логин: sitee_proxy_1190\nПароль: Qz!7712pL\nСерверы: NL, DE, SE, NO, FI, PL, TR, US, GB, JP",
		},
	},
	{
		shopSlug: "proxy-nord", title: "VPN-подписка Premium, 6 месяцев",
		description: "6 месяцев VPN: 60+ стран, WireGuard, kill switch, 5 устройств одновременно.",
		kind: "subscription", categoryID: 12, priceSOL: 2.2, priceStars: 220, warranty: 30, slaHours: 1,
		stock: []string{
			"VPN-PREM-6M-7712-KLMQ-9981\nАктивация: приложение → «Ввести код»",
			"VPN-PREM-6M-3390-ZXPL-1102",
		},
	},
	{
		shopSlug: "key-master", title: "Готовый аккаунт стриминга (EU, премиум)",
		description: "Аккаунт стримингового сервиса с премиум-подпиской до конца года, регион EU.",
		kind: "account", categoryID: 2, priceSOL: 3.4, priceStars: 340, warranty: 14, slaHours: 3,
		stock: []string{
			"Логин: stream.eu.44@mail.dev\nПароль: Nm!2287Qx\nПодписка: Premium до 2026-12-31\nРегион: EU",
		},
	},
}

// giftSpec — подарок из каталога (добавляется только из админ-панели).
type giftSpec struct {
	sku         string
	titleRU     string
	titleEN     string
	description string
	rarity      string
	emoji       string
	stars       int64
	sol         float64
	boostsShop  bool
	boostValue  float64
	boostDays   int
	collectible bool
	sort        int
}

var demoGiftsSpec = []giftSpec{
	{sku: "gift-rocket", titleRU: "Ракета", titleEN: "Rocket", description: "Ускорьте магазин: небольшой буст в ленте.", rarity: "common", emoji: "🚀", stars: 50, sol: 0.5, boostsShop: true, boostValue: 0.05, boostDays: 3, sort: 1},
	{sku: "gift-fire", titleRU: "Огонь", titleEN: "Fire", description: "Знак горячей поддержки покупателей.", rarity: "common", emoji: "🔥", stars: 30, sol: 0.3, sort: 2},
	{sku: "gift-headphones", titleRU: "Наушники", titleEN: "Headphones", description: "Для магазинов с музыкой и аудио-товарами.", rarity: "common", emoji: "🎧", stars: 75, sol: 0.75, sort: 3},
	{sku: "gift-chest", titleRU: "Сундук", titleEN: "Chest", description: "Сундук с бонусами: заметный буст в выдаче.", rarity: "rare", emoji: "🎁", stars: 200, sol: 2, boostsShop: true, boostValue: 0.12, boostDays: 7, sort: 4},
	{sku: "gift-diamond", titleRU: "Бриллиант", titleEN: "Diamond", description: "Редкий подарок для проверенных продавцов.", rarity: "rare", emoji: "💎", stars: 250, sol: 2.5, boostsShop: true, boostValue: 0.15, boostDays: 7, collectible: true, sort: 5},
	{sku: "gift-trophy", titleRU: "Кубок", titleEN: "Trophy", description: "Эпический кубок: сильный буст и статус.", rarity: "epic", emoji: "🏆", stars: 500, sol: 5, boostsShop: true, boostValue: 0.25, boostDays: 10, sort: 6},
	{sku: "gift-superstar", titleRU: "Суперзвезда", titleEN: "Superstar", description: "Магазин сияет в ленте 14 дней.", rarity: "epic", emoji: "🌟", stars: 900, sol: 9, boostsShop: true, boostValue: 0.35, boostDays: 14, collectible: true, sort: 7},
	{sku: "gift-crown", titleRU: "Корона", titleEN: "Crown", description: "Легендарная корона: максимум внимания покупателей.", rarity: "legendary", emoji: "👑", stars: 1500, sol: 15, boostsShop: true, boostValue: 0.6, boostDays: 14, collectible: true, sort: 8},
}

// reviewSpec — отзыв покупателя.
type reviewSpec struct {
	shopSlug string
	author   string
	rating   int
	delivery int
	desc     int
	support  int
	body     string
	reply    string
	daysAgo  int
	helpful  int
}

var demoReviewsSpec = []reviewSpec{
	{shopSlug: "key-master", author: "buyer_nova", rating: 5, delivery: 5, desc: 5, support: 5,
		body: "Ключ пришёл через минуту после оплаты, активировался без проблем. Продавец ответил в чате за 10 минут.",
		reply: "Спасибо за отзыв! Обращайтесь — продлим и настроим.", daysAgo: 4, helpful: 12},
	{shopSlug: "key-master", author: "buyer_max", rating: 5, delivery: 5, desc: 5, support: 4,
		body: "Второй заказ, всё чётко. Автовыдача работает ночью — это главное.", daysAgo: 9, helpful: 7},
	{shopSlug: "key-master", author: "buyer_nova", rating: 4, delivery: 4, desc: 5, support: 4,
		body: "Office встал с первой попытки, но ответа в чате ждал около часа.", daysAgo: 16, helpful: 3},
	{shopSlug: "cifra-nord", author: "buyer_max", rating: 5, delivery: 5, desc: 4, support: 5,
		body: "Подписка на музыку работает, регион EU как и обещали. Помогли с входом.",
		reply: "Рады помочь! Если смените устройство — пишите.", daysAgo: 3, helpful: 9},
	{shopSlug: "cifra-nord", author: "buyer_nova", rating: 4, delivery: 4, desc: 4, support: 5,
		body: "Облако 2 ТБ активировалось, инструкция понятная. Хотелось бы быстрее выдачу.", daysAgo: 11, helpful: 2},
	{shopSlug: "almaty-keys", author: "buyer_nova", rating: 5, delivery: 5, desc: 5, support: 5,
		body: "Аккаунт передали с полной сменой почты, всё по инструкции. Поддержка на русском.",
		daysAgo: 2, helpful: 5},
	{shopSlug: "game-vault", author: "buyer_max", rating: 4, delivery: 5, desc: 4, support: 4,
		body: "Ключ игры пришёл мгновенно, активировался. Минус балл за скудное описание региона.", daysAgo: 6, helpful: 4},
	{shopSlug: "proxy-nord", author: "buyer_nova", rating: 5, delivery: 5, desc: 5, support: 5,
		body: "Прокси работают стабильно, локаций реально 10. Узел заменили за 40 минут по запросу.",
		reply: "Спасибо! Держим SLA.", daysAgo: 5, helpful: 11},
	{shopSlug: "proxy-nord", author: "buyer_max", rating: 3, delivery: 3, desc: 4, support: 3,
		body: "VPN неплохой, но выдача заняла почти сутки вместо обещанных часов.", daysAgo: 13, helpful: 1},
	{shopSlug: "soft-license", author: "buyer_max", rating: 2, delivery: 2, desc: 3, support: 2,
		body: "Лицензию ждал два дня, магазин сейчас недоступен из-за аренды.", daysAgo: 20, helpful: 0},
}

// Demo наполняет хранилище. Повторный вызов при непустом хранилище — no-op.
func Demo(st *store.Store, cr *cryptod.Core, cfg *config.Config, log *slog.Logger) (*Result, error) {
	alreadySeeded := false
	st.Read(func() { alreadySeeded = len(st.Users) > 0 })
	if alreadySeeded {
		log.Info("seed: хранилище уже наполнено, пропускаем демо-данные")
		return nil, nil
	}
	now := time.Now().UTC()
	res := &Result{Counters: map[string]int{}}

	users, creds, err := buildUsers(cr, now)
	if err != nil {
		return nil, fmt.Errorf("seed: пользователи: %w", err)
	}
	res.Users = creds
	res.Counters["users"] = len(users)

	shops, products, stock, payloads, err := buildShops(cr, users, now)
	if err != nil {
		return nil, fmt.Errorf("seed: магазины/товары: %w", err)
	}
	res.Counters["shops"] = len(shops)
	res.Counters["products"] = len(products)

	gifts := buildGifts(now)
	res.Counters["gifts"] = len(gifts)

	reviews := buildReviews(users, shops, now)
	res.Counters["reviews"] = len(reviews)

	chats, members, messages := buildChats(cr, users, shops, now)
	res.Counters["chats"] = len(chats)
	msgCount := 0
	for _, list := range messages {
		msgCount += len(list)
	}
	res.Counters["messages"] = msgCount

	orders, disputes, orderChats, orderMembers, orderMessages, err := buildOrders(cr, users, shops, products, stock, payloads, now, cfg)
	if err != nil {
		return nil, fmt.Errorf("seed: заказы: %w", err)
	}
	res.Counters["orders"] = len(orders)
	res.Counters["disputes"] = len(disputes)

	notifications := buildNotifications(users, shops, orders, now)
	res.Counters["notifications"] = len(notifications)

	// Единая транзакция записи: справочники, сущности, ledger.
	st.Write(func() {
		seedGeo(st)
		seedCategories(st)
		seedRentPlans(st)

		for _, u := range users {
			st.Users[u.ID] = u
			st.UsersByNick[u.Nickname] = u.ID
			if u.EmailIdx != "" {
				st.UsersByMail[u.EmailIdx] = u.ID
			}
			st.EnsureAccountLocked(store.OwnerUser, u.ID, store.AssetSOL)
			st.EnsureAccountLocked(store.OwnerUser, u.ID, store.AssetStars)
		}
		for _, sh := range shops {
			st.Shops[sh.ID] = sh
			st.ShopsBySlug[sh.Slug] = sh.ID
		}
		for _, p := range products {
			st.Products[p.ID] = p
		}
		for productID, items := range stock {
			st.Stock[productID] = items
		}
		for _, g := range gifts {
			st.Gifts[g.ID] = g
		}
		for _, rv := range reviews {
			st.Reviews[rv.ID] = rv
		}
		for _, c := range chats {
			st.Chats[c.ID] = c
			st.Members[c.ID] = members[c.ID]
			st.Messages[c.ID] = messages[c.ID]
		}
		for _, o := range orders {
			st.Orders[o.ID] = o
			st.OrdersByNumber[o.Number] = o.ID
		}
		for _, ev := range orderStatusEvents {
			st.OrderStatuses = append(st.OrderStatuses, ev)
		}
		for _, d := range disputes {
			st.Disputes[d.ID] = d
		}
		for _, c := range orderChats {
			st.Chats[c.ID] = c
			st.Members[c.ID] = orderMembers[c.ID]
			st.Messages[c.ID] = orderMessages[c.ID]
		}
		for userID, list := range notifications {
			st.Notifications[userID] = list
		}
		seedSettings(st)
		seedBalances(st, users)
		seedSubscriptions(st, shops, now)
		seedOrderLedger(st, orders)
		seedPlatformFees(st, orders)
		recalcShopRatings(shops, reviews)
	})

	for _, sh := range shops {
		res.ShopIDs = append(res.ShopIDs, sh.ID)
	}
	for _, p := range products {
		res.ProductIDs = append(res.ProductIDs, p.ID)
	}
	for _, o := range orders {
		res.OrderIDs = append(res.OrderIDs, o.ID)
	}
	for _, d := range disputes {
		res.DisputeIDs = append(res.DisputeIDs, d.ID)
	}
	for _, g := range gifts {
		res.GiftIDs = append(res.GiftIDs, g.ID)
	}
	for _, c := range chats {
		res.ChatIDs = append(res.ChatIDs, c.ID)
	}
	for _, c := range orderChats {
		res.ChatIDs = append(res.ChatIDs, c.ID)
	}
	st.Read(func() {
		for i := range res.Users {
			u := users[res.Users[i].Nickname]
			if u == nil {
				continue
			}
			res.Users[i].BalanceSOL = store.FormatSOL(st.BalanceLocked(store.UserAccount(u.ID, store.AssetSOL)))
			res.Users[i].BalanceStars = st.BalanceLocked(store.UserAccount(u.ID, store.AssetStars))
			for _, sh := range shops {
				if sh.AdminUserID == u.ID {
					res.Users[i].ShopIDs = append(res.Users[i].ShopIDs, sh.ID)
				}
			}
		}
	})
	log.Info("seed: демо-данные загружены",
		"users", len(users), "shops", len(shops), "products", len(products),
		"orders", len(orders), "disputes", len(disputes), "gifts", len(gifts))
	return res, nil
}

// orderStatusEvents накапливается при построении заказов.
var orderStatusEvents []*store.StatusEvent

// ---------------------------------------------------------------------------
// Справочники
// ---------------------------------------------------------------------------

func seedGeo(st *store.Store) {
	countries := []store.Country{
		{Code: "RU", NameRU: "Россия", NameEN: "Russia"},
		{Code: "BY", NameRU: "Беларусь", NameEN: "Belarus"},
		{Code: "KZ", NameRU: "Казахстан", NameEN: "Kazakhstan"},
		{Code: "GE", NameRU: "Грузия", NameEN: "Georgia"},
		{Code: "AM", NameRU: "Армения", NameEN: "Armenia"},
		{Code: "UZ", NameRU: "Узбекистан", NameEN: "Uzbekistan"},
		{Code: "TR", NameRU: "Турция", NameEN: "Turkey"},
		{Code: "AE", NameRU: "ОАЭ", NameEN: "United Arab Emirates"},
		{Code: "DE", NameRU: "Германия", NameEN: "Germany"},
		{Code: "NL", NameRU: "Нидерланды", NameEN: "Netherlands"},
		{Code: "NO", NameRU: "Норвегия", NameEN: "Norway"},
		{Code: "SE", NameRU: "Швеция", NameEN: "Sweden"},
		{Code: "FI", NameRU: "Финляндия", NameEN: "Finland"},
		{Code: "PL", NameRU: "Польша", NameEN: "Poland"},
		{Code: "GB", NameRU: "Великобритания", NameEN: "United Kingdom"},
		{Code: "US", NameRU: "США", NameEN: "United States"},
		{Code: "IN", NameRU: "Индия", NameEN: "India"},
		{Code: "BR", NameRU: "Бразилия", NameEN: "Brazil"},
	}
	for _, c := range countries {
		cc := c
		st.Countries[cc.Code] = &cc
	}
	cities := []store.City{
		{ID: 1001, Country: "RU", NameRU: "Москва", NameEN: "Moscow", TZ: "Europe/Moscow", Population: 13100000},
		{ID: 1002, Country: "RU", NameRU: "Санкт-Петербург", NameEN: "Saint Petersburg", TZ: "Europe/Moscow", Population: 5600000},
		{ID: 1003, Country: "RU", NameRU: "Новосибирск", NameEN: "Novosibirsk", TZ: "Asia/Novosibirsk", Population: 1630000},
		{ID: 1004, Country: "RU", NameRU: "Екатеринбург", NameEN: "Yekaterinburg", TZ: "Asia/Yekaterinburg", Population: 1540000},
		{ID: 1005, Country: "RU", NameRU: "Казань", NameEN: "Kazan", TZ: "Europe/Moscow", Population: 1310000},
		{ID: 1006, Country: "RU", NameRU: "Сочи", NameEN: "Sochi", TZ: "Europe/Moscow", Population: 440000},
		{ID: 2001, Country: "BY", NameRU: "Минск", NameEN: "Minsk", TZ: "Europe/Minsk", Population: 1990000},
		{ID: 3001, Country: "KZ", NameRU: "Алматы", NameEN: "Almaty", TZ: "Asia/Almaty", Population: 2000000},
		{ID: 3002, Country: "KZ", NameRU: "Астана", NameEN: "Astana", TZ: "Asia/Almaty", Population: 1350000},
		{ID: 4001, Country: "GE", NameRU: "Тбилиси", NameEN: "Tbilisi", TZ: "Asia/Tbilisi", Population: 1200000},
		{ID: 5001, Country: "AM", NameRU: "Ереван", NameEN: "Yerevan", TZ: "Asia/Yerevan", Population: 1100000},
		{ID: 6001, Country: "UZ", NameRU: "Ташкент", NameEN: "Tashkent", TZ: "Asia/Tashkent", Population: 2900000},
		{ID: 7001, Country: "TR", NameRU: "Стамбул", NameEN: "Istanbul", TZ: "Europe/Istanbul", Population: 15800000},
		{ID: 8001, Country: "AE", NameRU: "Дубай", NameEN: "Dubai", TZ: "Asia/Dubai", Population: 3600000},
		{ID: 8501, Country: "DE", NameRU: "Берлин", NameEN: "Berlin", TZ: "Europe/Berlin", Population: 3700000},
		{ID: 8502, Country: "DE", NameRU: "Мюнхен", NameEN: "Munich", TZ: "Europe/Berlin", Population: 1500000},
		{ID: 8601, Country: "NL", NameRU: "Амстердам", NameEN: "Amsterdam", TZ: "Europe/Amsterdam", Population: 920000},
		{ID: 9001, Country: "NO", NameRU: "Осло", NameEN: "Oslo", TZ: "Europe/Oslo", Population: 700000},
		{ID: 9002, Country: "NO", NameRU: "Берген", NameEN: "Bergen", TZ: "Europe/Oslo", Population: 290000},
		{ID: 9003, Country: "NO", NameRU: "Саннефьорд", NameEN: "Sandefjord", TZ: "Europe/Oslo", Population: 65000},
		{ID: 9004, Country: "NO", NameRU: "Тронхейм", NameEN: "Trondheim", TZ: "Europe/Oslo", Population: 210000},
		{ID: 9101, Country: "SE", NameRU: "Стокгольм", NameEN: "Stockholm", TZ: "Europe/Stockholm", Population: 980000},
		{ID: 9201, Country: "FI", NameRU: "Хельсинки", NameEN: "Helsinki", TZ: "Europe/Helsinki", Population: 660000},
		{ID: 9301, Country: "PL", NameRU: "Варшава", NameEN: "Warsaw", TZ: "Europe/Warsaw", Population: 1860000},
		{ID: 9401, Country: "GB", NameRU: "Лондон", NameEN: "London", TZ: "Europe/London", Population: 8900000},
		{ID: 9501, Country: "US", NameRU: "Нью-Йорк", NameEN: "New York", TZ: "America/New_York", Population: 8300000},
		{ID: 9601, Country: "IN", NameRU: "Мумбаи", NameEN: "Mumbai", TZ: "Asia/Kolkata", Population: 21000000},
		{ID: 9701, Country: "BR", NameRU: "Сан-Паулу", NameEN: "Sao Paulo", TZ: "America/Sao_Paulo", Population: 12300000},
	}
	for _, c := range cities {
		cc := c
		st.Cities[cc.ID] = &cc
	}
}

func seedCategories(st *store.Store) {
	cats := []store.Category{
		{ID: 1, Slug: "keys", NameRU: "Ключи и активации", NameEN: "Keys & activations"},
		{ID: 2, Slug: "accounts", NameRU: "Аккаунты", NameEN: "Accounts", Restricted: true},
		{ID: 3, Slug: "software", NameRU: "Программы", NameEN: "Software"},
		{ID: 4, Slug: "subscriptions", NameRU: "Подписки", NameEN: "Subscriptions"},
		{ID: 5, Slug: "gaming", NameRU: "Игровые товары", NameEN: "Gaming"},
		{ID: 6, Slug: "education", NameRU: "Обучение и курсы", NameEN: "Education"},
		{ID: 7, Slug: "design", NameRU: "Дизайн и графика", NameEN: "Design & graphics"},
		{ID: 8, Slug: "music", NameRU: "Музыка и аудио", NameEN: "Music & audio"},
		{ID: 9, Slug: "crypto-tools", NameRU: "Крипто-инструменты", NameEN: "Crypto tools", Restricted: true},
		{ID: 10, Slug: "services", NameRU: "Услуги", NameEN: "Services"},
		{ID: 11, Slug: "files", NameRU: "Файлы и шаблоны", NameEN: "Files & templates"},
		{ID: 12, Slug: "vpn-proxy", NameRU: "VPN и прокси", NameEN: "VPN & proxy"},
	}
	for _, c := range cats {
		cc := c
		st.Categories[cc.ID] = &cc
	}
}

func seedRentPlans(st *store.Store) {
	plans := []store.RentPlan{
		{
			ID: ids.New("pln"), Code: "starter", NameRU: "Стартовый", NameEN: "Starter",
			PriceLamports: 5 * store.LamportsPerSOL, PriceStars: 500,
			ProductLimit: 5, OperatorLimit: 1, FeeBPS: 700, FeedBoost: 0,
			GrantsCrown: false, SupportSLAH: 48, Active: true,
			Description: "Для первого магазина: до 5 товаров, комиссия 7 %, пробный период 7 дней.",
		},
		{
			ID: ids.New("pln"), Code: "pro", NameRU: "Профи", NameEN: "Pro",
			PriceLamports: 19 * store.LamportsPerSOL, PriceStars: 1900,
			ProductLimit: 25, OperatorLimit: 3, FeeBPS: 500, FeedBoost: 0.15,
			GrantsCrown: false, SupportSLAH: 24, Active: true,
			Description: "До 25 товаров, комиссия 5 %, буст в ленте, поддержка 24 ч.",
		},
		{
			ID: ids.New("pln"), Code: "crown", NameRU: "Корона", NameEN: "Crown",
			PriceLamports: 49 * store.LamportsPerSOL, PriceStars: 4900,
			ProductLimit: 100, OperatorLimit: 10, FeeBPS: 350, FeedBoost: 0.3,
			GrantsCrown: true, SupportSLAH: 12, Active: true,
			Description: "Коронка в ленте при рейтинге ≥ 4.0, до 100 товаров, комиссия 3.5 %.",
		},
		{
			ID: ids.New("pln"), Code: "enterprise", NameRU: "Бизнес", NameEN: "Enterprise",
			PriceLamports: 149 * store.LamportsPerSOL, PriceStars: 14900,
			ProductLimit: 500, OperatorLimit: 25, FeeBPS: 250, FeedBoost: 0.35,
			GrantsCrown: true, SupportSLAH: 6, Active: true,
			Description: "Максимум возможностей: 500 товаров, комиссия 2.5 %, верификация, SLA 6 ч.",
		},
	}
	for i := range plans {
		p := plans[i]
		st.RentPlans[p.ID] = &p
	}
}

func seedSettings(st *store.Store) {
	st.Settings["registration_open"] = true
	st.Settings["rent_trial_days"] = 7
	st.Settings["max_shops_per_account"] = 3
	st.Settings["default_fee_bps"] = 700
	st.Settings["gift_boost_max"] = 0.6
	st.Settings["promoted_slots_per_page"] = 1
	st.Settings["maintenance_mode"] = false
	st.Settings["withdrawals_frozen"] = false
}

// ---------------------------------------------------------------------------
// Пользователи и двойной 2FA
// ---------------------------------------------------------------------------

func buildUsers(cr *cryptod.Core, now time.Time) (map[string]*store.User, []UserCredentials, error) {
	users := map[string]*store.User{}
	creds := []UserCredentials{}
	for i, spec := range demoUsersSpec {
		userID := ids.New("usr")
		hash, err := cryptod.HashPassword(spec.password)
		if err != nil {
			return nil, nil, fmt.Errorf("хэш пароля %s: %w", spec.nickname, err)
		}
		emailCT, err := cr.EncryptString(store.DomainPII, userID, spec.email)
		if err != nil {
			return nil, nil, fmt.Errorf("шифрование email %s: %w", spec.nickname, err)
		}
		u := &store.User{
			ID: userID, EmailCT: emailCT, EmailIdx: cr.BlindIndex(spec.email),
			Nickname: spec.nickname, PasswordHash: hash, Role: spec.role,
			Country: spec.country, CityID: spec.cityID, Locale: "ru", Theme: "dark",
			Status: store.UserActive, Factors: map[string]*store.Factor{},
			Seq: uint64(i + 1), Is18Plus: true,
			CreatedAt: now.Add(-time.Duration(40+i*3) * 24 * time.Hour),
			LastLoginAt: now.Add(-time.Duration(i) * time.Hour),
		}
		// Депозитный адрес (SLIP-0010, docs/solana.md §3.1).
		u.DepositPath = cryptod.DepositPath(u.Seq)
		if addr, aerr := cr.AddressOf(u.DepositPath); aerr == nil {
			u.DepositAddress = addr
		}
		cred := UserCredentials{
			UserID: userID, Role: spec.role, Nickname: spec.nickname,
			Email: spec.email, Password: spec.password, Country: spec.country,
		}
		for _, factor := range []string{store.FactorLogin, store.FactorOps} {
			secret, serr := cryptod.NewTOTPSecret()
			if serr != nil {
				return nil, nil, fmt.Errorf("TOTP-секрет %s/%s: %w", spec.nickname, factor, serr)
			}
			ct, cerr := cr.Encrypt(store.Domain2FA, userID+":"+factor, secret)
			if cerr != nil {
				return nil, nil, fmt.Errorf("шифрование секрета %s/%s: %w", spec.nickname, factor, cerr)
			}
			codes, hashes, berr := cr.BackupCodes(10)
			if berr != nil {
				return nil, nil, fmt.Errorf("резервные коды %s/%s: %w", spec.nickname, factor, berr)
			}
			label := "вход"
			if factor == store.FactorOps {
				label = "операции"
			}
			secretB32 := cryptod.SecretBase32(secret)
			u.Factors[factor] = &store.Factor{
				Name: factor, SecretCT: ct, Status: "active",
				BackupHashes: hashes, BackupUsed: map[int]bool{},
				UsedCodes: map[string]int64{}, EnrolledAt: now.Add(-time.Duration(30+i) * 24 * time.Hour),
			}
			if factor == store.FactorLogin {
				cred.LoginSecret = secretB32
				cred.LoginOTPURL = cryptod.OTPAuthURL("SITEE", spec.nickname, secretB32, label)
				cred.LoginBackup = codes
			} else {
				cred.OpsSecret = secretB32
				cred.OpsOTPURL = cryptod.OTPAuthURL("SITEE", spec.nickname, secretB32, label)
				cred.OpsBackup = codes
			}
		}
		users[spec.nickname] = u
		creds = append(creds, cred)
	}
	return users, creds, nil
}

func seedBalances(st *store.Store, users map[string]*store.User) {
	st.EnsureAccountLocked(store.OwnerPlatform, store.PlatformCustody, store.AssetSOL)
	st.EnsureAccountLocked(store.OwnerPlatform, store.PlatformStarsReserve, store.AssetStars)
	for _, spec := range demoUsersSpec {
		u := users[spec.nickname]
		if u == nil {
			continue
		}
		if spec.sol > 0 {
			lamports := int64(spec.sol * float64(store.LamportsPerSOL))
			_, err := st.PostLocked("seed:balance:"+u.ID+":SOL", store.AssetSOL, store.KindSeed,
				"user", u.ID, "", []store.Posting{
					store.Debit(store.PlatformAccount(store.PlatformCustody, store.AssetSOL), lamports),
					store.Credit(store.UserAccount(u.ID, store.AssetSOL), lamports),
				})
			if err != nil {
				continue
			}
		}
		if spec.stars > 0 {
			_, err := st.PostLocked("seed:balance:"+u.ID+":STARS", store.AssetStars, store.KindSeed,
				"user", u.ID, "", []store.Posting{
					store.Debit(store.PlatformAccount(store.PlatformStarsReserve, store.AssetStars), spec.stars),
					store.Credit(store.UserAccount(u.ID, store.AssetStars), spec.stars),
				})
			if err != nil {
				continue
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Магазины, тарифы, товары
// ---------------------------------------------------------------------------

func buildShops(cr *cryptod.Core, users map[string]*store.User, now time.Time) ([]*store.Shop, []*store.Product, map[string][]*store.StockItem, map[string][]string, error) {
	shops := []*store.Shop{}
	products := []*store.Product{}
	stock := map[string][]*store.StockItem{}
	payloads := map[string][]string{}
	byNick := map[string]*store.User{}
	for nick, u := range users {
		byNick[nick] = u
	}

	for _, spec := range demoShopsSpec {
		admin := byNick[spec.adminNick]
		if admin == nil {
			return nil, nil, nil, nil, fmt.Errorf("админ магазина %s не найден", spec.adminNick)
		}
		sh := &store.Shop{
			ID: ids.New("shp"), AdminUserID: admin.ID, Slug: spec.slug, Name: spec.name,
			Description: spec.description, CategoryIDs: spec.categoryIDs,
			Country: spec.country, CityID: spec.cityID, TZ: cityTZ(spec.cityID),
			Status: store.ShopActive, IsVerified: spec.verified,
			AcceptsStars: spec.acceptStars, SanctionLevel: "none",
			CreatedAt: now.Add(-time.Duration(30+len(shops)*2) * 24 * time.Hour),
			UpdatedAt: now,
		}
		if spec.rentStatus == store.RentSuspended {
			sh.Status = store.ShopSuspended
		}
		shops = append(shops, sh)
	}

	for _, spec := range demoProductsSpec {
		var shop *store.Shop
		for _, sh := range shops {
			if sh.Slug == spec.shopSlug {
				shop = sh
				break
			}
		}
		if shop == nil {
			return nil, nil, nil, nil, fmt.Errorf("магазин %s для товара %q не найден", spec.shopSlug, spec.title)
		}
		lamports, err := parseSOL(spec.priceSOL)
		if err != nil {
			return nil, nil, nil, nil, err
		}
		p := &store.Product{
			ID: ids.New("prd"), ShopID: shop.ID, Title: spec.title, Description: spec.description,
			Kind: spec.kind, CategoryID: spec.categoryID,
			PriceLamports: lamports, PriceStars: spec.priceStars,
			WarrantyDays: spec.warranty, DeliverySLAH: spec.slaHours,
			Status: store.ProductPublished, StockTotal: len(spec.stock), StockFree: len(spec.stock),
			CreatedAt: now.Add(-time.Duration(10+len(products)) * 24 * time.Hour),
			UpdatedAt: now,
		}
		products = append(products, p)
		payloads[p.ID] = spec.stock
		items := make([]*store.StockItem, 0, len(spec.stock))
		for _, payload := range spec.stock {
			item := &store.StockItem{
				ID: ids.New("stk"), ProductID: p.ID, Status: "free",
				CreatedAt: p.CreatedAt,
			}
			ct, cerr := cr.EncryptString(store.DomainProductStock, item.ID, payload)
			if cerr != nil {
				return nil, nil, nil, nil, fmt.Errorf("шифрование стока %s: %w", p.Title, cerr)
			}
			item.PayloadCT = ct
			items = append(items, item)
		}
		stock[p.ID] = items
	}
	return shops, products, stock, payloads, nil
}

func cityTZ(cityID int64) string {
	switch cityID {
	case 1003:
		return "Asia/Novosibirsk"
	case 1004:
		return "Asia/Yekaterinburg"
	case 3001, 3002:
		return "Asia/Almaty"
	case 9001, 9002, 9003, 9004:
		return "Europe/Oslo"
	}
	return "Europe/Moscow"
}

func seedSubscriptions(st *store.Store, shops []*store.Shop, now time.Time) {
	planByCode := map[string]*store.RentPlan{}
	for _, p := range st.RentPlans {
		planByCode[p.Code] = p
	}
	for i, spec := range demoShopsSpec {
		if i >= len(shops) {
			break
		}
		sh := shops[i]
		plan := planByCode[spec.planCode]
		if plan == nil {
			continue
		}
		start := now.Add(-time.Duration(20+i*4) * 24 * time.Hour)
		end := now.Add(time.Duration(spec.rentDays) * 24 * time.Hour)
		sub := &store.RentSub{
			ID: ids.New("sub"), ShopID: sh.ID, PlanID: plan.ID, Status: spec.rentStatus,
			Asset: store.AssetSOL, PriceLamports: plan.PriceLamports, PriceStars: plan.PriceStars,
			PeriodStart: start, PeriodEnd: end, AutoRenew: spec.rentStatus == store.RentActive,
			CreatedAt: start, UpdatedAt: now,
		}
		if spec.rentStatus == store.RentSuspended {
			sub.GraceEnd = now.Add(-24 * time.Hour)
		}
		st.Subs[sh.ID] = sub
		// Демо-проводка аренды: platform:custody → platform:rent (KindSeed),
		// чтобы не списывать с пользователей суммы, которых у них нет в демо.
		st.EnsureAccountLocked(store.OwnerPlatform, store.PlatformRent, store.AssetSOL)
		_, _ = st.PostLocked("seed:rent:"+sh.ID, store.AssetSOL, store.KindSeed, "shop", sh.ID, "",
			[]store.Posting{
				store.Debit(store.PlatformAccount(store.PlatformCustody, store.AssetSOL), plan.PriceLamports),
				store.Credit(store.PlatformAccount(store.PlatformRent, store.AssetSOL), plan.PriceLamports),
			})
	}
}

// ---------------------------------------------------------------------------
// Подарки, отзывы
// ---------------------------------------------------------------------------

func buildGifts(now time.Time) []*store.Gift {
	gifts := []*store.Gift{}
	for _, spec := range demoGiftsSpec {
		lamports, _ := parseSOL(spec.sol)
		g := &store.Gift{
			ID: ids.New("gft"), SKU: spec.sku, TitleRU: spec.titleRU, TitleEN: spec.titleEN,
			Description: spec.description, Rarity: spec.rarity, Emoji: spec.emoji,
			PriceStars: spec.stars, PriceLamport: lamports,
			BoostsShop: spec.boostsShop, BoostValue: spec.boostValue, BoostDays: spec.boostDays,
			Collectible: spec.collectible, Status: "published", Sort: spec.sort,
			CreatedBy: "seed", CreatedAt: now.Add(-30 * 24 * time.Hour), UpdatedAt: now,
		}
		if spec.sku == "gift-crown" {
			g.PerUserLimit = 3
		}
		gifts = append(gifts, g)
	}
	return gifts
}

func buildReviews(users map[string]*store.User, shops []*store.Shop, now time.Time) []*store.Review {
	reviews := []*store.Review{}
	shopBySlug := map[string]*store.Shop{}
	for _, sh := range shops {
		shopBySlug[sh.Slug] = sh
	}
	for _, spec := range demoReviewsSpec {
		sh := shopBySlug[spec.shopSlug]
		author := users[spec.author]
		if sh == nil || author == nil {
			continue
		}
		created := now.Add(-time.Duration(spec.daysAgo) * 24 * time.Hour)
		rv := &store.Review{
			ID: ids.New("rev"), OrderID: "", ShopID: sh.ID, AuthorID: author.ID,
			Rating: spec.rating, RatingDelivery: spec.delivery,
			RatingDescription: spec.desc, RatingSupport: spec.support,
			Body: spec.body, ShopReply: spec.reply, Verified: true, Status: "published",
			Helpful: spec.helpful, CreatedAt: created,
		}
		if spec.reply != "" {
			rv.ShopReplyAt = created.Add(6 * time.Hour)
		}
		reviews = append(reviews, rv)
	}
	return reviews
}

// recalcShopRatings пересчитывает рейтинг по Байесу (C=10, m=3.8) — та же
// формула, что и в api.recalcRatingLocked (docs/economy.md §6.1).
func recalcShopRatings(shops []*store.Shop, reviews []*store.Review) {
	const (
		priorC = 10.0
		priorM = 3.8
	)
	for _, sh := range shops {
		var sum int64
		count := 0
		for _, rv := range reviews {
			if rv.ShopID != sh.ID {
				continue
			}
			sum += int64(rv.Rating)
			count++
		}
		sh.RatingSum = sum
		sh.RatingCount = count
		sh.RatingBayes = (priorC*priorM + float64(sum)) / (priorC + float64(count))
	}
}

// ---------------------------------------------------------------------------
// Диалоги: каналы магазинов, чаты поддержки
// ---------------------------------------------------------------------------

func buildChats(cr *cryptod.Core, users map[string]*store.User, shops []*store.Shop, now time.Time) ([]*store.Chat, map[string][]*store.Member, map[string][]*store.Message) {
	chats := []*store.Chat{}
	members := map[string][]*store.Member{}
	messages := map[string][]*store.Message{}

	addMsg := func(c *store.Chat, sender *store.User, text string, minutesAgo int) {
		c.LastSeq++
		m := &store.Message{
			ID: ids.New("msg"), ChatID: c.ID, Seq: c.LastSeq, Type: "text",
			SenderVisibleAs: sender.Nickname, CreatedAt: now.Add(-time.Duration(minutesAgo) * time.Minute),
			BodySize: len(text),
		}
		if sender != nil {
			m.SenderID = sender.ID
		}
		if ct, err := cr.EncryptString(store.DomainMessage, m.ID, text); err == nil {
			m.BodyCT = ct
		}
		messages[c.ID] = append(messages[c.ID], m)
		c.LastMessageAt = m.CreatedAt
		c.LastPreview = text
	}

	for i, sh := range shops {
		admin := users[nickOfAdmin(sh)]
		// Канал магазина.
		channel := &store.Chat{
			ID: ids.New("cht"), Kind: store.ChatChannel, Title: sh.Name + " · анонсы",
			ShopID: sh.ID, AdminUserID: sh.AdminUserID, CreatedAt: now.Add(-time.Duration(20+i) * 24 * time.Hour),
		}
		chats = append(chats, channel)
		members[channel.ID] = []*store.Member{
			{ChatID: channel.ID, UserID: sh.AdminUserID, Role: "owner", JoinedAt: channel.CreatedAt},
		}
		for _, buyer := range []string{"buyer_nova", "buyer_max"} {
			if u := users[buyer]; u != nil {
				members[channel.ID] = append(members[channel.ID], &store.Member{
					ChatID: channel.ID, UserID: u.ID, Role: "subscriber", JoinedAt: channel.CreatedAt,
				})
			}
		}
		addMsg(channel, admin, "Добро пожаловать в канал «"+sh.Name+"»! Здесь — акции и новые товары.", 60*24*3)
		addMsg(channel, admin, channelPost(i), 60*12)

		// Чат поддержки с админом магазина (TZ §3.1: все диалоги открываются с админом).
		buyer := users["buyer_nova"]
		if i%2 == 1 {
			buyer = users["buyer_max"]
		}
		support := &store.Chat{
			ID: ids.New("cht"), Kind: store.ChatShopSupport, Title: sh.Name + " · поддержка",
			ShopID: sh.ID, AdminUserID: sh.AdminUserID,
			CreatedAt: now.Add(-time.Duration(5+i) * 24 * time.Hour),
		}
		chats = append(chats, support)
		members[support.ID] = []*store.Member{
			{ChatID: support.ID, UserID: sh.AdminUserID, Role: "admin", VisibleAs: "Админ магазина", JoinedAt: support.CreatedAt},
			{ChatID: support.ID, UserID: buyer.ID, Role: "member", JoinedAt: support.CreatedAt},
		}
		addMsg(support, buyer, supportQuestion(i), 60*5)
		addMsg(support, admin, supportAnswer(i), 60*4-20)
	}
	return chats, members, messages
}

func nickOfAdmin(sh *store.Shop) string {
	switch sh.Slug {
	case "key-master", "game-vault":
		return "keymaster"
	case "cifra-nord", "soft-license":
		return "lena_digital"
	case "almaty-keys", "proxy-nord":
		return "viktor_keys"
	}
	return "keymaster"
}

func channelPost(i int) string {
	posts := []string{
		"Скидка 15 % на ключи Windows до конца недели — промо применяется автоматически при оплате.",
		"Добавили годовые подписки на облако 2 ТБ: выдача в течение 6 часов, гарантия 30 дней.",
		"Новые игровые аккаунты с полной сменой почты. Поддержка отвечает на русском и казахском.",
		"Сезонные пропуска в наличии: автовыдача круглосуточно, гарантия замены 7 дней.",
		"Магазин на паузе: продлеваем аренду, скоро вернёмся с новыми лицензиями.",
		"Персональные прокси: 10 локаций, замена узла по запросу в течение часа.",
	}
	return posts[i%len(posts)]
}

func supportQuestion(i int) string {
	questions := []string{
		"Здравствуйте! Ключ Windows подходит для активации на уже установленной системе?",
		"Добрый день. Подписка на музыку — какой регион и можно ли менять устройство?",
		"Привет! Аккаунт передаёте с полной сменой почты? Сколько занимает выдача?",
		"Здравствуйте, сезонный пропуск активируется в любом регионе?",
		"Добрый день! Лицензия графического пакета допускает коммерческое использование?",
		"Привет! Прокси поддерживает WireGuard и сколько устройств можно подключить?",
	}
	return questions[i%len(questions)]
}

func supportAnswer(i int) string {
	answers := []string{
		"Да, ключ активирует уже установленную систему. После оплаты код придёт автоматически в чат заказа.",
		"Регион EU, устройство можно менять — привязка к аккаунту. Инструкция придёт вместе с данными.",
		"Да, меняем почту и пароль на ваши, выдача обычно в течение 4 часов. Все данные — в зашифрованном сообщении.",
		"Пропуск без региональных ограничений, активация в лаунчере. Гарантия замены 7 дней.",
		"Да, коммерческое использование разрешено в течение срока лицензии.",
		"WireGuard поддерживается, до 5 устройств одновременно. Узел заменим по запросу.",
	}
	return answers[i%len(answers)]
}

// ---------------------------------------------------------------------------
// Заказы во всех ключевых статусах + спор с маскировкой
// ---------------------------------------------------------------------------

type orderSpec struct {
	number      string
	buyerNick   string
	shopSlug    string
	productIdx  int // индекс товара этого магазина в demoProductsSpec
	qty         int
	status      string
	asset       string
	minutesAgo  int
	delivered   bool
	completed   bool
	dispute     bool
	disputeBy   string
}

var demoOrdersSpec = []orderSpec{
	{number: "SITEE-1001", buyerNick: "buyer_nova", shopSlug: "key-master", productIdx: 0, qty: 1,
		status: store.StatusCompleted, asset: store.AssetSOL, minutesAgo: 60 * 24 * 4, delivered: true, completed: true},
	{number: "SITEE-1002", buyerNick: "buyer_nova", shopSlug: "cifra-nord", productIdx: 3, qty: 1,
		status: store.StatusDelivered, asset: store.AssetStars, minutesAgo: 60 * 20, delivered: true},
	{number: "SITEE-1003", buyerNick: "buyer_max", shopSlug: "game-vault", productIdx: 8, qty: 1,
		status: store.StatusProcessing, asset: store.AssetSOL, minutesAgo: 60 * 3, delivered: false},
	{number: "SITEE-1004", buyerNick: "buyer_max", shopSlug: "key-master", productIdx: 1, qty: 1,
		status: store.StatusDisputeOpened, asset: store.AssetSOL, minutesAgo: 60 * 30, delivered: true,
		dispute: true, disputeBy: "buyer_max"},
	{number: "SITEE-1005", buyerNick: "buyer_nova", shopSlug: "almaty-keys", productIdx: 6, qty: 1,
		status: store.StatusAwaitingPayment, asset: store.AssetStars, minutesAgo: 8, delivered: false},
	{number: "SITEE-1006", buyerNick: "buyer_max", shopSlug: "proxy-nord", productIdx: 11, qty: 2,
		status: store.StatusPaidEscrow, asset: store.AssetSOL, minutesAgo: 60 * 2, delivered: false},
}

func buildOrders(cr *cryptod.Core, users map[string]*store.User, shops []*store.Shop,
	products []*store.Product, stock map[string][]*store.StockItem, payloads map[string][]string,
	now time.Time, cfg *config.Config) ([]*store.Order, []*store.Dispute,
	[]*store.Chat, map[string][]*store.Member, map[string][]*store.Message, error) {

	orders := []*store.Order{}
	disputes := []*store.Dispute{}
	chats := []*store.Chat{}
	members := map[string][]*store.Member{}
	messages := map[string][]*store.Message{}

	shopBySlug := map[string]*store.Shop{}
	for _, sh := range shops {
		shopBySlug[sh.Slug] = sh
	}
	productsByShop := map[string][]*store.Product{}
	for _, p := range products {
		productsByShop[p.ShopID] = append(productsByShop[p.ShopID], p)
	}

	for _, spec := range demoOrdersSpec {
		sh := shopBySlug[spec.shopSlug]
		buyer := users[spec.buyerNick]
		if sh == nil || buyer == nil {
			return nil, nil, nil, nil, nil, fmt.Errorf("заказ %s: не найден магазин или покупатель", spec.number)
		}
		list := productsByShop[sh.ID]
		var prod *store.Product
		if spec.productIdx < len(products) {
			prod = products[spec.productIdx]
			if prod.ShopID != sh.ID {
				prod = nil
			}
		}
		if prod == nil && len(list) > 0 {
			prod = list[0]
		}
		if prod == nil {
			return nil, nil, nil, nil, nil, fmt.Errorf("заказ %s: товар не найден", spec.number)
		}

		created := now.Add(-time.Duration(spec.minutesAgo) * time.Minute)
		o := &store.Order{
			ID: ids.New("ord"), Number: spec.number, BuyerID: buyer.ID, ShopID: sh.ID,
			Status: spec.status, PayAsset: spec.asset, DeliveryKind: "auto",
			FeeBPS: 500, CreatedAt: created, UpdatedAt: created,
		}
		qty := spec.qty
		if qty <= 0 {
			qty = 1
		}
		item := &store.OrderItem{
			ID: ids.New("oit"), ProductID: prod.ID, Title: prod.Title, Qty: qty,
			UnitLamports: prod.PriceLamports, UnitStars: prod.PriceStars,
		}
		o.Items = []*store.OrderItem{item}
		if spec.asset == store.AssetStars {
			o.SubtotalStars = prod.PriceStars * int64(qty)
			o.FeeStars = o.SubtotalStars * int64(o.FeeBPS) / 10000
			o.TotalStars = o.SubtotalStars + o.FeeStars
		} else {
			o.SubtotalLamports = prod.PriceLamports * int64(qty)
			o.FeeLamports = o.SubtotalLamports * int64(o.FeeBPS) / 10000
			o.TotalLamports = o.SubtotalLamports + o.FeeLamports
		}
		if spec.status == store.StatusAwaitingPayment || spec.status == store.StatusCreated {
			o.PayDeadline = created.Add(time.Duration(cfg.PayTimeoutMinutes) * time.Minute)
		} else {
			o.PaidAt = created.Add(2 * time.Minute)
			o.EscrowAccount = store.EscrowAccount(o.ID, spec.asset)
		}
		if spec.delivered {
			o.DeliveredAt = o.PaidAt.Add(15 * time.Minute)
			item.DeliveredAt = o.DeliveredAt
			o.ConfirmDeadline = o.DeliveredAt.Add(time.Duration(cfg.AutoConfirmHours) * time.Hour)
		} else if !o.PaidAt.IsZero() {
			o.DeliveryDeadline = o.PaidAt.Add(time.Duration(prod.DeliverySLAH) * time.Hour)
		}
		if spec.completed {
			o.CompletedAt = o.DeliveredAt.Add(3 * time.Hour)
			o.ConfirmDeadline = time.Time{}
			sh.SalesCount += qty
			sh.SalesVolumeLamport += o.TotalLamports
		}

		// Чат заказа — всегда с админом магазина.
		chat := &store.Chat{
			ID: ids.New("cht"), Kind: store.ChatOrder, Title: "Заказ " + o.Number,
			ShopID: sh.ID, OrderID: o.ID, AdminUserID: sh.AdminUserID, CreatedAt: created,
		}
		o.ChatID = chat.ID
		chats = append(chats, chat)
		members[chat.ID] = []*store.Member{
			{ChatID: chat.ID, UserID: sh.AdminUserID, Role: "admin", VisibleAs: "Админ магазина", JoinedAt: created},
			{ChatID: chat.ID, UserID: buyer.ID, Role: "member", JoinedAt: created},
		}
		messages[chat.ID] = []*store.Message{}
		addOrderMsg := func(senderID, senderName, text string, at time.Time, kind string) {
			chat.LastSeq++
			m := &store.Message{
				ID: ids.New("msg"), ChatID: chat.ID, Seq: chat.LastSeq, SenderID: senderID,
				SenderVisibleAs: senderName, Type: "system", CreatedAt: at, BodySize: len(text),
				System: store.SystemPayload{Kind: kind, OrderID: o.ID, Status: o.Status, Title: text},
			}
			if ct, err := cr.EncryptString(store.DomainMessage, m.ID, text); err == nil {
				m.BodyCT = ct
			}
			messages[chat.ID] = append(messages[chat.ID], m)
			chat.LastMessageAt = at
			chat.LastPreview = text
		}
		addOrderMsg("", "Система", "Заказ "+o.Number+" создан. Все вопросы — админу магазина.", created, "order_status")
		if !o.PaidAt.IsZero() {
			addOrderMsg("", "Система", "Оплата получена, средства в эскроу до подтверждения.", o.PaidAt, "order_status")
		}
		if spec.delivered {
			addOrderMsg("", "Система", "Товар выдан автоматически. Проверьте данные и подтвердите заказ.", o.DeliveredAt, "order_status")
			// Автовыдача: позиции стока free → sold, payload перешифровывается
			// в домен msg под идентификатор позиции заказа (docs/security.md §3.2).
			item.StockItemIDs = []string{}
			delivered := []string{}
			for _, si := range stock[prod.ID] {
				if len(item.StockItemIDs) >= qty {
					break
				}
				if si.Status != "free" {
					continue
				}
				si.Status = "sold"
				si.ReservedBy = o.ID
				si.SoldAt = o.DeliveredAt
				item.StockItemIDs = append(item.StockItemIDs, si.ID)
				if idx := indexOfStock(stock[prod.ID], si.ID); idx >= 0 && idx < len(payloads[prod.ID]) {
					delivered = append(delivered, payloads[prod.ID][idx])
				}
			}
			payload := strings.Join(delivered, "\n---\n")
			if payload == "" {
				payload = "SITEE-DEMO-PAYLOAD-0001"
			}
			item.DeliveredPayloadCT = mustEncrypt(cr, store.DomainMessage, item.ID, payload)
			prod.StockFree = countFree(stock[prod.ID])
		}
		if spec.completed {
			addOrderMsg(buyer.ID, buyer.Nickname, "Всё работает, спасибо! Подтверждаю заказ.", o.CompletedAt, "system")
		}

		appendStatus(o.ID, "", store.StatusCreated, "system", created)
		if !o.PaidAt.IsZero() {
			appendStatus(o.ID, store.StatusCreated, store.StatusPaidEscrow, "buyer", o.PaidAt)
		}
		if spec.status == store.StatusProcessing {
			appendStatus(o.ID, store.StatusPaidEscrow, store.StatusProcessing, "shop", o.PaidAt.Add(time.Minute))
		}
		if spec.delivered {
			appendStatus(o.ID, store.StatusProcessing, store.StatusDelivered, "system", o.DeliveredAt)
		}
		if spec.completed {
			appendStatus(o.ID, store.StatusDelivered, store.StatusCompleted, "buyer", o.CompletedAt)
		}

		// Спор с маскировкой сторон (FR-DSP-03).
		if spec.dispute {
			salt := ids.Hex(16)
			opener := users[spec.disputeBy]
			d := &store.Dispute{
				ID: ids.New("dsp"), OrderID: o.ID, ShopID: sh.ID, OpenedBy: opener.ID,
				ReasonCode: "invalid_key", Status: store.DisputeOpen,
				Description: "Ключ из заказа не активируется: сервис сообщает, что код уже использован. Прошу замену или возврат.",
				BuyerID: o.BuyerID, SellerID: sh.AdminUserID,
				BuyerAlias:  aliasFor(salt, o.BuyerID, "buyer"),
				SellerAlias: aliasFor(salt, sh.AdminUserID, "shop"),
				ReplyDeadline: now.Add(time.Duration(cfg.DisputeReplyHours) * time.Hour),
				Salt: salt, CreatedAt: now.Add(-2 * time.Hour), UpdatedAt: now.Add(-2 * time.Hour),
			}
			d.Timeline = append(d.Timeline, &store.DisputeEvent{
				TS: d.CreatedAt, Kind: "opened", ActorID: opener.ID,
				VisibleAs: d.BuyerAlias, Note: "Ключ/аккаунт не работает",
			})
			dchat := &store.Chat{
				ID: ids.New("cht"), Kind: store.ChatDispute, Title: "Спор по заказу " + o.Number,
				ShopID: sh.ID, OrderID: o.ID, DisputeID: d.ID, AdminUserID: sh.AdminUserID,
				CreatedAt: d.CreatedAt,
			}
			d.ChatID = dchat.ID
			o.DisputeID = d.ID
			chats = append(chats, dchat)
			members[dchat.ID] = []*store.Member{
				{ChatID: dchat.ID, UserID: o.BuyerID, Role: "member", VisibleAs: d.BuyerAlias, JoinedAt: d.CreatedAt},
				{ChatID: dchat.ID, UserID: sh.AdminUserID, Role: "admin", VisibleAs: d.SellerAlias, JoinedAt: d.CreatedAt},
			}
			messages[dchat.ID] = []*store.Message{}
			addDisputeMsg := func(senderID, visibleAs, text string, at time.Time, system bool) {
				dchat.LastSeq++
				m := &store.Message{
					ID: ids.New("msg"), ChatID: dchat.ID, Seq: dchat.LastSeq, SenderID: senderID,
					SenderVisibleAs: visibleAs, Type: "text", CreatedAt: at, BodySize: len(text),
				}
				if system {
					m.Type = "system"
					m.System = store.SystemPayload{Kind: "dispute", OrderID: o.ID, Title: text}
				}
				m.BodyCT = mustEncrypt(cr, store.DomainMessage, m.ID, text)
				messages[dchat.ID] = append(messages[dchat.ID], m)
				dchat.LastMessageAt = at
				dchat.LastPreview = text
			}
			addDisputeMsg("", "Система", "Спор открыт: ключ не работает. Личные данные скрыты, стороны видят псевдонимы.",
				d.CreatedAt, true)
			addDisputeMsg(o.BuyerID, d.BuyerAlias, "Код SITEE-OFF24 уже использован — сервис выдаёт ошибку активации.",
				d.CreatedAt.Add(5*time.Minute), false)
			addDisputeMsg(sh.AdminUserID, d.SellerAlias, "Проверяю партию, готов заменить ключ в течение 24 часов.",
				d.CreatedAt.Add(40*time.Minute), false)
			ev := &store.Evidence{
				ID: ids.New("evd"), Kind: "image", UploaderID: o.BuyerID,
				SHA256: "seed00000000000000000000000000000000000000000000000000000000000000",
				Size: 20480, Name: "activation_error.png", MetaStripped: true,
				CreatedAt: d.CreatedAt.Add(6 * time.Minute),
			}
			ev.DataCT = mustEncrypt(cr, store.DomainDispute, ev.ID, "seed:demo-evidence-placeholder")
			d.Evidence = append(d.Evidence, ev)
			disputes = append(disputes, d)
			appendStatus(o.ID, store.StatusDelivered, store.StatusDisputeOpened, "buyer", d.CreatedAt)
			o.Status = store.StatusDisputeOpened
		}
		orders = append(orders, o)
	}
	return orders, disputes, chats, members, messages, nil
}

// indexOfStock возвращает позицию единицы стока в срезе (для сопоставления
// с исходными plaintext-нагрузками демо-набора).
func indexOfStock(items []*store.StockItem, id string) int {
	for i, it := range items {
		if it.ID == id {
			return i
		}
	}
	return -1
}

func countFree(items []*store.StockItem) int {
	n := 0
	for _, it := range items {
		if it.Status == "free" {
			n++
		}
	}
	return n
}

func mustEncrypt(cr *cryptod.Core, domain, objectID, plaintext string) string {
	ct, err := cr.EncryptString(domain, objectID, plaintext)
	if err != nil {
		return ""
	}
	return ct
}

func appendStatus(orderID, from, to, actorKind string, at time.Time) {
	orderStatusEvents = append(orderStatusEvents, &store.StatusEvent{
		OrderID: orderID, From: from, To: to, ActorKind: actorKind,
		ActorID: "", Reason: "seed", TS: at,
	})
}

func seedOrderLedger(st *store.Store, orders []*store.Order) {
	for _, o := range orders {
		if o.PaidAt.IsZero() {
			continue
		}
		asset := o.PayAsset
		total := o.TotalLamports
		if asset == store.AssetStars {
			total = o.TotalStars
		}
		if total <= 0 {
			continue
		}
		st.EnsureAccountLocked(store.OwnerEscrow, o.ID, asset)
		if _, err := st.PostLocked("seed:hold:"+o.ID, asset, store.KindOrderHold, "order", o.ID, o.BuyerID,
			[]store.Posting{
				store.Debit(store.UserAccount(o.BuyerID, asset), total),
				store.Credit(store.EscrowAccount(o.ID, asset), total),
			}); err != nil {
			continue
		}
	}
}

func seedPlatformFees(st *store.Store, orders []*store.Order) {
	st.EnsureAccountLocked(store.OwnerPlatform, store.PlatformFees, store.AssetSOL)
	st.EnsureAccountLocked(store.OwnerPlatform, store.PlatformFees, store.AssetStars)
	for _, o := range orders {
		if o.Status != store.StatusCompleted {
			continue
		}
		asset := o.PayAsset
		total := o.TotalLamports
		if asset == store.AssetStars {
			total = o.TotalStars
		}
		fee := o.FeeLamports
		if asset == store.AssetStars {
			fee = o.FeeStars
		}
		net := total - fee
		st.EnsureAccountLocked(store.OwnerShop, o.ShopID, asset)
		postings := []store.Posting{store.Debit(store.EscrowAccount(o.ID, asset), total)}
		if net > 0 {
			postings = append(postings, store.Credit(store.ShopAccount(o.ShopID, asset), net))
		}
		if fee > 0 {
			postings = append(postings, store.Credit(store.PlatformAccount(store.PlatformFees, asset), fee))
		}
		_, _ = st.PostLocked("seed:release:"+o.ID, asset, store.KindOrderRelease, "order", o.ID, o.BuyerID, postings)
	}
}

func buildNotifications(users map[string]*store.User, shops []*store.Shop, orders []*store.Order, now time.Time) map[string][]*store.Notification {
	out := map[string][]*store.Notification{}
	add := func(userID, kind, title, body, dedup string, minutesAgo int, data map[string]any) {
		n := &store.Notification{
			ID: ids.New("ntf"), UserID: userID, Channel: "inapp", Kind: kind,
			Title: title, Body: body, DedupKey: dedup, Data: data,
			CreatedAt: now.Add(-time.Duration(minutesAgo) * time.Minute),
		}
		out[userID] = append(out[userID], n)
	}
	if len(shops) > 0 {
		add(users["keymaster"].ID, "rent_expiring", "Аренда магазина истекает",
			"GameVault: период заканчивается через 5 дней. Продлите, чтобы магазин не ушёл в grace-период.",
			"seed:rent:game-vault", 60*5, nil)
		add(users["lena_digital"].ID, "shop_suspended", "Магазин приостановлен",
			"SoftLicense скрыт из ленты: аренда не продлена. Оплатите тариф, чтобы вернуть магазин.",
			"seed:rent:soft-license", 60*26, nil)
		add(users["viktor_keys"].ID, "gift_received", "Вам подарили «Ракета» 🚀",
			"Покупатель поддержал магазин ProxyNord — буст в ленте 3 дня.",
			"seed:gift:proxy-nord", 60*8, nil)
	}
	for _, o := range orders {
		switch o.Status {
		case store.StatusDelivered:
			add(o.BuyerID, "order_delivered", "Товар выдан: заказ "+o.Number,
				"Проверьте данные и подтвердите заказ — после этого средства уйдут продавцу.",
				"seed:order:"+o.ID+":delivered", 60*20, map[string]any{"order_id": o.ID})
		case store.StatusDisputeOpened:
			add(o.BuyerID, "dispute_opened", "Спор по заказу "+o.Number,
				"Ответ продавца ожидается в течение 72 часов.",
				"seed:order:"+o.ID+":dispute", 120, map[string]any{"order_id": o.ID})
		case store.StatusAwaitingPayment:
			add(o.BuyerID, "order_payment_pending", "Ожидается оплата заказа "+o.Number,
				"Оплатите заказ в течение 30 минут, иначе он будет отменён.",
				"seed:order:"+o.ID+":pay", 8, map[string]any{"order_id": o.ID})
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Псевдонимы сторон спора — та же схема, что и в api.aliasFor (docs/security.md §5.2)
// ---------------------------------------------------------------------------

const aliasAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func aliasFor(salt, userID, role string) string {
	mac := cryptod.HMACSHA256([]byte("sitee-dispute-alias-v1:"+salt), []byte(userID))
	code := make([]byte, 3)
	for i := 0; i < 3; i++ {
		code[i] = aliasAlphabet[int(mac[i])%len(aliasAlphabet)]
	}
	switch role {
	case "buyer":
		return "Покупатель #" + string(code)
	case "shop":
		return "Продавец #" + string(code)
	}
	return "Участник #" + string(code)
}

func parseSOL(v float64) (int64, error) {
	if v < 0 {
		return 0, fmt.Errorf("seed: отрицательная сумма SOL: %s", strconv.FormatFloat(v, 'f', -1, 64))
	}
	return int64(v * float64(store.LamportsPerSOL)), nil
}
