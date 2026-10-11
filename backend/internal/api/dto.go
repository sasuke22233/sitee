package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/sasuke22233/sitee/backend/internal/store"
)

// ---------------------------------------------------------------------------
// DTO: пользователь
// ---------------------------------------------------------------------------

func (s *Server) userDTO(u *store.User) map[string]any {
	return s.userDTOLocked(u)
}

// userDTOLocked собирает публичный/профильный DTO пользователя.
// Вызывать внутри Store.Read/Write (или когда гонки исключены).
func (s *Server) userDTOLocked(u *store.User) map[string]any {
	factors := map[string]string{"login": "pending", "ops": "pending"}
	for name, f := range u.Factors {
		factors[name] = f.Status
	}
	cityName := ""
	countryName := ""
	if c, ok := s.Store.Cities[u.CityID]; ok {
		cityName = c.NameRU
	}
	if c, ok := s.Store.Countries[u.Country]; ok {
		countryName = c.NameRU
	}
	shops := []map[string]any{}
	for _, sh := range s.Store.Shops {
		if sh.AdminUserID == u.ID {
			shops = append(shops, map[string]any{
				"id": sh.ID, "slug": sh.Slug, "name": sh.Name, "status": sh.Status,
				"rent_status": s.Store.RentStatusLocked(sh.ID),
				"is_crowned":  s.Store.IsCrownedLocked(sh),
				"rating":      round1(sh.RatingBayes),
			})
		}
	}
	sort.Slice(shops, func(i, j int) bool { return shops[i]["name"].(string) < shops[j]["name"].(string) })

	unread := 0
	for chatID, members := range s.Store.Members {
		for _, m := range members {
			if m.UserID != u.ID || m.LeftAt != (time.Time{}) {
				continue
			}
			if chat, ok := s.Store.Chats[chatID]; ok && chat.LastSeq > m.LastReadSeq {
				unread += int(chat.LastSeq - m.LastReadSeq)
			}
		}
	}

	gifts := 0
	for _, gp := range s.Store.GiftPurch {
		if gp.RecipientType == "user" && gp.RecipientID == u.ID && gp.Status == "paid" {
			gifts++
		}
		if gp.RecipientType == "self" && gp.BuyerID == u.ID && gp.Status == "paid" {
			gifts++
		}
	}

	return map[string]any{
		"id": u.ID, "nickname": u.Nickname, "role": u.Role,
		"country": u.Country, "country_name": countryName,
		"city_id": u.CityID, "city_name": cityName,
		"locale": u.Locale, "theme": u.Theme, "status": u.Status,
		"is_18plus": u.Is18Plus,
		"factors":   factors,
		"balances": map[string]any{
			"SOL":     store.FormatSOL(s.Store.UserBalanceLocked(u.ID, store.AssetSOL)),
			"SOL_raw": s.Store.UserBalanceLocked(u.ID, store.AssetSOL),
			"STARS":   s.Store.UserBalanceLocked(u.ID, store.AssetStars),
		},
		"shops":         shops,
		"gifts_count":   gifts,
		"unread":        map[string]any{"chats": unread},
		"created_at":    u.CreatedAt,
		"last_login_at": u.LastLoginAt,
		"warmup_until":  u.WarmupUntil,
		"is_privileged": u.IsPrivileged(),
		"risk_score":    u.RiskScore,
	}
}

// ---------------------------------------------------------------------------
// DTO: магазин и лента (FR-FEED-*)
// ---------------------------------------------------------------------------

// feedScoresLocked пересчитывает score магазинов (FR-FEED-05).
func (s *Server) feedScoresLocked() {
	now := time.Now()
	for _, sh := range s.Store.Shops {
		sh.FeedScore = s.feedScoreLocked(sh, now)
		// Актуальность буста от подарков.
		if !sh.GiftBoostUntil.IsZero() && now.After(sh.GiftBoostUntil) {
			sh.GiftBoost = 0
			sh.GiftBoostUntil = time.Time{}
		}
	}
}

func (s *Server) feedScoreLocked(sh *store.Shop, now time.Time) float64 {
	rating := norm(sh.RatingBayes, 0, 5)
	sales := math.Log10(float64(sh.SalesCount)+1) / 4
	if sales > 1 {
		sales = 1
	}
	recency := 1.0
	if age := now.Sub(sh.CreatedAt).Hours(); age > 0 {
		recency = 1 / (1 + age/(24*30))
	}
	rentBoost := 0.0
	if sub, ok := s.Store.Subs[sh.ID]; ok {
		if plan, ok := s.Store.RentPlans[sub.PlanID]; ok && (sub.Status == store.RentActive ||
			sub.Status == store.RentExpiring || sub.Status == store.RentTrial) {
			rentBoost = plan.FeedBoost
		}
	}
	response := 0.0
	if sh.ResponseP50S > 0 {
		response = 1 - math.Min(1, float64(sh.ResponseP50S)/3600)
	}
	geo := 0.5 // нейтральное значение; буст «рядом» добавляется в выдаче
	score := 0.30*rating + 0.20*sales + 0.15*recency + 0.15*rentBoost +
		0.10*geo + 0.05*response + 0.05*math.Min(sh.GiftBoost, 0.6) -
		0.20*sh.ComplaintPenalty - 0.30*sh.DisputeLossPenalty
	return math.Round(score*10000) / 10000
}

func norm(v, lo, hi float64) float64 {
	if hi <= lo {
		return 0
	}
	x := (v - lo) / (hi - lo)
	if x < 0 {
		return 0
	}
	if x > 1 {
		return 1
	}
	return x
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

// shopCardLocked — карточка магазина для ленты (FR-FEED-02).
// coverURL — обложка магазина как data-URI SVG (FR-FEED-02: обложка, название,
// рейтинг, коронка). Если продавец не загрузил свою, генерируем детерминированную
// из акцента и инициалов: работает офлайн и без внешних CDN.
// Зеркалирует coverSvg в tools/preview/lib.mjs.
func coverURL(sh *store.Shop) string {
	if sh.CoverURL != "" {
		return sh.CoverURL
	}
	// Акцент берём из палитры по хэшу id — детерминированно и без правок схемы.
	palette := []string{"6c5ce7", "2f80ed", "219653", "b7791f", "c53030", "805ad5", "03888e", "d53f8c"}
	var ph uint32 = 2166136261
	for _, c := range sh.ID {
		ph = ph*16777619 ^ uint32(c)
	}
	accent := palette[int(ph)%len(palette)]
	var num int64
	for _, c := range accent {
		var v int64
		switch {
		case c >= '0' && c <= '9':
			v = int64(c - '0')
		case c >= 'a' && c <= 'f':
			v = int64(c-'a') + 10
		case c >= 'A' && c <= 'F':
			v = int64(c-'A') + 10
		default:
			v = 0
		}
		num = num*16 + v
	}
	hex := func(v int64) string {
		if v < 0 {
			v = 0
		}
		const digits = "0123456789abcdef"
		return string([]byte{digits[(v>>4)&0xf], digits[v&0xf]})
	}
	top := "#" + hex((num>>16)&0xff) + hex((num>>8)&0xff) + hex(num&0xff)
	dark := func(v int64) int64 {
		if v < 55 {
			return 0
		}
		return v - 55
	}
	bottom := "#" + hex(dark((num>>16)&0xff)) + hex(dark((num>>8)&0xff)) + hex(dark(num&0xff))

	var h uint32 = 2166136261
	for _, c := range sh.ID {
		h = h*16777619 ^ uint32(c)
	}
	rnd := func(n int) int {
		h = h*1103515245 + 12345
		return int(h % uint32(n))
	}
	var b strings.Builder
	for i := 0; i < 5; i++ {
		fmt.Fprintf(&b, `<circle cx="%d" cy="%d" r="%d" fill="#ffffff" opacity="0.%02d"/>`,
			20+rnd(280), 10+rnd(70), 12+rnd(38), 4+rnd(7))
	}
	for i := 0; i < 3; i++ {
		fmt.Fprintf(&b, `<rect x="%d" y="%d" width="%d" height="3" rx="1.5" fill="#ffffff" opacity="0.%02d"/>`,
			rnd(300), rnd(80), 18+rnd(40), 5+rnd(6))
	}
	initials := shopInitials(sh.Name)
	svg := `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160">` +
		`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
		`<stop offset="0" stop-color="` + top + `"/><stop offset="1" stop-color="` + bottom + `"/>` +
		`</linearGradient></defs><rect width="320" height="160" fill="url(#g)"/>` + b.String() +
		`<text x="160" y="98" font-family="Inter,system-ui,sans-serif" font-size="52" ` +
		`font-weight="800" fill="#ffffff" fill-opacity=".92" text-anchor="middle">` + initials +
		`</text></svg>`
	return "data:image/svg+xml;utf8," + url.QueryEscape(svg)
}

// shopInitials — до двух первых букв слов названия («КлючМастер» → «КМ»).
func shopInitials(name string) string {
	words := strings.Fields(name)
	var out []string
	for _, w := range words {
		if w == "" {
			continue
		}
		r := []rune(w)
		out = append(out, strings.ToUpper(string(r[0])))
		if len(out) == 2 {
			break
		}
	}
	if len(out) == 0 {
		r := []rune(name)
		if len(r) > 2 {
			r = r[:2]
		}
		return strings.ToUpper(string(r))
	}
	return strings.Join(out, "")
}

func (s *Server) shopCardLocked(sh *store.Shop, viewerCountry string) map[string]any {
	city := ""
	if c, ok := s.Store.Cities[sh.CityID]; ok {
		city = c.NameRU
	}
	cats := []map[string]any{}
	for _, id := range sh.CategoryIDs {
		if c, ok := s.Store.Categories[id]; ok {
			cats = append(cats, map[string]any{"id": c.ID, "slug": c.Slug, "name_ru": c.NameRU})
		}
	}
	priceFrom := int64(-1)
	for _, p := range s.Store.Products {
		if p.ShopID == sh.ID && p.Status == store.ProductPublished {
			if priceFrom < 0 || p.PriceLamports < priceFrom {
				priceFrom = p.PriceLamports
			}
		}
	}
	score := sh.FeedScore
	if viewerCountry != "" && sh.Country == viewerCountry {
		score += 0.05 // geo_boost «магазины рядом»
	}
	badges := []string{}
	if sh.IsVerified {
		badges = append(badges, "verified")
	}
	if sh.SalesCount >= 500 {
		badges = append(badges, "top_seller")
	}
	if sh.GiftBoost > 0 {
		badges = append(badges, "boosted")
	}
	return map[string]any{
		"id": sh.ID, "slug": sh.Slug, "name": sh.Name,
		"cover_url":    coverURL(sh),
		"avatar_url":   sh.AvatarURL,
		"rating":       round1(sh.RatingBayes),
		"rating_count": sh.RatingCount,
		"is_crowned":   s.Store.IsCrownedLocked(sh),
		"is_verified":  sh.IsVerified,
		"country":      sh.Country, "city": city,
		"sales_count":    sh.SalesCount,
		"response_p50_s": sh.ResponseP50S,
		"categories":     cats,
		"price_from_sol": priceFromStr(priceFrom),
		"badges":         badges,
		"promoted":       false,
		"rent_status":    s.Store.RentStatusLocked(sh.ID),
		"score":          math.Round(score*10000) / 10000,
		"accepts_stars":  sh.AcceptsStars,
		"status":         sh.Status,
		"sanction":       sh.SanctionLevel,
	}
}

func priceFromStr(lamports int64) any {
	if lamports < 0 {
		return nil
	}
	return store.FormatSOL(lamports)
}

// shopDetailLocked — полная карточка магазина (FR-FEED-08).
func (s *Server) shopDetailLocked(sh *store.Shop, viewer *store.User) map[string]any {
	card := s.shopCardLocked(sh, countryOf(viewer))
	admin := s.Store.Users[sh.AdminUserID]
	adminDTO := map[string]any{"visible_as": "Админ магазина", "is_online": false}
	if admin != nil {
		adminDTO["nickname"] = admin.Nickname
		adminDTO["is_online"] = s.Hub.Online(admin.ID)
		adminDTO["registered_at"] = admin.CreatedAt
	}
	card["admin"] = adminDTO
	card["description"] = sh.Description
	card["tz"] = sh.TZ
	card["stats"] = map[string]any{
		"dispute_rate":   sh.DisputeRate,
		"sales_volume":   store.FormatSOL(sh.SalesVolumeLamport),
		"positive_pct":   positivePctLocked(s.Store, sh.ID),
		"response_p50_s": sh.ResponseP50S,
	}
	card["actions"] = map[string]any{
		"can_chat":  true,
		"can_order": sh.Status == store.ShopActive && s.Store.RentStatusLocked(sh.ID) != store.RentGrace,
		"can_gift":  true,
		"is_owner":  viewer != nil && viewer.ID == sh.AdminUserID,
	}
	products := []map[string]any{}
	for _, p := range s.Store.Products {
		if p.ShopID == sh.ID && p.Status == store.ProductPublished {
			products = append(products, s.productDTOLocked(p))
		}
	}
	sort.Slice(products, func(i, j int) bool {
		return fmt.Sprint(products[i]["title"]) < fmt.Sprint(products[j]["title"])
	})
	card["products"] = products
	card["rent"] = s.rentDTOLocked(sh.ID)
	return card
}

func countryOf(u *store.User) string {
	if u == nil {
		return ""
	}
	return u.Country
}

func positivePctLocked(st *store.Store, shopID string) int {
	total, pos := 0, 0
	for _, r := range st.Reviews {
		if r.ShopID != shopID || r.Status != "published" {
			continue
		}
		total++
		if r.Rating >= 4 {
			pos++
		}
	}
	if total == 0 {
		return 0
	}
	return int(math.Round(float64(pos) / float64(total) * 100))
}

// recalcRatingLocked пересчитывает байесовский рейтинг магазина (FR-REV-02).
func (s *Server) recalcRatingLocked(shopID string) {
	sh, ok := s.Store.Shops[shopID]
	if !ok {
		return
	}
	var sum int64
	count := 0
	for _, r := range s.Store.Reviews {
		if r.ShopID == shopID && r.Status == "published" {
			sum += int64(r.Rating)
			count++
		}
	}
	sh.RatingSum = sum
	sh.RatingCount = count
	const (
		C = 10.0
		m = 3.8
	)
	sh.RatingBayes = (C*m + float64(sum)) / (C + float64(count))
}

// ---------------------------------------------------------------------------
// DTO: аренда (FR-SHOP-04…07)
// ---------------------------------------------------------------------------

func (s *Server) rentDTOLocked(shopID string) map[string]any {
	sub, ok := s.Store.Subs[shopID]
	if !ok {
		return map[string]any{"status": store.RentNone}
	}
	plan := s.Store.RentPlans[sub.PlanID]
	planCode := ""
	if plan != nil {
		planCode = plan.Code
	}
	out := map[string]any{
		"id": sub.ID, "shop_id": sub.ShopID, "plan": planCode, "status": sub.Status,
		"asset": sub.Asset, "period_start": sub.PeriodStart, "period_end": sub.PeriodEnd,
		"auto_renew": sub.AutoRenew, "renew_attempts": sub.RenewAttempts,
	}
	if sub.Asset == store.AssetStars {
		out["price"] = fmt.Sprint(sub.PriceStars)
	} else {
		out["price"] = store.FormatSOL(sub.PriceLamports)
	}
	days := int(math.Ceil(sub.PeriodEnd.Sub(time.Now()).Hours() / 24))
	if days < 0 {
		days = 0
	}
	out["days_left"] = days
	if !sub.GraceEnd.IsZero() {
		out["grace_end"] = sub.GraceEnd
	}
	if sh, ok := s.Store.Shops[shopID]; ok {
		out["is_crowned"] = s.Store.IsCrownedLocked(sh)
	}
	return out
}

func (s *Server) rentPlanDTO(p *store.RentPlan) map[string]any {
	return map[string]any{
		"id": p.ID, "code": p.Code, "name_ru": p.NameRU, "name_en": p.NameEN,
		"price_sol": store.FormatSOL(p.PriceLamports), "price_stars": p.PriceStars,
		"product_limit": p.ProductLimit, "operator_limit": p.OperatorLimit,
		"fee_bps": p.FeeBPS, "fee_pct": float64(p.FeeBPS) / 100,
		"feed_boost": p.FeedBoost, "grants_crown": p.GrantsCrown,
		"support_sla_h": p.SupportSLAH, "active": p.Active, "description": p.Description,
	}
}

// ---------------------------------------------------------------------------
// DTO: товары
// ---------------------------------------------------------------------------

func (s *Server) productDTOLocked(p *store.Product) map[string]any {
	rating := 0.0
	if p.RatingCount > 0 {
		rating = float64(p.RatingSum) / float64(p.RatingCount)
	}
	return map[string]any{
		"id": p.ID, "shop_id": p.ShopID, "title": p.Title, "description": p.Description,
		"kind": p.Kind, "price_sol": store.FormatSOL(p.PriceLamports), "price_stars": p.PriceStars,
		"price_sol_raw":  p.PriceLamports,
		"media_urls":     p.MediaURLs,
		"stock_free":     p.StockFree,
		"stock_total":    p.StockTotal,
		"warranty_days":  p.WarrantyDays,
		"delivery_sla_h": p.DeliverySLAH,
		"status":         p.Status,
		"rating":         round1(rating),
		"rating_count":   p.RatingCount,
		"delivery_kind":  deliveryKindOf(p),
		"created_at":     p.CreatedAt,
	}
}

func deliveryKindOf(p *store.Product) string {
	switch p.Kind {
	case "custom":
		return "manual"
	case "file":
		return "file"
	}
	if p.StockTotal > 0 {
		return "auto"
	}
	return "manual"
}

// ---------------------------------------------------------------------------
// DTO: заказы (FR-ORD-*)
// ---------------------------------------------------------------------------

func (s *Server) orderDTOLocked(o *store.Order, role string) map[string]any {
	shop := s.Store.Shops[o.ShopID]
	shopDTO := map[string]any{"id": o.ShopID}
	if shop != nil {
		shopDTO["name"] = shop.Name
		shopDTO["slug"] = shop.Slug
		shopDTO["is_crowned"] = s.Store.IsCrownedLocked(shop)
	}
	items := []map[string]any{}
	for _, it := range o.Items {
		items = append(items, map[string]any{
			"id": it.ID, "product_id": it.ProductID, "title": it.Title, "qty": it.Qty,
			"unit_price_sol":   store.FormatSOL(it.UnitLamports),
			"unit_price_stars": it.UnitStars,
			"delivered_at":     it.DeliveredAt,
			"has_delivery":     it.DeliveredPayloadCT != "",
		})
	}
	timeline := []map[string]any{}
	for _, ev := range s.Store.OrderStatuses {
		if ev.OrderID != o.ID {
			continue
		}
		timeline = append(timeline, map[string]any{
			"status": ev.To, "title": store.StatusTitleRU(ev.To), "ts": ev.TS,
			"actor": ev.ActorKind, "reason": ev.Reason,
		})
	}
	asset := o.PayAsset
	if asset == "" {
		asset = store.AssetSOL
	}
	totals := map[string]any{"asset": asset}
	if asset == store.AssetStars {
		totals["subtotal"] = o.SubtotalStars
		totals["fee"] = o.FeeStars
		totals["total"] = o.TotalStars
	} else {
		totals["subtotal"] = store.FormatSOL(o.SubtotalLamports)
		totals["fee"] = store.FormatSOL(o.FeeLamports)
		totals["total"] = store.FormatSOL(o.TotalLamports)
		totals["total_raw"] = o.TotalLamports
	}
	dto := map[string]any{
		"id": o.ID, "number": o.Number, "status": o.Status,
		"status_title":  store.StatusTitleRU(o.Status),
		"shop":          shopDTO,
		"items":         items,
		"totals":        totals,
		"delivery_kind": o.DeliveryKind,
		"created_at":    o.CreatedAt,
		"actions":       store.OrderActionsRU(o.Status, role),
		"chat_id":       o.ChatID,
		"fee_bps":       o.FeeBPS,
	}
	if !o.PayDeadline.IsZero() {
		dto["pay_deadline"] = o.PayDeadline
	}
	if !o.ConfirmDeadline.IsZero() {
		dto["confirm_deadline"] = o.ConfirmDeadline
		dto["extend_used"] = o.ExtendUsed
	}
	if !o.DeliveryDeadline.IsZero() {
		dto["delivery_deadline"] = o.DeliveryDeadline
	}
	if o.DisputeID != "" {
		if d, ok := s.Store.Disputes[o.DisputeID]; ok {
			dto["dispute"] = s.disputeBriefLocked(d, role)
		}
	}
	if o.ReviewID != "" {
		dto["review_id"] = o.ReviewID
	}
	return dto
}

// ---------------------------------------------------------------------------
// DTO: чаты и сообщения (FR-MSG-*)
// ---------------------------------------------------------------------------

func (s *Server) chatDTOLocked(c *store.Chat, viewerID string) map[string]any {
	dto := map[string]any{
		"id": c.ID, "kind": c.Kind, "title": c.Title, "e2ee": c.E2EE,
		"last_seq": c.LastSeq, "pinned": c.Pinned, "created_at": c.CreatedAt,
		"last_message_at": c.LastMessageAt,
	}
	if c.ShopID != "" {
		if sh, ok := s.Store.Shops[c.ShopID]; ok {
			dto["shop"] = map[string]any{
				"id": sh.ID, "name": sh.Name, "slug": sh.Slug,
				"avatar_url": sh.AvatarURL, "is_crowned": s.Store.IsCrownedLocked(sh),
			}
		}
	}
	if c.OrderID != "" {
		dto["order_id"] = c.OrderID
		if o, ok := s.Store.Orders[c.OrderID]; ok {
			dto["order_status"] = o.Status
			dto["order_number"] = o.Number
		}
	}
	if c.DisputeID != "" {
		dto["dispute_id"] = c.DisputeID
	}
	if c.AdminUserID != "" {
		admin := s.Store.Users[c.AdminUserID]
		dto["admin"] = map[string]any{
			"visible_as": "Админ магазина",
			"is_online":  s.Hub.Online(c.AdminUserID),
			"nickname":   s.nicknameOrMaskedLocked(admin, viewerID, c),
		}
	}
	unread := 0
	for _, m := range s.Store.Members[c.ID] {
		if m.UserID == viewerID {
			if c.LastSeq > m.LastReadSeq {
				unread = int(c.LastSeq - m.LastReadSeq)
			}
			dto["is_muted"] = m.Muted
			dto["role"] = m.Role
			dto["visible_as"] = m.VisibleAs
			dto["last_read_seq"] = m.LastReadSeq
		}
	}
	dto["unread"] = unread
	if msgs := s.Store.Messages[c.ID]; len(msgs) > 0 {
		last := msgs[len(msgs)-1]
		dto["last_message"] = map[string]any{
			"preview": previewLocked(s, c, last, viewerID),
			"ts":      last.CreatedAt,
			"sender":  last.SenderID,
			"seq":     last.Seq,
			"type":    last.Type,
		}
	}
	members := []map[string]any{}
	for _, m := range s.Store.Members[c.ID] {
		if !m.LeftAt.IsZero() {
			continue
		}
		name := m.VisibleAs
		if name == "" {
			if u, ok := s.Store.Users[m.UserID]; ok {
				name = u.Nickname
			}
		}
		if c.Kind == store.ChatDispute && m.UserID != viewerID && !isArbiterMember(s.Store, c.ID, viewerID) {
			name = m.VisibleAs // маскировка (FR-DSP-03)
		}
		members = append(members, map[string]any{
			"user_id": m.UserID, "role": m.Role, "visible_as": name,
			"is_self": m.UserID == viewerID, "is_online": s.Hub.Online(m.UserID),
		})
	}
	dto["members"] = members
	return dto
}

func isArbiterMember(st *store.Store, chatID, userID string) bool {
	u, ok := st.Users[userID]
	if !ok {
		return false
	}
	return u.Role == store.RoleArbiter || u.Role == store.RoleSuperAdmin
}

// nicknameOrMaskedLocked возвращает ник или маскированный псевдоним (для споров).
func (s *Server) nicknameOrMaskedLocked(u *store.User, viewerID string, c *store.Chat) string {
	if u == nil {
		return ""
	}
	if c.Kind == store.ChatDispute && u.ID != viewerID {
		for _, m := range s.Store.Members[c.ID] {
			if m.UserID == u.ID && m.VisibleAs != "" {
				return m.VisibleAs
			}
		}
		return "Участник"
	}
	return u.Nickname
}

func previewLocked(s *Server, c *store.Chat, m *store.Message, viewerID string) string {
	if m.Type == "system" {
		return systemTitle(m)
	}
	if m.DeletedAt != (time.Time{}) {
		return "сообщение удалено"
	}
	if c.E2EE || m.E2EE {
		return "<encrypted>"
	}
	// Серверное шифрование: превью доступно только участникам чата.
	if !s.Store.IsMemberLocked(c.ID, viewerID) {
		return ""
	}
	plain, err := s.Crypto.DecryptString(store.DomainMessage, m.ID, m.BodyCT)
	if err != nil {
		return "<encrypted>"
	}
	plain = strings.ReplaceAll(plain, "\n", " ")
	if len([]rune(plain)) > 80 {
		return string([]rune(plain)[:80]) + "…"
	}
	return plain
}

func systemTitle(m *store.Message) string {
	switch m.System.Kind {
	case "order_status":
		return "Статус заказа: " + store.StatusTitleRU(m.System.Status)
	case "gift":
		return "Подарок: " + m.System.Title
	case "dispute":
		return "Спор: " + m.System.Title
	case "rent":
		return "Аренда: " + m.System.Title
	}
	return m.System.Title
}

func (s *Server) messageDTOLocked(c *store.Chat, m *store.Message, viewerID string) map[string]any {
	dto := map[string]any{
		"id": m.ID, "chat_id": m.ChatID, "seq": m.Seq, "type": m.Type,
		"sender_id": m.SenderID, "e2ee": m.E2EE || c.E2EE,
		"created_at": m.CreatedAt, "client_msg_id": m.ClientMsgID,
		"is_self": m.SenderID == viewerID,
	}
	// Маскировка отправителя в спорах (FR-DSP-03).
	senderName := ""
	if u, ok := s.Store.Users[m.SenderID]; ok {
		senderName = u.Nickname
	}
	if c.Kind == store.ChatDispute && m.SenderID != viewerID && !isArbiterMember(s.Store, c.ID, viewerID) {
		senderName = m.SenderVisibleAs
	}
	if m.SenderVisibleAs != "" && c.Kind == store.ChatDispute {
		dto["sender_visible_as"] = m.SenderVisibleAs
	} else {
		dto["sender_visible_as"] = senderName
	}
	if m.ReplyTo != "" {
		dto["reply_to"] = m.ReplyTo
	}
	if !m.EditedAt.IsZero() {
		dto["edited_at"] = m.EditedAt
	}
	if !m.DeletedAt.IsZero() {
		dto["deleted_at"] = m.DeletedAt
		dto["body"] = ""
		return dto
	}
	if m.Type == "system" {
		dto["system"] = map[string]any{
			"kind": m.System.Kind, "title": m.System.Title, "status": m.System.Status,
			"order_id": m.System.OrderID, "gift_id": m.System.GiftID,
			"amount": m.System.Amount, "asset": m.System.Asset,
		}
		dto["body"] = systemTitle(m)
		return dto
	}
	if c.E2EE || m.E2EE {
		dto["body_ct"] = m.BodyCT
		dto["body"] = nil
		dto["sender_key_id"] = m.SenderKeyID
		return dto
	}
	dto["body_ct"] = "<encrypted-at-rest>"
	if s.Store.IsMemberLocked(c.ID, viewerID) {
		if plain, err := s.Crypto.DecryptString(store.DomainMessage, m.ID, m.BodyCT); err == nil {
			dto["body"] = plain
		} else {
			dto["body"] = "<decrypt-error>"
		}
	}
	return dto
}

// ---------------------------------------------------------------------------
// DTO: споры (маскировка, FR-DSP-03)
// ---------------------------------------------------------------------------

// aliasFor генерирует стабильный маскированный псевдоним в рамках спора.
func aliasFor(salt, userID, role string) string {
	mac := hmac.New(sha256.New, []byte("sitee-dispute-alias-v1:"+salt))
	mac.Write([]byte(userID))
	sum := mac.Sum(nil)
	code := base36Code(sum, 3)
	switch role {
	case "buyer":
		return "Покупатель #" + code
	case "shop":
		return "Продавец #" + code
	}
	return "Участник #" + code
}

// base36Code — детерминированный буквенно-цифровой код фиксированной длины
// (для маскировки сторон в споре, FR-DSP-03).
func base36Code(sum []byte, length int) string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	out := make([]byte, length)
	for i := 0; i < length; i++ {
		out[i] = alphabet[int(sum[i])%len(alphabet)]
	}
	return string(out)
}

func (s *Server) disputeBriefLocked(d *store.Dispute, role string) map[string]any {
	return map[string]any{
		"id": d.ID, "status": d.Status, "reason_code": d.ReasonCode,
		"chat_id": d.ChatID, "created_at": d.CreatedAt,
		"reply_deadline": d.ReplyDeadline,
	}
}

func (s *Server) disputeDTOLocked(d *store.Dispute, viewer *store.User) map[string]any {
	youAre := "buyer"
	switch {
	case viewer == nil:
		youAre = "buyer"
	case viewer.ID == d.SellerID:
		youAre = "shop_admin"
	case viewer.ID == d.ArbiterID || viewer.Role == store.RoleArbiter || viewer.Role == store.RoleSuperAdmin:
		youAre = "arbiter"
	}
	reveal := youAre == "arbiter"

	yourAlias, counterAlias := d.BuyerAlias, d.SellerAlias
	if youAre == "shop_admin" {
		yourAlias, counterAlias = d.SellerAlias, d.BuyerAlias
	}

	participants := []map[string]any{}
	buyer := s.Store.Users[d.BuyerID]
	seller := s.Store.Users[d.SellerID]
	addParticipant := func(u *store.User, role, alias string) {
		if u == nil {
			return
		}
		p := map[string]any{"role": role, "visible_as": alias}
		if reveal {
			p["id"] = u.ID
			p["nickname"] = u.Nickname
			p["country"] = u.Country
			p["registered_at"] = u.CreatedAt
		}
		participants = append(participants, p)
	}
	addParticipant(buyer, "buyer", d.BuyerAlias)
	addParticipant(seller, "shop_admin", d.SellerAlias)
	if d.ArbiterID != "" {
		if arb := s.Store.Users[d.ArbiterID]; arb != nil {
			p := map[string]any{"role": "arbiter", "visible_as": "Арбитр"}
			if reveal {
				p["id"] = arb.ID
				p["nickname"] = arb.Nickname
			}
			participants = append(participants, p)
		}
	}

	evidence := []map[string]any{}
	for _, ev := range d.Evidence {
		item := map[string]any{
			"id": ev.ID, "kind": ev.Kind, "sha256": ev.SHA256, "size": ev.Size,
			"name": ev.Name, "created_at": ev.CreatedAt, "meta_stripped": ev.MetaStripped,
		}
		if reveal || (viewer != nil && ev.UploaderID == viewer.ID) {
			item["uploader_id"] = ev.UploaderID
		} else {
			item["uploader_alias"] = aliasForViewers(d, ev.UploaderID)
		}
		evidence = append(evidence, item)
	}

	timeline := []map[string]any{}
	for _, ev := range d.Timeline {
		visible := ev.VisibleAs
		if !reveal && ev.ActorID != "" && viewer != nil && ev.ActorID != viewer.ID {
			visible = aliasForViewers(d, ev.ActorID)
		}
		timeline = append(timeline, map[string]any{
			"ts": ev.TS, "kind": ev.Kind, "actor_visible_as": visible, "note": ev.Note,
		})
	}

	actions := []string{}
	switch d.Status {
	case store.DisputeOpen, store.DisputeAwaitingReply:
		actions = []string{"reply", "attach_evidence", "escalate"}
	case store.DisputeInArbitration:
		if youAre == "arbiter" {
			actions = []string{"resolve", "request_evidence"}
		} else {
			actions = []string{"reply", "attach_evidence"}
		}
	case store.DisputeResolved, store.DisputeDismissed:
		if d.AppealOf == "" && (d.ResolvedAt.IsZero() || time.Since(d.ResolvedAt) <= 72*time.Hour) {
			actions = []string{"appeal"}
		}
	case store.DisputeAppeal:
		if youAre == "arbiter" {
			actions = []string{"resolve", "request_evidence"}
		} else {
			actions = []string{"reply", "attach_evidence"}
		}
	}

	dto := map[string]any{
		"id": d.ID, "order_id": d.OrderID, "shop_id": d.ShopID, "status": d.Status,
		"reason_code": d.ReasonCode, "chat_id": d.ChatID,
		"you_are": youAre, "your_alias": yourAlias, "counterparty_alias": counterAlias,
		"reveal": reveal, "participants": participants, "evidence": evidence,
		"timeline": timeline, "actions": actions,
		"reply_deadline": d.ReplyDeadline, "created_at": d.CreatedAt,
		"masking_notice": "Вы видите вторую сторону как " + counterAlias +
			". Личные данные скрыты; арбитр видит обе стороны.",
	}
	dto["description"] = d.Description
	if !d.AssignedAt.IsZero() {
		dto["assigned_at"] = d.AssignedAt
	}
	if d.Resolution != "" {
		dto["resolution"] = d.Resolution
		dto["resolution_reason"] = d.ResolutionReason
		dto["resolved_at"] = d.ResolvedAt
		if d.ResolutionLamport > 0 {
			dto["resolution_amount"] = store.FormatSOL(d.ResolutionLamport)
		}
	}
	if d.AppealOf != "" {
		dto["appeal_of"] = d.AppealOf
		dto["appealed_at"] = d.AppealedAt
		dto["appeal_reason"] = d.AppealReason
	}
	dto["execution_suspended"] = d.ExecutionSuspended
	return dto
}

func aliasForViewers(d *store.Dispute, userID string) string {
	switch userID {
	case d.BuyerID:
		return d.BuyerAlias
	case d.SellerID:
		return d.SellerAlias
	case d.ArbiterID:
		return "Арбитр"
	}
	return "Участник"
}

// ---------------------------------------------------------------------------
// DTO: подарки, кошелёк, отзывы
// ---------------------------------------------------------------------------

func (s *Server) giftDTOLocked(g *store.Gift) map[string]any {
	dto := map[string]any{
		"id": g.ID, "sku": g.SKU, "title_ru": g.TitleRU, "title_en": g.TitleEN,
		"description": g.Description, "rarity": g.Rarity,
		"media_url": g.MediaURL, "media_kind": g.MediaKind, "emoji": g.Emoji,
		"price_stars": g.PriceStars, "price_sol": store.FormatSOL(g.PriceLamport),
		"boosts_shop": g.BoostsShop, "boost_days": g.BoostDays, "boost_value": g.BoostValue,
		"collectible": g.Collectible, "status": g.Status, "sort": g.Sort,
	}
	if g.PerUserLimit > 0 {
		dto["per_user_limit"] = g.PerUserLimit
	}
	return dto
}

func (s *Server) walletDTOLocked(u *store.User) map[string]any {
	solAvailable := s.Store.UserBalanceLocked(u.ID, store.AssetSOL)
	starsAvailable := s.Store.UserBalanceLocked(u.ID, store.AssetStars)
	solLocked := s.Store.BalanceLocked(store.LockedAccount(u.ID, store.AssetSOL))
	return map[string]any{
		"balances": []map[string]any{
			{"asset": store.AssetSOL, "available": store.FormatSOL(solAvailable),
				"available_raw": solAvailable, "locked": store.FormatSOL(solLocked)},
			{"asset": store.AssetStars, "available": starsAvailable, "locked": 0},
		},
		"deposit": map[string]any{
			"asset": store.AssetSOL, "address": u.DepositAddress,
			"path": u.DepositPath, "min": store.FormatSOL(s.Cfg.MinDeposit),
			"confirmations_required": s.Cfg.Confirmations,
			"network":                s.Cfg.SolanaNetwork, "memo": nil,
		},
		"limits": map[string]any{
			"withdraw_daily_sol":           store.FormatSOL(s.Cfg.WithdrawDailyLamports),
			"withdraw_four_eyes_sol":       store.FormatSOL(s.Cfg.FourEyesLamports),
			"withdraw_whitelist_cooling_h": 24,
			"ops_totp_threshold_sol":       store.FormatSOL(s.Cfg.OpsTotThresholdLamports),
			"ops_totp_threshold_stars":     s.Cfg.OpsTotThresholdStars,
		},
		"network": s.Cfg.SolanaNetwork,
	}
}

func (s *Server) reviewDTOLocked(rv *store.Review) map[string]any {
	author := s.Store.Users[rv.AuthorID]
	authorName := "пользователь"
	if author != nil {
		authorName = maskNickname(author.Nickname)
	}
	return map[string]any{
		"id": rv.ID, "order_id": rv.OrderID, "shop_id": rv.ShopID, "product_id": rv.ProductID,
		"author": authorName, "rating": rv.Rating,
		"rating_delivery": rv.RatingDelivery, "rating_description": rv.RatingDescription,
		"rating_support": rv.RatingSupport,
		"body":           rv.Body, "is_verified_purchase": rv.Verified,
		"shop_reply": rv.ShopReply, "shop_reply_at": rv.ShopReplyAt,
		"status": rv.Status, "helpful_count": rv.Helpful, "created_at": rv.CreatedAt,
	}
}

func maskNickname(n string) string {
	if len(n) <= 2 {
		return n[:1] + "***"
	}
	return n[:1] + "***" + n[len(n)-1:]
}
