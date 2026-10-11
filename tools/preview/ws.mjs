// Минимальный WebSocket-сервер (RFC 6455) на node:net — без внешних зависимостей.
// Используется preview-сервером для доставки сообщений мессенджера и событий
// заказов/кошелька в реальном времени (docs/api.md §5).
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
export const CLOSE = {
  NORMAL: 1000, GOING_AWAY: 1001, PROTOCOL: 1002, POLICY: 1008,
  TOO_BIG: 1009, UNAUTHENTICATED: 4401, FORBIDDEN: 4403, RATE_LIMITED: 4429,
};

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode, сервер не маскирует
  return Buffer.concat([header, payload]);
}

export class WSConnection {
  constructor(socket, request, { authDeadlineMs = 10_000, readDeadlineMs = 120_000 } = {}) {
    this.socket = socket;
    this.request = request;
    this.userId = null;
    this.deviceId = null;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.connectedAt = Date.now();
    this.lastReadAt = Date.now();
    this.sent = 0;
    this.received = 0;
    this.onMessage = null;
    this.onClose = null;
    this.authenticated = false;
    // FR-ABF-06: обязательная аутентификация в первые 10 с после подключения.
    this.authDeadlineMs = authDeadlineMs;
    // FR-ABF-06: read-deadline — разрыв «молчащих» соединений (защита от slowloris).
    this.readDeadlineMs = readDeadlineMs;
    socket.on('data', (chunk) => {
      this.lastReadAt = Date.now();
      this.#onData(chunk);
    });
    socket.on('error', () => this.close(CLOSE.GOING_AWAY, 'socket error'));
    socket.on('close', () => {
      this.closed = true;
      if (this.onClose) this.onClose();
    });
    this.authTimer = setTimeout(() => {
      if (this.closed || this.authenticated) return;
      this.close(CLOSE.UNAUTHENTICATED, 'auth timeout');
    }, this.authDeadlineMs);
    this.readTimer = setInterval(() => {
      if (this.closed) return;
      if (this.authenticated && Date.now() - this.lastReadAt > this.readDeadlineMs) {
        this.close(CLOSE.POLICY, 'read timeout');
      }
    }, 5000);
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      try {
        socket.write(encodeFrame(OP.PING, Buffer.from('sitee')));
      } catch {
        this.close(CLOSE.GOING_AWAY, 'ping failed');
      }
    }, 25000);
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const fin = (this.buffer[0] & 0x80) !== 0;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let len = this.buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < offset + 2) return;
        len = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buffer.length < offset + 8) return;
        len = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      if (len > 64 * 1024) {
        this.close(CLOSE.TOO_BIG, 'frame too big');
        return;
      }
      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.subarray(offset, offset + len);
      if (mask) {
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      }
      this.buffer = this.buffer.subarray(offset + len);
      this.received += 1;

      if (opcode === OP.CLOSE) {
        this.close(CLOSE.NORMAL, 'client close');
        return;
      }
      if (opcode === OP.PING) {
        this.socket.write(encodeFrame(OP.PONG, payload));
        continue;
      }
      if (opcode === OP.PONG) continue;
      if ((opcode === OP.TEXT || opcode === OP.BINARY) && fin && this.onMessage) {
        this.onMessage(payload.toString('utf8'));
      }
    }
  }

  send(obj) {
    if (this.closed) return false;
    try {
      this.socket.write(encodeFrame(OP.TEXT, Buffer.from(JSON.stringify(obj), 'utf8')));
      this.sent += 1;
      return true;
    } catch {
      return false;
    }
  }

  close(code = CLOSE.NORMAL, reason = '') {
    if (this.closed) return;
    try {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      this.socket.write(encodeFrame(OP.CLOSE, payload));
      this.socket.end();
    } catch { /* сокет уже закрыт */ }
    clearInterval(this.pingTimer);
    clearTimeout(this.authTimer);
    clearInterval(this.readTimer);
    this.closed = true;
    if (this.onClose) this.onClose();
  }
}

// Hub — адресация кадров по user_id (как в Go backend/internal/platform/wsx).
export class Hub {
  constructor() {
    this.peers = new Map();
  }

  register(userId, conn) {
    if (!this.peers.has(userId)) this.peers.set(userId, new Set());
    this.peers.get(userId).add(conn);
  }

  unregister(userId, conn) {
    const set = this.peers.get(userId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) this.peers.delete(userId);
  }

  send(userId, frame) {
    const set = this.peers.get(userId);
    if (!set) return 0;
    let delivered = 0;
    for (const conn of set) if (conn.send(frame)) delivered += 1;
    return delivered;
  }

  sendMany(userIds, frame) {
    let delivered = 0;
    for (const id of userIds) delivered += this.send(id, frame);
    return delivered;
  }

  online(userId) {
    return (this.peers.get(userId)?.size ?? 0) > 0;
  }

  count() {
    let n = 0;
    for (const set of this.peers.values()) n += set.size;
    return n;
  }
}

// attach — обработка HTTP-upgrade на пути /ws.
export function attach(server, hub, { onConnection, maxPerIp = 5, authDeadlineMs = 10_000, readDeadlineMs = 120_000 } = {}) {
  const perIp = new Map();
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const ip = req.socket.remoteAddress || 'unknown';
    if ((perIp.get(ip) ?? 0) >= maxPerIp) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const conn = new WSConnection(socket, req, { authDeadlineMs, readDeadlineMs });
    conn.remoteIp = ip;
    conn.onClose = () => {
      perIp.set(ip, Math.max(0, (perIp.get(ip) ?? 1) - 1));
      if (conn.userId) hub.unregister(conn.userId, conn);
    };
    onConnection(conn, url);
  });
}
