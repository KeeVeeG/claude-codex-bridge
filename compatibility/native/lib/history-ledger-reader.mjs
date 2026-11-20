// Schema-1 state is a JSON object, not a line format. Frame one value at a time
// and let JSON.parse validate it, including values history does not project.
const WINDOW_BYTES = 256 * 1024;
const MAX_VALUE_BYTES = 2 * 1024 * 1024;
const MAX_KEY_BYTES = 2 * 1024;
const MAX_DEPTH = 256;
const MAX_ENTRIES = 65536;
const whitespace = byte => byte === 32 || byte === 9 || byte === 10 || byte === 13;
const invalid = () => ledgerError('STATE_INVALID');
const tooLarge = () => ledgerError('LEDGER_TOO_LARGE');
function ledgerError(code) { return Object.assign(new Error(code), { code }); }

class JsonWindows {
  constructor(handle, size, check) {
    this.handle = handle;
    this.size = size;
    this.check = check;
    this.buffer = Buffer.allocUnsafe(Math.min(size + 1, WINDOW_BYTES));
    this.position = this.end = this.loaded = 0;
  }

  async refill() {
    this.check();
    if (this.loaded === this.size) return false;
    const { bytesRead } = await this.handle.read(this.buffer, 0, Math.min(this.buffer.length, this.size - this.loaded), this.loaded);
    this.check();
    if (!bytesRead) throw ledgerError('LEDGER_CHANGED');
    this.loaded += bytesRead;
    this.position = 0;
    this.end = bytesRead;
    return true;
  }

  async peek() {
    do {
      while (this.position < this.end) {
        const byte = this.buffer[this.position];
        if (!whitespace(byte)) return byte;
        this.position++;
      }
    } while (await this.refill());
  }

  async take(byte) {
    if (await this.peek() !== byte) return false;
    this.position++;
    return true;
  }

  async expect(byte) { if (!await this.take(byte)) throw invalid(); }

  async value(maxBytes = MAX_VALUE_BYTES) {
    const first = await this.peek();
    if (first === undefined) throw invalid();
    const primitive = first !== 34 && first !== 123 && first !== 91;
    let start = this.position, copied = 0, depth = 0, quoted = false, escaped = false;
    for (;;) {
      const { buffer, end } = this;
      // Check the value size before copying or handing any of it to JSON.parse.
      const limit = Math.min(end, start + maxBytes - copied + 1);
      let finished = false;
      for (; this.position < limit; this.position++) {
        const byte = buffer[this.position];
        if (primitive) {
          if (byte === 44 || byte === 125 || byte === 93 || whitespace(byte)) { finished = true; break; }
        } else if (quoted) {
          if (escaped) escaped = false;
          else if (byte === 92) escaped = true;
          else if (byte === 34) {
            quoted = false;
            if (!depth) { this.position++; finished = true; break; }
          }
        } else if (byte === 34) quoted = true;
        else if (byte === 123 || byte === 91) {
          if (++depth > MAX_DEPTH) throw tooLarge();
        } else if (byte === 125 || byte === 93) {
          if (!--depth) { this.position++; finished = true; break; }
        }
      }
      const length = this.position - start;
      if (copied + length > maxBytes) throw tooLarge();
      if (finished || (this.loaded === this.size && primitive && this.position === end)) {
        if (!copied) return this.parse(buffer, start, this.position);
        buffer.copy(this.scratch, copied, start, this.position);
        return this.parse(this.scratch, 0, copied + length);
      }
      if (this.position !== end) throw tooLarge();
      this.scratch ??= Buffer.allocUnsafe(MAX_VALUE_BYTES);
      buffer.copy(this.scratch, copied, start, this.position);
      copied += length;
      if (!await this.refill()) throw invalid();
      start = 0;
    }
  }

  parse(buffer, start, end) {
    try { return JSON.parse(buffer.toString('utf8', start, end)); }
    catch { throw invalid(); }
  }

  async map(entry, maxEntries = MAX_ENTRIES) {
    await this.expect(123); // {
    if (await this.take(125)) return;
    const seen = new Set();
    let keyWeight = 0;
    do {
      if (seen.size === maxEntries) throw tooLarge();
      if (await this.peek() !== 34) throw invalid();
      const key = await this.value(MAX_KEY_BYTES);
      // A writer emits unique keys. Reject ambiguous documents rather than
      // projecting a stale value overwritten later in the same generation.
      if (seen.has(key)) throw invalid();
      keyWeight += 48 + 2 * key.length;
      if (keyWeight > 32 * 1024 * 1024) throw tooLarge();
      seen.add(key);
      await this.expect(58); // :
      await entry(key);
    } while (await this.take(44)); // ,
    await this.expect(125); // }
  }
}

export async function readHistoryLedger(handle, size, check, visitRecord) {
  const reader = new JsonWindows(handle, size, check);
  const header = Object.create(null);
  await reader.map(async name => {
    if (name === 'messages') {
      await reader.map(async key => visitRecord(key, await reader.value(), header.threadId));
    } else if (name === 'requests' && await reader.peek() === 123) {
      // Earlier schema-1 writers used a requests map. Verify its syntax without loading it all.
      await reader.map(async () => { await reader.value(); });
    } else if (name === 'key' || name === 'schemaVersion' || name === 'threadId' || name === 'cwd') {
      // The largest supported header is cwd (32 KiB UTF-8 in the writer, up to
      // six serialized bytes per original byte). Never retain arbitrary metadata.
      header[name] = await reader.value(name === 'cwd' ? 200 * 1024 : 4 * 1024);
    } else {
      await reader.value();
    }
  }, 256);
  if (await reader.peek() !== undefined) throw invalid();
  check();
  const { bytesRead } = await handle.read(reader.buffer, 0, 1, size);
  if (bytesRead) throw ledgerError('LEDGER_CHANGED');
  return header;
}
