package store

// Статусы заказа (docs/orders-disputes.md §1).
const (
	StatusCreated         = "created"
	StatusAwaitingPayment = "awaiting_payment"
	StatusPaidEscrow      = "paid_escrow"
	StatusProcessing      = "processing"
	StatusDelivered       = "delivered"
	StatusCompleted       = "completed"
	StatusDisputeOpened   = "dispute_opened"
	StatusInArbitration   = "in_arbitration"
	StatusRefunded        = "refunded"
	StatusCancelled       = "cancelled"
	StatusExpired         = "expired"
)

// orderTransitions — конечный автомат заказа (FR-ORD-02).
var orderTransitions = map[string][]string{
	StatusCreated:         {StatusAwaitingPayment, StatusPaidEscrow, StatusCancelled, StatusExpired},
	StatusAwaitingPayment: {StatusPaidEscrow, StatusCancelled, StatusExpired},
	StatusPaidEscrow:      {StatusProcessing, StatusDelivered, StatusDisputeOpened, StatusCancelled},
	StatusProcessing:      {StatusDelivered, StatusDisputeOpened},
	StatusDelivered:       {StatusCompleted, StatusDisputeOpened},
	StatusDisputeOpened:   {StatusInArbitration, StatusCompleted, StatusRefunded},
	StatusInArbitration:   {StatusCompleted, StatusRefunded},
	StatusCompleted:       {StatusDisputeOpened},
	StatusRefunded:        {StatusDisputeOpened},
	StatusCancelled:       {},
	StatusExpired:         {},
}

// AllOrderStatuses возвращает статусы заказа в порядке жизненного цикла.
func AllOrderStatuses() []string {
	return []string{
		StatusCreated, StatusAwaitingPayment, StatusPaidEscrow, StatusProcessing,
		StatusDelivered, StatusCompleted, StatusDisputeOpened, StatusInArbitration,
		StatusRefunded, StatusCancelled, StatusExpired,
	}
}

// CanTransitionOrder сообщает, допустим ли переход статуса заказа.
func CanTransitionOrder(from, to string) bool {
	if from == to {
		return true // идемпотентный повтор
	}
	for _, v := range orderTransitions[from] {
		if v == to {
			return true
		}
	}
	return false
}

// StatusTitleRU — человекочитаемое название статуса для UI и уведомлений.
func StatusTitleRU(status string) string {
	switch status {
	case StatusCreated:
		return "Создан"
	case StatusAwaitingPayment:
		return "Ожидает оплаты"
	case StatusPaidEscrow:
		return "Оплачен (эскроу)"
	case StatusProcessing:
		return "В работе"
	case StatusDelivered:
		return "Выдан"
	case StatusCompleted:
		return "Завершён"
	case StatusDisputeOpened:
		return "Спор открыт"
	case StatusInArbitration:
		return "На арбитраже"
	case StatusRefunded:
		return "Возврат"
	case StatusCancelled:
		return "Отменён"
	case StatusExpired:
		return "Истёк"
	}
	return status
}

// OrderActionsRU — доступные действия по статусу и роли (FR-ORD-07: actions[]).
func OrderActionsRU(status, role string) []string {
	switch role {
	case "buyer":
		switch status {
		case StatusCreated, StatusAwaitingPayment:
			return []string{"pay", "cancel", "chat_with_admin"}
		case StatusPaidEscrow, StatusProcessing:
			return []string{"open_dispute", "chat_with_admin"}
		case StatusDelivered:
			return []string{"confirm", "extend", "open_dispute", "chat_with_admin"}
		case StatusCompleted:
			return []string{"review", "open_dispute", "chat_with_admin"}
		case StatusDisputeOpened, StatusInArbitration:
			return []string{"reply_dispute", "escalate"}
		case StatusRefunded:
			return []string{"reorder", "chat_with_admin"}
		}
	case "shop":
		switch status {
		case StatusCreated, StatusAwaitingPayment:
			return []string{"cancel"}
		case StatusPaidEscrow:
			return []string{"processing", "deliver", "cancel_refund", "chat_with_buyer"}
		case StatusProcessing:
			return []string{"deliver", "chat_with_buyer"}
		case StatusDelivered, StatusCompleted:
			return []string{"chat_with_buyer"}
		case StatusDisputeOpened, StatusInArbitration:
			return []string{"reply_dispute", "offer_refund"}
		}
	case "arbiter":
		if status == StatusDisputeOpened || status == StatusInArbitration {
			return []string{"resolve", "request_evidence"}
		}
	}
	return []string{}
}

// Виды чатов (FR-MSG-01).
const (
	ChatShopSupport = "shop_support"
	ChatOrder       = "order"
	ChatDispute     = "dispute"
	ChatGroup       = "group"
	ChatChannel     = "channel"
	ChatDirect      = "direct"
)

// Статусы спора.
const (
	DisputeOpen          = "open"
	DisputeAwaitingReply = "awaiting_reply"
	DisputeInArbitration = "in_arbitration"
	DisputeResolved      = "resolved"
	DisputeDismissed     = "dismissed"
	DisputeAppeal        = "appeal"
	DisputeClosed        = "closed"
)

// Решения арбитра (FR-DSP-05).
const (
	ResolutionComplete       = "complete"
	ResolutionRefundFull     = "refund_full"
	ResolutionRefundPartial  = "refund_partial"
	ResolutionReplace        = "replace"
	ResolutionDismiss        = "dismiss"
	ResolutionEscalateSenior = "escalate_senior"
	ResolutionSanction       = "sanction"
)

// Статусы аренды (FR-SHOP-05).
const (
	RentTrial     = "trial"
	RentActive    = "active"
	RentExpiring  = "expiring"
	RentGrace     = "grace"
	RentSuspended = "suspended"
	RentCancelled = "cancelled"
	RentExpired   = "expired"
	RentNone      = "none"
)

// Статусы магазинов.
const (
	ShopDraft      = "draft"
	ShopModeration = "moderation"
	ShopActive     = "active"
	ShopFrozen     = "frozen"
	ShopSuspended  = "suspended"
	ShopBanned     = "banned"
)

// Статусы товаров.
const (
	ProductDraft      = "draft"
	ProductModeration = "moderation"
	ProductPublished  = "published"
	ProductRejected   = "rejected"
	ProductArchived   = "archived"
)

// Статусы пользователей.
const (
	UserPending    = "pending"
	UserActive     = "active"
	UserRestricted = "restricted"
	UserSuspended  = "suspended"
	UserBanned     = "banned"
)

// Факторы 2FA (FR-2FA-01).
const (
	FactorLogin = "login"
	FactorOps   = "ops"
)

// IsCrownedLocked вычисляет признак «коронки» (FR-SHOP-07).
func (s *Store) IsCrownedLocked(shop *Shop) bool {
	if shop == nil || shop.Status != ShopActive {
		return false
	}
	if shop.SanctionLevel != "" && shop.SanctionLevel != "none" {
		return false
	}
	if shop.RatingCount > 0 && shop.RatingBayes < 4.0 {
		return false
	}
	sub, ok := s.Subs[shop.ID]
	if !ok {
		return false
	}
	if sub.Status != RentActive && sub.Status != RentExpiring && sub.Status != RentTrial {
		return false
	}
	plan, ok := s.RentPlans[sub.PlanID]
	if !ok {
		return false
	}
	return plan.GrantsCrown
}

// RentStatusLocked возвращает текущий статус аренды магазина (или "none").
func (s *Store) RentStatusLocked(shopID string) string {
	if sub, ok := s.Subs[shopID]; ok {
		return sub.Status
	}
	return RentNone
}

// FeeBPSLocked возвращает комиссию площадки для магазина (по тарифу аренды).
func (s *Store) FeeBPSLocked(shopID string) int {
	if sub, ok := s.Subs[shopID]; ok {
		if plan, ok := s.RentPlans[sub.PlanID]; ok {
			return plan.FeeBPS
		}
	}
	return s.SettingInt("default_fee_bps", 700)
}
