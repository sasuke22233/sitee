package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/sasuke22233/sitee/backend/internal/platform/httpx"
	"github.com/sasuke22233/sitee/backend/internal/platform/ids"
	"github.com/sasuke22233/sitee/backend/internal/store"
)

// ---------------------------------------------------------------------------
// Споры (FR-DSP-01…08, docs/orders-disputes.md §3–5)
//
// Правила маскировки:
//   покупатель видит «Продавец #XYZ», магазин — «Покупатель #ABC»;
//   арбитр видит реальные идентификаторы (reveal=true) — каждое раскрытие
//   пишется в аудит-лог (dispute.reveal).
// ---------------------------------------------------------------------------

var disputeReasons = map[string]string{
	"not_delivered":  "Товар не доставлен",
	"wrong_item":     "Доставлен не тот товар",
	"invalid_key":    "Ключ/аккаунт не работает",
	"duplicate":      "Товар уже был продан (дубликат)",
	"partial":        "Доставлено частично",
	"quality":        "Качество не соответствует описанию",
	"fraud":          "Подозрение на мошенничество",
	"refund_request": "Запрос возврата по гарантии",
	"other":          "Другое",
}

type openDisputeRequest struct {
	ReasonCode  string `json:"reason_code"`
	Description string `json:"description"`
	TotpCode    string `json:"totp_code"`
}

func (s *Server) handleOpenDispute(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	orderID := r.PathValue("id")
	var req openDisputeRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if _, known := disputeReasons[req.ReasonCode]; !known {
		httpx.Fail(w, r, httpx.BadRequest("недопустимый reason_code", map[string]any{
			"allowed": disputeReasonCodes(),
		}))
		return
	}
	desc := strings.TrimSpace(req.Description)
	if utf8len(desc) < 10 || utf8len(desc) > 4000 {
		httpx.Fail(w, r, httpx.BadRequest("описание спора: от 10 до 4000 символов", nil))
		return
	}

	// Второй фактор 2FA для чувствительной операции (FR-2FA-04).
	if !s.requireOps(w, r, u, "dispute_open", 0, 0, req.TotpCode) {
		return
	}

	var (
		disp   *store.Dispute
		chatID string
		fail   *httpx.APIError
		order  *store.Order
		peers  []string
	)
	s.Store.Write(func() {
		o := s.findOrderLocked(orderID)
		if o == nil {
			fail = httpx.NotFound("заказ не найден")
			return
		}
		order = o
		shop := s.Store.Shops[o.ShopID]
		if shop == nil {
			fail = httpx.NotFound("магазин не найден")
			return
		}
		isBuyer := o.BuyerID == u.ID
		isSeller := shop.AdminUserID == u.ID || contains(shop.Operators, u.ID)
		if !isBuyer && !isSeller && !u.IsPrivileged() {
			fail = httpx.NotFound("заказ не найден")
			return
		}
		if o.DisputeID != "" {
			if existing := s.Store.Disputes[o.DisputeID]; existing != nil &&
				(existing.Status == store.DisputeOpen || existing.Status == store.DisputeAwaitingReply ||
					existing.Status == store.DisputeInArbitration) {
				fail = httpx.Conflict("DISPUTE_EXISTS", "по заказу уже открыт спор №"+existing.ID)
				return
			}
		}
		if !store.CanTransitionOrder(o.Status, store.StatusDisputeOpened) {
			fail = httpx.Conflict("INVALID_TRANSITION",
				"нельзя открыть спор из статуса «"+store.StatusTitleRU(o.Status)+"»")
			return
		}
		// Окно спора: DisputeWindowDays после доставки/завершения (FR-DSP-02).
		base := o.DeliveredAt
		if base.IsZero() {
			base = o.PaidAt
		}
		if !base.IsZero() && time.Since(base) > time.Duration(s.Cfg.DisputeWindowDays)*24*time.Hour {
			fail = httpx.Forbidden("DISPUTE_WINDOW_CLOSED", fmt.Sprintf(
				"окно спора закрыто: %d дней с момента доставки", s.Cfg.DisputeWindowDays))
			return
		}

		salt := ids.Hex(16)
		d := &store.Dispute{
			ID: ids.New("dsp"), OrderID: o.ID, ShopID: o.ShopID, OpenedBy: u.ID,
			ReasonCode: req.ReasonCode, Description: desc, Status: store.DisputeOpen,
			BuyerID: o.BuyerID, SellerID: shop.AdminUserID,
			BuyerAlias:    aliasFor(salt, o.BuyerID, "buyer"),
			SellerAlias:   aliasFor(salt, shop.AdminUserID, "shop"),
			ReplyDeadline: time.Now().UTC().Add(time.Duration(s.Cfg.DisputeReplyHours) * time.Hour),
			Salt:          salt,
			CreatedAt:     time.Now().UTC(), UpdatedAt: time.Now().UTC(),
		}
		d.Timeline = append(d.Timeline, &store.DisputeEvent{
			TS: d.CreatedAt, Kind: "opened", ActorID: u.ID,
			VisibleAs: aliasForViewers(d, u.ID),
			Note:      disputeReasons[d.ReasonCode],
		})

		// Чат спора: участники видят друг друга только под псевдонимами.
		chat := &store.Chat{
			ID: ids.New("cht"), Kind: store.ChatDispute,
			Title: "Спор по заказу " + o.Number, ShopID: o.ShopID, OrderID: o.ID,
			DisputeID: d.ID, AdminUserID: shop.AdminUserID, E2EE: false,
			CreatedAt: time.Now().UTC(),
		}
		s.Store.Chats[chat.ID] = chat
		s.addMemberLocked(chat, s.Store.Users[o.BuyerID], "member", d.BuyerAlias)
		s.addMemberLocked(chat, s.Store.Users[shop.AdminUserID], "admin", d.SellerAlias)
		d.ChatID = chat.ID
		s.Store.Disputes[d.ID] = d
		o.DisputeID = d.ID
		chatID = chat.ID

		s.appendSystemMessageLocked(chat, nil, store.SystemPayload{
			Kind: "dispute", OrderID: o.ID, Status: o.Status,
			Title: "Спор открыт: " + disputeReasons[d.ReasonCode] +
				". Личные данные скрыты, ответы до " + d.ReplyDeadline.Format(time.RFC3339) + ".",
		})

		if err := s.transitionLocked(o, store.StatusDisputeOpened, u.ID, "buyer", "открыт спор "+d.ID); err != nil {
			fail = httpx.Conflict("INVALID_TRANSITION", err.Error())
			return
		}
		disp = d
		for _, m := range s.Store.Members[chat.ID] {
			if m.UserID != u.ID {
				peers = append(peers, m.UserID)
			}
		}
		if sh, ok := s.Store.Shops[o.ShopID]; ok {
			s.recalcDisputeRateLocked(sh)
			s.feedScoresLocked()
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}

	s.audit(r, u.ID, u.Role, "dispute.open", "dispute", disp.ID, req.ReasonCode, store.FactorOps, nil,
		map[string]any{"order_id": order.ID, "shop_id": order.ShopID, "masked": true})

	title := "Открыт спор по заказу " + order.Number
	s.notify(order.BuyerID, "dispute_opened", title, disputeReasons[req.ReasonCode],
		"dispute:"+disp.ID+":buyer", map[string]any{"dispute_id": disp.ID, "order_id": order.ID})
	if order.BuyerID != u.ID {
		s.notify(order.BuyerID, "dispute_opened", title, "Магазин открыл спор", "dispute:"+disp.ID+":buyer2", nil)
	}
	for _, m := range s.shopAdmins(order.ShopID) {
		s.notify(m, "dispute_opened", title, disputeReasons[req.ReasonCode],
			"dispute:"+disp.ID+":"+m, map[string]any{"dispute_id": disp.ID})
	}
	s.pushMany(peers, "dispute.opened", map[string]any{
		"dispute_id": disp.ID, "order_id": order.ID, "chat_id": chatID,
		"reply_deadline": disp.ReplyDeadline, "status": disp.Status,
	})
	// Пул арбитров уведомляется сразу, чтобы спор не завис без арбитра.
	for _, arb := range s.arbiterPool() {
		s.notify(arb, "dispute_new", "Новый спор требует арбитра",
			"Заказ "+order.Number+": "+disputeReasons[req.ReasonCode],
			"dispute:"+disp.ID+":arbiter", map[string]any{"dispute_id": disp.ID})
	}

	var dto map[string]any
	s.Store.Read(func() { dto = s.disputeDTOLocked(disp, u) })
	httpx.JSON(w, http.StatusCreated, dto)
}

func disputeReasonCodes() []string {
	out := make([]string, 0, len(disputeReasons))
	for k := range disputeReasons {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// arbiterPool — кандидаты в арбитры: модераторы, арбитры, супер-админы.
func (s *Server) arbiterPool() []string {
	out := []string{}
	s.Store.Read(func() {
		for _, u := range s.Store.Users {
			switch u.Role {
			case store.RoleArbiter, store.RoleModerator, store.RoleSuperAdmin:
				if u.Status == "active" || u.Status == "" {
					out = append(out, u.ID)
				}
			}
		}
	})
	sort.Strings(out)
	return out
}

// shopAdmins — админ магазина и его операторы.
func (s *Server) shopAdmins(shopID string) []string {
	out := []string{}
	s.Store.Read(func() {
		sh, ok := s.Store.Shops[shopID]
		if !ok {
			return
		}
		out = append(out, sh.AdminUserID)
		out = append(out, sh.Operators...)
	})
	return out
}

// pickArbiterLocked выбирает арбитра с учётом анти-конфликтных правил
// (docs/orders-disputes.md §5.4): не участник спора, не оператор магазина,
// не тот, кто уже вёл споры этого магазина (ротация по наименьшей нагрузке).
func (s *Server) pickArbiterLocked(d *store.Dispute) string {
	excluded := map[string]bool{d.BuyerID: true, d.SellerID: true, d.OpenedBy: true}
	if sh, ok := s.Store.Shops[d.ShopID]; ok {
		for _, op := range sh.Operators {
			excluded[op] = true
		}
	}
	load := map[string]int{}
	best, bestLoad := "", -1
	for _, u := range s.Store.Users {
		if excluded[u.ID] {
			continue
		}
		switch u.Role {
		case store.RoleArbiter, store.RoleModerator, store.RoleSuperAdmin:
		default:
			continue
		}
		n := 0
		for _, other := range s.Store.Disputes {
			if other.ArbiterID == u.ID && other.Status != store.DisputeResolved &&
				other.Status != store.DisputeDismissed && other.Status != store.DisputeClosed {
				n++
			}
		}
		load[u.ID] = n
		if bestLoad < 0 || n < bestLoad {
			best, bestLoad = u.ID, n
		}
	}
	return best
}

func (s *Server) handleListDisputes(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	status := q.Get("status")
	role := q.Get("role") // buyer|shop|arbiter|all (для привилегированных)

	items := []map[string]any{}
	s.Store.Read(func() {
		list := []*store.Dispute{}
		for _, d := range s.Store.Disputes {
			switch {
			case u.IsPrivileged() && (role == "all" || role == ""):
				list = append(list, d)
			case d.BuyerID == u.ID && (role == "" || role == "buyer"):
				list = append(list, d)
			case d.SellerID == u.ID && (role == "" || role == "shop"):
				list = append(list, d)
			case d.ArbiterID == u.ID && (role == "" || role == "arbiter"):
				list = append(list, d)
			}
		}
		for _, d := range list {
			if status != "" && d.Status != status {
				continue
			}
			items = append(items, s.disputeDTOLocked(d, u))
		}
	})
	sort.Slice(items, func(i, j int) bool {
		a, _ := items[i]["created_at"].(time.Time)
		b, _ := items[j]["created_at"].(time.Time)
		return a.After(b)
	})
	start, end, next, hasMore := s.page(len(items), limit, q.Get("cursor"))
	open := 0
	for _, it := range items {
		if st, _ := it["status"].(string); st == store.DisputeOpen ||
			st == store.DisputeAwaitingReply || st == store.DisputeInArbitration {
			open++
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items[start:end], "next_cursor": next, "has_more": hasMore,
		"total": len(items), "open": open, "reasons": disputeReasonCodes(),
	})
}

func (s *Server) loadDisputeForUser(w http.ResponseWriter, r *http.Request, u *store.User) (*store.Dispute, bool) {
	id := r.PathValue("id")
	var (
		d    *store.Dispute
		fail *httpx.APIError
	)
	s.Store.Read(func() {
		d = s.Store.Disputes[id]
		if d == nil {
			fail = httpx.NotFound("спор не найден")
			return
		}
		switch {
		case d.BuyerID == u.ID, d.SellerID == u.ID, d.ArbiterID == u.ID:
		case u.IsPrivileged():
		default:
			d = nil
			fail = httpx.NotFound("спор не найден")
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return nil, false
	}
	return d, true
}

func (s *Server) handleGetDispute(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	d, ok := s.loadDisputeForUser(w, r, u)
	if !ok {
		return
	}
	var (
		dto   map[string]any
		msgs  []map[string]any
		order *store.Order
	)
	s.Store.Read(func() {
		dto = s.disputeDTOLocked(d, u)
		order = s.Store.Orders[d.OrderID]
		if d.ChatID != "" {
			if c := s.Store.Chats[d.ChatID]; c != nil {
				for _, m := range s.Store.Messages[d.ChatID] {
					msgs = append(msgs, s.messageDTOLocked(c, m, u.ID))
				}
			}
		}
	})
	dto["messages"] = msgs
	if order != nil {
		dto["order"] = map[string]any{
			"id": order.ID, "number": order.Number, "status": order.Status,
			"pay_asset": order.PayAsset, "total": orderTotalStr(order),
		}
	}
	// Раскрытие личностей арбитру фиксируется в аудит-логе (docs/security.md §5.3).
	if dto["reveal"] == true {
		s.audit(r, u.ID, u.Role, "dispute.reveal", "dispute", d.ID, "арбитр видит реальные ID", "",
			nil, map[string]any{"buyer_id": d.BuyerID, "seller_id": d.SellerID})
	}
	httpx.JSON(w, http.StatusOK, dto)
}

func orderTotalStr(o *store.Order) string {
	if o.PayAsset == store.AssetStars {
		return strconv.FormatInt(o.TotalStars, 10) + " ⭐"
	}
	return store.FormatSOL(o.TotalLamports) + " SOL"
}

// handleEscalateDispute — передача спора арбитру (FR-DSP-06).
func (s *Server) handleEscalateDispute(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req struct {
		Comment   string `json:"comment"`
		ArbiterID string `json:"arbiter_id"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		// тело необязательно
		req.Comment = ""
	}
	d, ok := s.loadDisputeForUser(w, r, u)
	if !ok {
		return
	}
	var (
		fail     *httpx.APIError
		arbiters []string
		assigned string
	)
	s.Store.Write(func() {
		if d.Status == store.DisputeResolved || d.Status == store.DisputeDismissed ||
			d.Status == store.DisputeClosed {
			fail = httpx.Conflict("DISPUTE_CLOSED", "спор уже закрыт")
			return
		}
		if req.ArbiterID != "" {
			if u.Role != store.RoleSuperAdmin && u.Role != store.RoleModerator {
				fail = httpx.Forbidden("FORBIDDEN", "назначать арбитра может только администрация")
				return
			}
			cand := s.Store.Users[req.ArbiterID]
			if cand == nil || (cand.Role != store.RoleArbiter && cand.Role != store.RoleModerator &&
				cand.Role != store.RoleSuperAdmin) {
				fail = httpx.BadRequest("арбитр не найден или не имеет роли арбитра", nil)
				return
			}
			if cand.ID == d.BuyerID || cand.ID == d.SellerID {
				fail = httpx.Conflict("ARBITER_CONFLICT", "арбитр не может быть участником спора")
				return
			}
			assigned = cand.ID
		} else {
			assigned = s.pickArbiterLocked(d)
		}
		d.Status = store.DisputeInArbitration
		d.ArbiterID = assigned
		d.AssignedAt = time.Now().UTC()
		d.ResolveDeadline = time.Now().UTC().Add(7 * 24 * time.Hour)
		d.UpdatedAt = d.AssignedAt
		d.Timeline = append(d.Timeline, &store.DisputeEvent{
			TS: d.UpdatedAt, Kind: "escalated", ActorID: u.ID,
			VisibleAs: aliasForViewers(d, u.ID), Note: strings.TrimSpace(req.Comment),
		})
		if assigned != "" {
			if arb := s.Store.Users[assigned]; arb != nil && d.ChatID != "" {
				if c := s.Store.Chats[d.ChatID]; c != nil {
					s.addMemberLocked(c, arb, "arbiter", "Арбитр")
				}
			}
			arbiters = append(arbiters, assigned)
		}
		if o := s.Store.Orders[d.OrderID]; o != nil {
			if store.CanTransitionOrder(o.Status, store.StatusInArbitration) {
				if err := s.transitionLocked(o, store.StatusInArbitration, u.ID, "arbiter",
					"спор передан арбитру"); err != nil {
					s.Log.Warn("dispute: переход заказа в арбитраж не удался", "err", err)
				}
			}
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "dispute.escalate", "dispute", d.ID, req.Comment, "", nil,
		map[string]any{"arbiter_id": assigned, "status": d.Status})

	notifyTargets := []string{d.BuyerID, d.SellerID}
	notifyTargets = append(notifyTargets, arbiters...)
	for _, t := range notifyTargets {
		s.notify(t, "dispute_escalated", "Спор передан арбитру",
			"Решение ожидается до "+d.ResolveDeadline.Format("02.01.2006 15:04"),
			"dispute:"+d.ID+":esc:"+t, map[string]any{"dispute_id": d.ID})
	}
	s.pushMany(notifyTargets, "dispute.escalated", map[string]any{
		"dispute_id": d.ID, "status": store.DisputeInArbitration,
		"arbiter_assigned": assigned != "", "resolve_deadline": d.ResolveDeadline,
	})

	var dto map[string]any
	s.Store.Read(func() { dto = s.disputeDTOLocked(d, u) })
	httpx.JSON(w, http.StatusOK, dto)
}

// ---------------------------------------------------------------------------
// Решение арбитра (FR-DSP-07, docs/orders-disputes.md §5)
// ---------------------------------------------------------------------------

type resolveDisputeRequest struct {
	Resolution  string `json:"resolution"` // refund_buyer|release_seller|partial|dismiss
	AmountSOL   string `json:"amount_sol"`
	AmountStars int64  `json:"amount_stars"`
	Reason      string `json:"reason"`
	TotpCode    string `json:"totp_code"`
}

func (s *Server) handleResolveDispute(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req resolveDisputeRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	switch req.Reason {
	case "":
		httpx.Fail(w, r, httpx.BadRequest("причина решения обязательна", nil))
		return
	}
	switch req.Resolution {
	case "refund_buyer", "release_seller", "partial", "dismiss":
	default:
		httpx.Fail(w, r, httpx.BadRequest("недопустимое решение", map[string]any{
			"allowed": []string{"refund_buyer", "release_seller", "partial", "dismiss"},
		}))
		return
	}
	d, ok := s.loadDisputeForUser(w, r, u)
	if !ok {
		return
	}
	// Решение принимает арбитр, модератор или супер-админ (правило R-ADMIN-1).
	if u.ID != d.ArbiterID && u.Role != store.RoleSuperAdmin && u.Role != store.RoleModerator {
		httpx.Fail(w, r, httpx.Forbidden("FORBIDDEN", "решение принимает назначенный арбитр"))
		return
	}
	if !s.requireOps(w, r, u, "dispute_resolve", 0, 0, req.TotpCode) {
		return
	}

	var (
		fail      *httpx.APIError
		txID      string
		amount    int64
		order     *store.Order
		newStatus string
		refunded  int64
	)
	s.Store.Write(func() {
		if d.Status == store.DisputeResolved || d.Status == store.DisputeDismissed {
			fail = httpx.Conflict("DISPUTE_CLOSED", "решение уже принято")
			return
		}
		o := s.Store.Orders[d.OrderID]
		if o == nil {
			fail = httpx.NotFound("заказ не найден")
			return
		}
		order = o
		asset := o.PayAsset
		if asset == "" {
			asset = store.AssetSOL
		}
		total := o.TotalLamports
		if asset == store.AssetStars {
			total = o.TotalStars
		}
		switch req.Resolution {
		case "refund_buyer":
			amount = total
		case "release_seller", "dismiss":
			amount = 0
		case "partial":
			if asset == store.AssetStars {
				amount = req.AmountStars
			} else {
				lamports, err := store.ParseSOL(req.AmountSOL)
				if err != nil {
					fail = httpx.BadRequest("некорректная сумма частичного возврата", nil)
					return
				}
				amount = lamports
			}
			if amount <= 0 || amount >= total {
				fail = httpx.BadRequest("частичная сумма должна быть в диапазоне (0; total)", nil)
				return
			}
		}

		if amount > 0 {
			id, refundedAmt, err := s.refundEscrowLocked(o, amount, u.ID, req.Reason)
			if err != nil {
				fail = mapLedgerError(err)
				return
			}
			txID = id
			refunded = refundedAmt
		}
		// Остаток эскроу — магазину за вычетом комиссии.
		if amount < total {
			if id := s.releaseEscrowLocked(o, u.ID); id != "" && txID == "" {
				txID = id
			}
		}

		d.Status = store.DisputeResolved
		if req.Resolution == "dismiss" {
			d.Status = store.DisputeDismissed
		}
		d.Resolution = req.Resolution
		d.ResolutionLamport = refunded
		d.ResolutionReason = req.Reason
		d.ResolvedAt = time.Now().UTC()
		d.UpdatedAt = d.ResolvedAt
		d.Timeline = append(d.Timeline, &store.DisputeEvent{
			TS: d.ResolvedAt, Kind: "resolved", ActorID: u.ID, VisibleAs: "Арбитр",
			Note: req.Reason,
		})

		// Влияние на репутацию: проигрыш магазина — штраф к фид-скорам.
		if sh, ok := s.Store.Shops[d.ShopID]; ok {
			switch req.Resolution {
			case "refund_buyer", "partial":
				sh.DisputeLossPenalty += 0.15
				sh.ComplaintPenalty += 0.05
			case "release_seller":
				if sh.DisputeLossPenalty > 0 {
					sh.DisputeLossPenalty -= 0.05
				}
			case "dismiss":
				// спор отклонён как необоснованный — санкций нет
			}
			s.recalcDisputeRateLocked(sh)
			s.feedScoresLocked()
		}

		// Итоговый статус заказа.
		if req.Resolution == "refund_buyer" || (req.Resolution == "partial" && refunded*2 >= total) {
			newStatus = store.StatusRefunded
		} else {
			newStatus = store.StatusCompleted
		}
		if store.CanTransitionOrder(o.Status, newStatus) {
			if err := s.transitionLocked(o, newStatus, u.ID, "arbiter", "решение арбитра: "+req.Resolution); err != nil {
				s.Log.Warn("dispute: переход заказа не удался", "err", err)
			}
		}
		if newStatus == store.StatusCompleted {
			o.CompletedAt = time.Now().UTC()
			s.finishOrderStatsLocked(o)
		} else {
			o.CancelledAt = time.Now().UTC()
		}
		if c := s.Store.Chats[d.ChatID]; c != nil {
			s.appendSystemMessageLocked(c, nil, store.SystemPayload{
				Kind: "dispute", OrderID: o.ID, Status: newStatus,
				Title:  "Решение арбитра: " + resolutionTitleRU(req.Resolution) + ". " + req.Reason,
				Amount: strconv.FormatInt(refunded, 10), Asset: asset,
			})
			c.ClosedAt = time.Now().UTC()
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}

	s.audit(r, u.ID, u.Role, "dispute.resolve", "dispute", d.ID, req.Reason, store.FactorOps, nil,
		map[string]any{
			"resolution": req.Resolution, "refunded": refunded, "tx_id": txID,
			"order_status": newStatus, "order_id": order.ID,
		})
	for _, t := range []string{d.BuyerID, d.SellerID} {
		s.notify(t, "dispute_resolved", "Спор решён",
			resolutionTitleRU(req.Resolution)+". "+req.Reason,
			"dispute:"+d.ID+":resolved:"+t,
			map[string]any{"dispute_id": d.ID, "order_id": order.ID, "refunded": refunded})
	}
	s.pushMany([]string{d.BuyerID, d.SellerID, d.ArbiterID}, "dispute.resolved", map[string]any{
		"dispute_id": d.ID, "resolution": req.Resolution, "order_status": newStatus,
		"refunded": refunded, "tx_id": txID,
	})

	var dto map[string]any
	s.Store.Read(func() { dto = s.disputeDTOLocked(d, u) })
	dto["escrow_tx"] = txID
	dto["refunded"] = refunded
	httpx.JSON(w, http.StatusOK, dto)
}

// ---------------------------------------------------------------------------
// Апелляция (FR-DSP-08): одна на спор, окно 72 ч, старший арбитр,
// исполнение refund_* приостанавливается до решения по апелляции.
// ---------------------------------------------------------------------------

type appealRequest struct {
	Reason string `json:"reason"`
}

func (s *Server) handleAppealDispute(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req appealRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if utf8len(reason) < 30 {
		httpx.Fail(w, r, httpx.BadRequest("обоснование апелляции — не менее 30 символов", nil))
		return
	}
	d, ok := s.loadDisputeForUser(w, r, u)
	if !ok {
		return
	}
	if d.BuyerID != u.ID && d.SellerID != u.ID {
		httpx.Fail(w, r, httpx.Forbidden("FORBIDDEN", "апелляция подаётся стороной спора"))
		return
	}
	var (
		fail   *httpx.APIError
		senior string
	)
	now := time.Now().UTC()
	s.Store.Write(func() {
		if d.AppealOf != "" {
			fail = httpx.Conflict("ALREADY_APPEALED", "по этому спору апелляция уже подана")
			return
		}
		if d.Status != store.DisputeResolved && d.Status != store.DisputeDismissed {
			fail = httpx.Conflict("DISPUTE_NOT_APPEALABLE",
				"апелляция возможна только после решения по спору")
			return
		}
		if !d.ResolvedAt.IsZero() && now.Sub(d.ResolvedAt) > 72*time.Hour {
			fail = httpx.Conflict("APPEAL_WINDOW_CLOSED",
				"окно апелляции — 72 часа с момента решения")
			return
		}
		// Старший арбитр: не тот, кто выносил решение (конфликт интересов).
		senior = s.pickSeniorArbiterLocked(d)
		if senior == "" {
			fail = httpx.Conflict("NO_ARBITER", "свободный старший арбитр не найден")
			return
		}
		d.AppealOf = d.ID
		d.AppealedBy = u.ID
		d.AppealedAt = now
		d.AppealReason = reason
		d.Status = store.DisputeAppeal
		d.ArbiterID = senior
		d.AssignedAt = now
		// Исполнение refund_* приостанавливается до решения по апелляции.
		if strings.HasPrefix(d.Resolution, "refund") || d.Resolution == "partial" {
			d.ExecutionSuspended = true
		}
		d.Timeline = append(d.Timeline, &store.DisputeEvent{
			TS: now, Kind: "appeal", ActorID: u.ID,
			VisibleAs: aliasForViewers(d, u.ID), Note: reason,
		})
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "dispute.appeal", "dispute", d.ID, reason, "",
		map[string]any{"resolution": d.Resolution, "execution_suspended": d.ExecutionSuspended},
		map[string]any{"status": d.Status, "arbiter_id": senior})
	s.notify(d.BuyerID, "dispute_appeal", "Апелляция принята",
		"Спор передан старшему арбитру. Исполнение решения приостановлено.",
		"dispute:"+d.ID+":appeal:"+d.BuyerID,
		map[string]any{"dispute_id": d.ID})
	s.notify(d.SellerID, "dispute_appeal", "Апелляция по спору",
		"По спору подана апелляция. Исполнение решения приостановлено.",
		"dispute:"+d.ID+":appeal:"+d.SellerID,
		map[string]any{"dispute_id": d.ID})
	s.notify(senior, "dispute_appeal", "Назначена апелляция",
		"Вам назначен спор по апелляции. Срок решения — 5 суток.",
		"dispute:"+d.ID+":appeal:"+senior,
		map[string]any{"dispute_id": d.ID})
	s.pushMany([]string{d.BuyerID, d.SellerID, senior}, "dispute.appealed", map[string]any{
		"dispute_id": d.ID, "status": d.Status, "execution_suspended": d.ExecutionSuspended,
	})

	var dto map[string]any
	s.Store.Read(func() { dto = s.disputeDTOLocked(d, u) })
	dto["appeal_of"] = d.AppealOf
	dto["appealed_by"] = d.AppealedBy
	dto["appealed_at"] = d.AppealedAt
	dto["appeal_reason"] = d.AppealReason
	dto["execution_suspended"] = d.ExecutionSuspended
	dto["senior_arbiter_assigned"] = senior
	httpx.JSON(w, http.StatusOK, dto)
}

// pickSeniorArbiterLocked — старший арбитр для апелляции: максимально свободный
// staff, исключая предыдущего арбитра и стороны спора (FR-DSP-08).
func (s *Server) pickSeniorArbiterLocked(d *store.Dispute) string {
	excluded := map[string]bool{d.BuyerID: true, d.SellerID: true, d.OpenedBy: true, d.ArbiterID: true}
	if sh, ok := s.Store.Shops[d.ShopID]; ok {
		for _, op := range sh.Operators {
			excluded[op] = true
		}
	}
	best, bestLoad := "", -1
	for _, u := range s.Store.Users {
		if excluded[u.ID] {
			continue
		}
		switch u.Role {
		case store.RoleArbiter, store.RoleModerator, store.RoleSuperAdmin:
		default:
			continue
		}
		n := 0
		for _, other := range s.Store.Disputes {
			if other.ArbiterID == u.ID && other.Status != store.DisputeResolved &&
				other.Status != store.DisputeDismissed && other.Status != store.DisputeClosed {
				n++
			}
		}
		if bestLoad < 0 || n < bestLoad {
			best, bestLoad = u.ID, n
		}
	}
	return best
}

func resolutionTitleRU(code string) string {
	switch code {
	case "refund_buyer":
		return "полный возврат покупателю"
	case "release_seller":
		return "средства перечислены продавцу"
	case "partial":
		return "частичный возврат"
	case "dismiss":
		return "спор отклонён"
	}
	return code
}

// ---------------------------------------------------------------------------
// Доказательства (FR-DSP-05): метаданные снимаются, содержимое шифруется.
// ---------------------------------------------------------------------------

type evidenceRequest struct {
	Kind    string `json:"kind"` // image|video|file|text
	Name    string `json:"name"`
	DataB64 string `json:"data_b64"`
	Text    string `json:"text"`
}

func (s *Server) handleAddEvidence(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req evidenceRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	switch req.Kind {
	case "image", "video", "file", "text":
	default:
		httpx.Fail(w, r, httpx.BadRequest("допустимые kind: image|video|file|text", nil))
		return
	}
	d, ok := s.loadDisputeForUser(w, r, u)
	if !ok {
		return
	}
	if d.Status == store.DisputeResolved || d.Status == store.DisputeDismissed ||
		d.Status == store.DisputeClosed {
		httpx.Fail(w, r, httpx.Conflict("DISPUTE_CLOSED", "спор закрыт, доказательства не принимаются"))
		return
	}

	raw := []byte(strings.TrimSpace(req.Text))
	if req.Kind != "text" {
		if req.DataB64 == "" {
			httpx.Fail(w, r, httpx.BadRequest("требуется data_b64", nil))
			return
		}
		decoded, err := base64.StdEncoding.DecodeString(req.DataB64)
		if err != nil {
			decoded, err = base64.RawURLEncoding.DecodeString(req.DataB64)
			if err != nil {
				httpx.Fail(w, r, httpx.BadRequest("некорректный base64", nil))
				return
			}
		}
		if len(decoded) > 4<<20 {
			httpx.Fail(w, r, httpx.BadRequest("файл больше 4 МБ", nil))
			return
		}
		raw = decoded
	}
	if len(raw) == 0 {
		httpx.Fail(w, r, httpx.BadRequest("пустое доказательство", nil))
		return
	}
	if len(d.Evidence) >= 20 {
		httpx.Fail(w, r, httpx.Forbidden("LIMIT_EXCEEDED", "не более 20 вложений на спор"))
		return
	}

	sum := sha256.Sum256(raw)
	ev := &store.Evidence{
		ID: ids.New("evd"), Kind: req.Kind, UploaderID: u.ID,
		SHA256: hex.EncodeToString(sum[:]), Size: len(raw),
		Name: sanitizeFilename(req.Name), MetaStripped: true, // EXIF/метаданные не сохраняются
		CreatedAt: time.Now().UTC(),
	}
	ct, err := s.Crypto.EncryptString(store.DomainDispute, ev.ID, base64.StdEncoding.EncodeToString(raw))
	if err != nil {
		httpx.Fail(w, r, httpx.Internal("не удалось зашифровать вложение"))
		return
	}
	ev.DataCT = ct

	s.Store.Write(func() {
		d.Evidence = append(d.Evidence, ev)
		d.UpdatedAt = time.Now().UTC()
		d.Timeline = append(d.Timeline, &store.DisputeEvent{
			TS: ev.CreatedAt, Kind: "evidence", ActorID: u.ID,
			VisibleAs: aliasForViewers(d, u.ID),
			Note:      "добавлено доказательство (" + ev.Kind + ", " + strconv.Itoa(ev.Size) + " байт)",
		})
		if d.Status == store.DisputeOpen {
			d.Status = store.DisputeAwaitingReply
		}
		if c := s.Store.Chats[d.ChatID]; c != nil {
			s.appendSystemMessageLocked(c, nil, store.SystemPayload{
				Kind: "dispute", OrderID: d.OrderID,
				Title: "Добавлено доказательство: " + ev.Name + " (" + ev.Kind + ")",
			})
		}
	})
	s.audit(r, u.ID, u.Role, "dispute.evidence", "dispute", d.ID, ev.Kind, "", nil,
		map[string]any{"evidence_id": ev.ID, "sha256": ev.SHA256, "size": ev.Size})

	peers := []string{}
	for _, t := range []string{d.BuyerID, d.SellerID, d.ArbiterID} {
		if t != "" && t != u.ID {
			peers = append(peers, t)
		}
	}
	s.pushMany(peers, "dispute.evidence", map[string]any{
		"dispute_id": d.ID, "evidence_id": ev.ID, "kind": ev.Kind, "name": ev.Name,
		"uploader_alias": aliasForViewers(d, u.ID),
	})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": ev.ID, "kind": ev.Kind, "name": ev.Name, "sha256": ev.SHA256, "size": ev.Size,
		"meta_stripped": ev.MetaStripped, "created_at": ev.CreatedAt,
		"notice": "Содержимое зашифровано (AES-256-GCM), метаданные удалены.",
	})
}

func sanitizeFilename(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "evidence"
	}
	name = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		case r == '.', r == '-', r == '_', r == ' ':
			return r
		}
		return '_'
	}, name)
	if utf8len(name) > 64 {
		name = truncate(name, 60) + ".bin"
	}
	return name
}

// handleAdminListDisputes и handleAdminAssignDispute — см. admin.go.

// disputeForOrderLocked возвращает активный спор заказа (для таймеров).
func (s *Server) disputeForOrderLocked(orderID string) *store.Dispute {
	for _, d := range s.Store.Disputes {
		if d.OrderID == orderID && d.Status != store.DisputeResolved &&
			d.Status != store.DisputeDismissed && d.Status != store.DisputeClosed {
			return d
		}
	}
	return nil
}

// autoEscalateOverdue переводит споры с истёкшим сроком ответа в арбитраж
// (вызывается таймером из cmd/siteed, docs/orders-disputes.md §2).
func (s *Server) autoEscalateOverdue() int {
	moved := 0
	now := time.Now().UTC()
	candidates := []*store.Dispute{}
	s.Store.Read(func() {
		for _, d := range s.Store.Disputes {
			if d.Status == store.DisputeOpen || d.Status == store.DisputeAwaitingReply {
				if !d.ReplyDeadline.IsZero() && now.After(d.ReplyDeadline) {
					candidates = append(candidates, d)
				}
			}
		}
	})
	for _, d := range candidates {
		s.Store.Write(func() {
			if d.Status != store.DisputeOpen && d.Status != store.DisputeAwaitingReply {
				return
			}
			d.Status = store.DisputeInArbitration
			d.ArbiterID = s.pickArbiterLocked(d)
			d.AssignedAt = now
			d.ResolveDeadline = now.Add(7 * 24 * time.Hour)
			d.UpdatedAt = now
			d.Timeline = append(d.Timeline, &store.DisputeEvent{
				TS: now, Kind: "auto_escalated", VisibleAs: "Система",
				Note: "срок ответа истёк — спор передан арбитру автоматически",
			})
			if o := s.Store.Orders[d.OrderID]; o != nil &&
				store.CanTransitionOrder(o.Status, store.StatusInArbitration) {
				_ = s.transitionLocked(o, store.StatusInArbitration, "", "timer", "истёк срок ответа в споре")
			}
			moved++
		})
		s.notify(d.BuyerID, "dispute_escalated", "Спор передан арбитру",
			"Срок ответа истёк", "dispute:"+d.ID+":auto", nil)
		s.notify(d.SellerID, "dispute_escalated", "Спор передан арбитру",
			"Срок ответа истёк", "dispute:"+d.ID+":auto:seller", nil)
	}
	return moved
}

// autoResolveOverdue — если арбитр не вынес решение за 7 дней, спор
// автоматически решается в пользу покупателя (защита от «вечных» споров).
func (s *Server) autoResolveOverdue() int {
	n := 0
	now := time.Now().UTC()
	candidates := []*store.Dispute{}
	s.Store.Read(func() {
		for _, d := range s.Store.Disputes {
			if d.Status == store.DisputeInArbitration && !d.ResolveDeadline.IsZero() &&
				now.After(d.ResolveDeadline) {
				candidates = append(candidates, d)
			}
		}
	})
	for _, d := range candidates {
		var ok bool
		s.Store.Write(func() {
			if d.Status != store.DisputeInArbitration {
				return
			}
			o := s.Store.Orders[d.OrderID]
			if o == nil {
				return
			}
			total := o.TotalLamports
			if o.PayAsset == store.AssetStars {
				total = o.TotalStars
			}
			if total > 0 {
				if _, _, err := s.refundEscrowLocked(o, total, "", "авто-решение: срок арбитража истёк"); err != nil {
					s.Log.Error("dispute: авто-возврат не удался", "dispute", d.ID, "err", err)
					return
				}
			}
			d.Status = store.DisputeResolved
			d.Resolution = "refund_buyer"
			d.ResolutionReason = "автоматическое решение: арбитр не вынес решение в срок"
			d.ResolvedAt = now
			d.UpdatedAt = now
			d.Timeline = append(d.Timeline, &store.DisputeEvent{
				TS: now, Kind: "auto_resolved", VisibleAs: "Система", Note: d.ResolutionReason,
			})
			if store.CanTransitionOrder(o.Status, store.StatusRefunded) {
				_ = s.transitionLocked(o, store.StatusRefunded, "", "timer", d.ResolutionReason)
			}
			o.CancelledAt = now
			if c := s.Store.Chats[d.ChatID]; c != nil {
				s.appendSystemMessageLocked(c, nil, store.SystemPayload{
					Kind: "dispute", OrderID: o.ID, Status: o.Status, Title: d.ResolutionReason,
				})
				c.ClosedAt = now
			}
			ok = true
			n++
		})
		if ok {
			s.notify(d.BuyerID, "dispute_resolved", "Спор решён автоматически",
				"Средства возвращены покупателю", "dispute:"+d.ID+":autores", nil)
			s.notify(d.SellerID, "dispute_resolved", "Спор решён автоматически",
				"Срок арбитража истёк", "dispute:"+d.ID+":autores:s", nil)
		}
	}
	return n
}

// handleGetDisputeEvidence — одно доказательство спора с расшифровкой (FR-DSP-03).
// Участники видят только свои вложения, арбитр — все; просмотр арбитром аудитируется.
func (s *Server) handleGetDisputeEvidence(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	evidenceID := r.PathValue("evidenceId")
	d, ok := s.loadDisputeForUser(w, r, u)
	if !ok {
		return
	}
	staff := u.Role == store.RoleArbiter || u.Role == store.RoleModerator || u.Role == store.RoleSuperAdmin
	var (
		dto  map[string]any
		fail *httpx.APIError
	)
	s.Store.Read(func() {
		var ev *store.Evidence
		for _, e := range d.Evidence {
			if e.ID == evidenceID {
				ev = e
				break
			}
		}
		if ev == nil {
			fail = httpx.NotFound("доказательство не найдено")
			return
		}
		if !staff && ev.UploaderID != u.ID {
			fail = httpx.Forbidden("FORBIDDEN", "нет доступа к доказательствам")
			return
		}
		alias := "Арбитр"
		switch {
		case ev.UploaderID == d.BuyerID:
			alias = d.BuyerAlias
		case ev.UploaderID == d.SellerID:
			alias = d.SellerAlias
		}
		dto = map[string]any{
			"id": ev.ID, "kind": ev.Kind, "name": ev.Name, "sha256": ev.SHA256,
			"size": ev.Size, "meta_stripped": ev.MetaStripped,
			"created_at": ev.CreatedAt, "uploader_visible_as": alias,
		}
		raw, err := s.Crypto.DecryptString(store.DomainDispute, ev.ID, ev.DataCT)
		if err != nil {
			return
		}
		if ev.Kind == "text" {
			dto["text"] = raw
			return
		}
		dto["data_b64"] = raw
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	if staff {
		s.audit(r, u.ID, u.Role, "dispute.evidence_view", "dispute", d.ID, "просмотр арбитром", "",
			nil, map[string]any{"evidence_id": evidenceID})
	}
	httpx.JSON(w, http.StatusOK, dto)
}
