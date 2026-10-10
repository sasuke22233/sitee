// Минимальный RFC 6455 клиент для смоук-теста (без зависимостей).
// Клиентские кадры обязаны быть маскированы — как в браузере.
import net from 'node:net';
import crypto from 'node:crypto';

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function encodeFrame(opcode, payload, mask = true) {
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
  header[0] = 0x80 | opcode;
  if (mask) {
    header[1] |= 0x80;
    const key = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ key[i % 4];
    return Buffer.concat([header, key, masked]);
  }
  return Buffer.concat([header, payload]);
}

export class WebSocket {
  constructor(url) {
    this.url = new URL(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.frames = [];
    this.waiters = [];
    this.onFrame = null;
    this.onClose = null;
    this.opened = false;
    this.closed = false;
  }

  open(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const port = Number(this.url.port || 80);
      this.socket = net.connect(port, this.url.hostname);
      const key = crypto.randomBytes(16).toString('base64');
      const timer = setTimeout(() => reject(new Error('ws handshake timeout')), timeoutMs);
      this.socket.once('connect', () => {
        const path = `${this.url.pathname}${this.url.search}`;
        this.socket.write(
          `GET ${path} HTTP/1.1\r\n` +
          `Host: ${this.url.host}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      let handshaked = false;
      this.socket.on('data', (chunk) => {
        if (!handshaked) {
          const idx = chunk.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const head = chunk.slice(0, idx).toString();
          if (!/101/.test(head)) {
            clearTimeout(timer);
            reject(new Error(`ws handshake failed: ${head.split('\r\n')[0]}`));
            return;
          }
          handshaked = true;
          this.opened = true;
          clearTimeout(timer);
          resolve();
          this.buffer = Buffer.concat([this.buffer, chunk.slice(idx + 4)]);
          this.parse();
          return;
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.parse();
      });
      this.socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      this.socket.on('close', () => {
        this.closed = true;
        for (const w of this.waiters) w.reject(new Error('ws closed'));
        this.waiters = [];
        if (this.onClose) this.onClose(this.closeCode ?? null, this.closeReason ?? '');
      });
    });
  }

  parse() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const fin = (this.buffer[0] & 0x80) !== 0;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let len = this.buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (masked) offset += 4;
      if (this.buffer.length < offset + len) return;
      const payload = this.buffer.slice(offset, offset + len);
      this.buffer = this.buffer.slice(offset + len);
      if (opcode === OP.CLOSE) {
        this.closed = true;
        this.closeCode = len >= 2 ? payload.readUInt16BE(0) : null;
        this.closeReason = len > 2 ? payload.slice(2).toString('utf8') : '';
        this.socket.end();
        if (this.onClose) this.onClose(this.closeCode, this.closeReason);
        return;
      }
      if (opcode === OP.PING) {
        this.socket.write(encodeFrame(OP.PONG, payload));
        continue;
      }
      if (opcode === OP.PONG) continue;
      if ((opcode === OP.TEXT || opcode === OP.BINARY) && fin) {
        let frame;
        try {
          frame = JSON.parse(payload.toString('utf8'));
        } catch {
          frame = { t: 'raw', d: payload.toString('utf8') };
        }
        this.frames.push(frame);
        if (this.onFrame) this.onFrame(frame);
        for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
          const w = this.waiters[i];
          if (w.type === frame.t || w.type === '*') {
            this.waiters.splice(i, 1);
            clearTimeout(w.timer);
            w.resolve(frame);
          }
        }
      }
    }
  }

  sendJson(obj) {
    if (!this.opened || this.closed) throw new Error('ws not open');
    this.socket.write(encodeFrame(OP.TEXT, Buffer.from(JSON.stringify(obj), 'utf8')));
  }

  waitFor(type, timeoutMs = 3000) {
    const existing = this.frames.find((f) => f.t === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.type !== type);
        resolve(null);
      }, timeoutMs);
      this.waiters.push({ type, resolve, reject, timer });
    });
  }

  close() {
    if (this.closed || !this.socket) return;
    try {
      this.socket.write(encodeFrame(OP.CLOSE, Buffer.alloc(0)));
      this.socket.end();
    } catch { /* уже закрыт */ }
    this.closed = true;
  }
}
