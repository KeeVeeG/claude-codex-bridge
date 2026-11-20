// lib/ws-jsonrpc.mjs
// Minimal WebSocket client framing (RFC 6455) for the Codex app-server control
// socket, which is reached through `codex app-server proxy` on stdio. No I/O here.
import { createHash, randomBytes } from 'node:crypto';

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function upgradeRequest() {
  const key = randomBytes(16).toString('base64');
  return {
    text: 'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    accept: createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64'),
  };
}

function clientFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) header = Buffer.from([0x80 | opcode, 0x80 | length]);
  else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index++) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

export function encodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > MAX_MESSAGE_BYTES) throw new Error('Codex daemon request exceeds 8 MiB.');
  return clientFrame(0x1, payload);
}

export const encodePong = payload => clientFrame(0xa, payload);
export const encodeClose = () => clientFrame(0x8, Buffer.alloc(0));

export class FrameDecoder {
  #buffer = Buffer.alloc(0);
  #storage = Buffer.alloc(0);
  #clientFrames;
  #upgraded;
  #parts = [];
  #partBytes = 0;

  #accept;

  constructor({ upgraded = false, accept = null, clientFrames = false } = {}) {
    // The handshake check fails closed: a decoder that reads the upgrade must know the expected key.
    if (!upgraded && typeof accept !== 'string') throw new Error('A WebSocket accept key is required to read the upgrade response.');
    this.#clientFrames = clientFrames;
    this.#upgraded = upgraded;
    this.#accept = accept;
  }

  /** Decode a chunk. A thrown error carries `events` decoded before the invalid input. */
  push(chunk) {
    const events = [];
    try {
      this.#decode(chunk, events);
    } catch (error) {
      error.events = events;
      throw error;
    }
    return events;
  }

  #decode(chunk, events) {
    // A large frame may arrive a byte at a time. Grow geometrically and copy the
    // pending prefix only when necessary, never concatenate it for every read.
    if (!this.#buffer.length) this.#buffer = chunk;
    else {
      const pending = this.#buffer, size = pending.length + chunk.length;
      if (this.#storage.length < size) this.#storage = Buffer.allocUnsafe(Math.max(size, this.#storage.length * 2, 1024));
      if (pending.buffer !== this.#storage.buffer || pending.byteOffset !== this.#storage.byteOffset) pending.copy(this.#storage);
      chunk.copy(this.#storage, pending.length);
      this.#buffer = this.#storage.subarray(0, size);
    }
    if (!this.#upgraded) {
      const end = this.#buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.#buffer.length > 16384) throw new Error('Codex daemon upgrade response is too large.');
        return;
      }
      if (end + 4 > 16384) throw new Error('Codex daemon upgrade response is too large.');
      const head = this.#buffer.subarray(0, end).toString('latin1');
      if (!/^HTTP\/1\.1 101\b/.test(head)) throw new Error('Codex daemon refused the WebSocket upgrade.');
      const received = /^sec-websocket-accept:\s*(.+)$/im.exec(head)?.[1]?.trim();
      if (received !== this.#accept) throw new Error('Codex daemon returned an invalid WebSocket accept key.');
      const headers = new Map();
      for (const line of head.split('\r\n').slice(1)) {
        const colon = line.indexOf(':'); const name = line.slice(0, colon).toLowerCase();
        if (colon < 1 || headers.has(name)) throw new Error('Invalid Codex daemon upgrade headers.');
        headers.set(name, line.slice(colon + 1).trim().toLowerCase());
      }
      if (headers.get('upgrade') !== 'websocket' || !headers.get('connection')?.split(/\s*,\s*/).includes('upgrade') ||
          headers.has('sec-websocket-extensions') || headers.has('sec-websocket-protocol')) throw new Error('Invalid Codex daemon upgrade headers.');
      this.#buffer = this.#buffer.subarray(end + 4);
      this.#upgraded = true;
      events.push({ type: 'open' });
    }
    for (;;) {
      if (this.#buffer.length < 2) return;
      const first = this.#buffer[0];
      const second = this.#buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      // No extension was negotiated, so every reserved bit must be clear.
      if (first & 0x70) throw new Error('Codex daemon sent a frame with reserved bits set.');
      const masked = (second & 0x80) !== 0;
      if (masked !== this.#clientFrames) throw new Error('Invalid Codex daemon frame masking.');
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        const wide = this.#buffer.readBigUInt64BE(2);
        if (wide > BigInt(MAX_MESSAGE_BYTES)) throw new Error('Codex daemon frame exceeds 8 MiB.');
        length = Number(wide); offset = 10;
      }
      if (length > MAX_MESSAGE_BYTES) throw new Error('Codex daemon frame exceeds 8 MiB.');
      const maskLength = masked ? 4 : 0;
      if (this.#buffer.length < offset + maskLength + length) return;
      const payload = Buffer.from(this.#buffer.subarray(offset + maskLength, offset + maskLength + length));
      if (masked) {
        const mask = this.#buffer.subarray(offset, offset + 4);
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      }
      this.#buffer = this.#buffer.subarray(offset + maskLength + length);
      if (opcode >= 0x8) {
        if (!fin || length > 125) throw new Error('Codex daemon sent an invalid control frame.');
        if (opcode === 0x8) events.push({ type: 'close' });
        else if (opcode === 0x9) events.push({ type: 'ping', payload });
        else if (opcode !== 0xa) throw new Error('Codex daemon sent an unsupported frame type.');
        continue;
      }
      if (opcode === 0x2) throw new Error('Codex daemon sent an unsupported binary frame.');
      if (opcode !== 0x1 && opcode !== 0x0) throw new Error('Codex daemon sent an unsupported frame type.');
      if (opcode === 0x0 && this.#parts.length === 0) throw new Error('Codex daemon sent an unexpected continuation frame.');
      if (opcode === 0x1 && this.#parts.length > 0) throw new Error('Codex daemon started a new message before finishing the previous one.');
      this.#parts.push(payload);
      this.#partBytes += payload.length;
      if (this.#partBytes > MAX_MESSAGE_BYTES) throw new Error('Codex daemon message exceeds 8 MiB.');
      if (fin) {
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(this.#parts.length === 1 ? this.#parts[0] : Buffer.concat(this.#parts)); }
        catch { throw new Error('Invalid UTF-8 in a Codex daemon frame.'); }
        events.push({ type: 'text', text });
        this.#parts = []; this.#partBytes = 0;
      }
    }
  }
}
