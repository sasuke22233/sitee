package api

import (
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
// Создание заказа (FR-ORD-01)
// ---------------------------------------------------------------------------

type orderCreateRequest struct {
	ShopID string `json:"shop_id"`
	Items  []struct {
		ProductID string `json:"product_id"`
		Qty       int    `json:"qty"`
	} `json:"items"`
	PayAsset       string `json:"pay_asset"`
	IdempotencyKey string `json:"idempotency_key"`
}

func (s *Server) handleCreateOrder(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req orderCreateRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if len(req.Items) == 0 {
		httpx.Fail(w, r, httpx.BadRequest("корзина пуста", nil))
		return
	}
	asset := strings.ToUpper(req.PayAsset)
	if asset != store.AssetSOL && asset != store.AssetStars {
		asset = store.AssetSOL
	}
	idem := strings.TrimSpace(req.IdempotencyKey)
	if idem == "" {
		idem = r.Header.Get("Idempotency-Key")
	}

	var (
		fail  *httpx.APIError
		order *store.Order
		shop  *store.Shop
	)

	s.Store.Write(func() {
		// Идемпотентность: повторный ключ возвращает уже созданный заказ.
		if idem != "" {
			if existingID, seen := s.Store.Idempotency["order:"+idem]; seen {
				if existing, ok := s.Store.Orders[existingID]; ok {
					order = existing
					shop = s.Store.Shops[existing.ShopID]
					return
				}
			}
		}
		shop = s.findShopLocked(req.ShopID)
		if shop == nil {
			fail = httpx.NotFound("магазин не найден")
			return
		}
		if shop.Status != store.ShopActive {
			fail = httpx.Unprocessable("SHOP_UNAVAILABLE", "магазин недоступен: "+shop.Status)
			return
		}
		rent := s.Store.RentStatusLocked(shop.ID)
		if rent == store.RentSuspended || rent == store.RentGrace {
			fail = httpx.Unprocessable("RENT_REQUIRED", "аренда магазина не активна, заказы не принимаются")
			return
		}
		// «Прогрев» нового аккаунта ограничивает вывод средств и создание магазина,
		// но не покупки (FR-ABF-07).

		now := time.Now().UTC()
		order = &store.Order{
			ID: ids.New("ord"), BuyerID: u.ID, ShopID: shop.ID, Status: store.StatusCreated,
			PayAsset: asset, CreatedAt: now, UpdatedAt: now,
			PayDeadline:    now.Add(time.Duration(s.Cfg.PayTimeoutMinutes) * time.Minute),
			IdempotencyKey: idem, FeeBPS: s.Store.FeeBPSLocked(shop.ID),
		}
		order.Number = orderNumber(order.ID)

		var subtotalLamports, subtotalStars int64
		delivery := "auto"
		for _, line := range req.Items {
			p := s.Store.Products[line.ProductID]
			if p == nil || p.ShopID != shop.ID {
				fail = httpx.NotFound("товар " + line.ProductID + " не найден в магазине")
				return
			}
			if p.Status != store.ProductPublished {
				fail = httpx.Unprocessable("PRODUCT_UNAVAILABLE", "товар недоступен: "+p.Title)
				return
			}
			// FR-GEO-03(б): товар запрещённой категории нельзя купить в этой юрисдикции.
			if cat := geoBlockedCategoryLocked(s.Store, []int64{p.CategoryID}, u.Country); cat != nil {
				fail = httpx.Forbidden("GEO_BLOCKED",
					"товар недоступен в стране "+u.Country+": категория «"+cat.NameRU+"»")
				return
			}
			qty := line.Qty
			if qty <= 0 {
				qty = 1
			}
			if qty > 50 {
				fail = httpx.BadRequest("не более 50 единиц одного товара", nil)
				return
			}
			kind := deliveryKindOf(p)
			if kind != "auto" {
				delivery = kind
			}
			// Резервирование стока (FR-PROD-03).
			taken := []string{}
			if p.StockTotal > 0 {
				for _, item := range s.Store.Stock[p.ID] {
					if len(taken) >= qty {
						break
					}
					if item.Status == "free" {
						item.Status = "reserved"
						item.ReservedBy = order.ID
						taken = append(taken, item.ID)
						p.StockFree--
					}
				}
				if len(taken) < qty {
					// откат резерва
					for _, id := range taken {
						for _, item := range s.Store.Stock[p.ID] {
							if item.ID == id {
								item.Status = "free"
								item.ReservedBy = ""
								p.StockFree++
							}
						}
					}
					fail = httpx.Unprocessable("STOCK_EMPTY",
						fmt.Sprintf("недостаточно единиц товара «%s» (свободно %d)", p.Title, p.StockFree))
					return
				}
			}
			subtotalLamports += p.PriceLamports * int64(qty)
			subtotalStars += p.PriceStars * int64(qty)
			order.Items = append(order.Items, &store.OrderItem{
				ID: ids.New("oit"), ProductID: p.ID, Title: p.Title, Qty: qty,
				UnitLamports: p.PriceLamports, UnitStars: p.PriceStars, StockItemIDs: taken,
			})
		}

		order.SubtotalLamports = subtotalLamports
		order.SubtotalStars = subtotalStars
		order.FeeLamports = subtotalLamports * int64(order.FeeBPS) / 10000
		order.FeeStars = subtotalStars * int64(order.FeeBPS) / 10000
		order.TotalLamports = subtotalLamports
		order.TotalStars = subtotalStars
		order.DeliveryKind = delivery

		s.Store.Orders[order.ID] = order
		s.Store.OrdersByNumber[order.Number] = order.ID
		if idem != "" {
			s.Store.Idempotency["order:"+idem] = order.ID
		}
		s.appendStatusLocked(order, "", store.StatusCreated, u.ID, "buyer", "оформлен заказ")
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}

	// Чат заказа открывается с админом магазина (FR-MSG-01, TZ §3.1).
	chatID := s.openOrderChat(order, shop, u)

	s.audit(r, u.ID, u.Role, "order.create", "order", order.ID, "", "", nil,
		map[string]any{"shop_id": shop.ID, "asset": order.PayAsset,
			"total_sol": store.FormatSOL(order.TotalLamports), "total_stars": order.TotalStars})
	s.notify(shop.AdminUserID, "order.created", "Новый заказ",
		fmt.Sprintf("Заказ %s на %s ожидает оплаты.", order.Number,
			amountStr(order.PayAsset, order.TotalLamports, order.TotalStars)),
		"order-created:"+order.ID, map[string]any{"order_id": order.ID})

	var dto map[string]any
	s.Store.Read(func() { dto = s.orderDTOLocked(order, "buyer") })
	dto["chat_id"] = chatID
	httpx.JSON(w, http.StatusCreated, dto)
}

func orderNumber(id string) string {
	clean := strings.ReplaceAll(id, "_", "")
	if len(clean) < 8 {
		return "#" + strings.ToUpper(clean)
	}
	return "#" + strings.ToUpper(clean[len(clean)-4:]) + "-" + strings.ToUpper(clean[4:8])
}

// appendStatusLocked добавляет запись истории статусов.
func (s *Server) appendStatusLocked(o *store.Order, from, to, actorID, actorKind, reason string) {
	s.Store.OrderStatuses = append(s.Store.OrderStatuses, &store.StatusEvent{
		OrderID: o.ID, From: from, To: to, ActorID: actorID, ActorKind: actorKind,
		Reason: reason, TS: time.Now().UTC(),
	})
	o.UpdatedAt = time.Now().UTC()
}

// transitionLocked переводит заказ в новый статус с проверкой конечного автомата.
func (s *Server) transitionLocked(o *store.Order, to, actorID, actorKind, reason string) error {
	if !store.CanTransitionOrder(o.Status, to) {
		return httpx.Conflict("INVALID_TRANSITION",
			fmt.Sprintf("переход %s → %s недопустим", o.Status, to))
	}
	from := o.Status
	o.Status = to
	s.appendStatusLocked(o, from, to, actorID, actorKind, reason)
	return nil
}

// ---------------------------------------------------------------------------
// Оплата и эскроу (FR-ORD-03/04, FR-PROD-03)
// ---------------------------------------------------------------------------

type payOrderRequest struct {
	Asset          string `json:"asset"`
	TotpCode       string `json:"totp_code"`
	IdempotencyKey string `json:"idempotency_key"`
}

func (s *Server) handlePayOrder(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	order, fail := s.loadOrderForUser(r, u, "buyer")
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	var req payOrderRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	asset := strings.ToUpper(req.Asset)
	if asset == "" {
		asset = order.PayAsset
	}
	if asset != store.AssetSOL && asset != store.AssetStars {
		asset = store.AssetSOL
	}
	amountLamports, amountStars := order.TotalLamports, order.TotalStars
	if asset == store.AssetSOL {
		amountStars = 0
	} else {
		amountLamports = 0
	}
	if amountLamports == 0 && amountStars == 0 {
		httpx.Fail(w, r, httpx.Unprocessable("ORDER_NOT_PAYABLE",
			"цена товара не задана в выбранном активе"))
		return
	}
	if !s.requireOps(w, r, u, "order_pay", amountLamports, amountStars, req.TotpCode) {
		return
	}

	idem := strings.TrimSpace(req.IdempotencyKey)
	if idem == "" {
		idem = r.Header.Get("Idempotency-Key")
	}
	if idem == "" {
		idem = "pay:" + order.ID + ":" + asset
	}

	var (
		payFail *httpx.APIError
		txID    string
	)
	s.Store.Write(func() {
		if order.Status != store.StatusCreated && order.Status != store.StatusAwaitingPayment {
			payFail = httpx.Conflict("INVALID_TRANSITION", "заказ уже оплачен или закрыт: "+order.Status)
			return
		}
		if time.Now().UTC().After(order.PayDeadline) {
			_ = s.transitionLocked(order, store.StatusExpired, "", "timer", "истёк срок оплаты")
			payFail = httpx.Conflict("INVALID_TRANSITION", "срок оплаты истёк")
			return
		}
		s.Store.EnsureAccountLocked(store.OwnerUser, u.ID, asset)
		s.Store.EnsureAccountLocked(store.OwnerEscrow, order.ID, asset)
		amount := amountLamports
		if asset == store.AssetStars {
			amount = amountStars
		}
		var err error
		txID, err = s.Store.PostLocked(idem, asset, store.KindOrderHold, "order", order.ID, u.ID,
			[]store.Posting{
				store.Debit(store.UserAccount(u.ID, asset), amount),
				store.Credit(store.EscrowAccount(order.ID, asset), amount),
			})
		if err != nil {
			payFail = mapLedgerError(err)
			return
		}
		order.PayAsset = asset
		order.EscrowAccount = store.EscrowAccount(order.ID, asset)
		order.PaidAt = time.Now().UTC()
		if err := s.transitionLocked(order, store.StatusPaidEscrow, u.ID, "buyer", "оплата получена, средства в эскроу"); err != nil {
			payFail = httpx.AsAPIError(err)
			return
		}
		// Автовыдача (FR-PROD-03).
		if order.DeliveryKind == "auto" {
			s.autoDeliverLocked(order, u)
		} else {
			order.DeliveryDeadline = time.Now().UTC().Add(time.Duration(s.deliverySLAHours(order)) * time.Hour)
		}
	})
	if payFail != nil {
		httpx.Fail(w, r, payFail)
		return
	}

	var shop *store.Shop
	s.Store.Read(func() { shop = s.Store.Shops[order.ShopID] })

	s.audit(r, u.ID, u.Role, "order.pay", "order", order.ID, "asset="+asset, "", nil,
		map[string]any{"tx_id": txID, "status": order.Status,
			"amount": amountStr(asset, amountLamports, amountStars)})
	if shop != nil {
		s.notify(shop.AdminUserID, "order.paid", "Заказ оплачен",
			fmt.Sprintf("Заказ %s оплачен (%s). Средства в эскроу до завершения.", order.Number,
				amountStr(asset, amountLamports, amountStars)),
			"order-paid:"+order.ID, map[string]any{"order_id": order.ID, "status": order.Status})
		s.systemMessage(shop.AdminUserID, order.ChatID, "order_status", order.ID, order.Status,
			amountStr(asset, amountLamports, amountStars), asset)
	}
	s.systemMessage(u.ID, order.ChatID, "order_status", order.ID, order.Status,
		amountStr(asset, amountLamports, amountStars), asset)
	s.push(u.ID, "order.status", map[string]any{
		"order_id": order.ID, "status": order.Status,
		"actions": store.OrderActionsRU(order.Status, "buyer"), "ts": time.Now().UTC(),
	})
	if shop != nil {
		s.push(shop.AdminUserID, "order.status", map[string]any{
			"order_id": order.ID, "status": order.Status,
			"actions": store.OrderActionsRU(order.Status, "shop"), "ts": time.Now().UTC(),
		})
	}

	var dto map[string]any
	s.Store.Read(func() { dto = s.orderDTOLocked(order, "buyer") })
	dto["payment"] = map[string]any{"tx_id": txID, "asset": asset,
		"amount": amountStr(asset, amountLamports, amountStars)}
	httpx.JSON(w, http.StatusOK, dto)
}

func (s *Server) deliverySLAHours(o *store.Order) int {
	sla := 24
	for _, it := range o.Items {
		if p, ok := s.Store.Products[it.ProductID]; ok && p.DeliverySLAH > 0 {
			sla = p.DeliverySLAH
			break
		}
	}
	return sla
}

// autoDeliverLocked выдаёт товар из зарезервированного стока (атомарно в рамках Write).
func (s *Server) autoDeliverLocked(o *store.Order, u *store.User) {
	now := time.Now().UTC()
	allDelivered := true
	for _, item := range o.Items {
		if len(item.StockItemIDs) == 0 {
			allDelivered = false
			continue
		}
		payloads := []string{}
		for _, stockID := range item.StockItemIDs {
			for _, si := range s.Store.Stock[item.ProductID] {
				if si.ID != stockID {
					continue
				}
				si.Status = "sold"
				si.SoldAt = now
				if plain, err := s.Crypto.DecryptString(store.DomainProductStock, si.ID, si.PayloadCT); err == nil {
					payloads = append(payloads, plain)
				} else {
					payloads = append(payloads, "<ошибка расшифровки позиции>")
					s.Log.Error("auto-delivery: ошибка расшифровки стока",
						"product", item.ProductID, "item", si.ID, "err", err)
				}
			}
		}
		if len(payloads) == 0 {
			allDelivered = false
			continue
		}
		ct, err := s.Crypto.EncryptString(store.DomainMessage, item.ID, strings.Join(payloads, "\n"))
		if err != nil {
			allDelivered = false
			continue
		}
		item.DeliveredPayloadCT = ct
		item.DeliveredAt = now
	}
	if !allDelivered {
		_ = s.transitionLocked(o, store.StatusProcessing, "", "system", "частичная автовыдача, ждём админа магазина")
		return
	}
	o.DeliveredAt = now
	o.ConfirmDeadline = now.Add(time.Duration(s.Cfg.AutoConfirmHours) * time.Hour)
	_ = s.transitionLocked(o, store.StatusDelivered, "", "system", "автовыдача цифрового товара")

	// Статистика магазина обновляется при завершении заказа.
	if sh, ok := s.Store.Shops[o.ShopID]; ok {
		s.systemMessage(sh.AdminUserID, o.ChatID, "order_status", o.ID, o.Status, "", o.PayAsset)
	}
	s.notify(u.ID, "order.delivered", "Товар выдан",
		fmt.Sprintf("Заказ %s: товар выдан автоматически. Подтвердите получение до %s.",
			o.Number, o.ConfirmDeadline.Format("02.01.2006 15:04")),
		"order-delivered:"+o.ID, map[string]any{"order_id": o.ID})
}

// loadOrderForUser загружает заказ с проверкой роли.
func (s *Server) loadOrderForUser(r *http.Request, u *store.User, role string) (*store.Order, *httpx.APIError) {
	id := r.PathValue("id")
	var (
		o    *store.Order
		fail *httpx.APIError
	)
	s.Store.Read(func() {
		o = s.findOrderLocked(id)
		if o == nil {
			fail = httpx.NotFound("заказ не найден")
			return
		}
		sh := s.Store.Shops[o.ShopID]
		switch role {
		case "buyer":
			if o.BuyerID != u.ID {
				fail = httpx.NotFound("заказ не найден")
			}
		case "shop":
			if sh == nil || (sh.AdminUserID != u.ID && !contains(sh.Operators, u.ID)) {
				fail = httpx.NotFound("заказ не найден")
			}
		}
	})
	return o, fail
}

func (s *Server) findOrderLocked(idOrNumber string) *store.Order {
	if o, ok := s.Store.Orders[idOrNumber]; ok {
		return o
	}
	if id, ok := s.Store.OrdersByNumber[strings.ToUpper(idOrNumber)]; ok {
		return s.Store.Orders[id]
	}
	return nil
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Подтверждение, продление, отмена, выдача (FR-ORD-05…07)
// ---------------------------------------------------------------------------

func (s *Server) handleConfirmOrder(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	order, fail := s.loadOrderForUser(r, u, "buyer")
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	var orderFail *httpx.APIError
	var txID string
	s.Store.Write(func() {
		if order.Status != store.StatusDelivered {
			orderFail = httpx.Conflict("INVALID_TRANSITION", "подтвердить можно только выданный заказ")
			return
		}
		txID = s.releaseEscrowLocked(order, u.ID)
		if txID == "" && order.TotalLamports > 0 && order.PayAsset != store.AssetStars {
			orderFail = httpx.Internal("не удалось раскрыть эскроу")
			return
		}
		order.CompletedAt = time.Now().UTC()
		if err := s.transitionLocked(order, store.StatusCompleted, u.ID, "buyer", "покупатель подтвердил получение"); err != nil {
			orderFail = httpx.AsAPIError(err)
			return
		}
		s.finishOrderStatsLocked(order)
	})
	if orderFail != nil {
		httpx.Fail(w, r, orderFail)
		return
	}
	s.afterOrderCompleted(w, r, u, order, txID, "buyer confirmed")
}

// releaseEscrowLocked раскрывает эскроу: магазину — сумма за вычетом комиссии,
// площадке — комиссия (FR-ORD-04). Возвращает tx_id (пустая строка — ошибка).
func (s *Server) releaseEscrowLocked(o *store.Order, actorID string) string {
	asset := o.PayAsset
	if asset == "" {
		asset = store.AssetSOL
	}
	amount := o.TotalLamports
	if asset == store.AssetStars {
		amount = o.TotalStars
	}
	if amount <= 0 {
		return ""
	}
	fee := amount * int64(o.FeeBPS) / 10000
	net := amount - fee

	s.Store.EnsureAccountLocked(store.OwnerEscrow, o.ID, asset)
	s.Store.EnsureAccountLocked(store.OwnerShop, o.ShopID, asset)
	s.Store.EnsureAccountLocked(store.OwnerPlatform, store.PlatformFees, asset)

	postings := []store.Posting{store.Debit(store.EscrowAccount(o.ID, asset), amount)}
	if net > 0 {
		postings = append(postings, store.Credit(store.ShopAccount(o.ShopID, asset), net))
	}
	if fee > 0 {
		postings = append(postings, store.Credit(store.PlatformAccount(store.PlatformFees, asset), fee))
	}
	txID, err := s.Store.PostLocked("release:"+o.ID, asset, store.KindOrderRelease,
		"order", o.ID, actorID, postings)
	if err != nil {
		s.Log.Error("ledger: раскрытие эскроу не удалось", "order", o.ID, "err", err)
		return ""
	}
	return txID
}

// refundEscrowLocked возвращает средства покупателю (полный или частичный).
func (s *Server) refundEscrowLocked(o *store.Order, amountLamports int64, actorID, reason string) (string, int64, error) {
	asset := o.PayAsset
	if asset == "" {
		asset = store.AssetSOL
	}
	total := o.TotalLamports
	if asset == store.AssetStars {
		total = o.TotalStars
	}
	amount := amountLamports
	if amount <= 0 || amount > total {
		amount = total
	}
	s.Store.EnsureAccountLocked(store.OwnerEscrow, o.ID, asset)
	s.Store.EnsureAccountLocked(store.OwnerUser, o.BuyerID, asset)
	txID, err := s.Store.PostLocked("refund:"+o.ID+":"+strconv.FormatInt(amount, 10),
		asset, store.KindRefund, "order", o.ID, actorID, []store.Posting{
			store.Debit(store.EscrowAccount(o.ID, asset), amount),
			store.Credit(store.UserAccount(o.BuyerID, asset), amount),
		})
	if err != nil {
		return "", amount, err
	}
	_ = reason
	return txID, amount, nil
}

func (s *Server) finishOrderStatsLocked(o *store.Order) {
	sh, ok := s.Store.Shops[o.ShopID]
	if !ok {
		return
	}
	sh.SalesCount++
	sh.SalesVolumeLamport += o.TotalLamports
	for _, item := range o.Items {
		if p, ok := s.Store.Products[item.ProductID]; ok {
			p.StockTotal = len(s.Store.Stock[p.ID])
			free := 0
			for _, si := range s.Store.Stock[p.ID] {
				if si.Status == "free" {
					free++
				}
			}
			p.StockFree = free
		}
	}
	s.recalcDisputeRateLocked(sh)
	s.feedScoresLocked()
}

func (s *Server) recalcDisputeRateLocked(sh *store.Shop) {
	total, disputed := 0, 0
	for _, o := range s.Store.Orders {
		if o.ShopID != sh.ID {
			continue
		}
		total++
		if o.DisputeID != "" {
			disputed++
		}
	}
	if total > 0 {
		sh.DisputeRate = float64(disputed) / float64(total)
	}
}

func (s *Server) afterOrderCompleted(w http.ResponseWriter, r *http.Request, u *store.User, o *store.Order, txID, reason string) {
	s.audit(r, u.ID, u.Role, "order.complete", "order", o.ID, reason, "", nil,
		map[string]any{"tx_id": txID, "status": o.Status})
	var shop *store.Shop
	s.Store.Read(func() { shop = s.Store.Shops[o.ShopID] })
	if shop != nil {
		s.notify(shop.AdminUserID, "order.completed", "Заказ завершён",
			fmt.Sprintf("Заказ %s завершён, средства раскрыты за вычетом комиссии %d%%.",
				o.Number, o.FeeBPS/100),
			"order-completed:"+o.ID, map[string]any{"order_id": o.ID})
		s.push(shop.AdminUserID, "order.status", map[string]any{
			"order_id": o.ID, "status": o.Status,
			"actions": store.OrderActionsRU(o.Status, "shop")})
	}
	s.notify(u.ID, "order.completed", "Заказ завершён",
		fmt.Sprintf("Заказ %s завершён. Оставьте отзыв в течение %d дней.",
			o.Number, s.Cfg.ReviewWindowDays),
		"order-completed-buyer:"+o.ID, map[string]any{"order_id": o.ID})
	s.push(u.ID, "order.status", map[string]any{
		"order_id": o.ID, "status": o.Status,
		"actions": store.OrderActionsRU(o.Status, "buyer")})
	s.systemMessage(u.ID, o.ChatID, "order_status", o.ID, o.Status, "", o.PayAsset)

	var dto map[string]any
	s.Store.Read(func() { dto = s.orderDTOLocked(o, "buyer") })
	dto["escrow_release_tx"] = txID
	httpx.JSON(w, http.StatusOK, dto)
}

func (s *Server) handleExtendOrder(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	order, fail := s.loadOrderForUser(r, u, "buyer")
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	var orderFail *httpx.APIError
	s.Store.Write(func() {
		if order.Status != store.StatusDelivered {
			orderFail = httpx.Conflict("INVALID_TRANSITION", "продлить можно только выданный заказ")
			return
		}
		if order.ExtendUsed {
			orderFail = httpx.Conflict("ALREADY_USED", "продление уже использовано (1 раз на заказ)")
			return
		}
		order.ExtendUsed = true
		base := order.ConfirmDeadline
		if base.IsZero() || base.Before(time.Now()) {
			base = time.Now().UTC()
		}
		order.ConfirmDeadline = base.Add(72 * time.Hour)
		s.appendStatusLocked(order, order.Status, order.Status, u.ID, "buyer",
			"окно подтверждения продлено на 72 ч")
	})
	if orderFail != nil {
		httpx.Fail(w, r, orderFail)
		return
	}
	s.audit(r, u.ID, u.Role, "order.extend", "order", order.ID, "", "", nil,
		map[string]any{"confirm_deadline": order.ConfirmDeadline})
	var dto map[string]any
	s.Store.Read(func() { dto = s.orderDTOLocked(order, "buyer") })
	httpx.JSON(w, http.StatusOK, dto)
}

func (s *Server) handleCancelOrder(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	var req struct {
		Reason string `json:"reason"`
	}
	_ = httpx.Decode(r, &req)

	var (
		order    *store.Order
		orderErr *httpx.APIError
		refunded int64
		txID     string
		asShop   bool
	)
	s.Store.Write(func() {
		order = s.findOrderLocked(id)
		if order == nil {
			orderErr = httpx.NotFound("заказ не найден")
			return
		}
		sh := s.Store.Shops[order.ShopID]
		isBuyer := order.BuyerID == u.ID
		isShop := sh != nil && (sh.AdminUserID == u.ID || contains(sh.Operators, u.ID))
		if !isBuyer && !isShop && u.Role != store.RoleSuperAdmin {
			orderErr = httpx.NotFound("заказ не найден")
			return
		}
		asShop = isShop && !isBuyer
		role := "buyer"
		if asShop {
			role = "shop"
		}
		switch order.Status {
		case store.StatusCreated, store.StatusAwaitingPayment:
			if err := s.transitionLocked(order, store.StatusCancelled, u.ID, role, "отмена до оплаты: "+req.Reason); err != nil {
				orderErr = httpx.AsAPIError(err)
				return
			}
			order.CancelledAt = time.Now().UTC()
			s.releaseStockLocked(order)
		case store.StatusPaidEscrow:
			if !asShop && u.Role != store.RoleSuperAdmin {
				orderErr = httpx.Conflict("INVALID_TRANSITION",
					"после оплаты отмена возможна через спор или согласие админа магазина")
				return
			}
			tx, amount, err := s.refundEscrowLocked(order, 0, u.ID, "отмена магазином")
			if err != nil {
				orderErr = mapLedgerError(err)
				return
			}
			txID, refunded = tx, amount
			order.CancelledAt = time.Now().UTC()
			if err := s.transitionLocked(order, store.StatusCancelled, u.ID, role, "отмена с возвратом: "+req.Reason); err != nil {
				orderErr = httpx.AsAPIError(err)
				return
			}
			s.releaseStockLocked(order)
		default:
			orderErr = httpx.Conflict("INVALID_TRANSITION",
				"заказ в статусе "+order.Status+" нельзя отменить — откройте спор")
		}
	})
	if orderErr != nil {
		httpx.Fail(w, r, orderErr)
		return
	}
	s.audit(r, u.ID, u.Role, "order.cancel", "order", order.ID, req.Reason, "", nil,
		map[string]any{"refund": refunded, "tx_id": txID})
	s.push(order.BuyerID, "order.status", map[string]any{"order_id": order.ID, "status": order.Status})
	var dto map[string]any
	s.Store.Read(func() { dto = s.orderDTOLocked(order, "buyer") })
	if refunded > 0 {
		dto["refund"] = map[string]any{"tx_id": txID, "amount": store.FormatSOL(refunded)}
	}
	httpx.JSON(w, http.StatusOK, dto)
}

func (s *Server) releaseStockLocked(o *store.Order) {
	for _, item := range o.Items {
		for _, stockID := range item.StockItemIDs {
			for _, si := range s.Store.Stock[item.ProductID] {
				if si.ID == stockID && si.Status == "reserved" {
					si.Status = "free"
					si.ReservedBy = ""
				}
			}
		}
		if p, ok := s.Store.Products[item.ProductID]; ok {
			free := 0
			for _, si := range s.Store.Stock[p.ID] {
				if si.Status == "free" {
					free++
				}
			}
			p.StockFree = free
		}
	}
}

func (s *Server) handleProcessingOrder(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	order, fail := s.loadOrderForUser(r, u, "shop")
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	var req struct {
		Comment string `json:"comment"`
	}
	_ = httpx.Decode(r, &req)
	var orderFail *httpx.APIError
	s.Store.Write(func() {
		if err := s.transitionLocked(order, store.StatusProcessing, u.ID, "shop",
			"админ магазина взял заказ в работу"); err != nil {
			orderFail = httpx.AsAPIError(err)
			return
		}
		order.DeliveryDeadline = time.Now().UTC().Add(time.Duration(s.deliverySLAHours(order)) * time.Hour)
	})
	if orderFail != nil {
		httpx.Fail(w, r, orderFail)
		return
	}
	s.systemMessage(order.BuyerID, order.ChatID, "order_status", order.ID, order.Status, "", order.PayAsset)
	s.push(order.BuyerID, "order.status", map[string]any{"order_id": order.ID, "status": order.Status})
	var dto map[string]any
	s.Store.Read(func() { dto = s.orderDTOLocked(order, "shop") })
	httpx.JSON(w, http.StatusOK, dto)
}

type deliverRequest struct {
	Payload      string   `json:"payload"`
	StockItemIDs []string `json:"stock_item_ids"`
	Comment      string   `json:"comment"`
}

func (s *Server) handleDeliverOrder(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	order, fail := s.loadOrderForUser(r, u, "shop")
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	var req deliverRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var orderFail *httpx.APIError
	s.Store.Write(func() {
		if order.Status != store.StatusPaidEscrow && order.Status != store.StatusProcessing {
			orderFail = httpx.Conflict("INVALID_TRANSITION", "выдача возможна после оплаты")
			return
		}
		now := time.Now().UTC()
		for _, item := range order.Items {
			if item.DeliveredPayloadCT != "" {
				continue
			}
			payload := strings.TrimSpace(req.Payload)
			if payload == "" {
				orderFail = httpx.BadRequest("укажите содержимое для ручной выдачи", nil)
				return
			}
			ct, err := s.Crypto.EncryptString(store.DomainMessage, item.ID, payload)
			if err != nil {
				orderFail = httpx.Internal("не удалось зашифровать выданный контент")
				return
			}
			item.DeliveredPayloadCT = ct
			item.DeliveredAt = now
		}
		order.DeliveredAt = now
		order.ConfirmDeadline = now.Add(time.Duration(s.Cfg.AutoConfirmHours) * time.Hour)
		if err := s.transitionLocked(order, store.StatusDelivered, u.ID, "shop", "ручная выдача"); err != nil {
			orderFail = httpx.AsAPIError(err)
			return
		}
		if sh, ok := s.Store.Shops[order.ShopID]; ok && sh.ResponseP50S == 0 {
			sh.ResponseP50S = int(now.Sub(order.PaidAt).Seconds())
		}
	})
	if orderFail != nil {
		httpx.Fail(w, r, orderFail)
		return
	}
	s.audit(r, u.ID, u.Role, "order.deliver", "order", order.ID, "", "", nil, nil)
	s.notify(order.BuyerID, "order.delivered", "Товар выдан",
		fmt.Sprintf("Заказ %s: админ магазина выдал товар. Подтвердите получение до %s.",
			order.Number, order.ConfirmDeadline.Format("02.01.2006 15:04")),
		"order-delivered:"+order.ID, map[string]any{"order_id": order.ID})
	s.systemMessage(order.BuyerID, order.ChatID, "order_status", order.ID, order.Status, "", order.PayAsset)
	s.push(order.BuyerID, "order.status", map[string]any{
		"order_id": order.ID, "status": order.Status,
		"actions": store.OrderActionsRU(order.Status, "buyer")})
	var dto map[string]any
	s.Store.Read(func() { dto = s.orderDTOLocked(order, "shop") })
	httpx.JSON(w, http.StatusOK, dto)
}

func (s *Server) handleOrderDelivery(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	order, fail := s.loadOrderForUser(r, u, "buyer")
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	if order.Status != store.StatusDelivered && order.Status != store.StatusCompleted &&
		order.Status != store.StatusRefunded {
		httpx.Fail(w, r, httpx.Conflict("INVALID_TRANSITION", "выдача ещё не произведена"))
		return
	}
	items := []map[string]any{}
	s.Store.Write(func() {
		for _, item := range order.Items {
			entry := map[string]any{
				"id": item.ID, "title": item.Title, "qty": item.Qty,
				"delivered_at": item.DeliveredAt,
			}
			if item.DeliveredPayloadCT == "" {
				entry["payload"] = nil
				entry["status"] = "not_delivered"
			} else {
				plain, err := s.Crypto.DecryptString(store.DomainMessage, item.ID, item.DeliveredPayloadCT)
				if err != nil {
					entry["payload"] = nil
					entry["status"] = "decrypt_error"
					s.Log.Error("delivery: ошибка расшифровки", "order", order.ID, "item", item.ID, "err", err)
				} else {
					entry["payload"] = plain
					entry["status"] = "delivered"
				}
				item.DownloadCount++
				entry["download_count"] = item.DownloadCount
			}
			items = append(items, entry)
		}
	})
	s.audit(r, u.ID, u.Role, "order.delivery_read", "order", order.ID, "", "", nil, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"order_id": order.ID, "number": order.Number, "status": order.Status,
		"items": items, "warranty_days": s.warrantyOf(order),
	})
}

func (s *Server) warrantyOf(o *store.Order) int {
	for _, it := range o.Items {
		if p, ok := s.Store.Products[it.ProductID]; ok && p.WarrantyDays > 0 {
			return p.WarrantyDays
		}
	}
	return 0
}

// ---------------------------------------------------------------------------
// Списки и история
// ---------------------------------------------------------------------------

func (s *Server) handleListOrders(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	role := q.Get("role")
	if role != "shop" {
		role = "buyer"
	}
	statusFilter := q.Get("status")
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	items := []map[string]any{}
	s.Store.Read(func() {
		orders := s.Store.UserOrdersLocked(u.ID, role == "shop")
		for _, o := range orders {
			if statusFilter != "" && o.Status != statusFilter {
				continue
			}
			items = append(items, s.orderDTOLocked(o, role))
		}
	})
	sort.Slice(items, func(i, j int) bool {
		a, _ := items[i]["created_at"].(time.Time)
		b, _ := items[j]["created_at"].(time.Time)
		return a.After(b)
	})
	start, end, next, hasMore := s.page(len(items), limit, q.Get("cursor"))
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items[start:end], "next_cursor": next, "has_more": hasMore,
		"total": len(items), "role": role,
	})
}

func (s *Server) handleGetOrder(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	var (
		dto  map[string]any
		fail *httpx.APIError
	)
	s.Store.Read(func() {
		o := s.findOrderLocked(id)
		if o == nil {
			fail = httpx.NotFound("заказ не найден")
			return
		}
		sh := s.Store.Shops[o.ShopID]
		role := ""
		switch {
		case o.BuyerID == u.ID:
			role = "buyer"
		case sh != nil && (sh.AdminUserID == u.ID || contains(sh.Operators, u.ID)):
			role = "shop"
		case u.Role == store.RoleArbiter || u.Role == store.RoleSuperAdmin || u.Role == store.RoleModerator:
			role = "arbiter"
		default:
			fail = httpx.NotFound("заказ не найден")
			return
		}
		dto = s.orderDTOLocked(o, role)
		dto["role"] = role
		if role == "buyer" && o.Status == store.StatusDelivered {
			dto["auto_confirm_at"] = o.ConfirmDeadline
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	httpx.JSON(w, http.StatusOK, dto)
}

func (s *Server) handleOrderHistory(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	var (
		items []map[string]any
		fail  *httpx.APIError
	)
	s.Store.Read(func() {
		o := s.findOrderLocked(id)
		if o == nil {
			fail = httpx.NotFound("заказ не найден")
			return
		}
		sh := s.Store.Shops[o.ShopID]
		allowed := o.BuyerID == u.ID || (sh != nil && (sh.AdminUserID == u.ID || contains(sh.Operators, u.ID))) ||
			u.Role == store.RoleArbiter || u.Role == store.RoleSuperAdmin || u.Role == store.RoleModerator
		if !allowed {
			fail = httpx.NotFound("заказ не найден")
			return
		}
		for _, ev := range s.Store.OrderStatuses {
			if ev.OrderID != o.ID {
				continue
			}
			items = append(items, map[string]any{
				"from": ev.From, "to": ev.To, "title": store.StatusTitleRU(ev.To),
				"actor_kind": ev.ActorKind, "reason": ev.Reason, "ts": ev.TS,
			})
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"order_id": id, "items": items})
}

// ---------------------------------------------------------------------------
// Отзыв на заказ (FR-REV-01)
// ---------------------------------------------------------------------------

type reviewCreateRequest struct {
	Rating            int    `json:"rating"`
	RatingDelivery    int    `json:"rating_delivery"`
	RatingDescription int    `json:"rating_description"`
	RatingSupport     int    `json:"rating_support"`
	Body              string `json:"body"`
}

func (s *Server) handleCreateReview(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	order, fail := s.loadOrderForUser(r, u, "buyer")
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	var req reviewCreateRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if req.Rating < 1 || req.Rating > 5 {
		httpx.Fail(w, r, httpx.BadRequest("оценка: 1–5", nil))
		return
	}
	if len([]rune(req.Body)) > 1000 {
		httpx.Fail(w, r, httpx.BadRequest("текст отзыва: до 1000 символов", nil))
		return
	}

	var (
		orderFail *httpx.APIError
		rv        *store.Review
	)
	s.Store.Write(func() {
		if order.Status != store.StatusCompleted && order.Status != store.StatusRefunded {
			orderFail = httpx.Conflict("INVALID_TRANSITION", "отзыв возможен после завершения заказа")
			return
		}
		if order.ReviewID != "" {
			orderFail = httpx.Conflict("ALREADY_USED", "отзыв на этот заказ уже оставлен")
			return
		}
		window := time.Duration(s.Cfg.ReviewWindowDays) * 24 * time.Hour
		if !order.CompletedAt.IsZero() && time.Since(order.CompletedAt) > window {
			orderFail = httpx.Conflict("INVALID_TRANSITION", "окно для отзыва закрыто")
			return
		}
		productID := ""
		if len(order.Items) > 0 {
			productID = order.Items[0].ProductID
		}
		rv = &store.Review{
			ID: ids.New("rev"), OrderID: order.ID, ShopID: order.ShopID, ProductID: productID,
			AuthorID: u.ID, Rating: req.Rating, RatingDelivery: req.RatingDelivery,
			RatingDescription: req.RatingDescription, RatingSupport: req.RatingSupport,
			Body: strings.TrimSpace(req.Body), Verified: true, Status: "published",
			CreatedAt: time.Now().UTC(),
		}
		s.Store.Reviews[rv.ID] = rv
		order.ReviewID = rv.ID
		s.recalcRatingLocked(order.ShopID)
		if p, ok := s.Store.Products[productID]; ok {
			p.RatingSum += int64(req.Rating)
			p.RatingCount++
		}
		s.feedScoresLocked()
	})
	if orderFail != nil {
		httpx.Fail(w, r, orderFail)
		return
	}
	s.audit(r, u.ID, u.Role, "review.create", "review", rv.ID, "order="+order.ID, "", nil,
		map[string]any{"rating": rv.Rating})
	var shop *store.Shop
	s.Store.Read(func() { shop = s.Store.Shops[order.ShopID] })
	if shop != nil {
		s.notify(shop.AdminUserID, "review.new", "Новый отзыв",
			fmt.Sprintf("На заказ %s оставлен отзыв: %d★.", order.Number, rv.Rating),
			"review:"+rv.ID, map[string]any{"review_id": rv.ID, "rating": rv.Rating})
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"review_id": rv.ID, "rating": rv.Rating,
		"shop_rating": s.shopRating(order.ShopID),
	})
}

func (s *Server) shopRating(shopID string) float64 {
	var v float64
	s.Store.Read(func() {
		if sh, ok := s.Store.Shops[shopID]; ok {
			v = round1(sh.RatingBayes)
		}
	})
	return v
}
