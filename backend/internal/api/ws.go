package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/sasuke22233/sitee/backend/internal/antifraud"
	"github.com/sasuke22233/sitee/backend/internal/cryptod"
	"github.com/sasuke22233/sitee/backend/internal/platform/httpx"
	"github.com/sasuke22233/sitee/backend/internal/platform/wsx"
	"github.com/sasuke22233/sitee/backend/internal/store"
)

// ---------------------------------------------------------------------------
// WebSocket-шлюз (docs/api.md §5, docs/architecture.md §6)
//
// Кадр: {"v":1,"t":"<тип>","ts":<ms>,"d":{…}}.
// Аутентификация: либо ?token=<access> в URL, либо первый кадр "auth"
// в течение WSAuthWindow (иначе close 4401).
// Ограничения: WSMaxPerIP соединений на IP, WSMaxPerUser на пользователя,
// профиль ws-msg (60/мин), кадр ≤ 64 KiB, медленный клиент → close 1008.
// ---------------------------------------------------------------------------

type wsInFrame struct {
	V  int             `json:"v"`
	T  string          `json:"t"`
	TS int64           `json:"ts"`
	D  json.RawMessage `json:"d"`
}

type wsAuthPayload struct {
	Token    string `json:"token"`
	DeviceID string `json:"device_id"`
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	ip := httpx.ClientIP(r)

	// Лимит соединений на IP (анти-DDoS L7, docs/security.md §8.4).
	s.wsIPMu.Lock()
	if s.wsIP[ip] >= s.Cfg.WSMaxPerIP {
		s.wsIPMu.Unlock()
		httpx.Fail(w, r, httpx.TooManyRequests("слишком много WS-соединений с адреса", 60*time.Second))
		return
	}
	s.wsIP[ip]++
	s.wsIPMu.Unlock()
	defer func() {
		s.wsIPMu.Lock()
		s.wsIP[ip]--
		if s.wsIP[ip] <= 0 {
			delete(s.wsIP, ip)
		}
		s.wsIPMu.Unlock()
	}()

	if d := s.Limiter.Allow("ws-connect:"+ip, antifraud.ProfileWSConn); !d.Allowed {
		httpx.Fail(w, r, httpx.TooManyRequests("превышена частота WS-подключений", d.RetryAfter+time.Second))
		return
	}

	conn, err := wsx.Upgrade(w, r, wsx.Options{
		MaxFrameBytes: s.Cfg.WSMaxFrame,
		SendQueue:     s.Cfg.WSSendQueue,
		ReadTimeout:   75 * time.Second,
		WriteTimeout:  10 * time.Second,
	})
	if err != nil {
		s.Log.Debug("ws: рукопожатие не удалось", "err", err, "ip", ip)
		httpx.Fail(w, r, httpx.BadRequest("некорректное WS-рукопожатие", nil))
		return
	}

	// Аутентификация: токен из URL (уже разобран authMiddleware) или кадр "auth".
	var user *store.User
	if p := s.principal(r); p != nil && p.Authorized {
		s.Store.Read(func() { user = s.Store.Users[p.UserID] })
	}
	if user == nil {
		user = s.wsAuthenticate(conn)
	}
	if user == nil {
		conn.Close(wsx.CloseUnauthenticated, "unauthenticated")
		return
	}
	if user.Status != store.UserActive {
		conn.Close(wsx.CloseForbidden, "account restricted")
		return
	}

	s.wsIPMu.Lock()
	perUser := 0
	for _, key := range s.Hub.Keys() {
		if key == user.ID {
			perUser++
		}
	}
	s.wsIPMu.Unlock()
	if perUser >= s.Cfg.WSMaxPerUser {
		conn.Close(wsx.ClosePolicy, "too many connections per user")
		return
	}

	conn.UserID = user.ID
	conn.RemoteIP = ip
	s.Hub.Register(user.ID, conn)
	defer func() {
		s.Hub.Unregister(user.ID, conn)
		s.broadcastPresence(user.ID, false)
		written, read, dropped, uptime := conn.Stats()
		s.Log.Info("ws: соединение закрыто",
			"user", user.ID, "ip", ip, "written", written, "read", read,
			"dropped", dropped, "uptime_s", int(uptime.Seconds()))
	}()

	// Heartbeat: ping каждые WSPingEvery (клиент обязан отвечать pong).
	stopPing := make(chan struct{})
	defer close(stopPing)
	go func() {
		t := time.NewTicker(s.Cfg.WSPingEvery)
		defer t.Stop()
		for {
			select {
			case <-stopPing:
				return
			case <-t.C:
				if conn.IsClosed() {
					return
				}
				if err := conn.Ping(); err != nil {
					conn.Close(wsx.CloseHeartbeat, "heartbeat timeout")
					return
				}
			}
		}
	}()

	s.sendFrame(conn, "hello", map[string]any{
		"user_id": user.ID, "nickname": user.Nickname, "role": user.Role,
		"server_time": time.Now().UTC(), "ping_every_s": int(s.Cfg.WSPingEvery.Seconds()),
		"max_frame": s.Cfg.WSMaxFrame, "e2ee": true,
		"notice": "Все тексты передаются по WSS; тела сообщений — в ciphertext (FR-MSG-03).",
	})
	s.broadcastPresence(user.ID, true)

	rejects := 0
	for {
		msg, err := conn.Read()
		if err != nil {
			return
		}
		if msg.Opcode != wsx.OpText {
			s.sendFrame(conn, "error", map[string]any{
				"code": "BAD_FRAME", "message": "ожидался текстовый кадр"})
			continue
		}
		// Rate-limit сообщений (docs/security.md §8.3).
		if d := s.Limiter.Allow("ws-msg:"+user.ID, antifraud.ProfileWSMsg); !d.Allowed {
			rejects++
			s.sendFrame(conn, "error", map[string]any{
				"code": "RATE_LIMITED", "message": "слишком много сообщений",
				"retry_after": int(d.RetryAfter.Seconds()) + 1,
			})
			if rejects >= 10 || d.Blocked {
				conn.Close(wsx.CloseRateLimited, "rate limited")
				return
			}
			continue
		}
		rejects = 0

		var frame wsInFrame
		if err := json.Unmarshal(msg.Data, &frame); err != nil {
			s.sendFrame(conn, "error", map[string]any{
				"code": "BAD_JSON", "message": "некорректный JSON кадра"})
			continue
		}
		s.handleWSFrame(conn, user, frame.T, frame.D)
	}
}

// wsAuthenticate ждёт кадр "auth" в пределах окна аутентификации.
func (s *Server) wsAuthenticate(conn *wsx.Conn) *store.User {
	window := s.Cfg.WSAuthWindow
	if window <= 0 {
		window = 10 * time.Second
	}
	deadline := time.AfterFunc(window, func() {
		if !conn.IsClosed() {
			conn.Close(wsx.CloseUnauthenticated, "auth window expired")
		}
	})
	defer deadline.Stop()

	msg, err := conn.Read()
	if err != nil {
		return nil
	}
	var frame wsInFrame
	if err := json.Unmarshal(msg.Data, &frame); err != nil || frame.T != "auth" {
		s.sendFrame(conn, "error", map[string]any{
			"code": "AUTH_REQUIRED", "message": "первым кадром должен быть auth"})
		return nil
	}
	var payload wsAuthPayload
	if err := json.Unmarshal(frame.D, &payload); err != nil || payload.Token == "" {
		s.sendFrame(conn, "error", map[string]any{
			"code": "AUTH_REQUIRED", "message": "token обязателен"})
		return nil
	}
	claims, verr := s.JWT.Verify(payload.Token)
	if verr != nil {
		code := "TOKEN_INVALID"
		if errors.Is(verr, cryptod.ErrTokenExpired) {
			code = "TOKEN_EXPIRED"
		}
		s.sendFrame(conn, "error", map[string]any{"code": code, "message": verr.Error()})
		return nil
	}
	userID, _ := claims["sub"].(string)
	sessionID, _ := claims["sid"].(string)
	var (
		user    *store.User
		session *store.Session
	)
	s.Store.Read(func() {
		user = s.Store.Users[userID]
		session = s.Store.Sessions[sessionID]
	})
	if user == nil || session == nil || !session.Active(time.Now()) {
		s.sendFrame(conn, "error", map[string]any{
			"code": "SESSION_INVALID", "message": "сессия недействительна"})
		return nil
	}
	conn.DeviceID = orDefault(payload.DeviceID, session.DeviceID)
	conn.Meta = map[string]string{"session_id": session.ID}
	return user
}

// handleWSFrame обрабатывает клиентский кадр.
func (s *Server) handleWSFrame(conn *wsx.Conn, u *store.User, t string, d json.RawMessage) {
	switch t {
	case "ping":
		s.sendFrame(conn, "pong", map[string]any{"server_time": time.Now().UTC()})

	case "msg.send":
		var payload struct {
			ChatID string `json:"chat_id"`
			sendMessageRequest
		}
		if err := json.Unmarshal(d, &payload); err != nil {
			s.sendFrame(conn, "error", map[string]any{
				"code": "BAD_PAYLOAD", "message": "некорректные данные msg.send"})
			return
		}
		if payload.ChatID == "" {
			s.sendFrame(conn, "error", map[string]any{"code": "CHAT_REQUIRED", "message": "chat_id обязателен"})
			return
		}
		msg, apiErr := s.postMessage(u, payload.ChatID, payload.sendMessageRequest)
		if apiErr != nil {
			s.sendFrame(conn, "error", map[string]any{
				"code": apiErr.Code, "message": apiErr.Message, "chat_id": payload.ChatID,
				"client_msg_id": payload.ClientMsgID,
			})
			return
		}
		// Подтверждение отправителю (at-least-once + идемпотентность по client_msg_id).
		s.sendFrame(conn, "msg.sent", map[string]any{
			"chat_id": payload.ChatID, "id": msg.ID, "seq": msg.Seq,
			"client_msg_id": msg.ClientMsgID, "created_at": msg.CreatedAt, "e2ee": msg.E2EE,
		})

	case "msg.read":
		var payload struct {
			ChatID string `json:"chat_id"`
			Seq    int64  `json:"seq"`
		}
		if err := json.Unmarshal(d, &payload); err != nil || payload.ChatID == "" {
			s.sendFrame(conn, "error", map[string]any{"code": "BAD_PAYLOAD", "message": "msg.read: chat_id"})
			return
		}
		member := false
		s.Store.Write(func() {
			for _, m := range s.Store.Members[payload.ChatID] {
				if m.UserID == u.ID && payload.Seq > m.LastReadSeq {
					m.LastReadSeq = payload.Seq
					member = true
				} else if m.UserID == u.ID {
					member = true
				}
			}
		})
		if !member {
			s.sendFrame(conn, "error", map[string]any{"code": "NOT_FOUND", "message": "чат не найден"})
			return
		}
		s.sendFrame(conn, "ack", map[string]any{"t": "msg.read", "chat_id": payload.ChatID, "seq": payload.Seq})
		s.pushMany(s.chatPeers(payload.ChatID, u.ID), "chat.read", map[string]any{
			"chat_id": payload.ChatID, "user_id": u.ID, "seq": payload.Seq})

	case "msg.backfill":
		var payload struct {
			ChatID    string `json:"chat_id"`
			BeforeSeq int64  `json:"before_seq"`
			Limit     int    `json:"limit"`
		}
		if err := json.Unmarshal(d, &payload); err != nil || payload.ChatID == "" {
			s.sendFrame(conn, "error", map[string]any{"code": "BAD_PAYLOAD", "message": "msg.backfill: chat_id"})
			return
		}
		limit := payload.Limit
		if limit <= 0 || limit > 100 {
			limit = 50
		}
		items := []map[string]any{}
		allowed := false
		s.Store.Read(func() {
			c := s.Store.Chats[payload.ChatID]
			if c == nil || !s.Store.IsMemberLocked(payload.ChatID, u.ID) {
				return
			}
			allowed = true
			all := s.Store.Messages[payload.ChatID]
			filtered := make([]*store.Message, 0, len(all))
			for _, m := range all {
				if payload.BeforeSeq > 0 && m.Seq >= payload.BeforeSeq {
					continue
				}
				filtered = append(filtered, m)
			}
			from := len(filtered) - limit
			if from < 0 {
				from = 0
			}
			for _, m := range filtered[from:] {
				items = append(items, s.messageDTOLocked(c, m, u.ID))
			}
		})
		if !allowed {
			s.sendFrame(conn, "error", map[string]any{"code": "FORBIDDEN", "message": "нет доступа к чату"})
			return
		}
		s.sendFrame(conn, "msg.backfill", map[string]any{
			"chat_id": payload.ChatID, "items": items, "has_more": len(items) == limit})

	case "typing":
		var payload struct {
			ChatID string `json:"chat_id"`
			Stop   bool   `json:"stop"`
		}
		if err := json.Unmarshal(d, &payload); err != nil || payload.ChatID == "" {
			return
		}
		if !s.memberOf(payload.ChatID, u.ID) {
			return
		}
		s.pushMany(s.chatPeers(payload.ChatID, u.ID), "typing", map[string]any{
			"chat_id": payload.ChatID, "user_id": u.ID,
			"visible_as": s.visibleAs(payload.ChatID, u.ID), "stop": payload.Stop,
		})

	case "presence":
		s.sendFrame(conn, "presence", map[string]any{
			"user_id": u.ID, "online": true, "ts": time.Now().UTC()})

	case "subscribe", "unsubscribe":
		// Хаб адресует кадры по user_id: подписки на чаты подтверждаем как ack.
		s.sendFrame(conn, "ack", map[string]any{"t": t, "raw": string(d)})

	default:
		s.sendFrame(conn, "error", map[string]any{
			"code": "UNKNOWN_TYPE", "message": "неизвестный тип кадра: " + t})
	}
}

func (s *Server) sendFrame(conn *wsx.Conn, t string, d any) {
	frame := map[string]any{"v": 1, "t": t, "ts": time.Now().UnixMilli(), "d": d}
	b, err := json.Marshal(frame)
	if err != nil {
		return
	}
	if !conn.Enqueue(b) {
		conn.Close(wsx.ClosePolicy, "slow consumer")
	}
}

func (s *Server) memberOf(chatID, userID string) bool {
	ok := false
	s.Store.Read(func() { ok = s.Store.IsMemberLocked(chatID, userID) })
	return ok
}

// visibleAs возвращает имя участника с учётом маскировки в спорах.
func (s *Server) visibleAs(chatID, userID string) string {
	name := ""
	s.Store.Read(func() {
		for _, m := range s.Store.Members[chatID] {
			if m.UserID == userID {
				name = m.VisibleAs
				break
			}
		}
		if name == "" {
			if u := s.Store.Users[userID]; u != nil {
				name = u.Nickname
			}
		}
	})
	return name
}

// broadcastPresence уведомляет собеседников о входе/выходе пользователя.
func (s *Server) broadcastPresence(userID string, online bool) {
	peers := map[string]bool{}
	s.Store.Read(func() {
		count := 0
		for _, members := range s.Store.Members {
			if count >= 50 {
				break
			}
			mine := false
			for _, m := range members {
				if m.UserID == userID {
					mine = true
					break
				}
			}
			if !mine {
				continue
			}
			count++
			for _, m := range members {
				if m.UserID != userID && m.LeftAt.IsZero() {
					peers[m.UserID] = true
				}
			}
		}
	})
	if len(peers) == 0 {
		return
	}
	keys := make([]string, 0, len(peers))
	for id := range peers {
		keys = append(keys, id)
	}
	s.pushMany(keys, "presence", map[string]any{
		"user_id": userID, "online": online, "ts": time.Now().UTC()})
}
