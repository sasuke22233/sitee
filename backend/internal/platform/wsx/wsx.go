// Package wsx — серверная реализация WebSocket (RFC 6455) на стандартной библиотеке.
//
// Используется мессенджером SITEE (TZ FR-MSG-02, docs/architecture.md §5):
// рукопожатие, кадры, ping/pong, backpressure и отключение медленных клиентов.
// В проде соединение terminates на nginx/TLS и приходит сюда как ws://.
package wsx

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Оперкоды кадров.
const (
	OpContinuation = 0x0
	OpText         = 0x1
	OpBinary       = 0x2
	OpClose        = 0x8
	OpPing         = 0x9
	OpPong         = 0xA
)

// Коды закрытия (docs/api.md §10.3).
const (
	CloseNormal         = 1000
	CloseGoingAway      = 1001
	CloseProtocolError  = 1002
	CloseUnsupported    = 1003
	CloseNoStatus       = 1005
	CloseAbnormal       = 1006
	CloseInvalidData    = 1007
	ClosePolicy         = 1008
	CloseTooBig         = 1009
	CloseMandatoryExt   = 1010
	CloseInternalError  = 1011
	CloseUnauthenticated = 4401
	CloseForbidden      = 4403
	CloseHeartbeat      = 4408
	CloseRateLimited    = 4429
	CloseOverloaded     = 4503
)

const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// Ошибки.
var (
	ErrNotWebSocket   = errors.New("wsx: запрос не является WebSocket-рукопожатием")
	ErrBadVersion     = errors.New("wsx: неподдерживаемая версия WebSocket")
	ErrClosed         = errors.New("wsx: соединение закрыто")
	ErrFrameTooBig    = errors.New("wsx: кадр превышает лимит")
	ErrSlowConsumer   = errors.New("wsx: очередь переполнена (медленный клиент)")
	ErrControlFragmented = errors.New("wsx: фрагментированный control-кадр")
)

// Conn — WebSocket-соединение.
type Conn struct {
	rwc      net.Conn
	br       *bufio.Reader
	writeMu  sync.Mutex
	out      chan []byte
	done     chan struct{}
	maxFrame int
	closed   atomic.Bool
	closeOnce sync.Once
	RemoteIP string
	UserID   string
	DeviceID string
	Meta     map[string]string

	readDeadline  time.Duration
	writeDeadline time.Duration
	writtenFrames atomic.Int64
	readFrames    atomic.Int64
	dropped       atomic.Int64
	connectedAt   time.Time
}

// Options — параметры соединения.
type Options struct {
	MaxFrameBytes int           // лимит размера кадра (по умолчанию 64 KiB)
	SendQueue     int           // размер очереди отправки (по умолчанию 256)
	ReadTimeout   time.Duration // idle-таймаут чтения (по умолчанию 75 с)
	WriteTimeout  time.Duration // таймаут записи (по умолчанию 10 с)
}

func (o Options) withDefaults() Options {
	if o.MaxFrameBytes <= 0 {
		o.MaxFrameBytes = 64 << 10
	}
	if o.SendQueue <= 0 {
		o.SendQueue = 256
	}
	if o.ReadTimeout <= 0 {
		o.ReadTimeout = 75 * time.Second
	}
	if o.WriteTimeout <= 0 {
		o.WriteTimeout = 10 * time.Second
	}
	return o
}

// Upgrade выполняет рукопожатие и возвращает соединение.
func Upgrade(w http.ResponseWriter, r *http.Request, opts Options) (*Conn, error) {
	opts = opts.withDefaults()

	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return nil, ErrNotWebSocket
	}
	if !headerContains(r.Header.Get("Connection"), "upgrade") {
		return nil, ErrNotWebSocket
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, ErrNotWebSocket
	}
	if v := r.Header.Get("Sec-WebSocket-Version"); v != "13" {
		return nil, fmt.Errorf("%w: %s", ErrBadVersion, v)
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("wsx: ResponseWriter не поддерживает hijack")
	}
	netConn, rw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}

	sum := sha1.Sum([]byte(key + websocketGUID))
	accept := base64.StdEncoding.EncodeToString(sum[:])

	var sb strings.Builder
	sb.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	sb.WriteString("Upgrade: websocket\r\n")
	sb.WriteString("Connection: Upgrade\r\n")
	sb.WriteString("Sec-WebSocket-Accept: " + accept + "\r\n")
	if proto := r.Header.Get("Sec-WebSocket-Protocol"); proto != "" {
		// Выбираем первый предложенный подпротокол.
		if first := strings.TrimSpace(strings.Split(proto, ",")[0]); first != "" {
			sb.WriteString("Sec-WebSocket-Protocol: " + first + "\r\n")
		}
	}
	sb.WriteString("\r\n")
	if _, err := netConn.Write([]byte(sb.String())); err != nil {
		_ = netConn.Close()
		return nil, err
	}

	c := &Conn{
		rwc:      netConn,
		br:       bufio.NewReaderSize(rw.Reader, 8<<10),
		out:      make(chan []byte, opts.SendQueue),
		done:     make(chan struct{}),
		maxFrame: opts.MaxFrameBytes,
		RemoteIP: remoteIP(r),
		Meta:     map[string]string{},
		readDeadline:  opts.ReadTimeout,
		writeDeadline: opts.WriteTimeout,
		connectedAt:   time.Now(),
	}
	go c.writeLoop()
	return c, nil
}

func headerContains(value, token string) bool {
	for _, part := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

func remoteIP(r *http.Request) string {
	if v := r.Header.Get("CF-Connecting-IP"); v != "" {
		return strings.TrimSpace(v)
	}
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	if i := strings.LastIndex(r.RemoteAddr, ":"); i > 0 {
		return r.RemoteAddr[:i]
	}
	return r.RemoteAddr
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

// Message — прочитанное сообщение (после склейки фрагментов).
type Message struct {
	Opcode int
	Data   []byte
}

// Read читает следующее сообщение. Control-кадры (ping/close) обрабатываются внутри.
func (c *Conn) Read() (Message, error) {
	var (
		msgOpcode int
		buf       []byte
		first     = true
	)
	for {
		if c.closed.Load() {
			return Message{}, ErrClosed
		}
		if c.readDeadline > 0 {
			_ = c.rwc.SetReadDeadline(time.Now().Add(c.readDeadline))
		}
		fin, opcode, payload, err := c.readFrame()
		if err != nil {
			return Message{}, err
		}
		c.readFrames.Add(1)

		switch opcode {
		case OpPing:
			if err := c.writeControl(OpPong, payload); err != nil {
				return Message{}, err
			}
			continue
		case OpPong:
			continue
		case OpClose:
			code := CloseNoStatus
			if len(payload) >= 2 {
				code = int(binary.BigEndian.Uint16(payload[:2]))
			}
			_ = c.writeControl(OpClose, payload)
			c.CloseNow()
			return Message{}, io.EOF
		case OpText, OpBinary:
			if !first {
				return Message{}, ErrControlFragmented
			}
			msgOpcode = int(opcode)
			buf = append(buf[:0], payload...)
			first = false
		case OpContinuation:
			if first {
				return Message{}, errors.New("wsx: continuation без начального кадра")
			}
			buf = append(buf, payload...)
		default:
			return Message{}, fmt.Errorf("wsx: неизвестный оперкод %d", opcode)
		}

		if fin && !first {
			if len(buf) > c.maxFrame*16 { // суммарный лимит сообщения
				return Message{}, ErrFrameTooBig
			}
			out := make([]byte, len(buf))
			copy(out, buf)
			return Message{Opcode: msgOpcode, Data: out}, nil
		}
	}
}

func (c *Conn) readFrame() (fin bool, opcode int, payload []byte, err error) {
	hdr := make([]byte, 2)
	if _, err = io.ReadFull(c.br, hdr); err != nil {
		return false, 0, nil, err
	}
	fin = hdr[0]&0x80 != 0
	rsv := hdr[0] & 0x70
	if rsv != 0 {
		return false, 0, nil, errors.New("wsx: зарезервированные биты RSV должны быть нулевыми")
	}
	opcode = int(hdr[0] & 0x0F)
	masked := hdr[1]&0x80 != 0
	length := uint64(hdr[1] & 0x7F)

	switch length {
	case 126:
		ext := make([]byte, 2)
		if _, err = io.ReadFull(c.br, ext); err != nil {
			return false, 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext))
	case 127:
		ext := make([]byte, 8)
		if _, err = io.ReadFull(c.br, ext); err != nil {
			return false, 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext)
		if length > 1<<40 {
			return false, 0, nil, ErrFrameTooBig
		}
	}

	isControl := opcode >= OpClose
	if isControl {
		if !fin {
			return false, 0, nil, ErrControlFragmented
		}
		if length > 125 {
			return false, 0, nil, ErrFrameTooBig
		}
	} else if length > uint64(c.maxFrame) {
		return false, 0, nil, ErrFrameTooBig
	}

	var maskKey [4]byte
	if masked {
		if _, err = io.ReadFull(c.br, maskKey[:]); err != nil {
			return false, 0, nil, err
		}
	}
	payload = make([]byte, length)
	if length > 0 {
		if _, err = io.ReadFull(c.br, payload); err != nil {
			return false, 0, nil, err
		}
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	return fin, opcode, payload, nil
}

// ---------------------------------------------------------------------------
// Запись
// ---------------------------------------------------------------------------

func (c *Conn) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case payload := <-c.out:
			if c.writeDeadline > 0 {
				_ = c.rwc.SetWriteDeadline(time.Now().Add(c.writeDeadline))
			}
			if _, err := c.rwc.Write(payload); err != nil {
				c.CloseNow()
				return
			}
			c.writtenFrames.Add(1)
		}
	}
}

// Enqueue ставит текстовый кадр в очередь отправки.
// Возвращает false, если очередь полна (медленный клиент → подлежит отключению).
func (c *Conn) Enqueue(text []byte) bool {
	if c.closed.Load() {
		return false
	}
	frame := encodeFrame(OpText, text)
	select {
	case <-c.done:
		return false
	case c.out <- frame:
		return true
	default:
		c.dropped.Add(1)
		return false
	}
}

// EnqueueJSON сериализует и ставит в очередь.
func (c *Conn) EnqueueJSON(v any) bool {
	b, err := json.Marshal(v)
	if err != nil {
		return false
	}
	return c.Enqueue(b)
}

// WriteText синхронно пишет текстовый кадр (используется для handshake-ответов).
func (c *Conn) WriteText(text []byte) error {
	if c.closed.Load() {
		return ErrClosed
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.writeDeadline > 0 {
		_ = c.rwc.SetWriteDeadline(time.Now().Add(c.writeDeadline))
	}
	_, err := c.rwc.Write(encodeFrame(OpText, text))
	if err != nil {
		c.CloseNow()
		return err
	}
	c.writtenFrames.Add(1)
	return nil
}

// WriteJSON синхронно пишет JSON.
func (c *Conn) WriteJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.WriteText(b)
}

func (c *Conn) writeControl(opcode int, payload []byte) error {
	if len(payload) > 125 {
		payload = payload[:125]
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.writeDeadline > 0 {
		_ = c.rwc.SetWriteDeadline(time.Now().Add(c.writeDeadline))
	}
	_, err := c.rwc.Write(encodeFrame(opcode, payload))
	return err
}

// Ping отправляет ping (heartbeat каждые 25 с — FR-MSG-02).
func (c *Conn) Ping() error { return c.writeControl(OpPing, []byte("sitee")) }

func encodeFrame(opcode int, payload []byte) []byte {
	n := len(payload)
	headerLen := 2
	switch {
	case n <= 125:
	case n <= 0xFFFF:
		headerLen += 2
	default:
		headerLen += 8
	}
	buf := make([]byte, headerLen+n)
	buf[0] = 0x80 | byte(opcode) // FIN + opcode
	switch {
	case n <= 125:
		buf[1] = byte(n)
	case n <= 0xFFFF:
		buf[1] = 126
		binary.BigEndian.PutUint16(buf[2:4], uint16(n))
	default:
		buf[1] = 127
		binary.BigEndian.PutUint64(buf[2:10], uint64(n))
	}
	copy(buf[headerLen:], payload)
	return buf
}

// Close отправляет close-кадр и закрывает соединение.
func (c *Conn) Close(code int, reason string) {
	payload := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(payload[:2], uint16(code))
	copy(payload[2:], reason)
	_ = c.writeControl(OpClose, payload)
	c.CloseNow()
}

// CloseNow закрывает соединение без close-кадра.
func (c *Conn) CloseNow() {
	c.closeOnce.Do(func() {
		c.closed.Store(true)
		close(c.done)
		_ = c.rwc.Close()
	})
}

// IsClosed сообщает, закрыто ли соединение.
func (c *Conn) IsClosed() bool { return c.closed.Load() }

// Stats — счётчики для метрик.
func (c *Conn) Stats() (written, read, dropped int64, uptime time.Duration) {
	return c.writtenFrames.Load(), c.readFrames.Load(), c.dropped.Load(), time.Since(c.connectedAt)
}

// ---------------------------------------------------------------------------
// Хаб
// ---------------------------------------------------------------------------

// Hub маршрутизирует сообщения соединениям по ключу (обычно user_id).
type Hub struct {
	mu    sync.RWMutex
	peers map[string]map[*Conn]struct{}
	conns int
}

// NewHub создаёт хаб.
func NewHub() *Hub { return &Hub{peers: map[string]map[*Conn]struct{}} }

// Register добавляет соединение.
func (h *Hub) Register(key string, c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set, ok := h.peers[key]
	if !ok {
		set = map[*Conn]struct{}{}
		h.peers[key] = set
	}
	set[c] = struct{}{}
	h.conns++
}

// Unregister удаляет соединение.
func (h *Hub) Unregister(key string, c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if set, ok := h.peers[key]; ok {
		if _, exists := set[c]; exists {
			delete(set, c)
			h.conns--
		}
		if len(set) == 0 {
			delete(h.peers, key)
		}
	}
}

// Send отправляет payload всем соединениям ключа; возвращает число доставок
// и число медленных клиентов, которые были отключены.
func (h *Hub) Send(key string, payload []byte) (delivered, kicked int) {
	h.mu.RLock()
	set := h.peers[key]
	conns := make([]*Conn, 0, len(set))
	for c := range set {
		conns = append(conns, c)
	}
	h.mu.RUnlock()

	for _, c := range conns {
		if c.Enqueue(payload) {
			delivered++
		} else {
			kicked++
			c.Close(ClosePolicy, "slow consumer")
			h.Unregister(key, c)
		}
	}
	return delivered, kicked
}

// SendJSON сериализует и отправляет.
func (h *Hub) SendJSON(key string, v any) (delivered, kicked int) {
	b, err := json.Marshal(v)
	if err != nil {
		return 0, 0
	}
	return h.Send(key, b)
}

// SendMany отправляет нескольким ключам (дедуплицируя соединения).
func (h *Hub) SendMany(keys []string, payload []byte) (delivered int) {
	seen := map[*Conn]bool{}
	for _, k := range keys {
		h.mu.RLock()
		set := h.peers[k]
		conns := make([]*Conn, 0, len(set))
		for c := range set {
			conns = append(conns, c)
		}
		h.mu.RUnlock()
		for _, c := range conns {
			if seen[c] {
				continue
			}
			seen[c] = true
			if c.Enqueue(payload) {
				delivered++
			}
		}
	}
	return delivered
}

// Online сообщает, есть ли активные соединения ключа (presence).
func (h *Hub) Online(key string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.peers[key]) > 0
}

// Count возвращает общее число соединений.
func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.conns
}

// Keys возвращает ключи с активными соединениями (для админ-метрик).
func (h *Hub) Keys() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]string, 0, len(h.peers))
	for k := range h.peers {
		out = append(out, k)
	}
	return out
}
