import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { beforeWrite, monotonicNow, throwIfStopped } from './call-time.mjs';
import { ensureStateDirectory } from './state-directory.mjs';
import { defaultStateDir, withStateLockAsync } from './store.mjs';
import { isWindowsSharingError } from './state-files.mjs';

const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
// A single body can take six JSON bytes per UTF-8 byte (escaped control characters).
const MAX_OVERFLOW_BYTES = 512 * 1024;
const keyPattern = /^[a-f0-9]{64}$/;
const overflowName = /^overflow-([a-f0-9]{64})\.json$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const statOptions = { bigint: true };
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const sameVersion = (a, b) => sameNode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const readFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const cacheKey = (paths, file) => `${paths.threadId}\0${file}`;
const utf8 = new TextDecoder('utf-8', { fatal: true });

class SnapshotCache {
  entries = new Map();
  weight = 0;
  constructor(budget, count) { this.budget = budget; this.count = count; }
  read(key, stat, load) {
    let entry = this.entries.get(key);
    if (entry) {
      this.weight -= entry.weight;
      this.entries.delete(key);
    }
    if (!stat) return undefined;
    if (!entry || !sameVersion(stat, entry.stat)) entry = { stat, ...load() };
    this.entries.set(key, entry);
    this.weight += entry.weight;
    while (this.weight > this.budget || this.entries.size > this.count) {
      const oldest = this.entries.keys().next().value;
      this.weight -= this.entries.get(oldest).weight;
      this.entries.delete(oldest);
    }
    return entry.value;
  }
}

// Keep large texts from evicting compact overflow metadata for other peers.
const ledgers = new SnapshotCache(4 * MAX_LEDGER_BYTES, 32);
const overflowMetadata = new SnapshotCache(16 * 1024 * 1024, 16384);
const bodies = new SnapshotCache(16 * 1024 * 1024, 1024);

export function manualLedgerPaths(stateDir, threadId, ownerKey) {
  const state = path.resolve(stateDir || defaultStateDir());
  const manual = path.join(state, 'manual');
  const directory = path.join(manual, ownerKey);
  return { state, manual, directory, file: path.join(directory, 'state.json'), threadId };
}

function checkDirectories(paths, create = false) {
  return [paths.state, paths.manual, paths.directory].map(directory => {
    if (create) ensureStateDirectory(directory);
    const stat = fs.lstatSync(directory, statOptions);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Manual bridge records require a real local directory.');
    return stat;
  });
}

function findDirectories(paths) {
  try { return checkDirectories(paths); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function assertDirectories(paths, before) {
  const after = findDirectories(paths);
  if (!after || !after.every((stat, i) => sameNode(stat, before[i]))) {
    throw new Error('Manual bridge directories changed during access.');
  }
}

function fileStat(file, maxBytes) {
  let stat;
  try { stat = fs.lstatSync(file, statOptions); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(maxBytes)) {
    throw new Error('Manual bridge ledger must be a bounded regular file.');
  }
  return stat;
}

function readJson(paths, directories, file, maxBytes, before) {
  const fd = fs.openSync(file, readFlags);
  try {
    const opened = fs.fstatSync(fd, statOptions);
    if (!opened.isFile() || !sameVersion(opened, before)) {
      throw new Error('Manual bridge ledger changed while it was opened.');
    }
    // Read exactly the opened snapshot, with a bounded guard byte for in-place writers.
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    const after = fileStat(file, maxBytes);
    if (size !== Number(opened.size) || !after || !sameVersion(after, opened) ||
        !sameVersion(fs.fstatSync(fd, statOptions), opened)) {
      throw new Error('Manual bridge ledger changed while it was read.');
    }
    assertDirectories(paths, directories);
    try { return JSON.parse(utf8.decode(buffer.subarray(0, size))); }
    catch { throw new Error('Manual bridge ledger contains invalid JSON.'); }
  } finally { fs.closeSync(fd); }
}

function readLedger(paths, directories, cached = false) {
  const { file, threadId } = paths;
  const stat = fileStat(file, MAX_LEDGER_BYTES);
  const load = () => {
    const value = readJson(paths, directories, file, MAX_LEDGER_BYTES, stat);
    if (!object(value) || value.schemaVersion !== 1 || value.owner_thread_id !== threadId || !object(value.records)) {
      throw new Error('Manual bridge records have an invalid owner or format.');
    }
    return { value, weight: Number(stat.size) };
  };
  return (cached ? ledgers.read(cacheKey(paths, file), stat, load) : stat && load().value) ??
    { schemaVersion: 1, owner_thread_id: threadId, records: {} };
}

const overflowFile = (paths, key) => path.join(paths.directory, `overflow-${key}.json`);
const bodyFile = (paths, key) => path.join(paths.directory, `body-${key}.json`);

function readOverflow(paths, directories, file, stat, cached = false) {
  const load = () => {
    const value = readJson(paths, directories, file, MAX_OVERFLOW_BYTES, stat);
    if (!object(value) || value.schemaVersion !== 1 || value.owner_thread_id !== paths.threadId || !object(value.record)) {
      throw new Error('Manual bridge overflow has an invalid owner or format.');
    }
    return { value: { ...value.record, overflow: true }, weight: Number(stat.size) };
  };
  return cached ? bodies.read(cacheKey(paths, file), stat, load) : stat && load().value;
}

function matchesMessage(paths, key, record, message) {
  return typeof message === 'string' && message.isWellFormed() && message.trim() && !message.includes('\0') &&
    Buffer.byteLength(message) <= 65536 && typeof record.session_id === 'string' && typeof record.message_id === 'string' &&
    hash(JSON.stringify([record.session_id, record.message_id])) === key &&
    hash(JSON.stringify({ direction: 'to_claude', message, route: {
      from: { kind: 'codex', id: paths.threadId }, to: { kind: 'claude', id: record.session_id },
    } })) === record.fingerprint;
}

function readBody(paths, directories, key, record) {
  if (!object(record) || !keyPattern.test(key)) return undefined;
  try {
    const file = bodyFile(paths, key);
    const stat = fileStat(file, MAX_OVERFLOW_BYTES);
    const body = bodies.read(cacheKey(paths, file), stat, () => ({ value: readJson(paths, directories, file, MAX_OVERFLOW_BYTES, stat),
      weight: Number(stat.size) }));
    if (body?.schemaVersion === 1 && body.owner_thread_id === paths.threadId && body.fingerprint === record.fingerprint &&
        matchesMessage(paths, key, record, body.message)) return body.message;
  } catch { /* Supplemental text must not make a claim unreadable or authorize new transport. */ }
  return undefined;
}

async function replaceJson(paths, directories, file, text, signal) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (signal) beforeWrite(signal);
    assertDirectories(paths, directories);
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    const until = monotonicNow() + 1000;
    for (;;) {
      if (signal) beforeWrite(signal);
      assertDirectories(paths, directories);
      try { fs.renameSync(temporary, file); return; }
      catch (error) {
        const remaining = until - monotonicNow();
        if (!isWindowsSharingError(error) || remaining <= 0) throw error;
        try { await wait(Math.min(25, remaining), undefined, { signal }); }
        catch (error) { throwIfStopped(signal); throw error; }
      }
    }
  } finally {
    // Temp cleanup cannot turn a committed rename into a failed receipt, or mask the original failure.
    try { fs.unlinkSync(temporary); } catch {}
  }
}

async function saveBody(paths, directories, key, record, signal) {
  if (!matchesMessage(paths, key, record, record.message)) throw new Error('Saved manual message does not match its delivery entry.');
  if (readBody(paths, directories, key, record) === record.message) return;
  const text = JSON.stringify({ schemaVersion: 1, owner_thread_id: paths.threadId,
    fingerprint: record.fingerprint, message: record.message }) + '\n';
  if (Buffer.byteLength(text) > MAX_OVERFLOW_BYTES) throw new Error('Saved manual message exceeds its size limit.');
  await replaceJson(paths, directories, bodyFile(paths, key), text, signal);
}

function withBody(paths, directories, key, record) {
  const message = record?.message === undefined ? readBody(paths, directories, key, record) : undefined;
  return message === undefined ? record : { ...record, message };
}

export function readManualEntry(paths, key) {
  if (!keyPattern.test(key)) throw new Error('Invalid manual bridge record key.');
  const directories = findDirectories(paths);
  if (!directories) return {};
  const file = overflowFile(paths, key);
  const overflow = readOverflow(paths, directories, file, fileStat(file, MAX_OVERFLOW_BYTES), true);
  const legacy = readLedger(paths, directories, true).records[key];
  const record = withBody(paths, directories, key, overflow ?? legacy);
  assertDirectories(paths, directories);
  return { record, ...(overflow ? { legacy } : {}) };
}

// The key binds peer + message ID. A change to mutable receipt fields cannot move a
// valid file to another peer. Cache only that membership, not its status or body.
const peerIndexes = new Map();
export async function selectedOverflow(paths, sessionId, signal) {
  const before = findDirectories(paths);
  if (!before) return { names: [], verify: () => { if (findDirectories(paths)) throw new Error('Manual directory changed.'); } };
  const generation = before.at(-1);
  const verify = () => {
    throwIfStopped(signal); assertDirectories(paths, before);
    if (!sameVersion(generation, fs.lstatSync(paths.directory, statOptions))) throw new Error('Manual directory changed.');
  };
  let index = peerIndexes.get(paths.directory);
  if (!index || !sameVersion(generation, index.generation)) {
    const peers = new Map(); let count = 0;
    for await (const entry of await fs.promises.opendir(paths.directory)) {
      const key = overflowName.exec(entry.name)?.[1]; if (!key) continue;
      throwIfStopped(signal);
      if (++count > 100000) throw new Error('Manual history index exceeds the safe read limit.');
      const file = path.join(paths.directory, entry.name), stat = await fs.promises.lstat(file, statOptions);
      if (!stat.isFile() || stat.size > BigInt(MAX_OVERFLOW_BYTES)) throw new Error('Invalid overflow file.');
      const handle = await fs.promises.open(file, readFlags);
      let value;
      try {
        if (!sameVersion(stat, await handle.stat(statOptions))) throw new Error('Overflow file changed.');
        const buffer = Buffer.alloc(Number(stat.size) + 1); let used = 0;
        while (used < buffer.length) {
          const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used); if (!bytesRead) break; used += bytesRead;
        }
        if (used !== Number(stat.size) || !sameVersion(stat, await handle.stat(statOptions))) throw new Error('Overflow file changed.');
        value = JSON.parse(utf8.decode(buffer.subarray(0, used)));
      } finally { await handle.close(); }
      const peer = value?.record?.session_id, id = value?.record?.message_id;
      if (value?.schemaVersion !== 1 || value.owner_thread_id !== paths.threadId || typeof peer !== 'string' || Buffer.byteLength(peer) > 256 ||
          typeof id !== 'string' || hash(JSON.stringify([peer,id])) !== key) throw new Error('Invalid overflow routing metadata.');
      if (!peers.has(peer)) peers.set(peer, []); peers.get(peer).push(entry.name);
    }
    verify(); index = { generation, peers }; peerIndexes.delete(paths.directory); peerIndexes.set(paths.directory,index);
    if (peerIndexes.size > 4) peerIndexes.delete(peerIndexes.keys().next().value);
  }
  return { names: index.peers.get(sessionId) ?? [], verify };
}

export function* readManualEntries(paths, sessionId, names) {
  const directories = findDirectories(paths);
  if (!directories) return;
  const records = readLedger(paths, directories, true).records;
  const overflowKeys = new Set();
  for (const name of names ?? fs.readdirSync(paths.directory)) {
    const key = overflowName.exec(name)?.[1];
    if (!key) continue;
    const file = path.join(paths.directory, name);
    const stat = fileStat(file, MAX_OVERFLOW_BYTES);
    const metadata = overflowMetadata.read(cacheKey(paths, file), stat, () => {
      const { message, ...record } = readOverflow(paths, directories, file, stat, true);
      return { value: { record, embedded: message !== undefined }, weight: Buffer.byteLength(JSON.stringify(record)) };
    });
    if (!metadata) continue;
    overflowKeys.add(key);
    const { record, embedded } = metadata;
    if (sessionId !== undefined && record.session_id !== sessionId) continue;
    const legacy = records[key];
    yield [key, record, legacy, () => {
      if (embedded) {
        const current = fileStat(file, MAX_OVERFLOW_BYTES);
        if (!current || !sameVersion(current, stat)) throw new Error('Manual bridge overflow changed during access.');
        return readOverflow(paths, directories, file, current, true).message;
      }
      return readBody(paths, directories, key, record) ??
        (legacy?.fingerprint === record.fingerprint ? legacy.message : undefined);
    }];
  }
  for (const [key, record] of Object.entries(records)) {
    if (!overflowKeys.has(key) && (sessionId === undefined || record?.session_id === sessionId)) {
      yield [key, record, undefined, () => record.message === undefined ? readBody(paths, directories, key, record) : record.message];
    }
  }
  assertDirectories(paths, directories);
}

/** Old writers synchronize on this same owner directory. Never move an existing v1
 * key out of state.json: it may contain an old writer's notice claim. A body by
 * itself represents no attempt. Only the v1 representation can authorize a notice. */
export async function updateManualEntry(paths, key, edit, { signal, create = true, onOverflow } = {}) {
  throwIfStopped(signal);
  if (!keyPattern.test(key)) throw new Error('Invalid manual bridge record key.');
  const directories = checkDirectories(paths, create);
  return await withStateLockAsync(paths.directory, async () => {
    if (signal) beforeWrite(signal);
    assertDirectories(paths, directories);
    const file = overflowFile(paths, key);
    const overflow = readOverflow(paths, directories, file, fileStat(file, MAX_OVERFLOW_BYTES));
    const ledger = overflow ? undefined : readLedger(paths, directories);
    const previous = overflow ?? ledger.records[key];
    const hydrated = withBody(paths, directories, key, previous);
    const record = await edit(object(hydrated) ? { ...hydrated } : hydrated);
    assertDirectories(paths, directories);
    if (!record || JSON.stringify(record) === JSON.stringify(hydrated)) return record;
    const { message, ...compact } = record;
    let overflowRecord = compact;
    // Save exact text first. A failure here spends neither the primary ID nor
    // the notice slot; a failure after this leaves an inert, reusable body.
    if (message !== undefined && (previous?.message !== undefined || message !== hydrated?.message)) {
      await saveBody(paths, directories, key, record, signal);
    }
    if (ledger) {
      ledger.records[key] = compact;
      let text = JSON.stringify(ledger, null, 2) + '\n';
      if (Buffer.byteLength(text) > MAX_LEDGER_BYTES) {
        // Earlier builds embedded text in v1 rows. Make room without dropping
        // their claims or publishing a row until every detached body is saved.
        for (const [oldKey, old] of Object.entries(ledger.records)) {
          if (old?.message === undefined) continue;
          await saveBody(paths, directories, oldKey, old, signal);
          delete old.message;
        }
        text = JSON.stringify(ledger, null, 2) + '\n';
      }
      // Keep the old writers' pretty-printed limit for new reservations. Compact
      // only when settling an existing key and no pretty-printed receipt fits.
      if (previous && Buffer.byteLength(text) > MAX_LEDGER_BYTES) text = JSON.stringify(ledger) + '\n';
      if (Buffer.byteLength(text) <= MAX_LEDGER_BYTES) {
        await replaceJson(paths, directories, paths.file, text, signal);
        return record;
      }
      if (previous || !onOverflow) throw new Error('Manual receipt did not fit the existing state. Free space and retry recording the outcome.');
      onOverflow(record);
      overflowRecord = { ...record };
      delete overflowRecord.message;
    }
    const text = JSON.stringify({ schemaVersion: 1, owner_thread_id: paths.threadId, record: overflowRecord }) + '\n';
    if (Buffer.byteLength(text) > MAX_OVERFLOW_BYTES) throw new Error('Manual receipt exceeds its size limit.');
    await replaceJson(paths, directories, file, text, signal);
    return record;
  }, { signal });
}
