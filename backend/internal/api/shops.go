package api

import (
	"fmt"
	"math"
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
// Лента магазинов и поиск (FR-FEED-01…06)
// ---------------------------------------------------------------------------

// geoBlockedCategoryLocked — первая категория из списка, запрещённая в стране
// (FR-GEO-03б). Вызывать внутри Store.Read/Write.
func geoBlockedCategoryLocked(st *store.Store, ids []int64, country string) *store.Category {
	if country == "" {
		return nil
	}
	code := strings.ToUpper(country)
	for _, id := range ids {
		cat, ok := st.Categories[id]
		if !ok {
			continue
		}
		for _, blocked := range cat.BlockedIn {
			if strings.EqualFold(blocked, code) {
				return cat
			}
		}
	}
	return nil
}

// geoAllBlockedLocked — true, если все категории магазина запрещены в стране
// зрителя (магазин скрывается из ленты, FR-GEO-03б).
func geoAllBlockedLocked(st *store.Store, ids []int64, country string) bool {
	if country == "" || len(ids) == 0 {
		return false
	}
	code := strings.ToUpper(country)
	for _, id := range ids {
		cat, ok := st.Categories[id]
		if !ok {
			return false
		}
		blocked := false
		for _, b := range cat.BlockedIn {
			if strings.EqualFold(b, code) {
				blocked = true
				break
			}
		}
		if !blocked {
			return false
		}
	}
	return true
}

func (s *Server) handleListShops(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	search := strings.ToLower(strings.TrimSpace(q.Get("q")))
	country := strings.ToUpper(strings.TrimSpace(q.Get("country")))
	cityID, _ := strconv.ParseInt(q.Get("city"), 10, 64)
	minRating, _ := strconv.ParseFloat(q.Get("min_rating"), 64)
	crownOnly := q.Get("crown_only") == "true"
	verifiedOnly := q.Get("verified_only") == "true"
	sortBy := q.Get("sort")
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	viewer, _ := s.currentUser(r)
	viewerCountry := countryOf(viewer)

	cards := []map[string]any{}
	s.Store.Read(func() {
		s.feedScoresLocked()
		for _, sh := range s.Store.Shops {
			if sh.Status != store.ShopActive {
				continue
			}
			if rent := s.Store.RentStatusLocked(sh.ID); rent == store.RentSuspended {
				continue
			}
			crowned := s.Store.IsCrownedLocked(sh)
			if crownOnly && !crowned {
				continue
			}
			if verifiedOnly && !sh.IsVerified {
				continue
			}
			if minRating > 0 && sh.RatingBayes < minRating {
				continue
			}
			if country != "" && sh.Country != country {
				continue
			}
			if cityID != 0 && sh.CityID != cityID {
				continue
			}
			if search != "" && !shopMatchesLocked(s.Store, sh, search) {
				continue
			}
			// FR-GEO-03(б): все категории запрещены в стране зрителя — скрываем.
			if geoAllBlockedLocked(s.Store, sh.CategoryIDs, viewerCountry) {
				continue
			}
			card := s.shopCardLocked(sh, viewerCountry)
			card["is_crowned"] = crowned
			cards = append(cards, card)
		}
	})

	switch sortBy {
	case "rating":
		sort.Slice(cards, func(i, j int) bool { return fnum(cards[i]["rating"]) > fnum(cards[j]["rating"]) })
	case "sales":
		sort.Slice(cards, func(i, j int) bool { return inum(cards[i]["sales_count"]) > inum(cards[j]["sales_count"]) })
	case "new":
		// карта не содержит created_at — сортировка по ID (ULID-порядок ≈ время)
		sort.Slice(cards, func(i, j int) bool { return strval(cards[i]["id"]) > strval(cards[j]["id"]) })
	default: // recommended
		sort.Slice(cards, func(i, j int) bool { return fnum(cards[i]["score"]) > fnum(cards[j]["score"]) })
	}

	start, end, next, hasMore := s.page(len(cards), limit, q.Get("cursor"))
	page := cards[start:end]

	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":       page,
		"next_cursor": next,
		"has_more":    hasMore,
		"total":       len(cards),
		"query":       map[string]any{"q": q.Get("q"), "sort": sortByOr(sortBy, "recommended")},
	})
}

func sortByOr(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// shopMatchesLocked — поиск по названию, описанию, slug и товарам магазина.
func shopMatchesLocked(st *store.Store, sh *store.Shop, needle string) bool {
	if strings.Contains(strings.ToLower(sh.Name), needle) ||
		strings.Contains(strings.ToLower(sh.Slug), needle) ||
		strings.Contains(strings.ToLower(sh.Description), needle) {
		return true
	}
	for _, p := range st.Products {
		if p.ShopID != sh.ID || p.Status != store.ProductPublished {
			continue
		}
		if strings.Contains(strings.ToLower(p.Title), needle) ||
			strings.Contains(strings.ToLower(p.Description), needle) {
			return true
		}
	}
	for _, id := range sh.CategoryIDs {
		if c, ok := st.Categories[id]; ok {
			if strings.Contains(strings.ToLower(c.NameRU), needle) ||
				strings.Contains(strings.ToLower(c.Slug), needle) {
				return true
			}
		}
	}
	return false
}

func fnum(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	}
	return 0
}

func inum(v any) int { return int(fnum(v)) }

func strval(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// ---------------------------------------------------------------------------
// Карточка магазина и управление (FR-SHOP-01…03, FR-FEED-08)
// ---------------------------------------------------------------------------

func (s *Server) handleGetShop(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("id")
	viewer, _ := s.currentUser(r)
	var dto map[string]any
	s.Store.Read(func() {
		sh := s.findShopLocked(key)
		if sh == nil {
			return
		}
		if sh.Status == store.ShopBanned || sh.Status == store.ShopDraft {
			if viewer == nil || viewer.ID != sh.AdminUserID {
				return
			}
		}
		dto = s.shopDetailLocked(sh, viewer)
	})
	if dto == nil {
		httpx.Fail(w, r, httpx.NotFound("магазин не найден"))
		return
	}
	httpx.JSON(w, http.StatusOK, dto)
}

func (s *Server) findShopLocked(idOrSlug string) *store.Shop {
	if sh, ok := s.Store.Shops[idOrSlug]; ok {
		return sh
	}
	if id, ok := s.Store.ShopsBySlug[strings.ToLower(idOrSlug)]; ok {
		return s.Store.Shops[id]
	}
	return nil
}

type shopCreateRequest struct {
	Name        string  `json:"name"`
	Slug        string  `json:"slug"`
	Description string  `json:"description"`
	CategoryIDs []int64 `json:"category_ids"`
	CountryCode string  `json:"country_code"`
	CityID      int64   `json:"city_id"`
	TZ          string  `json:"tz"`
	CoverURL    string  `json:"cover_url"`
	AvatarURL   string  `json:"avatar_url"`
	TotpCode    string  `json:"totp_code"`
	Trial       bool    `json:"trial"`
}

func (s *Server) handleCreateShop(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req shopCreateRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if !s.requireOps(w, r, u, "create_shop", 0, 0, req.TotpCode) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Slug = strings.ToLower(strings.TrimSpace(req.Slug))
	if len([]rune(req.Name)) < 3 || len([]rune(req.Name)) > 40 {
		httpx.Fail(w, r, httpx.BadRequest("название магазина: 3–40 символов", nil))
		return
	}
	if req.Slug == "" {
		req.Slug = translit(req.Name)
	}
	if len(req.Slug) < 3 || len(req.Slug) > 40 {
		httpx.Fail(w, r, httpx.BadRequest("slug: 3–40 символов", nil))
		return
	}
	for _, ch := range req.Slug {
		if !((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-') {
			httpx.Fail(w, r, httpx.BadRequest("slug: только a-z, 0-9, дефис", nil))
			return
		}
	}
	if len(req.CategoryIDs) == 0 || len(req.CategoryIDs) > 3 {
		httpx.Fail(w, r, httpx.BadRequest("выберите от 1 до 3 категорий", nil))
		return
	}
	if u.Country == "" {
		httpx.Fail(w, r, httpx.BadRequest("сначала укажите страну и город в профиле (FR-GEO-01)", nil))
		return
	}

	shopCount := 0
	s.Store.Read(func() {
		for _, sh := range s.Store.Shops {
			if sh.AdminUserID == u.ID {
				shopCount++
			}
		}
	})
	if shopCount >= 3 {
		httpx.Fail(w, r, httpx.Forbidden("LIMIT_EXCEEDED", "лимит магазинов на аккаунт: 3"))
		return
	}

	country := strings.ToUpper(req.CountryCode)
	if country == "" {
		country = u.Country
	}
	cityID := req.CityID
	if cityID == 0 {
		cityID = u.CityID
	}
	tz := req.TZ
	if tz == "" {
		if c, ok := s.Store.Cities[cityID]; ok {
			tz = c.TZ
		}
	}
	if tz == "" {
		tz = "UTC"
	}

	shop := &store.Shop{
		ID: ids.New("shp"), AdminUserID: u.ID, Slug: req.Slug, Name: req.Name,
		Description: req.Description, CoverURL: req.CoverURL, AvatarURL: req.AvatarURL,
		CategoryIDs: req.CategoryIDs, Country: country, CityID: cityID, TZ: tz,
		Status: store.ShopActive, SanctionLevel: "none", AcceptsStars: true,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}

	var fail *httpx.APIError
	s.Store.Write(func() {
		if _, dup := s.Store.ShopsBySlug[shop.Slug]; dup {
			fail = httpx.Conflict("ALREADY_USED", "slug занят")
			return
		}
		// FR-GEO-03(б): категория недоступна в юрисдикции продавца.
		if cat := geoBlockedCategoryLocked(s.Store, shop.CategoryIDs, shop.Country); cat != nil {
			fail = httpx.Forbidden("GEO_BLOCKED",
				"категория «"+cat.NameRU+"» недоступна в стране "+shop.Country)
			return
		}
		s.Store.Shops[shop.ID] = shop
		s.Store.ShopsBySlug[shop.Slug] = shop.ID
		s.Store.EnsureAccountLocked(store.OwnerShop, shop.ID, store.AssetSOL)
		s.Store.EnsureAccountLocked(store.OwnerShop, shop.ID, store.AssetStars)
		// Триал 7 дней (один раз на аккаунт) — FR-SHOP-04.
		hasTrial := false
		for _, sub := range s.Store.Subs {
			if existing, ok := s.Store.Shops[sub.ShopID]; ok && existing.AdminUserID == u.ID {
				hasTrial = true
			}
		}
		if !hasTrial {
			plan := s.planByCodeLocked("starter")
			if plan != nil {
				s.Store.Subs[shop.ID] = &store.RentSub{
					ID: ids.New("sub"), ShopID: shop.ID, PlanID: plan.ID, Status: store.RentTrial,
					Asset: store.AssetSOL, PriceLamports: 0,
					PeriodStart: time.Now().UTC(), PeriodEnd: time.Now().UTC().Add(7 * 24 * time.Hour),
					AutoRenew: true, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
				}
			}
		}
		if u.Role == store.RoleBuyer {
			u.Role = store.RoleShopAdmin
		}
		s.feedScoresLocked()
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}

	s.audit(r, u.ID, u.Role, "shop.create", "shop", shop.ID, "", store.FactorOps, nil,
		map[string]any{"name": shop.Name, "slug": shop.Slug})
	// Канал магазина создаётся автоматически (FR-MSG-08).
	s.ensureShopChannel(shop, u)

	var dto map[string]any
	s.Store.Read(func() { dto = s.shopDetailLocked(shop, u) })
	httpx.JSON(w, http.StatusCreated, dto)
}

func (s *Server) planByCodeLocked(code string) *store.RentPlan {
	for _, p := range s.Store.RentPlans {
		if p.Code == strings.ToLower(code) && p.Active {
			return p
		}
	}
	return nil
}

// translit — простая транслитерация названия в slug.
func translit(in string) string {
	mapRU := map[rune]string{
		'а': "a", 'б': "b", 'в': "v", 'г': "g", 'д': "d", 'е': "e", 'ё': "e", 'ж': "zh",
		'з': "z", 'и': "i", 'й': "y", 'к': "k", 'л': "l", 'м': "m", 'н': "n", 'о': "o",
		'п': "p", 'р': "r", 'с': "s", 'т': "t", 'у': "u", 'ф': "f", 'х': "h", 'ц': "c",
		'ч': "ch", 'ш': "sh", 'щ': "sch", 'ъ': "", 'ы': "y", 'ь': "", 'э': "e", 'ю': "yu",
		'я': "ya", ' ': "-", '_': "-",
	}
	var b strings.Builder
	for _, r := range strings.ToLower(in) {
		if v, ok := mapRU[r]; ok {
			b.WriteString(v)
			continue
		}
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			continue
		}
		if r == '-' {
			b.WriteRune(r)
		}
	}
	out := b.String()
	for strings.Contains(out, "--") {
		out = strings.ReplaceAll(out, "--", "-")
	}
	out = strings.Trim(out, "-")
	if out == "" {
		out = "shop-" + ids.Hex(3)
	}
	if len(out) > 40 {
		out = out[:40]
	}
	return out
}

type shopUpdateRequest struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	CoverURL    string  `json:"cover_url"`
	AvatarURL   string  `json:"avatar_url"`
	CategoryIDs []int64 `json:"category_ids"`
	CityID      int64   `json:"city_id"`
	TZ          string  `json:"tz"`
	AcceptsStars *bool  `json:"accepts_stars"`
}

func (s *Server) handleUpdateShop(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req shopUpdateRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	key := r.PathValue("id")
	var (
		fail *httpx.APIError
		sh   *store.Shop
	)
	before := map[string]any{}
	s.Store.Write(func() {
		sh = s.findShopLocked(key)
		if sh == nil {
			fail = httpx.NotFound("магазин не найден")
			return
		}
		if sh.AdminUserID != u.ID && u.Role != store.RoleSuperAdmin {
			fail = httpx.Forbidden("FORBIDDEN", "только админ магазина может изменять его")
			return
		}
		before = map[string]any{"name": sh.Name, "description": sh.Description,
			"cover_url": sh.CoverURL, "avatar_url": sh.AvatarURL}
		if req.Name != "" {
			sh.Name = strings.TrimSpace(req.Name)
		}
		if req.Description != "" {
			sh.Description = req.Description
		}
		if req.CoverURL != "" {
			sh.CoverURL = req.CoverURL
		}
		if req.AvatarURL != "" {
			sh.AvatarURL = req.AvatarURL
		}
		if len(req.CategoryIDs) > 0 {
			sh.CategoryIDs = req.CategoryIDs
		}
		if req.CityID != 0 {
			sh.CityID = req.CityID
		}
		if req.TZ != "" {
			sh.TZ = req.TZ
		}
		if req.AcceptsStars != nil {
			sh.AcceptsStars = *req.AcceptsStars
		}
		sh.UpdatedAt = time.Now().UTC()
		s.feedScoresLocked()
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "shop.update", "shop", sh.ID, "", "", before,
		map[string]any{"name": sh.Name})
	var dto map[string]any
	s.Store.Read(func() { dto = s.shopDetailLocked(sh, u) })
	httpx.JSON(w, http.StatusOK, dto)
}

func (s *Server) handleShopStats(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	key := r.PathValue("id")
	var (
		fail *httpx.APIError
		out  map[string]any
	)
	s.Store.Read(func() {
		sh := s.findShopLocked(key)
		if sh == nil {
			fail = httpx.NotFound("магазин не найден")
			return
		}
		if sh.AdminUserID != u.ID && !u.IsPrivileged() {
			fail = httpx.Forbidden("FORBIDDEN", "статистика доступна админу магазина")
			return
		}
		orders7, orders30, revenue := 0, 0, int64(0)
		now := time.Now()
		for _, o := range s.Store.Orders {
			if o.ShopID != sh.ID {
				continue
			}
			if now.Sub(o.CreatedAt) <= 7*24*time.Hour {
				orders7++
			}
			if now.Sub(o.CreatedAt) <= 30*24*time.Hour {
				orders30++
			}
			if o.Status == store.StatusCompleted {
				revenue += o.TotalLamports - o.FeeLamports
			}
		}
		disputes := 0
		for _, d := range s.Store.Disputes {
			if d.ShopID == sh.ID {
				disputes++
			}
		}
		out = map[string]any{
			"shop_id": sh.ID,
			"orders_7d": orders7, "orders_30d": orders30,
			"revenue_sol": store.FormatSOL(revenue),
			"balance_sol": store.FormatSOL(s.Store.BalanceLocked(store.ShopAccount(sh.ID, store.AssetSOL))),
			"balance_stars": s.Store.BalanceLocked(store.ShopAccount(sh.ID, store.AssetStars)),
			"disputes": disputes,
			"dispute_rate": sh.DisputeRate,
			"rating": round1(sh.RatingBayes), "rating_count": sh.RatingCount,
			"response_p50_s": sh.ResponseP50S,
			"feed_score": sh.FeedScore,
			"rent": s.rentDTOLocked(sh.ID),
			"products_total": countProductsLocked(s.Store, sh.ID),
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func countProductsLocked(st *store.Store, shopID string) int {
	n := 0
	for _, p := range st.Products {
		if p.ShopID == shopID && p.Status != store.ProductArchived {
			n++
		}
	}
	return n
}

// ---------------------------------------------------------------------------
// Аренда (FR-SHOP-04…07)
// ---------------------------------------------------------------------------

func (s *Server) handleRentPlans(w http.ResponseWriter, r *http.Request) {
	items := []map[string]any{}
	s.Store.Read(func() {
		for _, p := range s.Store.RentPlans {
			if p.Active {
				items = append(items, s.rentPlanDTO(p))
			}
		}
	})
	sort.Slice(items, func(i, j int) bool { return fnum(items[i]["price_stars"]) < fnum(items[j]["price_stars"]) })
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleGetRent(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	key := r.PathValue("id")
	var (
		dto  map[string]any
		fail *httpx.APIError
	)
	s.Store.Read(func() {
		sh := s.findShopLocked(key)
		if sh == nil {
			fail = httpx.NotFound("магазин не найден")
			return
		}
		if sh.AdminUserID != u.ID && !u.IsPrivileged() {
			fail = httpx.Forbidden("FORBIDDEN", "нет доступа к аренде магазина")
			return
		}
		dto = s.rentDTOLocked(sh.ID)
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	httpx.JSON(w, http.StatusOK, dto)
}

type rentSubscribeRequest struct {
	PlanCode  string `json:"plan_code"`
	Asset     string `json:"asset"`
	Months    int    `json:"months"`
	AutoRenew bool   `json:"auto_renew"`
	TotpCode  string `json:"totp_code"`
}

func (s *Server) handleSubscribeRent(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req rentSubscribeRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	key := r.PathValue("id")
	if req.Months <= 0 {
		req.Months = 1
	}
	if req.Months > 12 {
		req.Months = 12
	}
	asset := strings.ToUpper(req.Asset)
	if asset != store.AssetSOL && asset != store.AssetStars {
		asset = store.AssetSOL
	}

	var (
		fail *httpx.APIError
		sh   *store.Shop
		plan *store.RentPlan
		sub  *store.RentSub
		txID string
	)

	s.Store.Read(func() {
		sh = s.findShopLocked(key)
		if sh == nil {
			fail = httpx.NotFound("магазин не найден")
			return
		}
		if sh.AdminUserID != u.ID && u.Role != store.RoleSuperAdmin {
			fail = httpx.Forbidden("FORBIDDEN", "аренду оплачивает админ магазина")
			return
		}
		plan = s.planByCodeLocked(req.PlanCode)
		if plan == nil {
			fail = httpx.BadRequest("неизвестный тариф аренды", nil)
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}

	chargeLamports := plan.PriceLamports * int64(req.Months)
	chargeStars := plan.PriceStars * int64(req.Months)
	if !s.requireOps(w, r, u, "rent", chargeLamports, chargeStars, req.TotpCode) {
		return
	}

	s.Store.Write(func() {
		s.Store.EnsureAccountLocked(store.OwnerUser, u.ID, asset)
		s.Store.EnsureAccountLocked(store.OwnerPlatform, store.PlatformRent, asset)
		var postings []store.Posting
		idem := "rent:" + sh.ID + ":" + plan.ID + ":" + time.Now().Format("20060102150405")
		if asset == store.AssetStars {
			postings = []store.Posting{
				store.Debit(store.UserAccount(u.ID, asset), chargeStars),
				store.Credit(store.PlatformAccount(store.PlatformRent, asset), chargeStars),
			}
		} else {
			postings = []store.Posting{
				store.Debit(store.UserAccount(u.ID, asset), chargeLamports),
				store.Credit(store.PlatformAccount(store.PlatformRent, asset), chargeLamports),
			}
		}
		var err error
		txID, err = s.Store.PostLocked(idem, asset, store.KindRent, "subscription", sh.ID, u.ID, postings)
		if err != nil {
			fail = mapLedgerError(err)
			return
		}
		now := time.Now().UTC()
		period := time.Duration(req.Months) * 30 * 24 * time.Hour
		existing := s.Store.Subs[sh.ID]
		if existing == nil {
			existing = &store.RentSub{ID: ids.New("sub"), ShopID: sh.ID, CreatedAt: now}
			s.Store.Subs[sh.ID] = existing
		}
		start := now
		if existing.PeriodEnd.After(now) && existing.PlanID == plan.ID {
			start = existing.PeriodEnd // продление текущего периода
		}
		existing.PlanID = plan.ID
		existing.Status = store.RentActive
		existing.Asset = asset
		existing.PriceLamports = chargeLamports
		existing.PriceStars = chargeStars
		existing.PeriodStart = start
		existing.PeriodEnd = start.Add(period)
		existing.GraceEnd = time.Time{}
		existing.AutoRenew = req.AutoRenew
		existing.RenewAttempts = 0
		existing.UpdatedAt = now
		sub = existing
		if sh.Status == store.ShopSuspended || sh.Status == store.ShopFrozen {
			sh.Status = store.ShopActive
		}
		sh.UpdatedAt = now
		s.feedScoresLocked()
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}

	crowned := false
	s.Store.Read(func() { crowned = s.Store.IsCrownedLocked(sh) })

	s.audit(r, u.ID, u.Role, "rent.subscribe", "subscription", sub.ID,
		"plan="+plan.Code+" months="+fmt.Sprint(req.Months), store.FactorOps, nil,
		map[string]any{"shop_id": sh.ID, "asset": asset, "tx_id": txID, "is_crowned": crowned})
	s.notify(u.ID, "rent.paid", "Аренда оплачена",
		fmt.Sprintf("Магазин «%s»: тариф %s до %s. Коронка: %v.", sh.Name, plan.NameRU,
			sub.PeriodEnd.Format("02.01.2006"), crowned),
		"rent:"+sub.ID+":"+sub.PeriodEnd.Format(time.RFC3339), map[string]any{"shop_id": sh.ID})

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"subscription_id": sub.ID, "status": sub.Status, "plan": plan.Code,
		"period_start": sub.PeriodStart, "period_end": sub.PeriodEnd,
		"charged": map[string]any{"asset": asset,
			"amount": amountStr(asset, chargeLamports, chargeStars)},
		"is_crowned": crowned, "tx_id": txID,
		"auto_renew": sub.AutoRenew,
	})
}

func amountStr(asset string, lamports, stars int64) any {
	if asset == store.AssetStars {
		return stars
	}
	return store.FormatSOL(lamports)
}

func mapLedgerError(err error) *httpx.APIError {
	switch {
	case err == store.ErrInsufficientFunds:
		return httpx.Unprocessable("INSUFFICIENT_FUNDS", "недостаточно средств на балансе")
	case err == store.ErrDuplicateTx:
		return httpx.Conflict("ALREADY_USED", "операция уже исполнена")
	case err == store.ErrUnbalanced:
		return httpx.Internal("операция несбалансирована (инвариант ledger)")
	case err == store.ErrBadAmount:
		return httpx.BadRequest("сумма должна быть больше нуля", nil)
	}
	return httpx.Internal("ошибка проводки: " + err.Error())
}

// ---------------------------------------------------------------------------
// Товары и сток (FR-PROD-*)
// ---------------------------------------------------------------------------

func (s *Server) handleListProducts(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	key := r.PathValue("id")
	search := strings.ToLower(strings.TrimSpace(q.Get("q")))
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	u, _ := s.currentUser(r)
	items := []map[string]any{}
	s.Store.Read(func() {
		sh := s.findShopLocked(key)
		if sh == nil {
			return
		}
		isOwner := u != nil && (u.ID == sh.AdminUserID || u.IsPrivileged())
		for _, p := range s.Store.Products {
			if p.ShopID != sh.ID {
				continue
			}
			if p.Status != store.ProductPublished && !isOwner {
				continue
			}
			if search != "" && !strings.Contains(strings.ToLower(p.Title), search) &&
				!strings.Contains(strings.ToLower(p.Description), search) {
				continue
			}
			// FR-GEO-03(б): товар запрещённой категории не отдаём покупателю страны.
			if !isOwner && geoBlockedCategoryLocked(s.Store, []int64{p.CategoryID}, countryOf(u)) != nil {
				continue
			}
			items = append(items, s.productDTOLocked(p))
		}
	})
	sort.Slice(items, func(i, j int) bool { return strval(items[i]["id"]) < strval(items[j]["id"]) })
	start, end, next, hasMore := s.page(len(items), limit, q.Get("cursor"))
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items[start:end], "next_cursor": next, "has_more": hasMore, "total": len(items),
	})
}

func (s *Server) handleGetProduct(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var (
		dto  map[string]any
		fail *httpx.APIError
	)
	u, _ := s.currentUser(r)
	s.Store.Read(func() {
		p, ok := s.Store.Products[id]
		if !ok {
			fail = httpx.NotFound("товар не найден")
			return
		}
		if p.Status != store.ProductPublished {
			sh := s.Store.Shops[p.ShopID]
			if sh == nil || (u == nil || (u.ID != sh.AdminUserID && !u.IsPrivileged())) {
				fail = httpx.NotFound("товар не найден")
				return
			}
		}
		// FR-GEO-03(б): запрещённая в стране покупателя категория — отказ.
		if cat := geoBlockedCategoryLocked(s.Store, []int64{p.CategoryID}, countryOf(u)); cat != nil {
			fail = httpx.Forbidden("GEO_BLOCKED",
				"товар недоступен в стране "+countryOf(u)+": категория «"+cat.NameRU+"»")
			return
		}
		dto = s.productDTOLocked(p)
		if sh, ok := s.Store.Shops[p.ShopID]; ok {
			dto["shop"] = s.shopCardLocked(sh, countryOf(u))
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	httpx.JSON(w, http.StatusOK, dto)
}

type productCreateRequest struct {
	Title         string   `json:"title"`
	Description   string   `json:"description"`
	Kind          string   `json:"kind"`
	CategoryID    int64    `json:"category_id"`
	PriceSOL      string   `json:"price_sol"`
	PriceStars    int64    `json:"price_stars"`
	WarrantyDays  int      `json:"warranty_days"`
	DeliverySLAH  int      `json:"delivery_sla_h"`
	StockItems    []string `json:"stock_items"`
	MediaURLs     []string `json:"media_urls"`
}

func (s *Server) handleCreateProduct(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	key := r.PathValue("id")
	var req productCreateRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var (
		fail *httpx.APIError
		sh   *store.Shop
		p    *store.Product
	)
	req.Title = strings.TrimSpace(req.Title)
	if len([]rune(req.Title)) < 3 || len([]rune(req.Title)) > 120 {
		httpx.Fail(w, r, httpx.BadRequest("название товара: 3–120 символов", nil))
		return
	}
	kind := req.Kind
	if kind == "" {
		kind = "key"
	}
	switch kind {
	case "key", "file", "account", "subscription", "service_code", "custom":
	default:
		httpx.Fail(w, r, httpx.BadRequest("недопустимый тип товара", nil))
		return
	}
	lamports, err := store.ParseSOL(req.PriceSOL)
	if err != nil || lamports < 0 {
		httpx.Fail(w, r, httpx.BadRequest("некорректная цена в SOL", nil))
		return
	}
	if lamports == 0 && req.PriceStars <= 0 {
		httpx.Fail(w, r, httpx.BadRequest("укажите цену в SOL или Stars", nil))
		return
	}

	s.Store.Write(func() {
		sh = s.findShopLocked(key)
		if sh == nil {
			fail = httpx.NotFound("магазин не найден")
			return
		}
		if sh.AdminUserID != u.ID {
			fail = httpx.Forbidden("FORBIDDEN", "товары создаёт админ магазина")
			return
		}
		if rent := s.Store.RentStatusLocked(sh.ID); rent == store.RentSuspended || rent == store.RentNone {
			fail = httpx.Unprocessable("RENT_REQUIRED", "оплатите аренду магазина, чтобы добавлять товары")
			return
		}
		// FR-GEO-03(б): категория товара недоступна в стране магазина.
		if cat := geoBlockedCategoryLocked(s.Store, []int64{req.CategoryID}, sh.Country); cat != nil {
			fail = httpx.Forbidden("GEO_BLOCKED",
				"категория «"+cat.NameRU+"» недоступна в стране "+sh.Country)
			return
		}
		if sub, ok := s.Store.Subs[sh.ID]; ok {
			if plan, ok := s.Store.RentPlans[sub.PlanID]; ok &&
				countProductsLocked(s.Store, sh.ID) >= plan.ProductLimit {
				fail = httpx.Forbidden("LIMIT_EXCEEDED",
					fmt.Sprintf("лимит товаров тарифа %s: %d", plan.Code, plan.ProductLimit))
				return
			}
		}
		// Первый товар магазина уходит на модерацию (FR-PROD-06).
		status := store.ProductPublished
		if countProductsLocked(s.Store, sh.ID) == 0 {
			status = store.ProductModeration
		}
		sla := req.DeliverySLAH
		if sla <= 0 {
			sla = 24
		}
		p = &store.Product{
			ID: ids.New("prd"), ShopID: sh.ID, Title: req.Title, Description: req.Description,
			Kind: kind, CategoryID: req.CategoryID, PriceLamports: lamports,
			PriceStars: req.PriceStars, MediaURLs: req.MediaURLs,
			WarrantyDays: req.WarrantyDays, DeliverySLAH: sla, Status: status,
			CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
		}
		s.Store.Products[p.ID] = p
		// Сток автовыдачи шифруется (FR-PROD-03).
		for _, payload := range req.StockItems {
			if strings.TrimSpace(payload) == "" {
				continue
			}
			itemID := ids.New("stk")
			ct, encErr := s.Crypto.EncryptString(store.DomainProductStock, itemID, payload)
			if encErr != nil {
				fail = httpx.Internal("не удалось зашифровать сток")
				return
			}
			s.Store.Stock[p.ID] = append(s.Store.Stock[p.ID], &store.StockItem{
				ID: itemID, ProductID: p.ID, PayloadCT: ct, Status: "free",
				CreatedAt: time.Now().UTC(),
			})
			p.StockTotal++
			p.StockFree++
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "product.create", "product", p.ID, "", "", nil,
		map[string]any{"title": p.Title, "status": p.Status, "stock": p.StockTotal})
	var dto map[string]any
	s.Store.Read(func() { dto = s.productDTOLocked(p) })
	httpx.JSON(w, http.StatusCreated, dto)
}

func (s *Server) handleUpdateProduct(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	var req productCreateRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var (
		fail *httpx.APIError
		p    *store.Product
	)
	s.Store.Write(func() {
		p = s.Store.Products[id]
		if p == nil {
			fail = httpx.NotFound("товар не найден")
			return
		}
		sh := s.Store.Shops[p.ShopID]
		if sh == nil || (sh.AdminUserID != u.ID && u.Role != store.RoleSuperAdmin) {
			fail = httpx.Forbidden("FORBIDDEN", "нет прав на товар")
			return
		}
		before := map[string]any{"title": p.Title, "price_sol": store.FormatSOL(p.PriceLamports),
			"description": p.Description, "status": p.Status}
		if req.Title != "" {
			p.Title = strings.TrimSpace(req.Title)
		}
		if req.Description != "" {
			p.Description = req.Description
		}
		if req.PriceSOL != "" {
			if lamports, err := store.ParseSOL(req.PriceSOL); err == nil {
				p.PriceLamports = lamports
			}
		}
		if req.PriceStars > 0 {
			p.PriceStars = req.PriceStars
		}
		if req.WarrantyDays > 0 {
			p.WarrantyDays = req.WarrantyDays
		}
		if req.DeliverySLAH > 0 {
			p.DeliverySLAH = req.DeliverySLAH
		}
		if len(req.MediaURLs) > 0 {
			p.MediaURLs = req.MediaURLs
		}
		// Существенные изменения возвращают товар в модерацию.
		if before["title"] != p.Title || before["price_sol"] != store.FormatSOL(p.PriceLamports) {
			if p.Status == store.ProductPublished && sh.SalesCount == 0 {
				p.Status = store.ProductModeration
			}
		}
		p.UpdatedAt = time.Now().UTC()
		s.audit(r, u.ID, u.Role, "product.update", "product", p.ID, "", "", before,
			map[string]any{"title": p.Title, "status": p.Status})
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	var dto map[string]any
	s.Store.Read(func() { dto = s.productDTOLocked(p) })
	httpx.JSON(w, http.StatusOK, dto)
}

type addStockRequest struct {
	Items []string `json:"items"`
}

func (s *Server) handleAddStock(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	var req addStockRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if len(req.Items) == 0 {
		httpx.Fail(w, r, httpx.BadRequest("передайте хотя бы одну позицию стока", nil))
		return
	}
	if len(req.Items) > 1000 {
		httpx.Fail(w, r, httpx.BadRequest("не более 1000 позиций за раз", nil))
		return
	}
	var (
		fail  *httpx.APIError
		added int
		p     *store.Product
	)
	s.Store.Write(func() {
		p = s.Store.Products[id]
		if p == nil {
			fail = httpx.NotFound("товар не найден")
			return
		}
		sh := s.Store.Shops[p.ShopID]
		if sh == nil || sh.AdminUserID != u.ID {
			fail = httpx.Forbidden("FORBIDDEN", "сток пополняет админ магазина")
			return
		}
		for _, payload := range req.Items {
			if strings.TrimSpace(payload) == "" {
				continue
			}
			itemID := ids.New("stk")
			ct, err := s.Crypto.EncryptString(store.DomainProductStock, itemID, payload)
			if err != nil {
				fail = httpx.Internal("не удалось зашифровать позицию стока")
				return
			}
			s.Store.Stock[p.ID] = append(s.Store.Stock[p.ID], &store.StockItem{
				ID: itemID, ProductID: p.ID, PayloadCT: ct, Status: "free",
				CreatedAt: time.Now().UTC(),
			})
			p.StockTotal++
			p.StockFree++
			added++
		}
		if p.Status == store.ProductDraft && added > 0 {
			p.Status = store.ProductPublished
		}
		p.UpdatedAt = time.Now().UTC()
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "product.stock_add", "product", p.ID,
		"added="+strconv.Itoa(added), "", nil, map[string]any{"stock_total": p.StockTotal})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"product_id": p.ID, "added": added, "stock_free": p.StockFree, "stock_total": p.StockTotal,
	})
}

// ---------------------------------------------------------------------------
// Отзывы (FR-REV-*)
// ---------------------------------------------------------------------------

func (s *Server) handleListReviews(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("id")
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	ratingFilter, _ := strconv.Atoi(q.Get("rating"))
	sortBy := q.Get("sort")

	shopID := key
	items := []map[string]any{}
	var summary map[string]any
	s.Store.Read(func() {
		sh := s.findShopLocked(key)
		if sh != nil {
			shopID = sh.ID
		}
		dist := map[int]int{1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
		for _, rv := range s.Store.Reviews {
			if rv.ShopID != shopID || rv.Status != "published" {
				continue
			}
			if ratingFilter > 0 && rv.Rating != ratingFilter {
				continue
			}
			dist[rv.Rating]++
			items = append(items, s.reviewDTOLocked(rv))
		}
		total := 0
		for _, v := range dist {
			total += v
		}
		pos := dist[4] + dist[5]
		pct := 0
		if total > 0 {
			pct = int(math.Round(float64(pos) / float64(total) * 100))
		}
		bayes := 0.0
		if sh != nil {
			bayes = round1(sh.RatingBayes)
		}
		summary = map[string]any{
			"bayes": bayes, "count": total, "positive_pct": pct,
			"distribution": map[string]any{
				"5": dist[5], "4": dist[4], "3": dist[3], "2": dist[2], "1": dist[1],
			},
		}
	})
	switch sortBy {
	case "helpful":
		sort.Slice(items, func(i, j int) bool { return inum(items[i]["helpful_count"]) > inum(items[j]["helpful_count"]) })
	default:
		sort.Slice(items, func(i, j int) bool {
			a, _ := items[i]["created_at"].(time.Time)
			b, _ := items[j]["created_at"].(time.Time)
			return a.After(b)
		})
	}
	start, end, next, hasMore := s.page(len(items), limit, q.Get("cursor"))
	httpx.JSON(w, http.StatusOK, map[string]any{
		"summary": summary, "items": items[start:end], "next_cursor": next,
		"has_more": hasMore, "total": len(items),
	})
}

func (s *Server) handleReplyReview(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	var req struct {
		Body string `json:"body"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" || len([]rune(body)) > 500 {
		httpx.Fail(w, r, httpx.BadRequest("ответ: 1–500 символов", nil))
		return
	}
	var (
		fail *httpx.APIError
		rv   *store.Review
	)
	s.Store.Write(func() {
		rv = s.Store.Reviews[id]
		if rv == nil {
			fail = httpx.NotFound("отзыв не найден")
			return
		}
		sh := s.Store.Shops[rv.ShopID]
		if sh == nil || sh.AdminUserID != u.ID {
			fail = httpx.Forbidden("FORBIDDEN", "отвечает админ магазина")
			return
		}
		if rv.ShopReply != "" {
			fail = httpx.Conflict("ALREADY_USED", "ответ уже оставлен")
			return
		}
		rv.ShopReply = body
		rv.ShopReplyAt = time.Now().UTC()
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "review.reply", "review", rv.ID, "", "", nil, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "ok", "review_id": rv.ID})
}

func (s *Server) handleReportReview(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	var req struct {
		Reason  string `json:"reason"`
		Comment string `json:"comment"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	switch req.Reason {
	case "spam", "abuse", "pii", "fake", "other":
	default:
		httpx.Fail(w, r, httpx.BadRequest("недопустимая причина жалобы", nil))
		return
	}
	var fail *httpx.APIError
	reportID := ids.New("rpt")
	s.Store.Write(func() {
		if _, ok := s.Store.Reviews[id]; !ok {
			fail = httpx.NotFound("отзыв не найден")
			return
		}
		s.Store.Reports[reportID] = &store.ReviewReport{
			ID: reportID, ReviewID: id, ReporterID: u.ID, Reason: req.Reason,
			Comment: req.Comment, Status: "pending", CreatedAt: time.Now().UTC(),
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "review.report", "review", id, req.Reason, "", nil, nil)
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": reportID, "status": "pending"})
}

// currentUser возвращает пользователя по Principal без записи ошибки в ответ.
func (s *Server) currentUser(r *http.Request) (*store.User, error) {
	p := s.principal(r)
	if p == nil || !p.Authorized {
		return nil, nil
	}
	var u *store.User
	s.Store.Read(func() { u = s.Store.Users[p.UserID] })
	return u, nil
}
