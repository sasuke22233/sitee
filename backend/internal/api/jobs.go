package api

import (
	"context"
	"strconv"
	"time"

	"github.com/sasuke22233/sitee/backend/internal/store"
)

// ---------------------------------------------------------------------------
// Фоновые задачи (docs/orders-disputes.md §2, docs/economy.md §4)
//
// В целевой архитектуре это отдельный сервис worker с очередями; в MVP задачи
// выполняются таймером внутри процесса API и идемпотентны (повторный прогон
// не приводит к двойным проводкам — ledger защищён idempotency_key).
// ---------------------------------------------------------------------------

// RunBackground запускает цикл снимков состояния и таймеры бизнес-процессов.
// Возвращается после отмены ctx.
func (s *Server) RunBackground(ctx context.Context) {
	snapshotEvery := s.Cfg.SnapshotInterval
	if snapshotEvery <= 0 {
		snapshotEvery = 30 * time.Second
	}
	snapshots := time.NewTicker(snapshotEvery)
	defer snapshots.Stop()

	jobs := time.NewTicker(30 * time.Second)
	defer jobs.Stop()

	hourly := time.NewTicker(time.Hour)
	defer hourly.Stop()

	// Первый прогон сразу после старта: демо-данные должны «дозреть».
	s.runJobs()

	for {
		select {
		case <-ctx.Done():
			if err := s.Store.SaveSnapshot(); err != nil {
				s.Log.Error("snapshot: сохранение при остановке не удалось", "err", err)
			} else {
				s.Log.Info("snapshot: состояние сохранено при остановке")
			}
			return
		case <-snapshots.C:
			if s.Cfg.DataDir == "" {
				continue
			}
			if err := s.Store.SaveSnapshot(); err != nil {
				s.Log.Error("snapshot: сохранение не удалось", "err", err)
			}
		case <-jobs.C:
			s.runJobs()
		case <-hourly.C:
			removed := s.Limiter.GC(2 * time.Hour)
			s.pruneExpired()
			if removed > 0 {
				s.Log.Debug("ratelimit: GC корзин", "removed", removed)
			}
		}
	}
}

func (s *Server) runJobs() {
	start := time.Now()
	expired := s.expireUnpaidOrders()
	confirmed := s.autoConfirmDelivered()
	overdue := s.notifyDeliveryOverdue()
	escalated := s.autoEscalateOverdue()
	resolved := s.autoResolveOverdue()
	rent := s.runRentLifecycle()
	boosts := s.expireGiftBoosts()
	s.feedRecalc()
	if expired+confirmed+overdue+escalated+resolved+rent+boosts > 0 {
		s.Log.Info("jobs: прогон фоновых задач",
			"expired_orders", expired, "auto_confirmed", confirmed,
			"delivery_overdue", overdue, "disputes_escalated", escalated,
			"disputes_auto_resolved", resolved, "rent_transitions", rent,
			"gift_boosts_expired", boosts, "took_ms", time.Since(start).Milliseconds())
	}
}

func (s *Server) feedRecalc() {
	s.Store.Write(func() { s.feedScoresLocked() })
}

// expireUnpaidOrders закрывает неоплаченные заказы по таймеру оплаты.
func (s *Server) expireUnpaidOrders() int {
	now := time.Now().UTC()
	candidates := []*store.Order{}
	s.Store.Read(func() {
		for _, o := range s.Store.Orders {
			if o.Status != store.StatusAwaitingPayment && o.Status != store.StatusCreated {
				continue
			}
			if !o.PayDeadline.IsZero() && now.After(o.PayDeadline) {
				candidates = append(candidates, o)
			}
		}
	})
	n := 0
	for _, o := range candidates {
		var (
			chatID string
			done   bool
		)
		s.Store.Write(func() {
			if o.Status != store.StatusAwaitingPayment && o.Status != store.StatusCreated {
				return
			}
			if !store.CanTransitionOrder(o.Status, store.StatusExpired) {
				return
			}
			if err := s.transitionLocked(o, store.StatusExpired, "", "timer",
				"истёк срок оплаты ("+strconv.Itoa(s.Cfg.PayTimeoutMinutes)+" мин)"); err != nil {
				return
			}
			s.releaseStockLocked(o)
			chatID = o.ChatID
			done = true
			n++
		})
		if !done {
			continue
		}
		s.notify(o.BuyerID, "order_expired", "Заказ "+o.Number+" отменён",
			"Срок оплаты истёк, товар возвращён в продажу", "order:"+o.ID+":expired",
			map[string]any{"order_id": o.ID})
		for _, t := range s.shopAdmins(o.ShopID) {
			s.notify(t, "order_expired", "Заказ "+o.Number+" не оплачен",
				"Товар снова доступен к продаже", "order:"+o.ID+":expired:"+t, nil)
		}
		s.push(o.BuyerID, "order.updated", map[string]any{
			"order_id": o.ID, "status": store.StatusExpired})
		if chatID != "" {
			s.systemMessage(o.BuyerID, chatID, "order_status", o.ID, store.StatusExpired, "0", o.PayAsset)
		}
	}
	return n
}

// autoConfirmDelivered подтверждает доставку по истечении AutoConfirmHours.
func (s *Server) autoConfirmDelivered() int {
	now := time.Now().UTC()
	candidates := []*store.Order{}
	s.Store.Read(func() {
		for _, o := range s.Store.Orders {
			if o.Status != store.StatusDelivered {
				continue
			}
			if !o.ConfirmDeadline.IsZero() && now.After(o.ConfirmDeadline) {
				candidates = append(candidates, o)
			}
		}
	})
	n := 0
	for _, o := range candidates {
		var (
			txID   string
			chatID string
			done   bool
		)
		s.Store.Write(func() {
			if o.Status != store.StatusDelivered {
				return
			}
			// Автоспор блокирует автоподтверждение.
			if d := s.disputeForOrderLocked(o.ID); d != nil {
				return
			}
			if !store.CanTransitionOrder(o.Status, store.StatusCompleted) {
				return
			}
			if err := s.transitionLocked(o, store.StatusCompleted, "", "timer",
				"автоподтверждение через "+strconv.Itoa(s.Cfg.AutoConfirmHours)+" ч"); err != nil {
				return
			}
			txID = s.releaseEscrowLocked(o, "")
			o.CompletedAt = now
			s.finishOrderStatsLocked(o)
			chatID = o.ChatID
			done = true
			n++
		})
		if !done {
			continue
		}
		s.notify(o.BuyerID, "order_completed", "Заказ "+o.Number+" завершён автоматически",
			"Средства перечислены продавцу. Оставьте отзыв — это помогает другим покупателям.",
			"order:"+o.ID+":completed", map[string]any{"order_id": o.ID, "tx_id": txID})
		for _, t := range s.shopAdmins(o.ShopID) {
			s.notify(t, "order_completed", "Заказ "+o.Number+" завершён",
				"Выручка зачислена на счёт магазина", "order:"+o.ID+":completed:"+t,
				map[string]any{"order_id": o.ID, "tx_id": txID})
		}
		s.pushMany(append([]string{o.BuyerID}, s.shopAdmins(o.ShopID)...), "order.updated",
			map[string]any{"order_id": o.ID, "status": store.StatusCompleted, "tx_id": txID})
		if chatID != "" {
			s.systemMessage(o.BuyerID, chatID, "order_status", o.ID, store.StatusCompleted, "0", o.PayAsset)
		}
	}
	return n
}

// notifyDeliveryOverdue уведомляет о срыве SLA выдачи и возвращает средства,
// если просрочка превысила сутки (docs/orders-disputes.md §2.3).
func (s *Server) notifyDeliveryOverdue() int {
	now := time.Now().UTC()
	candidates := []*store.Order{}
	s.Store.Read(func() {
		for _, o := range s.Store.Orders {
			if o.Status != store.StatusPaidEscrow && o.Status != store.StatusProcessing {
				continue
			}
			if !o.DeliveryDeadline.IsZero() && now.After(o.DeliveryDeadline) {
				candidates = append(candidates, o)
			}
		}
	})
	n := 0
	for _, o := range candidates {
		hoursLate := int(now.Sub(o.DeliveryDeadline).Hours())
		var (
			refunded bool
			txID     string
			amount   int64
			chatID   string
		)
		s.Store.Write(func() {
			if hoursLate < 24 {
				return
			}
			// Просрочка больше суток → автоматический возврат покупателю.
			total := o.TotalLamports
			if o.PayAsset == store.AssetStars {
				total = o.TotalStars
			}
			id, amt, err := s.refundEscrowLocked(o, total, "", "авто-возврат: SLA выдачи нарушен более чем на 24 ч")
			if err != nil {
				s.Log.Error("jobs: авто-возврат не удался", "order", o.ID, "err", err)
				return
			}
			txID, amount = id, amt
			if store.CanTransitionOrder(o.Status, store.StatusRefunded) {
				_ = s.transitionLocked(o, store.StatusRefunded, "", "timer", "нарушен SLA выдачи")
				refunded = true
				s.releaseStockLocked(o)
				chatID = o.ChatID
			}
		})
		if !refunded {
			// Ещё не сутки — только уведомление (идемпотентно по dedup_key).
			s.notify(o.BuyerID, "order_delivery_overdue", "Заказ "+o.Number+": задержка выдачи",
				"Продавец превысил SLA на "+strconv.Itoa(hoursLate)+" ч. Можно отменить заказ с возвратом.",
				"order:"+o.ID+":sla:"+strconv.Itoa(hoursLate/6), map[string]any{"order_id": o.ID})
			for _, t := range s.shopAdmins(o.ShopID) {
				s.notify(t, "order_delivery_overdue", "Заказ "+o.Number+": просрочка выдачи",
					"Через 24 ч средства вернутся покупателю автоматически",
					"order:"+o.ID+":sla:"+strconv.Itoa(hoursLate/6)+":"+t, nil)
			}
			n++
			continue
		}
		s.notify(o.BuyerID, "order_refunded", "Заказ "+o.Number+": возврат средств",
			"Продавец не выдал товар в срок — деньги возвращены", "order:"+o.ID+":refunded",
			map[string]any{"order_id": o.ID, "tx_id": txID})
		for _, t := range s.shopAdmins(o.ShopID) {
			s.notify(t, "order_refunded", "Заказ "+o.Number+": авто-возврат",
				"SLA выдачи нарушен, средства возвращены покупателю", "order:"+o.ID+":refunded:"+t, nil)
		}
		s.push(o.BuyerID, "wallet.updated", map[string]any{"order_id": o.ID, "tx_id": txID, "amount": amount})
		if chatID != "" {
			s.systemMessage(o.BuyerID, chatID, "order_status", o.ID, store.StatusRefunded,
				strconv.FormatInt(amount, 10), o.PayAsset)
		}
		n++
	}
	return n
}

// runRentLifecycle ведёт жизненный цикл аренды:
// trial/active → expiring → grace(72 ч) → suspended (docs/economy.md §4).
func (s *Server) runRentLifecycle() int {
	now := time.Now().UTC()
	type change struct {
		shopID  string
		adminID string
		from    string
		to      string
		name    string
		end     time.Time
	}
	changes := []change{}

	s.Store.Write(func() {
		for shopID, sub := range s.Store.Subs {
			sh := s.Store.Shops[shopID]
			if sh == nil {
				continue
			}
			from := sub.Status
			switch sub.Status {
			case store.RentTrial, store.RentActive, store.RentExpiring:
				if sub.PeriodEnd.IsZero() {
					continue
				}
				// Автопродление при включённом флаге и достаточном балансе.
				if sub.AutoRenew && now.After(sub.PeriodEnd) {
					if s.tryAutoRenewLocked(sh, sub, now) {
						changes = append(changes, change{shopID, sh.AdminUserID, from, store.RentActive,
							sh.Name, sub.PeriodEnd})
						continue
					}
					sub.AutoRenew = false
				}
				if now.Add(72 * time.Hour).After(sub.PeriodEnd) && sub.Status != store.RentExpiring {
					sub.Status = store.RentExpiring
				}
				if now.After(sub.PeriodEnd) {
					sub.Status = store.RentGrace
					sub.GraceEnd = now.Add(72 * time.Hour)
				}
			case store.RentGrace:
				if !sub.GraceEnd.IsZero() && now.After(sub.GraceEnd) {
					sub.Status = store.RentSuspended
					sh.Status = store.ShopSuspended
				}
			}
			if sub.Status != from {
				sub.UpdatedAt = now
				sh.UpdatedAt = now
				changes = append(changes, change{shopID, sh.AdminUserID, from, sub.Status, sh.Name, sub.PeriodEnd})
			}
		}
		s.feedScoresLocked()
	})

	for _, c := range changes {
		title, body := rentTransitionText(c.from, c.to, c.name, c.end)
		s.notify(c.adminID, "rent_"+c.to, title, body, "rent:"+c.shopID+":"+c.to+":"+c.end.Format(time.RFC3339),
			map[string]any{"shop_id": c.shopID, "from": c.from, "to": c.to})
		s.push(c.adminID, "rent.updated", map[string]any{
			"shop_id": c.shopID, "status": c.to, "period_end": c.end})
	}
	return len(changes)
}

// tryAutoRenewLocked списывает аренду с баланса админа и продлевает период.
func (s *Server) tryAutoRenewLocked(sh *store.Shop, sub *store.RentSub, now time.Time) bool {
	plan := s.Store.RentPlans[sub.PlanID]
	if plan == nil {
		return false
	}
	asset := sub.Asset
	if asset == "" {
		asset = store.AssetSOL
	}
	price := plan.PriceLamports
	if asset == store.AssetStars {
		price = plan.PriceStars
	}
	if price <= 0 {
		return false
	}
	if s.Store.UserBalanceLocked(sh.AdminUserID, asset) < price {
		return false
	}
	s.Store.EnsureAccountLocked(store.OwnerUser, sh.AdminUserID, asset)
	s.Store.EnsureAccountLocked(store.OwnerPlatform, store.PlatformRent, asset)
	txID, err := s.Store.PostLocked("rent:auto:"+sh.ID+":"+sub.PeriodEnd.Format(time.RFC3339),
		asset, store.KindRent, "shop", sh.ID, sh.AdminUserID, []store.Posting{
			store.Debit(store.UserAccount(sh.AdminUserID, asset), price),
			store.Credit(store.PlatformAccount(store.PlatformRent, asset), price),
		})
	if err != nil {
		s.Log.Warn("jobs: автопродление аренды не удалось", "shop", sh.ID, "err", err)
		return false
	}
	sub.PeriodStart = now
	sub.PeriodEnd = now.AddDate(0, 1, 0)
	sub.Status = store.RentActive
	sub.GraceEnd = time.Time{}
	sub.RenewAttempts++
	sub.PriceLamports = plan.PriceLamports
	sub.PriceStars = plan.PriceStars
	sh.Status = store.ShopActive
	s.Log.Info("jobs: аренда продлена автоматически", "shop", sh.ID, "tx", txID, "until", sub.PeriodEnd)
	return true
}

func rentTransitionText(from, to, shopName string, end time.Time) (string, string) {
	switch to {
	case store.RentExpiring:
		return "Аренда магазина истекает",
			shopName + ": период до " + end.Format("02.01.2006 15:04") +
				". Продлите, чтобы сохранить место в ленте."
	case store.RentGrace:
		return "Grace-период аренды (72 часа)",
			shopName + ": оплата не прошла. Магазин останется в ленте ещё 72 часа."
	case store.RentSuspended:
		return "Магазин приостановлен",
			shopName + " скрыт из ленты: аренда не продлена. Оплатите тариф, чтобы вернуть магазин."
	case store.RentActive:
		return "Аренда продлена",
			shopName + ": новый период до " + end.Format("02.01.2006") + "."
	}
	return "Статус аренды изменён", shopName + ": " + from + " → " + to
}

// expireGiftBoosts снимает истёкшие бусты от подарков (docs/economy.md §5.4).
func (s *Server) expireGiftBoosts() int {
	now := time.Now().UTC()
	n := 0
	s.Store.Write(func() {
		for _, sh := range s.Store.Shops {
			if sh.GiftBoost > 0 && !sh.GiftBoostUntil.IsZero() && now.After(sh.GiftBoostUntil) {
				sh.GiftBoost = 0
				sh.GiftBoostUntil = time.Time{}
				n++
			}
			// Санкции с истекающим сроком снимаются автоматически.
			if sh.SanctionLevel != "" && sh.SanctionLevel != "none" &&
				!sh.SanctionUntil.IsZero() && now.After(sh.SanctionUntil) {
				sh.SanctionLevel = "none"
				sh.SanctionReason = ""
				if sh.Status == store.ShopFrozen {
					sh.Status = store.ShopActive
				}
				n++
			}
		}
	})
	return n
}

// pruneExpired удаляет истёкшие регистрации, сессии, refresh-токены и котировки.
func (s *Server) pruneExpired() {
	now := time.Now().UTC()
	s.Store.Write(func() {
		for id, e := range s.Store.Enrollments {
			if now.After(e.ExpiresAt) {
				delete(s.Store.Enrollments, id)
			}
		}
		for id, sess := range s.Store.Sessions {
			if now.After(sess.ExpiresAt.Add(24 * time.Hour)) {
				delete(s.Store.Sessions, id)
			}
		}
		for hash, rt := range s.Store.Refresh {
			if now.After(rt.ExpiresAt.Add(24 * time.Hour)) {
				delete(s.Store.Refresh, hash)
			}
		}
		for id, q := range s.Store.Quotes {
			if now.After(q.ValidUntil.Add(time.Hour)) {
				delete(s.Store.Quotes, id)
			}
		}
		for id, pk := range s.Store.Prekeys {
			if now.After(pk.CreatedAt.Add(90 * 24 * time.Hour)) && len(pk.OneTimeKeys) == 0 {
				delete(s.Store.Prekeys, id)
			}
		}
		// Анти-replay кэш TOTP: убираем давно истёкшие коды.
		for _, u := range s.Store.Users {
			for _, f := range u.Factors {
				for code, expiry := range f.UsedCodes {
					if expiry < now.Unix() {
						delete(f.UsedCodes, code)
					}
				}
			}
		}
	})
}
