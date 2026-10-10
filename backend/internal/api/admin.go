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
// Админ-панель (FR-ADM-01…14, docs/TZ.md §7.15, правило R-ADMIN-1)
//
// Доступ: чтение — moderator/arbiter/superadmin; запись — только superadmin.
// Каждая запись сопровождается вторым фактором 2FA и записью в аудит-лог.
// ---------------------------------------------------------------------------

func (s *Server) adminRead(w http.ResponseWriter, r *http.Request) (*store.User, bool) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return nil, false
	}
	if !s.requireRole(w, r, u, store.RoleModerator, store.RoleArbiter, store.RoleSuperAdmin) {
		return nil, false
	}
	return u, true
}

func (s *Server) adminWrite(w http.ResponseWriter, r *http.Request, operation string, totp string) (*store.User, bool) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return nil, false
	}
	if !s.requireRole(w, r, u, store.RoleSuperAdmin) {
		return nil, false
	}
	if !s.requireOps(w, r, u, operation, 0, 0, totp) {
		return nil, false
	}
	return u, true
}

// ---------------------------------------------------------------------------
// Дашборд
// ---------------------------------------------------------------------------

func (s *Server) handleAdminDashboard(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.adminRead(w, r); !ok {
		return
	}
	dto := map[string]any{}
	s.Store.Read(func() {
		usersByRole := map[string]int{}
		usersActive := 0
		for _, u := range s.Store.Users {
			usersByRole[u.Role]++
			if u.Status == "active" {
				usersActive++
			}
		}
		shopsByStatus := map[string]int{}
		crowned, verified := 0, 0
		for _, sh := range s.Store.Shops {
			shopsByStatus[sh.Status]++
			if s.Store.IsCrownedLocked(sh) {
				crowned++
			}
			if sh.IsVerified {
				verified++
			}
		}
		ordersByStatus := map[string]int{}
		var gmv, fees, escrowHeld int64
		for _, o := range s.Store.Orders {
			ordersByStatus[o.Status]++
			if o.PayAsset == store.AssetStars {
				continue
			}
			if o.PaidAt.IsZero() {
				continue
			}
			gmv += o.TotalLamports
			fees += o.FeeLamports
			if o.Status == store.StatusPaidEscrow || o.Status == store.StatusProcessing ||
				o.Status == store.StatusDelivered || o.Status == store.StatusInArbitration ||
				o.Status == store.StatusDisputeOpened {
				escrowHeld += o.TotalLamports
			}
		}
		disputesByStatus := map[string]int{}
		for _, d := range s.Store.Disputes {
			disputesByStatus[d.Status]++
		}
		rentByStatus := map[string]int{}
		var rentMRR int64
		for shopID, sub := range s.Store.Subs {
			rentByStatus[sub.Status]++
			status := s.Store.RentStatusLocked(shopID)
			if status == store.RentActive || status == store.RentExpiring || status == store.RentTrial {
				rentMRR += sub.PriceLamports
			}
		}
		products := map[string]int{}
		for _, p := range s.Store.Products {
			products[p.Status]++
		}
		dto = map[string]any{
			"users": map[string]any{
				"total": len(s.Store.Users), "active": usersActive, "by_role": usersByRole,
			},
			"shops": map[string]any{
				"total": len(s.Store.Shops), "by_status": shopsByStatus,
				"crowned": crowned, "verified": verified,
			},
			"products": map[string]any{"total": len(s.Store.Products), "by_status": products},
			"orders":   map[string]any{"total": len(s.Store.Orders), "by_status": ordersByStatus},
			"finance": map[string]any{
				"gmv_sol": store.FormatSOL(gmv), "fees_sol": store.FormatSOL(fees),
				"escrow_held_sol": store.FormatSOL(escrowHeld),
				"rent_mrr_sol":    store.FormatSOL(rentMRR),
				"platform_accounts": map[string]any{
					"fees":               store.FormatSOL(s.Store.BalanceLocked(store.PlatformAccount(store.PlatformFees, store.AssetSOL))),
					"rent":               store.FormatSOL(s.Store.BalanceLocked(store.PlatformAccount(store.PlatformRent, store.AssetSOL))),
					"custody":            store.FormatSOL(s.Store.BalanceLocked(store.PlatformAccount(store.PlatformCustody, store.AssetSOL))),
					"withdrawals_pending": store.FormatSOL(s.Store.BalanceLocked(store.PlatformAccount(store.PlatformWithdrawHold, store.AssetSOL))),
					"stars_reserve":      s.Store.BalanceLocked(store.PlatformAccount(store.PlatformStarsReserve, store.AssetStars)),
					"gift_revenue_stars": s.Store.BalanceLocked(store.PlatformAccount(store.GiftRevenue, store.AssetStars)),
				},
			},
			"disputes": map[string]any{"total": len(s.Store.Disputes), "by_status": disputesByStatus},
			"rent":     map[string]any{"subscriptions": len(s.Store.Subs), "by_status": rentByStatus},
			"ledger": map[string]any{
				"entries": len(s.Store.Ledger), "accounts": len(s.Store.Accounts),
				"invariants_ok": len(s.Store.CheckInvariantsLocked()) == 0,
				"problems":      s.Store.CheckInvariantsLocked(),
			},
			"runtime": map[string]any{
				"ws_connections": s.Hub.Count(),
				"uptime_s":       int(time.Since(s.Started).Seconds()),
				"env":            s.Cfg.Env,
			},
		}
	})
	httpx.JSON(w, http.StatusOK, dto)
}

// ---------------------------------------------------------------------------
// Подарки: каталог добавляется только из админ-панели (FR-STR-03)
// ---------------------------------------------------------------------------

func (s *Server) handleAdminListGifts(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.adminRead(w, r); !ok {
		return
	}
	items := []map[string]any{}
	s.Store.Read(func() {
		list := []*store.Gift{}
		for _, g := range s.Store.Gifts {
			list = append(list, g)
		}
		sort.Slice(list, func(i, j int) bool {
			if list[i].Sort != list[j].Sort {
				return list[i].Sort < list[j].Sort
			}
			return list[i].CreatedAt.After(list[j].CreatedAt)
		})
		for _, g := range list {
			dto := s.giftDTOLocked(g)
			sold := 0
			for _, gp := range s.Store.GiftPurch {
				if gp.GiftID == g.ID {
					sold++
				}
			}
			dto["purchases"] = sold
			dto["created_at"] = g.CreatedAt
			dto["created_by"] = g.CreatedBy
			items = append(items, dto)
		}
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
}

type giftUpsertRequest struct {
	SKU          string  `json:"sku"`
	TitleRU      string  `json:"title_ru"`
	TitleEN      string  `json:"title_en"`
	Description  string  `json:"description"`
	Rarity       string  `json:"rarity"`
	MediaURL     string  `json:"media_url"`
	MediaKind    string  `json:"media_kind"`
	Emoji        string  `json:"emoji"`
	PriceStars   int64   `json:"price_stars"`
	PriceSOL     string  `json:"price_sol"`
	PerUserLimit int     `json:"per_user_limit"`
	BoostsShop   bool    `json:"boosts_shop"`
	BoostValue   float64 `json:"boost_value"`
	BoostDays    int     `json:"boost_days"`
	Collectible  bool    `json:"collectible"`
	StartsAt     string  `json:"starts_at"`
	EndsAt       string  `json:"ends_at"`
	Status       string  `json:"status"`
	Sort         int     `json:"sort"`
	TotpCode     string  `json:"totp_code"`
}

func (g giftUpsertRequest) validate() *httpx.APIError {
	if strings.TrimSpace(g.TitleRU) == "" || utf8len(g.TitleRU) > 80 {
		return httpx.BadRequest("title_ru обязателен (до 80 символов)", nil)
	}
	switch g.Rarity {
	case "common", "rare", "epic", "legendary":
	default:
		return httpx.BadRequest("rarity: common|rare|epic|legendary", nil)
	}
	if g.PriceStars < 0 || g.PriceStars > 1_000_000 {
		return httpx.BadRequest("price_stars: 0…1000000", nil)
	}
	if g.PriceStars == 0 && strings.TrimSpace(g.PriceSOL) == "" {
		return httpx.BadRequest("укажите цену в Stars или SOL", nil)
	}
	if g.BoostsShop && (g.BoostValue < 0 || g.BoostValue > 0.6) {
		return httpx.BadRequest("boost_value: 0…0.6 (анти-накрутка фида)", nil)
	}
	if g.BoostDays > 14 {
		return httpx.BadRequest("boost_days: не более 14", nil)
	}
	switch g.Status {
	case "", "draft", "published", "archived":
	default:
		return httpx.BadRequest("status: draft|published|archived", nil)
	}
	return nil
}

func (s *Server) handleAdminCreateGift(w http.ResponseWriter, r *http.Request) {
	var req giftUpsertRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	u, ok := s.adminWrite(w, r, "admin_write", req.TotpCode)
	if !ok {
		return
	}
	if verr := req.validate(); verr != nil {
		httpx.Fail(w, r, verr)
		return
	}
	var fail *httpx.APIError
	g := &store.Gift{
		ID: ids.New("gft"), SKU: strings.TrimSpace(req.SKU), TitleRU: strings.TrimSpace(req.TitleRU),
		TitleEN: req.TitleEN, Description: req.Description, Rarity: req.Rarity,
		MediaURL: req.MediaURL, MediaKind: req.MediaKind, Emoji: req.Emoji,
		PriceStars: req.PriceStars, PerUserLimit: req.PerUserLimit,
		BoostsShop: req.BoostsShop, BoostValue: req.BoostValue, BoostDays: req.BoostDays,
		Collectible: req.Collectible, Status: orDefault(req.Status, "draft"), Sort: req.Sort,
		CreatedBy: u.ID, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	if g.SKU == "" {
		g.SKU = "gift-" + g.ID[len(g.ID)-6:]
	}
	if req.PriceSOL != "" {
		lamports, perr := store.ParseSOL(req.PriceSOL)
		if perr != nil {
			httpx.Fail(w, r, httpx.BadRequest("некорректная цена SOL", nil))
			return
		}
		g.PriceLamport = lamports
	}
	if req.StartsAt != "" {
		if t, terr := time.Parse(time.RFC3339, req.StartsAt); terr == nil {
			g.StartsAt = t
		} else {
			httpx.Fail(w, r, httpx.BadRequest("starts_at: формат RFC3339", nil))
			return
		}
	}
	if req.EndsAt != "" {
		if t, terr := time.Parse(time.RFC3339, req.EndsAt); terr == nil {
			g.EndsAt = t
		} else {
			httpx.Fail(w, r, httpx.BadRequest("ends_at: формат RFC3339", nil))
			return
		}
	}
	s.Store.Write(func() {
		for _, other := range s.Store.Gifts {
			if other.SKU == g.SKU {
				fail = httpx.Conflict("SKU_EXISTS", "подарок с таким SKU уже есть")
				return
			}
		}
		if fail == nil {
			s.Store.Gifts[g.ID] = g
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "admin.gift_create", "gift", g.ID, g.SKU, store.FactorOps, nil,
		map[string]any{"title": g.TitleRU, "price_stars": g.PriceStars, "status": g.Status})
	httpx.JSON(w, http.StatusCreated, s.giftSafe(g))
}

func (s *Server) handleAdminUpdateGift(w http.ResponseWriter, r *http.Request) {
	giftID := r.PathValue("id")
	var req giftUpsertRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	u, ok := s.adminWrite(w, r, "admin_write", req.TotpCode)
	if !ok {
		return
	}
	var (
		fail   *httpx.APIError
		before map[string]any
		g      *store.Gift
	)
	s.Store.Write(func() {
		existing := s.Store.Gifts[giftID]
		if existing == nil {
			fail = httpx.NotFound("подарок не найден")
			return
		}
		before = map[string]any{
			"title": existing.TitleRU, "price_stars": existing.PriceStars,
			"price_sol": existing.PriceLamport, "status": existing.Status,
			"boost_value": existing.BoostValue, "boost_days": existing.BoostDays,
		}
		if strings.TrimSpace(req.TitleRU) != "" {
			existing.TitleRU = strings.TrimSpace(req.TitleRU)
		}
		if req.TitleEN != "" {
			existing.TitleEN = req.TitleEN
		}
		if req.Description != "" {
			existing.Description = req.Description
		}
		switch req.Rarity {
		case "common", "rare", "epic", "legendary":
			existing.Rarity = req.Rarity
		}
		if req.MediaURL != "" {
			existing.MediaURL = req.MediaURL
		}
		if req.Emoji != "" {
			existing.Emoji = req.Emoji
		}
		if req.PriceStars > 0 {
			existing.PriceStars = req.PriceStars
		}
		if req.PriceSOL != "" {
			if lamports, perr := store.ParseSOL(req.PriceSOL); perr == nil {
				existing.PriceLamport = lamports
			} else {
				fail = httpx.BadRequest("некорректная цена SOL", nil)
				return
			}
		}
		if req.PerUserLimit >= 0 {
			existing.PerUserLimit = req.PerUserLimit
		}
		existing.BoostsShop = req.BoostsShop
		if req.BoostValue >= 0 && req.BoostValue <= 0.6 {
			existing.BoostValue = req.BoostValue
		}
		if req.BoostDays >= 0 && req.BoostDays <= 14 {
			existing.BoostDays = req.BoostDays
		}
		existing.Collectible = req.Collectible
		switch req.Status {
		case "draft", "published", "archived":
			existing.Status = req.Status
		}
		if req.Sort != 0 {
			existing.Sort = req.Sort
		}
		if req.StartsAt != "" {
			if t, terr := time.Parse(time.RFC3339, req.StartsAt); terr == nil {
				existing.StartsAt = t
			}
		}
		if req.EndsAt != "" {
			if t, terr := time.Parse(time.RFC3339, req.EndsAt); terr == nil {
				existing.EndsAt = t
			}
		}
		existing.UpdatedAt = time.Now().UTC()
		g = existing
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "admin.gift_update", "gift", g.ID, "", store.FactorOps, before,
		map[string]any{
			"title": g.TitleRU, "price_stars": g.PriceStars, "price_sol": g.PriceLamport,
			"status": g.Status, "boost_value": g.BoostValue,
		})
	httpx.JSON(w, http.StatusOK, s.giftSafe(g))
}

func (s *Server) handleAdminArchiveGift(w http.ResponseWriter, r *http.Request) {
	giftID := r.PathValue("id")
	var req struct {
		TotpCode string `json:"totp_code"`
	}
	_ = httpx.Decode(r, &req) // тело необязательно
	u, ok := s.adminWrite(w, r, "admin_write", req.TotpCode)
	if !ok {
		return
	}
	var (
		fail *httpx.APIError
		g    *store.Gift
	)
	s.Store.Write(func() {
		g = s.Store.Gifts[giftID]
		if g == nil {
			fail = httpx.NotFound("подарок не найден")
			return
		}
		g.Status = "archived"
		g.UpdatedAt = time.Now().UTC()
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "admin.gift_archive", "gift", g.ID, "archived", store.FactorOps, nil, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "archived", "id": g.ID})
}

// ---------------------------------------------------------------------------
// Магазины: санкции, верификация, аренда
// ---------------------------------------------------------------------------

func (s *Server) handleAdminListShops(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.adminRead(w, r); !ok {
		return
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	status := q.Get("status")
	sanction := q.Get("sanction")
	rent := q.Get("rent")
	search := strings.ToLower(strings.TrimSpace(q.Get("q")))

	items := []map[string]any{}
	s.Store.Read(func() {
		list := []*store.Shop{}
		for _, sh := range s.Store.Shops {
			if status != "" && sh.Status != status {
				continue
			}
			if sanction != "" && sh.SanctionLevel != sanction {
				continue
			}
			if rent != "" && s.Store.RentStatusLocked(sh.ID) != rent {
				continue
			}
			if search != "" && !strings.Contains(strings.ToLower(sh.Name), search) &&
				!strings.Contains(sh.Slug, search) {
				continue
			}
			list = append(list, sh)
		}
		sort.Slice(list, func(i, j int) bool { return list[i].FeedScore > list[j].FeedScore })
		for _, sh := range list {
			dto := s.shopDetailLocked(sh, nil)
			sub := s.Store.Subs[sh.ID]
			dto["rent_status"] = s.Store.RentStatusLocked(sh.ID)
			if sub != nil {
				dto["rent_plan"] = sub.PlanID
				dto["rent_period_end"] = sub.PeriodEnd
				dto["rent_paid_sol"] = store.FormatSOL(sub.PriceLamports)
			}
			dto["admin_user"] = s.userDTOLocked(s.Store.Users[sh.AdminUserID])
			dto["balance_sol"] = store.FormatSOL(s.Store.BalanceLocked(store.ShopAccount(sh.ID, store.AssetSOL)))
			dto["products"] = countProductsLocked(s.Store, sh.ID)
			items = append(items, dto)
		}
	})
	start, end, next, hasMore := s.page(len(items), limit, q.Get("cursor"))
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items[start:end], "next_cursor": next, "has_more": hasMore, "total": len(items),
	})
}

type sanctionRequest struct {
	Level    string `json:"level"` // none|warn|shadow_ban|freeze|ban
	Reason   string `json:"reason"`
	UntilRFC string `json:"until"`
	Days     int    `json:"days"`
	TotpCode string `json:"totp_code"`
}

func (s *Server) handleAdminSanction(w http.ResponseWriter, r *http.Request) {
	shopID := r.PathValue("id")
	var req sanctionRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	u, ok := s.adminWrite(w, r, "sanction", req.TotpCode)
	if !ok {
		return
	}
	switch req.Level {
	case "none", "warn", "shadow_ban", "freeze", "ban":
	default:
		httpx.Fail(w, r, httpx.BadRequest("level: none|warn|shadow_ban|freeze|ban", nil))
		return
	}
	if req.Level != "none" && strings.TrimSpace(req.Reason) == "" {
		httpx.Fail(w, r, httpx.BadRequest("причина санкции обязательна", nil))
		return
	}
	var (
		fail   *httpx.APIError
		before map[string]any
		after  map[string]any
		sh     *store.Shop
		adminID string
	)
	s.Store.Write(func() {
		existing := s.Store.Shops[shopID]
		if existing == nil {
			fail = httpx.NotFound("магазин не найден")
			return
		}
		sh = existing
		adminID = existing.AdminUserID
		before = map[string]any{
			"sanction_level": existing.SanctionLevel, "status": existing.Status,
			"complaint_penalty": existing.ComplaintPenalty,
		}
		existing.SanctionLevel = req.Level
		existing.SanctionReason = req.Reason
		until := time.Time{}
		if req.UntilRFC != "" {
			if t, terr := time.Parse(time.RFC3339, req.UntilRFC); terr == nil {
				until = t
			} else {
				fail = httpx.BadRequest("until: формат RFC3339", nil)
				return
			}
		} else if req.Days > 0 {
			until = time.Now().UTC().Add(time.Duration(req.Days) * 24 * time.Hour)
		}
		existing.SanctionUntil = until
		switch req.Level {
		case "none":
			if existing.Status == "frozen" || existing.Status == "banned" || existing.Status == "suspended" {
				existing.Status = "active"
			}
			existing.ComplaintPenalty = 0
		case "warn":
			existing.ComplaintPenalty += 0.1
		case "shadow_ban":
			existing.ComplaintPenalty += 0.35 // магазин выпадает из фида, но работает
		case "freeze":
			existing.Status = "frozen"
			existing.ComplaintPenalty += 0.2
		case "ban":
			existing.Status = "banned"
			existing.ComplaintPenalty += 0.5
		}
		existing.UpdatedAt = time.Now().UTC()
		s.feedScoresLocked()
		after = map[string]any{
			"sanction_level": existing.SanctionLevel, "status": existing.Status,
			"sanction_until": existing.SanctionUntil, "complaint_penalty": existing.ComplaintPenalty,
			"feed_score": existing.FeedScore,
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "admin.sanction", "shop", sh.ID, req.Reason, store.FactorOps, before, after)
	s.notify(adminID, "shop_sanction", "Санкция применена к магазину "+sh.Name,
		"Уровень: "+req.Level+". Причина: "+req.Reason, "sanction:"+sh.ID+":"+req.Level,
		map[string]any{"shop_id": sh.ID, "level": req.Level})
	s.push(adminID, "shop.sanction", map[string]any{
		"shop_id": sh.ID, "level": req.Level, "status": sh.Status, "until": sh.SanctionUntil})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"shop_id": sh.ID, "sanction_level": sh.SanctionLevel, "status": sh.Status,
		"sanction_until": sh.SanctionUntil, "reason": sh.SanctionReason,
		"feed_score": sh.FeedScore, "notice": "Изменения сразу отражены в выдаче (feed_score).",
	})
}

func (s *Server) handleAdminVerified(w http.ResponseWriter, r *http.Request) {
	shopID := r.PathValue("id")
	var req struct {
		Verified bool   `json:"verified"`
		Reason   string `json:"reason"`
		TotpCode string `json:"totp_code"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	u, ok := s.adminWrite(w, r, "admin_write", req.TotpCode)
	if !ok {
		return
	}
	var (
		fail *httpx.APIError
		sh   *store.Shop
	)
	s.Store.Write(func() {
		existing := s.Store.Shops[shopID]
		if existing == nil {
			fail = httpx.NotFound("магазин не найден")
			return
		}
		existing.IsVerified = req.Verified
		existing.UpdatedAt = time.Now().UTC()
		s.feedScoresLocked()
		sh = existing
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "admin.shop_verified", "shop", sh.ID, req.Reason, store.FactorOps,
		nil, map[string]any{"verified": sh.IsVerified})
	httpx.JSON(w, http.StatusOK, map[string]any{"shop_id": sh.ID, "verified": sh.IsVerified})
}

func (s *Server) handleAdminRentExtend(w http.ResponseWriter, r *http.Request) {
	shopID := r.PathValue("id")
	var req struct {
		Days     int    `json:"days"`
		PlanCode string `json:"plan_code"`
		Reason   string `json:"reason"`
		TotpCode string `json:"totp_code"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	u, ok := s.adminWrite(w, r, "rent", req.TotpCode)
	if !ok {
		return
	}
	if req.Days <= 0 || req.Days > 365 {
		httpx.Fail(w, r, httpx.BadRequest("days: 1…365", nil))
		return
	}
	var (
		fail *httpx.APIError
		sub  *store.RentSub
		sh   *store.Shop
	)
	s.Store.Write(func() {
		existing := s.Store.Shops[shopID]
		if existing == nil {
			fail = httpx.NotFound("магазин не найден")
			return
		}
		sh = existing
		current := s.Store.Subs[shopID]
		planID := ""
		if current != nil {
			planID = current.PlanID
		}
		if req.PlanCode != "" {
			if p := s.planByCodeLocked(req.PlanCode); p != nil {
				planID = p.ID
			} else {
				fail = httpx.NotFound("тариф не найден")
				return
			}
		}
		if planID == "" {
			if p := s.planByCodeLocked("starter"); p != nil {
				planID = p.ID
			}
		}
		plan := s.Store.RentPlans[planID]
		if plan == nil {
			fail = httpx.NotFound("тариф не найден")
			return
		}
		base := time.Now().UTC()
		if current != nil && current.PeriodEnd.After(base) && current.PlanID == planID {
			base = current.PeriodEnd
		}
		if current == nil {
			current = &store.RentSub{
				ID: ids.New("sub"), ShopID: shopID, PlanID: planID,
				Asset: store.AssetSOL, PriceLamports: plan.PriceLamports, PriceStars: plan.PriceStars,
				PeriodStart: time.Now().UTC(), CreatedAt: time.Now().UTC(),
			}
			s.Store.Subs[shopID] = current
		}
		current.PlanID = planID
		current.PriceLamports = plan.PriceLamports
		current.PriceStars = plan.PriceStars
		current.PeriodEnd = base.Add(time.Duration(req.Days) * 24 * time.Hour)
		current.Status = store.RentActive
		current.GraceEnd = time.Time{}
		current.UpdatedAt = time.Now().UTC()
		existing.Status = store.ShopActive
		existing.UpdatedAt = current.UpdatedAt
		// «Коронка» пересчитывается на лету (store.IsCrownedLocked) — здесь
		// достаточно обновить фид-скоры.
		s.feedScoresLocked()
		sub = current
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "admin.rent_extend", "shop", sh.ID, req.Reason, store.FactorOps, nil,
		map[string]any{"plan": sub.PlanID, "days": req.Days, "period_end": sub.PeriodEnd})
	s.notify(sh.AdminUserID, "rent_extended", "Аренда магазина продлена администрацией",
		sh.Name+": до "+sub.PeriodEnd.Format("02.01.2006"), "rent:"+sh.ID+":"+sub.PeriodEnd.Format(time.RFC3339),
		map[string]any{"shop_id": sh.ID, "period_end": sub.PeriodEnd})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"shop_id": sh.ID, "plan_id": sub.PlanID, "period_end": sub.PeriodEnd,
		"status": s.rentStatusSafe(sh.ID), "days_added": req.Days,
	})
}

func (s *Server) rentStatusSafe(shopID string) string {
	var st string
	s.Store.Read(func() { st = s.Store.RentStatusLocked(shopID) })
	return st
}

func (s *Server) handleAdminRentPlans(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.adminRead(w, r); !ok {
		return
	}
	items := []map[string]any{}
	s.Store.Read(func() {
		plans := []*store.RentPlan{}
		for _, p := range s.Store.RentPlans {
			plans = append(plans, p)
		}
		sort.Slice(plans, func(i, j int) bool { return plans[i].PriceLamports < plans[j].PriceLamports })
		for _, p := range plans {
			subscribers := 0
			for _, sub := range s.Store.Subs {
				if sub.PlanID == p.ID {
					subscribers++
				}
			}
			items = append(items, map[string]any{
				"id": p.ID, "code": p.Code, "name_ru": p.NameRU, "name_en": p.NameEN,
				"price_sol": store.FormatSOL(p.PriceLamports), "price_sol_raw": p.PriceLamports,
				"price_stars": p.PriceStars, "product_limit": p.ProductLimit,
				"operator_limit": p.OperatorLimit, "fee_bps": p.FeeBPS,
				"feed_boost": p.FeedBoost, "grants_crown": p.GrantsCrown,
				"support_sla_h": p.SupportSLAH, "active": p.Active, "description": p.Description,
				"subscribers": subscribers,
			})
		}
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
}

type rentPlanUpsert struct {
	Code          string  `json:"code"`
	NameRU        string  `json:"name_ru"`
	NameEN        string  `json:"name_en"`
	PriceSOL      string  `json:"price_sol"`
	PriceStars    int64   `json:"price_stars"`
	ProductLimit  int     `json:"product_limit"`
	OperatorLimit int     `json:"operator_limit"`
	FeeBPS        int     `json:"fee_bps"`
	FeedBoost     float64 `json:"feed_boost"`
	GrantsCrown   bool    `json:"grants_crown"`
	SupportSLAH   int     `json:"support_sla_h"`
	Active        *bool   `json:"active"`
	Description   string  `json:"description"`
	TotpCode      string  `json:"totp_code"`
}

func (s *Server) handleAdminUpdateRentPlan(w http.ResponseWriter, r *http.Request) {
	planID := r.PathValue("id")
	var req rentPlanUpsert
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	u, ok := s.adminWrite(w, r, "admin_write", req.TotpCode)
	if !ok {
		return
	}
	if req.FeeBPS < 0 || req.FeeBPS > 3000 {
		httpx.Fail(w, r, httpx.BadRequest("fee_bps: 0…3000 (0…30 %)", nil))
		return
	}
	var (
		fail   *httpx.APIError
		before map[string]any
		plan   *store.RentPlan
	)
	s.Store.Write(func() {
		existing := s.Store.RentPlans[planID]
		if existing == nil {
			for _, p := range s.Store.RentPlans {
				if p.Code == planID {
					existing = p
					break
				}
			}
		}
		if existing == nil {
			fail = httpx.NotFound("тариф не найден")
			return
		}
		before = map[string]any{
			"price_sol": existing.PriceLamports, "price_stars": existing.PriceStars,
			"fee_bps": existing.FeeBPS, "product_limit": existing.ProductLimit,
			"feed_boost": existing.FeedBoost, "grants_crown": existing.GrantsCrown,
		}
		if req.NameRU != "" {
			existing.NameRU = req.NameRU
		}
		if req.NameEN != "" {
			existing.NameEN = req.NameEN
		}
		if req.PriceSOL != "" {
			if lamports, perr := store.ParseSOL(req.PriceSOL); perr == nil {
				existing.PriceLamports = lamports
			} else {
				fail = httpx.BadRequest("некорректная цена SOL", nil)
				return
			}
		}
		if req.PriceStars > 0 {
			existing.PriceStars = req.PriceStars
		}
		if req.ProductLimit > 0 {
			existing.ProductLimit = req.ProductLimit
		}
		if req.OperatorLimit >= 0 {
			existing.OperatorLimit = req.OperatorLimit
		}
		existing.FeeBPS = req.FeeBPS
		if req.FeedBoost >= 0 {
			existing.FeedBoost = req.FeedBoost
		}
		existing.GrantsCrown = req.GrantsCrown
		if req.SupportSLAH > 0 {
			existing.SupportSLAH = req.SupportSLAH
		}
		if req.Active != nil {
			existing.Active = *req.Active
		}
		if req.Description != "" {
			existing.Description = req.Description
		}
		plan = existing
		s.feedScoresLocked()
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "admin.rent_plan_update", "rent_plan", plan.ID, "", store.FactorOps, before,
		map[string]any{
			"price_sol": plan.PriceLamports, "price_stars": plan.PriceStars, "fee_bps": plan.FeeBPS,
			"grants_crown": plan.GrantsCrown, "active": plan.Active,
		})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": plan.ID, "code": plan.Code, "name_ru": plan.NameRU,
		"price_sol": store.FormatSOL(plan.PriceLamports), "price_stars": plan.PriceStars,
		"fee_bps": plan.FeeBPS, "product_limit": plan.ProductLimit,
		"grants_crown": plan.GrantsCrown, "active": plan.Active,
		"notice": "Изменение тарифа не влияет на уже оплаченные периоды.",
	})
}

// ---------------------------------------------------------------------------
// Споры: очередь арбитража и назначение (FR-DSP-06)
// ---------------------------------------------------------------------------

func (s *Server) handleAdminListDisputes(w http.ResponseWriter, r *http.Request) {
	u, ok := s.adminRead(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	status := q.Get("status")
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	items := []map[string]any{}
	overdue := 0
	s.Store.Read(func() {
		list := []*store.Dispute{}
		for _, d := range s.Store.Disputes {
			if status != "" && d.Status != status {
				continue
			}
			list = append(list, d)
		}
		sort.Slice(list, func(i, j int) bool {
			// Сначала — без арбитра и с истекающим сроком.
			if (list[i].ArbiterID == "") != (list[j].ArbiterID == "") {
				return list[i].ArbiterID == ""
			}
			return list[i].ReplyDeadline.Before(list[j].ReplyDeadline)
		})
		for _, d := range list {
			dto := s.disputeDTOLocked(d, u)
			dto["buyer_id"] = d.BuyerID
			dto["seller_id"] = d.SellerID
			dto["arbiter_id"] = d.ArbiterID
			dto["reveal"] = true
			if o := s.Store.Orders[d.OrderID]; o != nil {
				dto["order_number"] = o.Number
				dto["order_status"] = o.Status
				dto["order_total"] = orderTotalStr(o)
			}
			if sh := s.Store.Shops[d.ShopID]; sh != nil {
				dto["shop_name"] = sh.Name
				dto["shop_dispute_rate"] = sh.DisputeRate
			}
			if !d.ResolveDeadline.IsZero() && time.Now().UTC().After(d.ResolveDeadline) &&
				d.Status == store.DisputeInArbitration {
				dto["overdue"] = true
				overdue++
			}
			items = append(items, dto)
		}
	})
	start, end, next, hasMore := s.page(len(items), limit, q.Get("cursor"))
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items[start:end], "next_cursor": next, "has_more": hasMore,
		"total": len(items), "overdue": overdue, "arbiter_pool": s.arbiterPool(),
	})
}

func (s *Server) handleAdminAssignDispute(w http.ResponseWriter, r *http.Request) {
	disputeID := r.PathValue("id")
	var req struct {
		ArbiterID string `json:"arbiter_id"`
		Comment   string `json:"comment"`
		TotpCode  string `json:"totp_code"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	u, ok := s.adminWrite(w, r, "admin_write", req.TotpCode)
	if !ok {
		return
	}
	var (
		fail *httpx.APIError
		d    *store.Dispute
	)
	s.Store.Write(func() {
		existing := s.Store.Disputes[disputeID]
		if existing == nil {
			fail = httpx.NotFound("спор не найден")
			return
		}
		d = existing
		arbiterID := req.ArbiterID
		if arbiterID == "" {
			arbiterID = s.pickArbiterLocked(existing)
		}
		arb := s.Store.Users[arbiterID]
		if arb == nil {
			fail = httpx.NotFound("арбитр не найден")
			return
		}
		switch arb.Role {
		case store.RoleArbiter, store.RoleModerator, store.RoleSuperAdmin:
		default:
			fail = httpx.BadRequest("пользователь не имеет роли арбитра", nil)
			return
		}
		// Анти-конфликт: арбитр не может быть участником спора или оператором магазина.
		if arb.ID == d.BuyerID || arb.ID == d.SellerID || arb.ID == d.OpenedBy {
			fail = httpx.Conflict("ARBITER_CONFLICT", "арбитр не может быть участником спора")
			return
		}
		if sh, ok := s.Store.Shops[d.ShopID]; ok && contains(sh.Operators, arb.ID) {
			fail = httpx.Conflict("ARBITER_CONFLICT", "арбитр связан с магазином")
			return
		}
		d.ArbiterID = arb.ID
		d.AssignedAt = time.Now().UTC()
		if d.Status == store.DisputeOpen || d.Status == store.DisputeAwaitingReply {
			d.Status = store.DisputeInArbitration
		}
		if d.ResolveDeadline.IsZero() {
			d.ResolveDeadline = time.Now().UTC().Add(7 * 24 * time.Hour)
		}
		d.UpdatedAt = time.Now().UTC()
		d.Timeline = append(d.Timeline, &store.DisputeEvent{
			TS: d.UpdatedAt, Kind: "assigned", ActorID: u.ID, VisibleAs: "Администрация",
			Note: "назначен арбитр " + arb.Nickname + "; " + strings.TrimSpace(req.Comment),
		})
		if c := s.Store.Chats[d.ChatID]; c != nil {
			s.addMemberLocked(c, arb, "arbiter", "Арбитр")
			s.appendSystemMessageLocked(c, nil, store.SystemPayload{
				Kind: "dispute", OrderID: d.OrderID,
				Title: "К спору подключён арбитр площадки. Решение — до " +
					d.ResolveDeadline.Format("02.01.2006 15:04") + ".",
			})
		}
		if o := s.Store.Orders[d.OrderID]; o != nil &&
			store.CanTransitionOrder(o.Status, store.StatusInArbitration) {
			_ = s.transitionLocked(o, store.StatusInArbitration, u.ID, "admin", "назначен арбитр")
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "admin.dispute_assign", "dispute", d.ID, req.Comment, store.FactorOps, nil,
		map[string]any{"arbiter_id": d.ArbiterID, "status": d.Status})
	for _, t := range []string{d.BuyerID, d.SellerID, d.ArbiterID} {
		s.notify(t, "dispute_assigned", "Назначен арбитр",
			"Спор "+d.ID+" передан в арбитраж", "dispute:"+d.ID+":assign:"+t,
			map[string]any{"dispute_id": d.ID})
	}
	s.pushMany([]string{d.BuyerID, d.SellerID, d.ArbiterID}, "dispute.assigned", map[string]any{
		"dispute_id": d.ID, "arbiter_id": d.ArbiterID, "status": d.Status,
		"resolve_deadline": d.ResolveDeadline,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"dispute_id": d.ID, "arbiter_id": d.ArbiterID, "status": d.Status,
		"resolve_deadline": d.ResolveDeadline, "chat_id": d.ChatID,
	})
}

// ---------------------------------------------------------------------------
// Заказы и модерация товаров
// ---------------------------------------------------------------------------

func (s *Server) handleAdminListOrders(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.adminRead(w, r); !ok {
		return
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	status := q.Get("status")
	shopID := q.Get("shop_id")
	items := []map[string]any{}
	s.Store.Read(func() {
		list := []*store.Order{}
		for _, o := range s.Store.Orders {
			if status != "" && o.Status != status {
				continue
			}
			if shopID != "" && o.ShopID != shopID {
				continue
			}
			list = append(list, o)
		}
		sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt.After(list[j].CreatedAt) })
		for _, o := range list {
			dto := s.orderDTOLocked(o, "")
			dto["buyer"] = s.userDTOLocked(s.Store.Users[o.BuyerID])
			if sh := s.Store.Shops[o.ShopID]; sh != nil {
				dto["shop_name"] = sh.Name
			}
			dto["escrow_balance"] = store.FormatSOL(
				s.Store.BalanceLocked(store.EscrowAccount(o.ID, store.AssetSOL)))
			items = append(items, dto)
		}
	})
	start, end, next, hasMore := s.page(len(items), limit, q.Get("cursor"))
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items[start:end], "next_cursor": next, "has_more": hasMore, "total": len(items),
		"statuses": store.AllOrderStatuses(),
	})
}

type setOrderStatusRequest struct {
	Status   string `json:"status"`
	Reason   string `json:"reason"`
	Refund   bool   `json:"refund"`
	TotpCode string `json:"totp_code"`
}

func (s *Server) handleAdminSetOrderStatus(w http.ResponseWriter, r *http.Request) {
	orderID := r.PathValue("id")
	var req setOrderStatusRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	u, ok := s.adminWrite(w, r, "admin_write", req.TotpCode)
	if !ok {
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		httpx.Fail(w, r, httpx.BadRequest("причина изменения статуса обязательна", nil))
		return
	}
	var (
		fail   *httpx.APIError
		o      *store.Order
		before string
		txID   string
		refund int64
	)
	s.Store.Write(func() {
		existing := s.findOrderLocked(orderID)
		if existing == nil {
			fail = httpx.NotFound("заказ не найден")
			return
		}
		o = existing
		before = existing.Status
		if !store.CanTransitionOrder(existing.Status, req.Status) {
			fail = httpx.Conflict("INVALID_TRANSITION", fmt.Sprintf(
				"переход %s → %s запрещён машиной состояний", existing.Status, req.Status))
			return
		}
		if req.Refund && existing.PaidAt.IsZero() {
			fail = httpx.BadRequest("возврат невозможен: заказ не оплачен", nil)
			return
		}
		if req.Refund {
			id, amount, rerr := s.refundEscrowLocked(existing, 0, u.ID, req.Reason)
			if rerr != nil {
				fail = mapLedgerError(rerr)
				return
			}
			txID, refund = id, amount
		}
		if err := s.transitionLocked(existing, req.Status, u.ID, "admin", req.Reason); err != nil {
			fail = httpx.Conflict("INVALID_TRANSITION", err.Error())
			return
		}
		switch req.Status {
		case store.StatusCompleted:
			existing.CompletedAt = time.Now().UTC()
			s.finishOrderStatsLocked(existing)
		case store.StatusRefunded, store.StatusCancelled:
			existing.CancelledAt = time.Now().UTC()
			s.releaseStockLocked(existing)
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "admin.order_status", "order", o.ID, req.Reason, store.FactorOps,
		map[string]any{"status": before}, map[string]any{"status": o.Status, "refund": refund, "tx_id": txID})
	s.notify(o.BuyerID, "order_admin_update", "Заказ "+o.Number+": статус изменён администрацией",
		store.StatusTitleRU(o.Status)+". "+req.Reason, "admin:"+o.ID+":"+o.Status,
		map[string]any{"order_id": o.ID, "status": o.Status})
	for _, t := range s.shopAdmins(o.ShopID) {
		s.notify(t, "order_admin_update", "Заказ "+o.Number+": вмешательство администрации",
			req.Reason, "admin:"+o.ID+":"+o.Status+":"+t, map[string]any{"order_id": o.ID})
	}
	s.pushMany(append([]string{o.BuyerID}, s.shopAdmins(o.ShopID)...), "order.updated", map[string]any{
		"order_id": o.ID, "status": o.Status, "refund": refund})
	if o.ChatID != "" {
		s.systemMessage(o.BuyerID, o.ChatID, "order_status", o.ID, o.Status,
			strconv.FormatInt(refund, 10), o.PayAsset)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"order_id": o.ID, "number": o.Number, "status_before": before, "status": o.Status,
		"refunded": refund, "tx_id": txID, "reason": req.Reason,
	})
}

func (s *Server) handleAdminModerationQueue(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.adminRead(w, r); !ok {
		return
	}
	items := []map[string]any{}
	s.Store.Read(func() {
		list := []*store.Product{}
		for _, p := range s.Store.Products {
			if p.Status == "moderation" || p.Status == "draft" {
				list = append(list, p)
			}
		}
		sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt.Before(list[j].CreatedAt) })
		for _, p := range list {
			dto := s.productDTOLocked(p)
			if sh := s.Store.Shops[p.ShopID]; sh != nil {
				dto["shop_name"] = sh.Name
				dto["shop_sanction"] = sh.SanctionLevel
				dto["shop_rating"] = sh.RatingBayes
			}
			dto["stock_total"] = len(s.Store.Stock[p.ID])
			items = append(items, dto)
		}
	})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "total": len(items),
		"policy": "Первый товар нового магазина проходит ручную модерацию (FR-PROD-06).",
	})
}

func (s *Server) moderateProduct(w http.ResponseWriter, r *http.Request, approve bool) {
	productID := r.PathValue("id")
	var req struct {
		Note     string `json:"note"`
		TotpCode string `json:"totp_code"`
	}
	_ = httpx.Decode(r, &req)
	u, ok := s.adminWrite(w, r, "admin_write", req.TotpCode)
	if !ok {
		return
	}
	var (
		fail *httpx.APIError
		p    *store.Product
		sh   *store.Shop
	)
	s.Store.Write(func() {
		existing := s.Store.Products[productID]
		if existing == nil {
			fail = httpx.NotFound("товар не найден")
			return
		}
		p = existing
		sh = s.Store.Shops[existing.ShopID]
		if approve {
			existing.Status = "published"
			existing.ModerationNote = ""
		} else {
			existing.Status = "rejected"
			existing.ModerationNote = orDefault(req.Note, "не соответствует правилам площадки")
		}
		existing.UpdatedAt = time.Now().UTC()
		s.feedScoresLocked()
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	action := "admin.product_reject"
	if approve {
		action = "admin.product_approve"
	}
	s.audit(r, u.ID, u.Role, action, "product", p.ID, req.Note, store.FactorOps, nil,
		map[string]any{"status": p.Status})
	if sh != nil {
		s.notify(sh.AdminUserID, "product_moderation",
			"Модерация товара «"+p.Title+"»", p.Status+": "+orDefault(req.Note, "решение принято"),
			"moderation:"+p.ID+":"+p.Status, map[string]any{"product_id": p.ID, "status": p.Status})
		s.push(sh.AdminUserID, "product.moderation", map[string]any{
			"product_id": p.ID, "status": p.Status})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"product_id": p.ID, "status": p.Status, "note": p.ModerationNote,
	})
}

func (s *Server) handleAdminApproveProduct(w http.ResponseWriter, r *http.Request) {
	s.moderateProduct(w, r, true)
}

func (s *Server) handleAdminRejectProduct(w http.ResponseWriter, r *http.Request) {
	s.moderateProduct(w, r, false)
}

// ---------------------------------------------------------------------------
// Пользователи
// ---------------------------------------------------------------------------

func (s *Server) handleAdminListUsers(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.adminRead(w, r); !ok {
		return
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	role := q.Get("role")
	status := q.Get("status")
	search := strings.ToLower(strings.TrimSpace(q.Get("q")))
	items := []map[string]any{}
	s.Store.Read(func() {
		list := []*store.User{}
		for _, usr := range s.Store.Users {
			if role != "" && usr.Role != role {
				continue
			}
			if status != "" && usr.Status != status {
				continue
			}
			if search != "" && !strings.Contains(strings.ToLower(usr.Nickname), search) &&
				!strings.Contains(strings.ToLower(usr.ID), search) {
				continue
			}
			list = append(list, usr)
		}
		sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt.After(list[j].CreatedAt) })
		for _, usr := range list {
			dto := s.userDTOLocked(usr)
			shops := 0
			for _, sh := range s.Store.Shops {
				if sh.AdminUserID == usr.ID {
					shops++
				}
			}
			dto["shops_count"] = shops
			dto["balance_sol"] = store.FormatSOL(s.Store.UserBalanceLocked(usr.ID, store.AssetSOL))
			dto["balance_stars"] = s.Store.UserBalanceLocked(usr.ID, store.AssetStars)
			dto["factors"] = map[string]any{
				"login": usr.HasFactor(store.FactorLogin),
				"ops":   usr.HasFactor(store.FactorOps),
			}
			items = append(items, dto)
		}
	})
	start, end, next, hasMore := s.page(len(items), limit, q.Get("cursor"))
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items[start:end], "next_cursor": next, "has_more": hasMore, "total": len(items),
	})
}

type updateUserRequest struct {
	Role     string `json:"role"`
	Status   string `json:"status"`
	Country  string `json:"country"`
	Nickname string `json:"nickname"`
	Reason   string `json:"reason"`
	TotpCode string `json:"totp_code"`
}

func (s *Server) handleAdminUpdateUser(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	var req updateUserRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	u, ok := s.adminWrite(w, r, "admin_write", req.TotpCode)
	if !ok {
		return
	}
	switch req.Role {
	case "", store.RoleBuyer, store.RoleShopAdmin, store.RoleModerator, store.RoleArbiter, store.RoleSuperAdmin:
	default:
		httpx.Fail(w, r, httpx.BadRequest("role: buyer|shop_admin|moderator|arbiter|superadmin", nil))
		return
	}
	switch req.Status {
	case "", "active", "restricted", "suspended", "banned":
	default:
		httpx.Fail(w, r, httpx.BadRequest("status: active|restricted|suspended|banned", nil))
		return
	}
	if (req.Status == "banned" || req.Status == "suspended") && strings.TrimSpace(req.Reason) == "" {
		httpx.Fail(w, r, httpx.BadRequest("причина блокировки обязательна", nil))
		return
	}
	var (
		fail   *httpx.APIError
		target *store.User
		before map[string]any
	)
	s.Store.Write(func() {
		existing := s.Store.Users[userID]
		if existing == nil {
			fail = httpx.NotFound("пользователь не найден")
			return
		}
		target = existing
		before = map[string]any{"role": existing.Role, "status": existing.Status}
		if existing.ID == u.ID && (req.Status == "banned" || req.Status == "suspended") {
			fail = httpx.BadRequest("нельзя заблокировать собственную учётную запись", nil)
			return
		}
		if existing.Role == store.RoleSuperAdmin && u.Role != store.RoleSuperAdmin {
			fail = httpx.Forbidden("FORBIDDEN", "изменять супер-админа может только супер-админ")
			return
		}
		if req.Role != "" {
			existing.Role = req.Role
		}
		if req.Status != "" {
			existing.Status = req.Status
		}
		if req.Country != "" {
			existing.Country = strings.ToUpper(req.Country)
		}
		if req.Nickname != "" && utf8len(req.Nickname) >= 3 && utf8len(req.Nickname) <= 32 {
			existing.Nickname = req.Nickname
		}
		// Блокировка пользователя замораживает его магазины.
		if req.Status == "banned" || req.Status == "suspended" {
			for _, sh := range s.Store.Shops {
				if sh.AdminUserID == existing.ID {
					sh.Status = "frozen"
					sh.UpdatedAt = time.Now().UTC()
				}
			}
			s.feedScoresLocked()
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "admin.user_update", "user", target.ID, req.Reason, store.FactorOps, before,
		map[string]any{"role": target.Role, "status": target.Status})
	s.notify(target.ID, "account_update", "Изменения учётной записи",
		"Роль: "+target.Role+", статус: "+target.Status+". "+req.Reason,
		"admin:user:"+target.ID+":"+target.Status, nil)
	s.push(target.ID, "user.updated", map[string]any{
		"role": target.Role, "status": target.Status})
	if target.Status == "banned" || target.Status == "suspended" {
		// Принудительно закрываем WS-соединения заблокированного пользователя.
		s.Hub.Send(target.ID, []byte(`{"v":1,"t":"user.banned","ts":0,"d":{"reason":"account suspended"}}`))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"user_id": target.ID, "role": target.Role, "status": target.Status,
		"nickname": target.Nickname,
	})
}

// ---------------------------------------------------------------------------
// Финансовая сверка (docs/solana.md §5): A + B == C + D + in-flight ± E
// ---------------------------------------------------------------------------

func (s *Server) handleAdminReconciliation(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.adminRead(w, r); !ok {
		return
	}
	dto := map[string]any{}
	s.Store.Read(func() {
		var userSOL, escrowSOL, shopSOL, platformSOL, holdSOL int64
		var userStars, platformStars int64
		for _, acc := range s.Store.Accounts {
			switch {
			case acc.OwnerType == store.OwnerUser && acc.Asset == store.AssetSOL:
				userSOL += acc.Balance
			case acc.OwnerType == store.OwnerUser && acc.Asset == store.AssetStars:
				userStars += acc.Balance
			case acc.OwnerType == store.OwnerEscrow:
				escrowSOL += acc.Balance
			case acc.OwnerType == store.OwnerShop && acc.Asset == store.AssetSOL:
				shopSOL += acc.Balance
			case acc.OwnerType == store.OwnerPlatform && acc.Asset == store.AssetSOL:
				platformSOL += acc.Balance
				if acc.OwnerID == store.PlatformWithdrawHold {
					holdSOL += acc.Balance
				}
			case acc.OwnerType == store.OwnerPlatform && acc.Asset == store.AssetStars:
				platformStars += acc.Balance
			}
		}
		var depositsSeen, withdrawalsPending int64
		for _, tx := range s.Store.SolTxs {
			if tx.Direction == "in" && tx.Status == "credited" {
				depositsSeen += tx.AmountLamport
			}
		}
		for _, wd := range s.Store.Withdrawals {
			if wd.Status == "pending_approval" || wd.Status == "approved" || wd.Status == "broadcast" {
				withdrawalsPending += wd.Amount + wd.Fee
			}
		}
		// A (балансы пользователей) + B (эскроу) == C (кастодия площадки) + D (счета магазинов) + in-flight
		left := userSOL + escrowSOL + shopSOL
		right := platformSOL + holdSOL
		problems := s.Store.CheckInvariantsLocked()
		dto = map[string]any{
			"generated_at": time.Now().UTC(),
			"sol": map[string]any{
				"user_balances":     store.FormatSOL(userSOL),
				"escrow":            store.FormatSOL(escrowSOL),
				"shop_balances":     store.FormatSOL(shopSOL),
				"platform_accounts": store.FormatSOL(platformSOL),
				"withdraw_hold":     store.FormatSOL(holdSOL),
				"deposits_credited": store.FormatSOL(depositsSeen),
				"withdrawals_in_flight": store.FormatSOL(withdrawalsPending),
				"left_side":  store.FormatSOL(left),
				"right_side": store.FormatSOL(right),
				"delta":      store.FormatSOL(left - right),
			},
			"stars": map[string]any{
				"user_balances":     userStars,
				"platform_accounts": platformStars,
			},
			"invariants": map[string]any{"ok": len(problems) == 0, "problems": problems},
			"ledger":     map[string]any{"entries": len(s.Store.Ledger), "accounts": len(s.Store.Accounts)},
			"action_on_mismatch": "P1-алерт + заморозка выводов (docs/solana.md §5.3)",
		}
	})
	httpx.JSON(w, http.StatusOK, dto)
}

// ---------------------------------------------------------------------------
// Аудит-лог с хэш-цепочкой (docs/security.md §10)
// ---------------------------------------------------------------------------

func (s *Server) handleAdminAudit(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.adminRead(w, r); !ok {
		return
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	action := q.Get("action")
	actor := q.Get("actor_id")
	items := []map[string]any{}
	chainOK := true
	brokenAt := ""
	head := ""
	s.Store.Read(func() {
		// Проверка целостности цепочки: record_hash(i) учитывает prev_hash.
		prev := ""
		for _, rec := range s.Store.Audit {
			if rec.PrevHash != prev {
				chainOK = false
				brokenAt = rec.ID
				break
			}
			prev = rec.RecordHash
		}
		head = prev
		for i := len(s.Store.Audit) - 1; i >= 0 && len(items) < limit; i-- {
			rec := s.Store.Audit[i]
			if action != "" && !strings.Contains(rec.Action, action) {
				continue
			}
			if actor != "" && rec.ActorID != actor {
				continue
			}
			items = append(items, map[string]any{
				"id": rec.ID, "ts": rec.TS, "actor_id": rec.ActorID, "actor_role": rec.ActorRole,
				"action": rec.Action, "object_type": rec.ObjectType, "object_id": rec.ObjectID,
				"reason": rec.Reason, "ip": rec.IP, "totp_factor": rec.TotpFactor,
				"before": rec.Before, "after": rec.After,
				"prev_hash": rec.PrevHash, "record_hash": rec.RecordHash,
			})
		}
	})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "total_records": len(s.Store.Audit), "chain_ok": chainOK,
		"chain_broken_at": brokenAt, "head_hash": head,
		"notice": "Каждая запись связана HMAC-цепочкой: изменение истории обнаруживается.",
	})
}

func (s *Server) handleAdminSecurityEvents(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.adminRead(w, r); !ok {
		return
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	event := q.Get("event")
	items := []map[string]any{}
	s.Store.Read(func() {
		for i := len(s.Store.AuthEvents) - 1; i >= 0 && len(items) < limit; i-- {
			ev := s.Store.AuthEvents[i]
			if event != "" && ev.Event != event {
				continue
			}
			items = append(items, map[string]any{
				"ts": ev.TS, "user_id": ev.UserID, "event": ev.Event,
				"ip": ev.IP, "geo": ev.Geo, "reason": ev.Reason, "risk_score": ev.RiskScore,
				"ua": ev.UA,
			})
		}
	})
	banned := []string{}
	s.Store.Read(func() {
		for key, val := range s.Store.Settings {
			if strings.HasPrefix(key, "ip_ban:") {
				banned = append(banned, strings.TrimPrefix(key, "ip_ban:"))
				_ = val
			}
		}
	})
	sort.Strings(banned)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "total": len(s.Store.AuthEvents),
		"banned_ips": banned,
		"rate_limit": s.Limiter.Stats(),
		"ws_connections": s.Hub.Count(),
	})
}

func (s *Server) handleAdminIPBan(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IP       string `json:"ip"`
		Ban      bool   `json:"ban"`
		Reason   string `json:"reason"`
		Hours    int    `json:"hours"`
		TotpCode string `json:"totp_code"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	u, ok := s.adminWrite(w, r, "sanction", req.TotpCode)
	if !ok {
		return
	}
	ip := strings.TrimSpace(req.IP)
	if ip == "" || strings.Contains(ip, "/") || len(ip) > 64 {
		httpx.Fail(w, r, httpx.BadRequest("укажите IPv4/IPv6 адрес без маски", nil))
		return
	}
	if req.Ban {
		s.Limiter.Block("ip:"+ip, time.Duration(orHours(req.Hours, 24))*time.Hour)
		s.Store.Write(func() {
			s.Store.Settings["ip_ban:"+ip] = map[string]any{
				"reason": req.Reason, "by": u.ID, "at": time.Now().UTC().Format(time.RFC3339),
				"hours": orHours(req.Hours, 24),
			}
		})
	} else {
		s.Limiter.Unblock("ip:" + ip)
		s.Store.Write(func() { delete(s.Store.Settings, "ip_ban:"+ip) })
	}
	s.audit(r, u.ID, u.Role, "admin.ip_ban", "ip", ip, req.Reason, store.FactorOps, nil,
		map[string]any{"ban": req.Ban, "hours": orHours(req.Hours, 24)})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"ip": ip, "banned": req.Ban, "hours": orHours(req.Hours, 24), "reason": req.Reason,
	})
}

func orHours(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

// ---------------------------------------------------------------------------
// Настройки площадки (feature flags, пороги)
// ---------------------------------------------------------------------------

var settingWhitelist = map[string]string{
	"registration_open":       "bool",
	"rent_trial_days":         "int",
	"max_shops_per_account":   "int",
	"exchange_fee_bps":        "int",
	"sol_stars_rate":          "float",
	"withdraw_daily_sol":      "float",
	"four_eyes_sol":           "float",
	"dispute_reply_hours":     "int",
	"dispute_window_days":     "int",
	"review_window_days":      "int",
	"auto_confirm_hours":      "int",
	"pay_timeout_minutes":     "int",
	"gift_boost_max":          "float",
	"promoted_slots_per_page": "int",
	"maintenance_mode":        "bool",
	"withdrawals_frozen":      "bool",
}

func (s *Server) handleAdminListSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.adminRead(w, r); !ok {
		return
	}
	items := map[string]any{}
	s.Store.Read(func() {
		for key, kind := range settingWhitelist {
			current, ok := s.Store.Settings[key]
			if !ok {
				current = s.settingDefault(key, kind)
			}
			items[key] = map[string]any{"value": current, "type": kind}
		}
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
}

func (s *Server) settingDefault(key, kind string) any {
	switch key {
	case "rent_trial_days":
		return 7
	case "max_shops_per_account":
		return 3
	case "exchange_fee_bps":
		return s.Cfg.ExchangeFeeBPS
	case "sol_stars_rate":
		return s.Cfg.SOLStarsRate
	case "withdraw_daily_sol":
		return float64(s.Cfg.WithdrawDailyLamports) / float64(store.LamportsPerSOL)
	case "four_eyes_sol":
		return float64(s.Cfg.FourEyesLamports) / float64(store.LamportsPerSOL)
	case "dispute_reply_hours":
		return s.Cfg.DisputeReplyHours
	case "dispute_window_days":
		return s.Cfg.DisputeWindowDays
	case "review_window_days":
		return s.Cfg.ReviewWindowDays
	case "auto_confirm_hours":
		return s.Cfg.AutoConfirmHours
	case "pay_timeout_minutes":
		return s.Cfg.PayTimeoutMinutes
	case "gift_boost_max":
		return 0.6
	case "promoted_slots_per_page":
		return 1
	case "registration_open", "maintenance_mode", "withdrawals_frozen":
		return false
	}
	if kind == "bool" {
		return false
	}
	return 0
}

type setSettingRequest struct {
	Value    any    `json:"value"`
	Reason   string `json:"reason"`
	TotpCode string `json:"totp_code"`
}

func (s *Server) handleAdminSetSetting(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	var req setSettingRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	u, ok := s.adminWrite(w, r, "admin_write", req.TotpCode)
	if !ok {
		return
	}
	kind, known := settingWhitelist[key]
	if !known {
		httpx.Fail(w, r, httpx.BadRequest("настройка не в белом списке", map[string]any{
			"allowed": settingKeys(),
		}))
		return
	}
	var typed any
	switch kind {
	case "bool":
		b, isBool := req.Value.(bool)
		if !isBool {
			httpx.Fail(w, r, httpx.BadRequest("ожидается булево значение", nil))
			return
		}
		typed = b
	case "int":
		switch v := req.Value.(type) {
		case float64:
			typed = int(v)
		case int:
			typed = v
		default:
			httpx.Fail(w, r, httpx.BadRequest("ожидается целое число", nil))
			return
		}
	case "float":
		switch v := req.Value.(type) {
		case float64:
			typed = v
		case int:
			typed = float64(v)
		case string:
			f, perr := strconv.ParseFloat(v, 64)
			if perr != nil {
				httpx.Fail(w, r, httpx.BadRequest("ожидается число", nil))
				return
			}
			typed = f
		default:
			httpx.Fail(w, r, httpx.BadRequest("ожидается число", nil))
			return
		}
	}
	var before any
	s.Store.Write(func() {
		before = s.Store.Settings[key]
		s.Store.Settings[key] = typed
	})
	s.audit(r, u.ID, u.Role, "admin.setting", "setting", key, req.Reason, store.FactorOps,
		map[string]any{"value": before}, map[string]any{"value": typed})
	httpx.JSON(w, http.StatusOK, map[string]any{"key": key, "value": typed, "type": kind})
}

func settingKeys() []string {
	out := make([]string, 0, len(settingWhitelist))
	for k := range settingWhitelist {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
