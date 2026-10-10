// Package store — модель данных и хранилище MVP.
//
// В проде хранилищем является PostgreSQL 16 (DDL — docs/data-model.md).
// MVP использует потокобезопасное in-memory хранилище с опциональным
// снапшотом в JSON (SITEED_DATA_DIR), чтобы сервис можно было запустить
// без внешних зависимостей: `go run ./cmd/siteed`.
//
// Соглашение по блокировкам: все сервисы работают через Store.Read / Store.Write.
// Вспомогательные функции, принимающие *Store, считаются уже держащими блокировку
// (суффикс Locked у таких функций).
package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Домены шифрования (соответствуют KEK-доменам, docs/security.md §2).
const (
	DomainPII         = "pii"
	Domain2FA         = "2fa"
	DomainMessage     = "msg"
	DomainProductStock = "product_stock"
	DomainDispute     = "dispute"
	DomainWallet      = "wallet"
	DomainAudit       = "audit"
)

// Роли пользователей.
const (
	RoleBuyer     = "buyer"
	RoleShopAdmin = "shop_admin"
	RoleModerator = "moderator"
	RoleArbiter   = "arbiter"
	RoleSuperAdmin = "superadmin"
)

// Активы.
const (
	AssetSOL   = "SOL"
	AssetStars = "STARS"
	AssetUSDC  = "USDC"
)

// LamportsPerSOL — точность SOL (9 знаков).
const LamportsPerSOL = int64(1_000_000_000)

// ---------------------------------------------------------------------------
// Сущности
// ---------------------------------------------------------------------------

// Country — страна (ISO 3166-1 alpha-2).
type Country struct {
	Code    string `json:"code"`
	NameRU  string `json:"name_ru"`
	NameEN  string `json:"name_en"`
	Blocked bool   `json:"blocked,omitempty"`
}

// City — город справочника.
type City struct {
	ID         int64  `json:"id"`
	Country    string `json:"country"`
	NameRU     string `json:"name_ru"`
	NameEN     string `json:"name_en"`
	TZ         string `json:"tz"`
	Population int    `json:"population,omitempty"`
}

// Factor — фактор 2FA (FR-2FA-01: два независимых TOTP-секрета).
type Factor struct {
	Name         string           `json:"name"`                    // login | ops
	SecretCT     string           `json:"secret_ct"`               // envelope, домен 2fa
	Status       string           `json:"status"`                  // pending | active | revoked
	BackupHashes []string         `json:"backup_hashes,omitempty"`
	BackupUsed   map[int]bool     `json:"backup_used,omitempty"`
	UsedCodes    map[string]int64 `json:"used_codes,omitempty"`    // анти-replay: hash -> unix expiry
	Fails        int              `json:"fails"`
	LockedUntil  time.Time        `json:"locked_until,omitempty"`
	EnrolledAt   time.Time        `json:"enrolled_at,omitempty"`
	LastUsedAt   time.Time        `json:"last_used_at,omitempty"`
	PendingCodes []string         `json:"-"`                       // коды, введённые при активации
}

// User — пользователь площадки.
type User struct {
	ID             string            `json:"id"`
	EmailCT        string            `json:"email_ct,omitempty"`
	EmailIdx       string            `json:"email_idx,omitempty"`
	Nickname       string            `json:"nickname"`
	TGID           int64             `json:"tg_id,omitempty"`
	TGUsername     string            `json:"tg_username,omitempty"`
	PasswordHash   string            `json:"password_hash"`
	Role           string            `json:"role"`
	Country        string            `json:"country,omitempty"`
	CityID         int64             `json:"city_id,omitempty"`
	Locale         string            `json:"locale"`
	Theme          string            `json:"theme"`
	Status         string            `json:"status"` // pending|active|restricted|suspended|banned|deleted
	Factors        map[string]*Factor `json:"factors,omitempty"`
	Seq            uint64            `json:"seq"`              // индекс HD-деривации депозитного адреса
	DepositAddress string            `json:"deposit_address,omitempty"`
	DepositPath    string            `json:"deposit_path,omitempty"`
	RiskScore      int               `json:"risk_score"`
	Is18Plus       bool              `json:"is_18plus"`
	WarmupUntil    time.Time         `json:"warmup_until,omitempty"`
	ReferredBy     string            `json:"referred_by,omitempty"`
	UnreadChats    int               `json:"unread_chats"`
	CreatedAt      time.Time         `json:"created_at"`
	LastLoginAt    time.Time         `json:"last_login_at,omitempty"`
	LastOpsCheck   time.Time         `json:"last_ops_check,omitempty"`
}

// HasFactor сообщает, активен ли фактор.
func (u *User) HasFactor(name string) bool {
	if u.Factors == nil {
		return false
	}
	f, ok := u.Factors[name]
	return ok && f.Status == "active"
}

// IsPrivileged — привилегированная роль (FR-AUTH-06, правило R-ADMIN-1).
func (u *User) IsPrivileged() bool {
	switch u.Role {
	case RoleShopAdmin, RoleModerator, RoleArbiter, RoleSuperAdmin:
		return true
	}
	return false
}

// Enrollment — незавершённая регистрация.
type Enrollment struct {
	ID          string    `json:"id"`
	UserID      string    `json:"user_id"`
	ContactCode string    `json:"-"`
	Attempts    int       `json:"attempts"`
	SentAt      time.Time `json:"sent_at"`
	Step        string    `json:"step"` // pending_contact_code|pending_2fa_login|pending_2fa_ops|complete
	ExpiresAt   time.Time `json:"expires_at"`
}

// Session — сессия пользователя.
type Session struct {
	ID            string    `json:"id"`
	UserID        string    `json:"user_id"`
	DeviceID      string    `json:"device_id,omitempty"`
	Status        string    `json:"status"` // pending_code|pending_2fa_login|pending_2fa_ops|active|revoked|expired
	FactorOpsOK   bool      `json:"factor_ops_ok"`
	FactorOpsAt   time.Time `json:"factor_ops_at,omitempty"`
	IP            string    `json:"ip,omitempty"`
	Geo           string    `json:"geo,omitempty"`
	UA            string    `json:"ua,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
	ExpiresAt     time.Time `json:"expires_at"`
	RevokedAt     time.Time `json:"revoked_at,omitempty"`
	RevokeReason  string    `json:"revoke_reason,omitempty"`
}

// Active — сессия действительна.
func (s *Session) Active(now time.Time) bool {
	return s.Status == "active" && s.ExpiresAt.After(now)
}

// RefreshToken — хэш refresh-токена.
type RefreshToken struct {
	TokenHash string    `json:"token_hash"`
	SessionID string    `json:"session_id"`
	FamilyID  string    `json:"family_id"`
	ExpiresAt time.Time `json:"expires_at"`
	UsedAt    time.Time `json:"used_at,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// RentPlan — тариф аренды магазина (FR-SHOP-04).
type RentPlan struct {
	ID            string  `json:"id"`
	Code          string  `json:"code"`
	NameRU        string  `json:"name_ru"`
	NameEN        string  `json:"name_en"`
	PriceLamports int64   `json:"price_sol"`
	PriceStars    int64   `json:"price_stars"`
	ProductLimit  int     `json:"product_limit"`
	OperatorLimit int     `json:"operator_limit"`
	FeeBPS        int     `json:"fee_bps"`
	FeedBoost     float64 `json:"feed_boost"`
	GrantsCrown   bool    `json:"grants_crown"`
	SupportSLAH   int     `json:"support_sla_h"`
	Active        bool    `json:"active"`
	Description   string  `json:"description,omitempty"`
}

// RentSub — подписка магазина на тариф.
type RentSub struct {
	ID            string    `json:"id"`
	ShopID        string    `json:"shop_id"`
	PlanID        string    `json:"plan_id"`
	Status        string    `json:"status"` // trial|active|expiring|grace|suspended|cancelled|expired
	Asset         string    `json:"asset"`
	PriceLamports int64     `json:"price_sol"`
	PriceStars    int64     `json:"price_stars"`
	PeriodStart   time.Time `json:"period_start"`
	PeriodEnd     time.Time `json:"period_end"`
	GraceEnd      time.Time `json:"grace_end,omitempty"`
	AutoRenew     bool      `json:"auto_renew"`
	RenewAttempts int       `json:"renew_attempts"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// Shop — магазин цифровых товаров, привязанный к админу (FR-SHOP-02).
type Shop struct {
	ID                string    `json:"id"`
	AdminUserID       string    `json:"admin_user_id"`
	Slug              string    `json:"slug"`
	Name              string    `json:"name"`
	Description       string    `json:"description"`
	CoverURL          string    `json:"cover_url,omitempty"`
	AvatarURL         string    `json:"avatar_url,omitempty"`
	CategoryIDs       []int64   `json:"category_ids"`
	Country           string    `json:"country,omitempty"`
	CityID            int64     `json:"city_id,omitempty"`
	TZ                string    `json:"tz"`
	Status            string    `json:"status"` // draft|moderation|active|frozen|suspended|banned
	IsVerified        bool      `json:"is_verified"`
	RatingSum         int64     `json:"rating_sum"`
	RatingCount       int       `json:"rating_count"`
	RatingBayes       float64   `json:"rating_bayes"`
	SalesCount        int       `json:"sales_count"`
	SalesVolumeLamport int64    `json:"sales_volume_sol"`
	ResponseP50S      int       `json:"response_p50_s,omitempty"`
	DisputeRate       float64   `json:"dispute_rate"`
	GiftBoost         float64   `json:"gift_boost"`
	GiftBoostUntil    time.Time `json:"gift_boost_until,omitempty"`
	ComplaintPenalty  float64   `json:"complaint_penalty"`
	DisputeLossPenalty float64  `json:"dispute_loss_penalty"`
	SanctionLevel     string    `json:"sanction_level"`
	SanctionUntil     time.Time `json:"sanction_until,omitempty"`
	SanctionReason    string    `json:"sanction_reason,omitempty"`
	AcceptsStars      bool      `json:"accepts_stars"`
	Operators         []string  `json:"operators,omitempty"`
	FeedScore         float64   `json:"feed_score"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

// Product — цифровой товар.
type Product struct {
	ID            string    `json:"id"`
	ShopID        string    `json:"shop_id"`
	Title         string    `json:"title"`
	Description   string    `json:"description"`
	Kind          string    `json:"kind"` // key|file|account|subscription|service_code|custom
	CategoryID    int64     `json:"category_id,omitempty"`
	PriceLamports int64     `json:"price_sol"`
	PriceStars    int64     `json:"price_stars"`
	MediaURLs     []string  `json:"media_urls,omitempty"`
	StockTotal    int       `json:"stock_total"`
	StockFree     int       `json:"stock_free"`
	WarrantyDays  int       `json:"warranty_days"`
	DeliverySLAH  int       `json:"delivery_sla_h"`
	Status        string    `json:"status"` // draft|moderation|published|rejected|archived
	ModerationNote string   `json:"moderation_note,omitempty"`
	RatingSum     int64     `json:"rating_sum"`
	RatingCount   int       `json:"rating_count"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// StockItem — единица товара для автовыдачи (payload зашифрован).
type StockItem struct {
	ID         string    `json:"id"`
	ProductID  string    `json:"product_id"`
	PayloadCT  string    `json:"payload_ct"`
	Status     string    `json:"status"` // free|reserved|sold|void
	ReservedBy string    `json:"reserved_by,omitempty"`
	SoldAt     time.Time `json:"sold_at,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

// OrderItem — позиция заказа.
type OrderItem struct {
	ID                 string    `json:"id"`
	ProductID          string    `json:"product_id"`
	Title              string    `json:"title"`
	Qty                int       `json:"qty"`
	UnitLamports       int64     `json:"unit_price_sol"`
	UnitStars          int64     `json:"unit_price_stars"`
	StockItemIDs       []string  `json:"stock_item_ids,omitempty"`
	DeliveredPayloadCT string    `json:"delivered_payload_ct,omitempty"`
	DeliveredAt        time.Time `json:"delivered_at,omitempty"`
	DownloadCount      int       `json:"download_count"`
}

// Order — заказ с эскроу.
type Order struct {
	ID               string       `json:"id"`
	Number           string       `json:"number"`
	BuyerID          string       `json:"buyer_id"`
	ShopID           string       `json:"shop_id"`
	Status           string       `json:"status"`
	Items            []*OrderItem `json:"items"`
	SubtotalLamports int64        `json:"subtotal_sol"`
	FeeLamports      int64        `json:"fee_sol"`
	TotalLamports    int64        `json:"total_sol"`
	SubtotalStars    int64        `json:"subtotal_stars"`
	FeeStars         int64        `json:"fee_stars"`
	TotalStars       int64        `json:"total_stars"`
	PayAsset         string       `json:"pay_asset"`
	DeliveryKind     string       `json:"delivery_kind"`
	FeeBPS           int          `json:"fee_bps"`
	EscrowAccount    string       `json:"escrow_account,omitempty"`
	PayDeadline      time.Time    `json:"pay_deadline,omitempty"`
	DeliveryDeadline time.Time    `json:"delivery_deadline,omitempty"`
	ConfirmDeadline  time.Time    `json:"confirm_deadline,omitempty"`
	ExtendUsed       bool         `json:"extend_used"`
	PaidAt           time.Time    `json:"paid_at,omitempty"`
	DeliveredAt      time.Time    `json:"delivered_at,omitempty"`
	CompletedAt      time.Time    `json:"completed_at,omitempty"`
	CancelledAt      time.Time    `json:"cancelled_at,omitempty"`
	ChatID           string       `json:"chat_id,omitempty"`
	DisputeID        string       `json:"dispute_id,omitempty"`
	ReviewID         string       `json:"review_id,omitempty"`
	IdempotencyKey   string       `json:"idempotency_key,omitempty"`
	CreatedAt        time.Time    `json:"created_at"`
	UpdatedAt        time.Time    `json:"updated_at"`
}

// StatusEvent — запись истории статусов заказа.
type StatusEvent struct {
	OrderID   string    `json:"order_id"`
	From      string    `json:"from,omitempty"`
	To        string    `json:"to"`
	ActorID   string    `json:"actor_id,omitempty"`
	ActorKind string    `json:"actor_kind"` // system|buyer|shop|arbiter|admin|timer
	Reason    string    `json:"reason,omitempty"`
	TS        time.Time `json:"ts"`
}

// Chat — диалог (FR-MSG-01).
type Chat struct {
	ID            string    `json:"id"`
	Kind          string    `json:"kind"` // shop_support|order|dispute|group|channel|direct
	Title         string    `json:"title,omitempty"`
	ShopID        string    `json:"shop_id,omitempty"`
	OrderID       string    `json:"order_id,omitempty"`
	DisputeID     string    `json:"dispute_id,omitempty"`
	AdminUserID   string    `json:"admin_user_id,omitempty"` // ★ с кем открыт диалог
	E2EE          bool      `json:"e2ee"`
	LastSeq       int64     `json:"last_seq"`
	LastMessageAt time.Time `json:"last_message_at,omitempty"`
	LastPreview   string    `json:"last_preview,omitempty"`
	Pinned        bool      `json:"pinned,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
	ClosedAt      time.Time `json:"closed_at,omitempty"`
}

// Member — участник диалога.
type Member struct {
	ChatID      string    `json:"chat_id"`
	UserID      string    `json:"user_id"`
	Role        string    `json:"role"` // owner|admin|operator|member|arbiter|subscriber
	VisibleAs   string    `json:"visible_as,omitempty"` // маскировка в спорах
	JoinedAt    time.Time `json:"joined_at"`
	LeftAt      time.Time `json:"left_at,omitempty"`
	LastReadSeq int64     `json:"last_read_seq"`
	Muted       bool      `json:"muted"`
	Blocked     bool      `json:"blocked"`
}

// Message — сообщение; тело всегда в ciphertext (FR-MSG-03).
type Message struct {
	ID              string    `json:"id"`
	ChatID          string    `json:"chat_id"`
	Seq             int64     `json:"seq"`
	SenderID        string    `json:"sender_id"`
	SenderVisibleAs string    `json:"sender_visible_as,omitempty"`
	Type            string    `json:"type"` // text|attachment|product_card|order_card|gift_card|system
	BodyCT          string    `json:"body_ct"`
	BodySize        int       `json:"body_size"`
	E2EE            bool      `json:"e2ee"`
	SenderKeyID     string    `json:"sender_key_id,omitempty"`
	ClientMsgID     string    `json:"client_msg_id,omitempty"`
	ReplyTo         string    `json:"reply_to,omitempty"`
	System          SystemPayload `json:"system,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	EditedAt        time.Time `json:"edited_at,omitempty"`
	DeletedAt       time.Time `json:"deleted_at,omitempty"`
}

// SystemPayload — данные системных сообщений (карточки заказов/подарков).
type SystemPayload struct {
	Kind     string         `json:"kind,omitempty"` // order_status|gift|dispute|rent|system
	OrderID  string         `json:"order_id,omitempty"`
	Status   string         `json:"status,omitempty"`
	GiftID   string         `json:"gift_id,omitempty"`
	Title    string         `json:"title,omitempty"`
	Amount   string         `json:"amount,omitempty"`
	Asset    string         `json:"asset,omitempty"`
	Extra    map[string]any `json:"extra,omitempty"`
}

// E2EEPrekey — публичная часть prekey-пакета устройства (FR-MSG-04).
type E2EEPrekey struct {
	UserID          string   `json:"user_id"`
	DeviceID        string   `json:"device_id"`
	IdentityPub     string   `json:"identity_pub"`
	IdentitySig     string   `json:"identity_sig"`
	SignedPrekeyPub string   `json:"signed_prekey_pub"`
	SignedPrekeySig string   `json:"signed_prekey_sig"`
	OneTimeKeys     []OneTime `json:"one_time_keys"`
	CreatedAt       time.Time `json:"created_at"`
}

// OneTime — одноразовый prekey.
type OneTime struct {
	ID  string `json:"id"`
	Pub string `json:"pub"`
}

// E2EESession — установленная E2EE-сессия (метаданные, без ключей).
type E2EESession struct {
	ID          string    `json:"id"`
	ChatID      string    `json:"chat_id"`
	FromUser    string    `json:"from_user"`
	ToDevice    string    `json:"to_device"`
	Fingerprint string    `json:"root_key_fingerprint"`
	SafetyNum   string    `json:"safety_number"`
	CreatedAt   time.Time `json:"created_at"`
}

// Evidence — доказательство в споре.
type Evidence struct {
	ID           string    `json:"id"`
	Kind         string    `json:"kind"` // image|video|file|text
	UploaderID   string    `json:"uploader_id"`
	SHA256       string    `json:"sha256"`
	Size         int       `json:"size"`
	DataCT       string    `json:"data_ct,omitempty"`
	Name         string    `json:"name,omitempty"`
	MetaStripped bool      `json:"meta_stripped"`
	CreatedAt    time.Time `json:"created_at"`
}

// DisputeEvent — шаг спора.
type DisputeEvent struct {
	TS        time.Time `json:"ts"`
	Kind      string    `json:"kind"`
	ActorID   string    `json:"actor_id,omitempty"`
	VisibleAs string    `json:"actor_visible_as,omitempty"`
	Note      string    `json:"note,omitempty"`
}

// Dispute — спор по заказу (FR-DSP-*).
type Dispute struct {
	ID               string         `json:"id"`
	OrderID          string         `json:"order_id"`
	ShopID           string         `json:"shop_id"`
	OpenedBy         string         `json:"opened_by"`
	ReasonCode       string         `json:"reason_code"`
	Description      string         `json:"description"`
	Status           string         `json:"status"` // open|awaiting_reply|in_arbitration|resolved|dismissed|appeal|closed
	BuyerID          string         `json:"buyer_id"`
	SellerID         string         `json:"seller_id"`
	BuyerAlias       string         `json:"buyer_alias"`
	SellerAlias      string         `json:"seller_alias"`
	ArbiterID        string         `json:"arbiter_id,omitempty"`
	AssignedAt       time.Time      `json:"assigned_at,omitempty"`
	ReplyDeadline    time.Time      `json:"reply_deadline"`
	ResolveDeadline  time.Time      `json:"resolve_deadline,omitempty"`
	Resolution       string         `json:"resolution,omitempty"`
	ResolutionLamport int64         `json:"resolution_amount_sol,omitempty"`
	ResolutionReason string         `json:"resolution_reason,omitempty"`
	ResolvedAt       time.Time      `json:"resolved_at,omitempty"`
	// Апелляция (FR-DSP-08): одна на спор, окно 72 ч, старший арбитр.
	AppealOf           string    `json:"appeal_of,omitempty"`
	AppealedBy         string    `json:"appealed_by,omitempty"`
	AppealedAt         time.Time `json:"appealed_at,omitempty"`
	AppealReason       string    `json:"appeal_reason,omitempty"`
	ExecutionSuspended bool      `json:"execution_suspended,omitempty"`
	ChatID           string         `json:"chat_id,omitempty"`
	Salt             string         `json:"-"`
	Evidence         []*Evidence    `json:"evidence,omitempty"`
	Timeline         []*DisputeEvent `json:"timeline,omitempty"`
	CreatedAt        time.Time      `json:"created_at"`
	UpdatedAt        time.Time      `json:"updated_at"`
}

// Gift — цифровой подарок из каталога (FR-STR-03).
type Gift struct {
	ID           string    `json:"id"`
	SKU          string    `json:"sku"`
	TitleRU      string    `json:"title_ru"`
	TitleEN      string    `json:"title_en,omitempty"`
	Description  string    `json:"description,omitempty"`
	Rarity       string    `json:"rarity"` // common|rare|epic|legendary
	MediaURL     string    `json:"media_url,omitempty"`
	MediaKind    string    `json:"media_kind,omitempty"`
	Emoji        string    `json:"emoji,omitempty"`
	PriceStars   int64     `json:"price_stars"`
	PriceLamport int64     `json:"price_sol"`
	PerUserLimit int       `json:"per_user_limit,omitempty"`
	BoostsShop   bool      `json:"boosts_shop"`
	BoostValue   float64   `json:"boost_value,omitempty"`
	BoostDays    int       `json:"boost_days,omitempty"`
	Collectible  bool      `json:"collectible"`
	StartsAt     time.Time `json:"starts_at,omitempty"`
	EndsAt       time.Time `json:"ends_at,omitempty"`
	Status       string    `json:"status"` // draft|published|archived
	Sort         int       `json:"sort"`
	CreatedBy    string    `json:"created_by"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// GiftPurchase — покупка/дарение подарка.
type GiftPurchase struct {
	ID            string    `json:"id"`
	GiftID        string    `json:"gift_id"`
	BuyerID       string    `json:"buyer_id"`
	RecipientType string    `json:"recipient_type"` // self|user|shop
	RecipientID   string    `json:"recipient_id,omitempty"`
	Asset         string    `json:"asset"`
	AmountStars   int64     `json:"amount_stars,omitempty"`
	AmountLamport int64     `json:"amount_sol,omitempty"`
	MessageCT     string    `json:"message_ct,omitempty"`
	Status        string    `json:"status"`
	ChatID        string    `json:"chat_id,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
}

// Review — отзыв (FR-REV-01: один на заказ).
type Review struct {
	ID                 string    `json:"id"`
	OrderID            string    `json:"order_id"`
	ShopID             string    `json:"shop_id"`
	ProductID          string    `json:"product_id,omitempty"`
	AuthorID           string    `json:"author_id"`
	Rating             int       `json:"rating"`
	RatingDelivery     int       `json:"rating_delivery,omitempty"`
	RatingDescription  int       `json:"rating_description,omitempty"`
	RatingSupport      int       `json:"rating_support,omitempty"`
	Body               string    `json:"body,omitempty"`
	Verified           bool      `json:"is_verified_purchase"`
	ShopReply          string    `json:"shop_reply,omitempty"`
	ShopReplyAt        time.Time `json:"shop_reply_at,omitempty"`
	Status             string    `json:"status"` // published|hidden|removed|pending_moderation
	Helpful            int       `json:"helpful_count"`
	CreatedAt          time.Time `json:"created_at"`
}

// ReviewReport — жалоба на отзыв.
type ReviewReport struct {
	ID         string    `json:"id"`
	ReviewID   string    `json:"review_id"`
	ReporterID string    `json:"reporter_id"`
	Reason     string    `json:"reason"`
	Comment    string    `json:"comment,omitempty"`
	Status     string    `json:"status"` // pending|approved|rejected
	CreatedAt  time.Time `json:"created_at"`
}

// Withdrawal — заявка на вывод средств.
type Withdrawal struct {
	ID          string    `json:"id"`
	UserID      string    `json:"user_id"`
	Asset       string    `json:"asset"`
	Amount      int64     `json:"amount"`
	DestAddress string    `json:"dest_address"`
	Status      string    `json:"status"` // pending_2fa|pending_approval|approved|broadcast|confirmed|failed|cancelled
	ApproverID  string    `json:"approver_id,omitempty"`
	Signature   string    `json:"signature,omitempty"`
	Fee         int64     `json:"fee"`
	Error       string    `json:"error,omitempty"`
	TxID        string    `json:"tx_id,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// SolTx — наблюдаемая on-chain транзакция (депозит/вывод).
type SolTx struct {
	Signature     string    `json:"signature"`
	Address       string    `json:"address"`
	UserID        string    `json:"user_id,omitempty"`
	Direction     string    `json:"direction"` // in|out
	AmountLamport int64     `json:"amount_lamports"`
	Confirmations int       `json:"confirmations"`
	Status        string    `json:"status"` // seen|credited|pending|broadcast|confirmed|failed
	TxID          string    `json:"tx_id,omitempty"`
	TS            time.Time `json:"ts"`
}

// Quote — котировка обменника.
type Quote struct {
	ID         string    `json:"id"`
	UserID     string    `json:"user_id"`
	FromAsset  string    `json:"from_asset"`
	ToAsset    string    `json:"to_asset"`
	Rate       float64   `json:"rate"`
	FeeBPS     int       `json:"fee_bps"`
	FromAmount int64     `json:"from_amount"`
	ToAmount   int64     `json:"to_amount"`
	ValidUntil time.Time `json:"valid_until"`
	CreatedAt  time.Time `json:"created_at"`
}

// Notification — уведомление пользователя.
type Notification struct {
	ID        string            `json:"id"`
	UserID    string            `json:"user_id"`
	Channel   string            `json:"channel"` // inapp|tg_bot|email
	Kind      string            `json:"kind"`
	Title     string            `json:"title"`
	Body      string            `json:"body,omitempty"`
	DedupKey  string            `json:"dedup_key"`
	Data      map[string]any    `json:"data,omitempty"`
	Read      bool              `json:"read"`
	CreatedAt time.Time         `json:"created_at"`
}

// AuthEvent — событие безопасности (FR-ABF-*, docs/security.md §7).
type AuthEvent struct {
	TS        time.Time `json:"ts"`
	UserID    string    `json:"user_id,omitempty"`
	Event     string    `json:"event"` // login_ok|login_fail|2fa_ok|2fa_fail|register|logout|reset
	IP        string    `json:"ip,omitempty"`
	Geo       string    `json:"geo,omitempty"`
	UA        string    `json:"ua,omitempty"`
	Reason    string    `json:"reason,omitempty"`
	RiskScore int       `json:"risk_score,omitempty"`
}

// AuditRecord — запись неизменяемого аудит-лога (docs/security.md §10).
type AuditRecord struct {
	ID         string         `json:"id"`
	TS         time.Time      `json:"ts"`
	ActorID    string         `json:"actor_id,omitempty"`
	ActorRole  string         `json:"actor_role,omitempty"`
	Action     string         `json:"action"`
	ObjectType string         `json:"object_type,omitempty"`
	ObjectID   string         `json:"object_id,omitempty"`
	Reason     string         `json:"reason,omitempty"`
	IP         string         `json:"ip,omitempty"`
	UA         string         `json:"ua,omitempty"`
	TotpFactor string         `json:"totp_factor,omitempty"`
	Before     map[string]any `json:"before,omitempty"`
	After      map[string]any `json:"after,omitempty"`
	PrevHash   string         `json:"prev_hash"`
	RecordHash string         `json:"record_hash"`
}

// Category — категория товаров.
type Category struct {
	ID           int64    `json:"id"`
	Slug         string   `json:"slug"`
	NameRU       string   `json:"name_ru"`
	NameEN       string   `json:"name_en"`
	Restricted   bool     `json:"restricted,omitempty"`
	BlockedIn    []string `json:"blocked_in,omitempty"`
	ParentID     int64    `json:"parent_id,omitempty"`
}

// ---------------------------------------------------------------------------
// Хранилище
// ---------------------------------------------------------------------------

// Store — потокобезопасное хранилище MVP.
type Store struct {
	mu sync.RWMutex

	Countries   map[string]*Country
	Cities      map[int64]*City
	Categories  map[int64]*Category
	Users       map[string]*User
	UsersByNick map[string]string
	UsersByMail map[string]string // blind index -> user id
	UserSeq     uint64
	Enrollments map[string]*Enrollment
	Sessions    map[string]*Session
	Refresh     map[string]*RefreshToken

	RentPlans map[string]*RentPlan
	Shops     map[string]*Shop
	ShopsBySlug map[string]string
	Subs      map[string]*RentSub // shop id -> sub

	Products map[string]*Product
	Stock    map[string][]*StockItem // product id -> items

	Orders        map[string]*Order
	OrdersByNumber map[string]string
	OrderStatuses []*StatusEvent
	Idempotency   map[string]string // key -> order/tx id

	Chats     map[string]*Chat
	Members   map[string][]*Member // chat id -> members
	Messages  map[string][]*Message
	Prekeys   map[string]*E2EEPrekey // userID+":"+deviceID
	Sessions2 map[string]*E2EESession

	Disputes map[string]*Dispute
	Gifts    map[string]*Gift
	GiftPurch map[string]*GiftPurchase
	Reviews  map[string]*Review
	Reports  map[string]*ReviewReport

	Accounts map[string]*Account
	Ledger   []*Entry
	TxSeen   map[string]bool // idempotency ledger

	Withdrawals map[string]*Withdrawal
	SolTxs      map[string]*SolTx
	Quotes      map[string]*Quote

	Notifications map[string][]*Notification // user id -> list
	AuthEvents    []*AuthEvent
	Audit         []*AuditRecord
	AuditHead     string

	Settings map[string]any

	dataDir string
}

// New создаёт пустое хранилище.
func New(dataDir string) *Store {
	s := &Store{
		Countries:     map[string]*Country{},
		Cities:        map[int64]*City{},
		Categories:    map[int64]*Category{},
		Users:         map[string]*User{},
		UsersByNick:   map[string]string{},
		UsersByMail:   map[string]string{},
		Enrollments:   map[string]*Enrollment{},
		Sessions:      map[string]*Session{},
		Refresh:       map[string]*RefreshToken{},
		RentPlans:     map[string]*RentPlan{},
		Shops:         map[string]*Shop{},
		ShopsBySlug:   map[string]string{},
		Subs:          map[string]*RentSub{},
		Products:      map[string]*Product{},
		Stock:         map[string][]*StockItem{},
		Orders:        map[string]*Order{},
		OrdersByNumber: map[string]string{},
		Idempotency:   map[string]string{},
		Chats:         map[string]*Chat{},
		Members:       map[string][]*Member{},
		Messages:      map[string][]*Message{},
		Prekeys:       map[string]*E2EEPrekey{},
		Sessions2:     map[string]*E2EESession{},
		Disputes:      map[string]*Dispute{},
		Gifts:         map[string]*Gift{},
		GiftPurch:     map[string]*GiftPurchase{},
		Reviews:       map[string]*Review{},
		Reports:       map[string]*ReviewReport{},
		Accounts:      map[string]*Account{},
		TxSeen:        map[string]bool{},
		Withdrawals:   map[string]*Withdrawal{},
		SolTxs:        map[string]*SolTx{},
		Quotes:        map[string]*Quote{},
		Notifications: map[string][]*Notification{},
		Settings:      map[string]any{},
		dataDir:       dataDir,
	}
	return s
}

// Read выполняет fn под общей блокировкой чтения.
func (s *Store) Read(fn func()) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	fn()
}

// Write выполняет fn под общей блокировкой записи и сохраняет снапшот (если настроено).
func (s *Store) Write(fn func()) {
	s.mu.Lock()
	fn()
	s.mu.Unlock()
}

// Errors хранилища.
var (
	ErrNotFound  = errors.New("store: не найдено")
	ErrDuplicate = errors.New("store: дубликат")
)

// Setting возвращает настройку (или def).
func (s *Store) Setting(key string, def any) any {
	if v, ok := s.Settings[key]; ok {
		return v
	}
	return def
}

// SettingInt — целочисленная настройка.
func (s *Store) SettingInt(key string, def int) int {
	switch v := s.Setting(key).(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		if n, err := v.Int64(); err == nil {
			return int(n)
		}
	}
	return def
}

// SettingFloat — дробная настройка.
func (s *Store) SettingFloat(key string, def float64) float64 {
	switch v := s.Setting(key).(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case int64:
		return float64(v)
	}
	return def
}

// SettingString — строковая настройка.
func (s *Store) SettingString(key, def string) string {
	if v, ok := s.Settings[key].(string); ok {
		return v
	}
	return def
}

// SettingBool — булева настройка.
func (s *Store) SettingBool(key string, def bool) bool {
	if v, ok := s.Settings[key].(bool); ok {
		return v
	}
	return def
}

// ---------------------------------------------------------------------------
// Снапшоты (dev-персистентность)
// ---------------------------------------------------------------------------

type snapshot struct {
	Version      int                       `json:"version"`
	SavedAt      time.Time                 `json:"saved_at"`
	Countries    map[string]*Country       `json:"countries"`
	Cities       map[int64]*City           `json:"cities"`
	Categories   map[int64]*Category       `json:"categories"`
	Users        map[string]*User          `json:"users"`
	UsersByNick  map[string]string         `json:"users_by_nick"`
	UsersByMail  map[string]string         `json:"users_by_mail"`
	UserSeq      uint64                    `json:"user_seq"`
	RentPlans    map[string]*RentPlan      `json:"rent_plans"`
	Shops        map[string]*Shop          `json:"shops"`
	ShopsBySlug  map[string]string         `json:"shops_by_slug"`
	Subs         map[string]*RentSub       `json:"subs"`
	Products     map[string]*Product       `json:"products"`
	Stock        map[string][]*StockItem   `json:"stock"`
	Orders       map[string]*Order         `json:"orders"`
	OrdersByNumber map[string]string       `json:"orders_by_number"`
	OrderStatuses []*StatusEvent           `json:"order_statuses"`
	Chats        map[string]*Chat          `json:"chats"`
	Members      map[string][]*Member      `json:"members"`
	Messages     map[string][]*Message     `json:"messages"`
	Disputes     map[string]*Dispute       `json:"disputes"`
	Gifts        map[string]*Gift          `json:"gifts"`
	GiftPurch    map[string]*GiftPurchase  `json:"gift_purchases"`
	Reviews      map[string]*Review        `json:"reviews"`
	Accounts     map[string]*Account       `json:"accounts"`
	Ledger       []*Entry                  `json:"ledger"`
	Withdrawals  map[string]*Withdrawal    `json:"withdrawals"`
	SolTxs       map[string]*SolTx         `json:"sol_txs"`
	Notifications map[string][]*Notification `json:"notifications"`
	Audit        []*AuditRecord            `json:"audit"`
	AuditHead    string                    `json:"audit_head"`
	Settings     map[string]any            `json:"settings"`
}

// SaveSnapshot сохраняет состояние в JSON-файл (если задан dataDir).
func (s *Store) SaveSnapshot() error {
	if s.dataDir == "" {
		return nil
	}
	s.mu.RLock()
	snap := snapshot{
		Version: 1, SavedAt: time.Now().UTC(),
		Countries: s.Countries, Cities: s.Cities, Categories: s.Categories,
		Users: s.Users, UsersByNick: s.UsersByNick, UsersByMail: s.UsersByMail, UserSeq: s.UserSeq,
		RentPlans: s.RentPlans, Shops: s.Shops, ShopsBySlug: s.ShopsBySlug, Subs: s.Subs,
		Products: s.Products, Stock: s.Stock, Orders: s.Orders, OrdersByNumber: s.OrdersByNumber,
		OrderStatuses: s.OrderStatuses, Chats: s.Chats, Members: s.Members, Messages: s.Messages,
		Disputes: s.Disputes, Gifts: s.Gifts, GiftPurch: s.GiftPurch, Reviews: s.Reviews,
		Accounts: s.Accounts, Ledger: s.Ledger, Withdrawals: s.Withdrawals, SolTxs: s.SolTxs,
		Notifications: s.Notifications, Audit: s.Audit, AuditHead: s.AuditHead, Settings: s.Settings,
	}
	s.mu.RUnlock()

	data, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.dataDir, 0o750); err != nil {
		return err
	}
	path := filepath.Join(s.dataDir, "snapshot.json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// LoadSnapshot загружает состояние, если снапшот существует.
func (s *Store) LoadSnapshot() (bool, error) {
	if s.dataDir == "" {
		return false, nil
	}
	path := filepath.Join(s.dataDir, "snapshot.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	var snap snapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if snap.Users != nil {
		s.Users = snap.Users
	}
	if snap.UsersByNick != nil {
		s.UsersByNick = snap.UsersByNick
	}
	if snap.UsersByMail != nil {
		s.UsersByMail = snap.UsersByMail
	}
	s.UserSeq = snap.UserSeq
	if snap.Countries != nil {
		s.Countries = snap.Countries
	}
	if snap.Cities != nil {
		s.Cities = snap.Cities
	}
	if snap.Categories != nil {
		s.Categories = snap.Categories
	}
	if snap.RentPlans != nil {
		s.RentPlans = snap.RentPlans
	}
	if snap.Shops != nil {
		s.Shops = snap.Shops
	}
	if snap.ShopsBySlug != nil {
		s.ShopsBySlug = snap.ShopsBySlug
	}
	if snap.Subs != nil {
		s.Subs = snap.Subs
	}
	if snap.Products != nil {
		s.Products = snap.Products
	}
	if snap.Stock != nil {
		s.Stock = snap.Stock
	}
	if snap.Orders != nil {
		s.Orders = snap.Orders
	}
	if snap.OrdersByNumber != nil {
		s.OrdersByNumber = snap.OrdersByNumber
	}
	if snap.OrderStatuses != nil {
		s.OrderStatuses = snap.OrderStatuses
	}
	if snap.Chats != nil {
		s.Chats = snap.Chats
	}
	if snap.Members != nil {
		s.Members = snap.Members
	}
	if snap.Messages != nil {
		s.Messages = snap.Messages
	}
	if snap.Disputes != nil {
		s.Disputes = snap.Disputes
	}
	if snap.Gifts != nil {
		s.Gifts = snap.Gifts
	}
	if snap.GiftPurch != nil {
		s.GiftPurch = snap.GiftPurch
	}
	if snap.Reviews != nil {
		s.Reviews = snap.Reviews
	}
	if snap.Accounts != nil {
		s.Accounts = snap.Accounts
	}
	if snap.Ledger != nil {
		s.Ledger = snap.Ledger
	}
	if snap.Withdrawals != nil {
		s.Withdrawals = snap.Withdrawals
	}
	if snap.SolTxs != nil {
		s.SolTxs = snap.SolTxs
	}
	if snap.Notifications != nil {
		s.Notifications = snap.Notifications
	}
	if snap.Audit != nil {
		s.Audit = snap.Audit
	}
	s.AuditHead = snap.AuditHead
	if snap.Settings != nil {
		s.Settings = snap.Settings
	}
	return true, nil
}

// ---------------------------------------------------------------------------
// Вспомогательные выборки (без блокировок — вызывать внутри Read/Write)
// ---------------------------------------------------------------------------

// SortedShopsLocked возвращает магазины, отсортированные по убыванию feed score.
func (s *Store) SortedShopsLocked() []*Shop {
	out := make([]*Shop, 0, len(s.Shops))
	for _, sh := range s.Shops {
		out = append(out, sh)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].FeedScore != out[j].FeedScore {
			return out[i].FeedScore > out[j].FeedScore
		}
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	return out
}

// ChatMembersLocked возвращает участников чата.
func (s *Store) ChatMembersLocked(chatID string) []*Member {
	return s.Members[chatID]
}

// IsMemberLocked проверяет участие пользователя в чате.
func (s *Store) IsMemberLocked(chatID, userID string) bool {
	for _, m := range s.Members[chatID] {
		if m.UserID == userID && m.LeftAt.IsZero() {
			return true
		}
	}
	return false
}

// MessagesLocked возвращает сообщения чата (по возрастанию seq).
func (s *Store) MessagesLocked(chatID string) []*Message {
	return s.Messages[chatID]
}

// UserOrdersLocked возвращает заказы пользователя (покупатель или владелец магазина).
func (s *Store) UserOrdersLocked(userID string, asShop bool) []*Order {
	out := make([]*Order, 0, 8)
	for _, o := range s.Orders {
		if !asShop && o.BuyerID == userID {
			out = append(out, o)
		}
		if asShop {
			if sh, ok := s.Shops[o.ShopID]; ok && sh.AdminUserID == userID {
				out = append(out, o)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

// CityLocked возвращает город по ID.
func (s *Store) CityLocked(id int64) *City { return s.Cities[id] }
