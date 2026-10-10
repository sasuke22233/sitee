package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
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
// Создание диалогов. По TZ (§3.1, FR-MSG-01) любая кнопка «Написать» открывает
// диалог с админом: shops.admin_user_id всегда является владельцем диалога.
// ---------------------------------------------------------------------------

// openSupportChatLocked создаёт или возвращает чат поддержки магазина.
func (s *Server) openSupportChatLocked(shop *store.Shop, admin *store.User, buyer *store.User) *store.Chat {
	if shop == nil || buyer == nil {
		return nil
	}
	if admin == nil {
		admin = s.Store.Users[shop.AdminUserID]
	}
	// Существующий чат поддержки этого покупателя с этим магазином.
	for _, c := range s.Store.Chats {
		if c.Kind != store.ChatShopSupport || c.ShopID != shop.ID {
			continue
		}
		if s.Store.IsMemberLocked(c.ID, buyer.ID) && c.ClosedAt.IsZero() {
			return c
		}
	}
	chat := &store.Chat{
		ID: ids.New("cht"), Kind: store.ChatShopSupport,
		Title: shop.Name + " · поддержка", ShopID: shop.ID,
		AdminUserID: shop.AdminUserID, E2EE: false,
		CreatedAt: time.Now().UTC(),
	}
	s.Store.Chats[chat.ID] = chat
	s.addMemberLocked(chat, admin, "admin", "Админ магазина")
	if buyer.ID != admin.ID {
		s.addMemberLocked(chat, buyer, "member", "")
	}
	for _, opID := range shop.Operators {
		if op := s.Store.Users[opID]; op != nil && op.ID != buyer.ID && op.ID != admin.ID {
			s.addMemberLocked(chat, op, "operator", "")
		}
	}
	return chat
}

// openSupportChat — публичная обёртка с блокировкой записи.
func (s *Server) openSupportChat(shop *store.Shop, admin, buyer *store.User) string {
	var chat *store.Chat
	s.Store.Write(func() { chat = s.openSupportChatLocked(shop, admin, buyer) })
	if chat == nil {
		return ""
	}
	return chat.ID
}

// openOrderChat создаёт/возвращает чат заказа.
func (s *Server) openOrderChat(o *store.Order, shop *store.Shop, buyer *store.User) string {
	if o.ChatID != "" {
		return o.ChatID
	}
	var chatID string
	s.Store.Write(func() {
		admin := s.Store.Users[shop.AdminUserID]
		for _, c := range s.Store.Chats {
			if c.Kind == store.ChatOrder && c.OrderID == o.ID {
				o.ChatID = c.ID
				chatID = c.ID
				return
			}
		}
		title := "Заказ " + o.Number
		chat := &store.Chat{
			ID: ids.New("cht"), Kind: store.ChatOrder, Title: title,
			ShopID: shop.ID, OrderID: o.ID, AdminUserID: shop.AdminUserID,
			CreatedAt: time.Now().UTC(),
		}
		s.Store.Chats[chat.ID] = chat
		s.addMemberLocked(chat, admin, "admin", "Админ магазина")
		s.addMemberLocked(chat, buyer, "member", "")
		o.ChatID = chat.ID
		chatID = chat.ID
		s.appendSystemMessageLocked(chat, nil, store.SystemPayload{
			Kind: "order_status", OrderID: o.ID, Status: o.Status,
			Title: "Заказ " + o.Number + " создан. Все вопросы — админу магазина.",
		})
	})
	return chatID
}

// ensureShopChannel создаёт канал магазина (FR-MSG-08).
func (s *Server) ensureShopChannel(shop *store.Shop, admin *store.User) string {
	var channelID string
	s.Store.Write(func() {
		for _, c := range s.Store.Chats {
			if c.Kind == store.ChatChannel && c.ShopID == shop.ID {
				channelID = c.ID
				return
			}
		}
		chat := &store.Chat{
			ID: ids.New("cht"), Kind: store.ChatChannel, Title: shop.Name + " · анонсы",
			ShopID: shop.ID, AdminUserID: shop.AdminUserID, CreatedAt: time.Now().UTC(),
		}
		s.Store.Chats[chat.ID] = chat
		s.addMemberLocked(chat, admin, "owner", "")
		channelID = chat.ID
		s.appendSystemMessageLocked(chat, admin, store.SystemPayload{
			Kind: "system", Title: "Канал магазина создан. Публикуйте анонсы и акции.",
		})
	})
	return channelID
}

func (s *Server) addMemberLocked(c *store.Chat, u *store.User, role, visibleAs string) {
	if u == nil {
		return
	}
	for _, m := range s.Store.Members[c.ID] {
		if m.UserID == u.ID {
			if role != "" {
				m.Role = role
			}
			return
		}
	}
	s.Store.Members[c.ID] = append(s.Store.Members[c.ID], &store.Member{
		ChatID: c.ID, UserID: u.ID, Role: role, VisibleAs: visibleAs,
		JoinedAt: time.Now().UTC(),
	})
}

// appendSystemMessageLocked добавляет системное сообщение в чат и рассылает по WS.
func (s *Server) appendSystemMessageLocked(c *store.Chat, sender *store.User, payload store.SystemPayload) *store.Message {
	if c == nil {
		return nil
	}
	c.LastSeq++
	senderID := ""
	senderName := "Система"
	if sender != nil {
		senderID = sender.ID
		senderName = sender.Nickname
	}
	m := &store.Message{
		ID: ids.New("msg"), ChatID: c.ID, Seq: c.LastSeq, SenderID: senderID,
		SenderVisibleAs: senderName, Type: "system", System: payload,
		CreatedAt: time.Now().UTC(),
	}
	// Системные сообщения тоже шифруются at-rest (FR-MSG-05): тело — заголовок.
	if ct, err := s.Crypto.EncryptString(store.DomainMessage, m.ID, payload.Title); err == nil {
		m.BodyCT = ct
	} else {
		m.BodyCT = ""
	}
	m.BodySize = len(payload.Title)
	s.Store.Messages[c.ID] = append(s.Store.Messages[c.ID], m)
	c.LastMessageAt = m.CreatedAt
	c.LastPreview = payload.Title
	return m
}

// systemMessage — внешний помощник: пишет системное сообщение в чат и уведомляет участника.
func (s *Server) systemMessage(userID, chatID, kind, orderID, status, amount, asset string) {
	if chatID == "" {
		return
	}
	var msg *store.Message
	var members []string
	s.Store.Write(func() {
		c, ok := s.Store.Chats[chatID]
		if !ok {
			return
		}
		title := store.StatusTitleRU(status)
		payload := store.SystemPayload{
			Kind: kind, OrderID: orderID, Status: status, Title: "Статус заказа: " + title,
			Amount: fmt.Sprint(amount), Asset: asset,
		}
		msg = s.appendSystemMessageLocked(c, nil, payload)
		for _, m := range s.Store.Members[chatID] {
			members = append(members, m.UserID)
		}
	})
	if msg == nil {
		return
	}
	frame := map[string]any{
		"v": 1, "t": "msg.new", "ts": time.Now().UnixMilli(),
		"d": map[string]any{
			"chat_id": chatID, "id": msg.ID, "seq": msg.Seq, "type": "system",
			"sender_visible_as": msg.SenderVisibleAs,
			"system":            msg.System,
			"body":              msg.System.Title,
			"created_at":        msg.CreatedAt,
		},
	}
	if b, err := json.Marshal(frame); err == nil {
		s.Hub.SendMany(members, b)
	}
}

// ---------------------------------------------------------------------------
// Список чатов (FR-MSG-09)
// ---------------------------------------------------------------------------

func (s *Server) handleListChats(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	filter := r.URL.Query().Get("filter")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	items := []map[string]any{}
	s.Store.Read(func() {
		chats := []*store.Chat{}
		for id, members := range s.Store.Members {
			for _, m := range members {
				if m.UserID != u.ID || !m.LeftAt.IsZero() {
					continue
				}
				if c, ok := s.Store.Chats[id]; ok && c.ClosedAt.IsZero() {
					chats = append(chats, c)
				}
				break
			}
		}
		for _, c := range chats {
			switch filter {
			case "shops":
				if c.Kind != store.ChatShopSupport && c.Kind != store.ChatChannel && c.Kind != store.ChatGroup {
					continue
				}
			case "orders":
				if c.Kind != store.ChatOrder {
					continue
				}
			case "disputes":
				if c.Kind != store.ChatDispute {
					continue
				}
			case "channels":
				if c.Kind != store.ChatChannel {
					continue
				}
			}
			items = append(items, s.chatDTOLocked(c, u.ID))
		}
	})
	sort.Slice(items, func(i, j int) bool {
		a, _ := items[i]["last_message_at"].(time.Time)
		b, _ := items[j]["last_message_at"].(time.Time)
		if a.Equal(b) {
			pinI, _ := items[i]["pinned"].(bool)
			pinJ, _ := items[j]["pinned"].(bool)
			return pinI && !pinJ
		}
		return a.After(b)
	})
	start, end, next, hasMore := s.page(len(items), limit, r.URL.Query().Get("cursor"))
	unreadTotal := 0
	for _, it := range items {
		if n, ok := it["unread"].(int); ok {
			unreadTotal += n
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items[start:end], "next_cursor": next, "has_more": hasMore,
		"total": len(items), "unread_total": unreadTotal,
	})
}

func (s *Server) handleGetChat(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	var (
		dto  map[string]any
		fail *httpx.APIError
		msgs []map[string]any
	)
	s.Store.Read(func() {
		c := s.Store.Chats[id]
		if c == nil {
			fail = httpx.NotFound("чат не найден")
			return
		}
		if !s.Store.IsMemberLocked(id, u.ID) && !u.IsPrivileged() {
			fail = httpx.Forbidden("FORBIDDEN", "нет доступа к диалогу")
			return
		}
		dto = s.chatDTOLocked(c, u.ID)
		list := s.Store.Messages[id]
		from := len(list) - 50
		if from < 0 {
			from = 0
		}
		for _, m := range list[from:] {
			msgs = append(msgs, s.messageDTOLocked(c, m, u.ID))
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	dto["messages"] = msgs
	httpx.JSON(w, http.StatusOK, dto)
}

type openChatRequest struct {
	Kind    string `json:"kind"`
	ShopID  string `json:"shop_id"`
	OrderID string `json:"order_id"`
	UserID  string `json:"user_id"`
	Title   string `json:"title"`
}

func (s *Server) handleOpenChat(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req openChatRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var (
		chat *store.Chat
		fail *httpx.APIError
	)
	s.Store.Write(func() {
		switch req.Kind {
		case store.ChatShopSupport, "":
			shop := s.findShopLocked(req.ShopID)
			if shop == nil {
				fail = httpx.NotFound("магазин не найден")
				return
			}
			chat = s.openSupportChatLocked(shop, s.Store.Users[shop.AdminUserID], u)
		case store.ChatOrder:
			o := s.findOrderLocked(req.OrderID)
			if o == nil {
				fail = httpx.NotFound("заказ не найден")
				return
			}
			if o.BuyerID != u.ID {
				shop := s.Store.Shops[o.ShopID]
				if shop == nil || (shop.AdminUserID != u.ID && !contains(shop.Operators, u.ID)) {
					fail = httpx.NotFound("заказ не найден")
					return
				}
			}
			shop := s.Store.Shops[o.ShopID]
			buyer := s.Store.Users[o.BuyerID]
			if o.ChatID != "" {
				chat = s.Store.Chats[o.ChatID]
			}
			if chat == nil && shop != nil && buyer != nil {
				chat = &store.Chat{
					ID: ids.New("cht"), Kind: store.ChatOrder, Title: "Заказ " + o.Number,
					ShopID: shop.ID, OrderID: o.ID, AdminUserID: shop.AdminUserID,
					CreatedAt: time.Now().UTC(),
				}
				s.Store.Chats[chat.ID] = chat
				s.addMemberLocked(chat, s.Store.Users[shop.AdminUserID], "admin", "Админ магазина")
				s.addMemberLocked(chat, buyer, "member", "")
				o.ChatID = chat.ID
			}
		case store.ChatDirect:
			peer := s.Store.Users[req.UserID]
			if peer == nil {
				fail = httpx.NotFound("пользователь не найден")
				return
			}
			if peer.ID == u.ID {
				fail = httpx.BadRequest("нельзя открыть чат с собой", nil)
				return
			}
			for _, c := range s.Store.Chats {
				if c.Kind != store.ChatDirect {
					continue
				}
				if s.Store.IsMemberLocked(c.ID, u.ID) && s.Store.IsMemberLocked(c.ID, peer.ID) {
					chat = c
					return
				}
			}
			chat = &store.Chat{
				ID: ids.New("cht"), Kind: store.ChatDirect,
				Title: "Приватный чат", E2EE: true, // E2EE обязателен для direct (FR-MSG-04)
				CreatedAt: time.Now().UTC(),
			}
			s.Store.Chats[chat.ID] = chat
			s.addMemberLocked(chat, u, "member", "")
			s.addMemberLocked(chat, peer, "member", "")
			s.appendSystemMessageLocked(chat, nil, store.SystemPayload{
				Kind: "system",
				Title: "Приватный чат со сквозным шифрованием. Сервер хранит только ciphertext.",
			})
		case store.ChatGroup:
			shop := s.findShopLocked(req.ShopID)
			if shop == nil || (shop.AdminUserID != u.ID && u.Role != store.RoleSuperAdmin) {
				fail = httpx.Forbidden("FORBIDDEN", "группу создаёт админ магазина")
				return
			}
			title := strings.TrimSpace(req.Title)
			if title == "" {
				title = shop.Name + " · команда"
			}
			chat = &store.Chat{
				ID: ids.New("cht"), Kind: store.ChatGroup, Title: title,
				ShopID: shop.ID, AdminUserID: shop.AdminUserID, CreatedAt: time.Now().UTC(),
			}
			s.Store.Chats[chat.ID] = chat
			s.addMemberLocked(chat, s.Store.Users[shop.AdminUserID], "owner", "")
			for _, opID := range shop.Operators {
				s.addMemberLocked(chat, s.Store.Users[opID], "operator", "")
			}
		case store.ChatChannel:
			shop := s.findShopLocked(req.ShopID)
			if shop == nil {
				fail = httpx.NotFound("магазин не найден")
				return
			}
			for _, c := range s.Store.Chats {
				if c.Kind == store.ChatChannel && c.ShopID == shop.ID {
					chat = c
					s.addMemberLocked(chat, u, "subscriber", "")
					return
				}
			}
			fail = httpx.NotFound("канал магазина не найден")
		default:
			fail = httpx.BadRequest("недопустимый тип чата", nil)
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	if chat == nil {
		httpx.Fail(w, r, httpx.NotFound("чат не найден"))
		return
	}
	var dto map[string]any
	s.Store.Read(func() { dto = s.chatDTOLocked(chat, u.ID) })
	dto["notice"] = "Диалог открыт с админом магазина: все обращения маршрутизируются владельцу (TZ §3.1)."
	httpx.JSON(w, http.StatusCreated, dto)
}

// ---------------------------------------------------------------------------
// Сообщения (FR-MSG-02…06)
// ---------------------------------------------------------------------------

func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	chatID := r.PathValue("id")
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	beforeSeq, _ := strconv.ParseInt(q.Get("before_seq"), 10, 64)

	var (
		items []map[string]any
		fail  *httpx.APIError
		hasMore bool
	)
	s.Store.Read(func() {
		c := s.Store.Chats[chatID]
		if c == nil {
			fail = httpx.NotFound("чат не найден")
			return
		}
		if !s.Store.IsMemberLocked(chatID, u.ID) && !u.IsPrivileged() {
			fail = httpx.Forbidden("FORBIDDEN", "нет доступа к диалогу")
			return
		}
		all := s.Store.Messages[chatID]
		filtered := make([]*store.Message, 0, len(all))
		for _, m := range all {
			if beforeSeq > 0 && m.Seq >= beforeSeq {
				continue
			}
			filtered = append(filtered, m)
		}
		start := len(filtered) - limit
		if start < 0 {
			start = 0
		}
		hasMore = start > 0
		for _, m := range filtered[start:] {
			items = append(items, s.messageDTOLocked(c, m, u.ID))
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"chat_id": chatID, "items": items, "has_more": hasMore,
		"e2ee_notice": "Тела сообщений хранятся в БД в зашифрованном виде (AES-256-GCM).",
	})
}

type sendMessageRequest struct {
	ClientMsgID string         `json:"client_msg_id"`
	Type        string         `json:"type"`
	Body        string         `json:"body"`
	BodyCT      string         `json:"body_ct"`
	E2EE        bool           `json:"e2ee"`
	SenderKeyID string         `json:"sender_key_id"`
	AAD         string         `json:"aad"`
	ReplyTo     string         `json:"reply_to"`
	System      map[string]any `json:"system"`
}

func (s *Server) handleSendMessage(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	chatID := r.PathValue("id")
	var req sendMessageRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	msg, fail := s.postMessage(u, chatID, req)
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	var dto map[string]any
	s.Store.Read(func() {
		if c := s.Store.Chats[chatID]; c != nil {
			dto = s.messageDTOLocked(c, msg, u.ID)
		}
	})
	httpx.JSON(w, http.StatusCreated, dto)
}

// postMessage — общая логика отправки (REST и WS используют один путь).
func (s *Server) postMessage(u *store.User, chatID string, req sendMessageRequest) (*store.Message, *httpx.APIError) {
	if strings.TrimSpace(req.ClientMsgID) == "" {
		req.ClientMsgID = ids.New("cmi")
	}
	msgType := req.Type
	if msgType == "" {
		msgType = "text"
	}
	switch msgType {
	case "text", "attachment", "product_card", "order_card", "gift_card", "reply":
	default:
		return nil, httpx.BadRequest("недопустимый тип сообщения", nil)
	}

	plain := req.Body
	if utf8len(plain) > 4096 {
		return nil, httpx.BadRequest("сообщение длиннее 4096 символов", nil)
	}
	if !req.E2EE && plain == "" && req.BodyCT == "" {
		return nil, httpx.BadRequest("пустое сообщение", nil)
	}

	var (
		msg   *store.Message
		fail  *httpx.APIError
		chat  *store.Chat
		members []string
	)
	s.Store.Write(func() {
		chat = s.Store.Chats[chatID]
		if chat == nil {
			fail = httpx.NotFound("чат не найден")
			return
		}
		if !s.Store.IsMemberLocked(chatID, u.ID) {
			fail = httpx.Forbidden("FORBIDDEN", "нет доступа к диалогу")
			return
		}
		if chat.ClosedAt != (time.Time{}) {
			fail = httpx.Conflict("CHAT_CLOSED", "чат закрыт")
			return
		}
		if chat.Kind == store.ChatChannel {
			isAdmin := false
			for _, m := range s.Store.Members[chatID] {
				if m.UserID == u.ID && (m.Role == "owner" || m.Role == "admin") {
					isAdmin = true
				}
			}
			if !isAdmin && u.Role != store.RoleSuperAdmin {
				fail = httpx.Forbidden("FORBIDDEN", "публиковать в канал может только админ")
				return
			}
		}
		// Идемпотентность по client_msg_id.
		for _, existing := range s.Store.Messages[chatID] {
			if existing.ClientMsgID != "" && existing.ClientMsgID == req.ClientMsgID &&
				existing.SenderID == u.ID {
				msg = existing
				return
			}
		}

		chat.LastSeq++
		msg = &store.Message{
			ID: ids.New("msg"), ChatID: chatID, Seq: chat.LastSeq, SenderID: u.ID,
			SenderVisibleAs: u.Nickname, Type: msgType, ClientMsgID: req.ClientMsgID,
			E2EE: req.E2EE || chat.E2EE, SenderKeyID: req.SenderKeyID,
			ReplyTo: req.ReplyTo, CreatedAt: time.Now().UTC(),
		}
		// Маскировка отправителя в спорах (FR-DSP-03).
		if chat.Kind == store.ChatDispute {
			for _, m := range s.Store.Members[chatID] {
				if m.UserID == u.ID && m.VisibleAs != "" {
					msg.SenderVisibleAs = m.VisibleAs
				}
			}
			plain = maskPIIInDispute(plain)
		}
		if msg.E2EE {
			if req.BodyCT == "" {
				fail = httpx.BadRequest("для E2EE-чата требуется body_ct (клиентский ciphertext)", nil)
				return
			}
			msg.BodyCT = req.BodyCT
			msg.BodySize = len(req.BodyCT)
		} else {
			ct, err := s.Crypto.EncryptString(store.DomainMessage, msg.ID, plain)
			if err != nil {
				fail = httpx.Internal("не удалось зашифровать сообщение")
				return
			}
			msg.BodyCT = ct // ★ в БД — только ciphertext (FR-MSG-03)
			msg.BodySize = len(plain)
		}
		s.Store.Messages[chatID] = append(s.Store.Messages[chatID], msg)
		chat.LastMessageAt = msg.CreatedAt
		if msg.E2EE {
			chat.LastPreview = "<encrypted>"
		} else {
			chat.LastPreview = truncate(plain, 80)
		}
		for _, m := range s.Store.Members[chatID] {
			members = append(members, m.UserID)
		}
	})
	if fail != nil {
		return nil, fail
	}
	if msg == nil {
		return nil, httpx.Internal("сообщение не создано")
	}

	// Доставка по WS всем участникам (FR-MSG-02).
	payload := s.wsMessagePayload(chat, msg, u)
	if b, err := json.Marshal(payload); err == nil {
		s.Hub.SendMany(members, b)
	}
	// Учёт времени ответа админа магазина.
	s.trackShopResponse(chat, msg, u)
	return msg, nil
}

func (s *Server) wsMessagePayload(c *store.Chat, m *store.Message, sender *store.User) map[string]any {
	dto := map[string]any{
		"v": 1, "t": "msg.new", "ts": time.Now().UnixMilli(),
		"d": map[string]any{
			"chat_id": m.ChatID, "id": m.ID, "seq": m.Seq, "type": m.Type,
			"sender_id": m.SenderID, "sender_visible_as": m.SenderVisibleAs,
			"e2ee": m.E2EE, "created_at": m.CreatedAt, "client_msg_id": m.ClientMsgID,
		},
	}
	d := dto["d"].(map[string]any)
	if m.E2EE {
		d["body_ct"] = m.BodyCT
		d["sender_key_id"] = m.SenderKeyID
	} else {
		if plain, err := s.Crypto.DecryptString(store.DomainMessage, m.ID, m.BodyCT); err == nil {
			d["body"] = plain
		}
		d["body_ct"] = "<encrypted-at-rest>"
	}
	if c != nil {
		d["chat_kind"] = c.Kind
		d["shop_id"] = c.ShopID
		d["order_id"] = c.OrderID
	}
	if sender != nil {
		d["sender_nick"] = sender.Nickname
	}
	return dto
}

func (s *Server) trackShopResponse(c *store.Chat, m *store.Message, sender *store.User) {
	if c == nil || c.ShopID == "" || sender == nil {
		return
	}
	s.Store.Write(func() {
		sh, ok := s.Store.Shops[c.ShopID]
		if !ok {
			return
		}
		if sh.AdminUserID != sender.ID {
			return
		}
		msgs := s.Store.Messages[c.ID]
		for i := len(msgs) - 2; i >= 0; i-- {
			prev := msgs[i]
			if prev.SenderID == sender.ID {
				continue
			}
			delta := int(m.CreatedAt.Sub(prev.CreatedAt).Seconds())
			if delta > 0 {
				if sh.ResponseP50S == 0 {
					sh.ResponseP50S = delta
				} else {
					sh.ResponseP50S = (sh.ResponseP50S + delta) / 2
				}
			}
			break
		}
		s.feedScoresLocked()
	})
}

func (s *Server) handleMarkRead(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	chatID := r.PathValue("id")
	var req struct {
		Seq int64 `json:"seq"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	found := false
	s.Store.Write(func() {
		for _, m := range s.Store.Members[chatID] {
			if m.UserID == u.ID {
				if req.Seq > m.LastReadSeq {
					m.LastReadSeq = req.Seq
				}
				found = true
			}
		}
		if u.UnreadChats > 0 {
			u.UnreadChats--
		}
	})
	if !found {
		httpx.Fail(w, r, httpx.NotFound("чат не найден"))
		return
	}
	s.pushMany(s.chatPeers(chatID, u.ID), "chat.read", map[string]any{
		"chat_id": chatID, "user_id": u.ID, "seq": req.Seq})
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "ok", "chat_id": chatID, "seq": req.Seq})
}

func (s *Server) chatPeers(chatID, exclude string) []string {
	out := []string{}
	s.Store.Read(func() {
		for _, m := range s.Store.Members[chatID] {
			if m.UserID != exclude && m.LeftAt.IsZero() {
				out = append(out, m.UserID)
			}
		}
	})
	return out
}

// ---------------------------------------------------------------------------
// E2EE: prekeys, bundle, сессии (FR-MSG-04, docs/security.md §4)
// ---------------------------------------------------------------------------

type prekeyUpload struct {
	DeviceID        string `json:"device_id"`
	IdentityPub     string `json:"identity_pub"`
	IdentitySig     string `json:"identity_sig"`
	SignedPrekeyPub string `json:"signed_prekey_pub"`
	SignedPrekeySig string `json:"signed_prekey_sig"`
	OneTimeKeys     []struct {
		ID  string `json:"id"`
		Pub string `json:"pub"`
	} `json:"one_time_keys"`
}

func (s *Server) handleUploadPrekeys(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req prekeyUpload
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if req.DeviceID == "" || req.IdentityPub == "" || req.SignedPrekeyPub == "" {
		httpx.Fail(w, r, httpx.BadRequest("device_id, identity_pub и signed_prekey_pub обязательны", nil))
		return
	}
	if len(req.OneTimeKeys) > 200 {
		httpx.Fail(w, r, httpx.BadRequest("не более 200 одноразовых ключей", nil))
		return
	}
	otk := make([]store.OneTime, 0, len(req.OneTimeKeys))
	for _, k := range req.OneTimeKeys {
		if k.ID == "" || k.Pub == "" {
			continue
		}
		otk = append(otk, store.OneTime{ID: k.ID, Pub: k.Pub})
	}
	key := u.ID + ":" + req.DeviceID
	s.Store.Write(func() {
		s.Store.Prekeys[key] = &store.E2EEPrekey{
			UserID: u.ID, DeviceID: req.DeviceID, IdentityPub: req.IdentityPub,
			IdentitySig: req.IdentitySig, SignedPrekeyPub: req.SignedPrekeyPub,
			SignedPrekeySig: req.SignedPrekeySig, OneTimeKeys: otk,
			CreatedAt: time.Now().UTC(),
		}
	})
	s.audit(r, u.ID, u.Role, "e2ee.prekeys_upload", "device", req.DeviceID, "", "", nil,
		map[string]any{"one_time_keys": len(otk)})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"status": "ok", "device_id": req.DeviceID, "one_time_keys": len(otk),
		"notice": "Сервер хранит только публичные части ключей (docs/security.md §4.1).",
	})
}

func (s *Server) handleGetBundle(w http.ResponseWriter, r *http.Request) {
	_, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	userID := r.PathValue("userId")
	deviceID := r.URL.Query().Get("device_id")
	var (
		out  map[string]any
		fail *httpx.APIError
	)
	s.Store.Write(func() {
		found := false
		for _, pk := range s.Store.Prekeys {
			if pk.UserID != userID {
				continue
			}
			if deviceID != "" && pk.DeviceID != deviceID {
				continue
			}
			found = true
			out = map[string]any{
				"user_id": pk.UserID, "device_id": pk.DeviceID,
				"identity_pub": pk.IdentityPub, "identity_sig": pk.IdentitySig,
				"signed_prekey_pub": pk.SignedPrekeyPub, "signed_prekey_sig": pk.SignedPrekeySig,
			}
			if len(pk.OneTimeKeys) > 0 {
				otk := pk.OneTimeKeys[0]
				pk.OneTimeKeys = pk.OneTimeKeys[1:] // одноразовый ключ изымается
				out["one_time_key"] = otk
			} else {
				out["one_time_key"] = nil
			}
			break
		}
		if !found {
			fail = httpx.NotFound("prekey-пакет устройства не найден")
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type createSessionRequest struct {
	ChatID        string `json:"chat_id"`
	ToUser        string `json:"to_user"`
	ToDevice      string `json:"to_device"`
	EphemeralPub  string `json:"ephemeral_pub"`
	UsedOPKID     string `json:"used_opk_id"`
	RootKeyFP     string `json:"root_key_fingerprint"`
}

func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req createSessionRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if req.ToUser == "" || req.ChatID == "" {
		httpx.Fail(w, r, httpx.BadRequest("chat_id и to_user обязательны", nil))
		return
	}
	var (
		fail *httpx.APIError
		sess *store.E2EESession
	)
	s.Store.Write(func() {
		if !s.Store.IsMemberLocked(req.ChatID, u.ID) {
			fail = httpx.Forbidden("FORBIDDEN", "нет доступа к чату")
			return
		}
		sess = &store.E2EESession{
			ID: ids.New("e2s"), ChatID: req.ChatID, FromUser: u.ID, ToDevice: req.ToDevice,
			Fingerprint: truncate(req.RootKeyFP, 16),
			SafetyNum:   safetyNumber(req.RootKeyFP, u.ID, req.ToUser),
			CreatedAt:   time.Now().UTC(),
		}
		s.Store.Sessions2[sess.ID] = sess
		if c := s.Store.Chats[req.ChatID]; c != nil {
			c.E2EE = true
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "e2ee.session_create", "chat", req.ChatID, "", "", nil,
		map[string]any{"to_user": req.ToUser, "ephemeral_used": req.EphemeralPub != ""})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"session_id": sess.ID, "safety_number": sess.SafetyNum,
		"notice": "Сверьте safety number с собеседником: ключи хранятся только на устройствах.",
	})
}

// safetyNumber — короткий код для визуальной сверки ключей (docs/security.md §4.2).
func safetyNumber(fingerprint, userA, userB string) string {
	a, b := userA, userB
	if b < a {
		a, b = b, a
	}
	mac := hmacSHA256([]byte("sitee-safety-v1:"+fingerprint), []byte(a+"|"+b))
	groups := []string{}
	for i := 0; i+1 < len(mac) && len(groups) < 8; i += 2 {
		n := int(mac[i])<<8 | int(mac[i+1])
		groups = append(groups, fmt.Sprintf("%05d", n%100000))
	}
	return strings.Join(groups, " ")
}

func hmacSHA256(key, msg []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(msg)
	return m.Sum(nil)
}

// ---------------------------------------------------------------------------
// Служебное
// ---------------------------------------------------------------------------

func utf8len(s string) int { return len([]rune(s)) }

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// maskPIIInDispute маскирует персональные данные в сообщениях спора (FR-DSP-03).
func maskPIIInDispute(s string) string {
	if s == "" {
		return s
	}
	// email
	for {
		i := strings.IndexByte(s, '@')
		if i <= 0 {
			break
		}
		start := i
		for start > 0 && !isSpaceOrPunct(s[start-1]) {
			start--
		}
		end := i + 1
		for end < len(s) && !isSpaceOrPunct(s[end]) {
			end++
		}
		if end-start > 4 {
			s = s[:start] + "***@***" + s[end:]
			break
		}
		break
	}
	// telegram @username
	for {
		i := strings.IndexByte(s, '@')
		if i < 0 {
			break
		}
		end := i + 1
		for end < len(s) && ((s[end] >= 'a' && s[end] <= 'z') || (s[end] >= 'A' && s[end] <= 'Z') ||
			(s[end] >= '0' && s[end] <= '9') || s[end] == '_') {
			end++
		}
		if end-i-1 >= 4 {
			s = s[:i] + "@***" + s[end:]
			continue
		}
		break
	}
	// base58-адреса Solana (32–44 символа)
	words := strings.Fields(s)
	for i, wd := range words {
		if len(wd) >= 32 && len(wd) <= 44 && isBase58(wd) {
			words[i] = wd[:4] + "…" + wd[len(wd)-4:]
		}
	}
	return strings.Join(words, " ")
}

func isSpaceOrPunct(b byte) bool {
	switch b {
	case ' ', '\n', '\t', ',', '.', ';', ':', '!', '?', '(', ')', '"', '\'':
		return true
	}
	return false
}

func isBase58(s string) bool {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	for i := 0; i < len(s); i++ {
		if !strings.ContainsRune(alphabet, rune(s[i])) {
			return false
		}
	}
	return true
}
