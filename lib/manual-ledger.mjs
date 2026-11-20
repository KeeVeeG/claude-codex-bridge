import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { beforeWrite, monotonicNow, throwIfStopped } from './call-time.mjs';
import { defaultStateDir, withStateLockAsync } from './store.mjs';

const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
// A single body can take six JSON bytes per UTF-8 byte (escaped control characters).
const MAX_OVERFLOW_BYTES = 512 * 1024;
const overflowName = /^overflow-([a-f0-9]{64})\.json$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function manualLedgerPaths(stateDir, threadId, ownerKey) {
  const state = path.resolve(stateDir || defaultStateDir());
  const manual = path.join(state, 'manual');
  const directory = path.join(manual, ownerKey);
  return { state, manual, directory, file: path.join(directory, 'state.json'), threadId };
}

function checkDirectories(paths, create = false) {
  for (const directory of [paths.state, paths.manual, paths.directory]) {
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Manual bridge records require a real local directory.');
  }
}

function findDirectories(paths) {
  try { checkDirectories(paths); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function readJson(file, maxBytes) {
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
      throw new Error('Manual bridge ledger must be a bounded regular file.');
    }
    const fd = fs.openSync(file, 'r');
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) {
        throw new Error('Manual bridge ledger changed while it was opened.');
      }
      // Read exactly the opened snapshot, with a bounded guard byte for in-place writers.
      const buffer = Buffer.alloc(opened.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = fs.readSync(fd, buffer, size, buffer.length - size, size);
        if (!count) break;
        size += count;
      }
      if (size !== opened.size) throw new Error('Manual bridge ledger changed while it was read.');
      try { return JSON.parse(buffer.subarray(0, size).toString('utf8')); }
      catch { throw new Error('Manual bridge ledger contains invalid JSON.'); }
    } finally { fs.closeSync(fd); }
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function readLedger(paths) {
  const value = readJson(paths.file, MAX_LEDGER_BYTES);
  if (value === undefined) return { schemaVersion: 1, owner_thread_id: paths.threadId, records: {} };
  if (!object(value) || value.schemaVersion !== 1 || value.owner_thread_id !== paths.threadId || !object(value.records)) {
    throw new Error('Manual bridge records have an invalid owner or format.');
  }
  return value;
}

const overflowFile = (paths, key) => path.join(paths.directory, `overflow-${key}.json`);

function readOverflow(paths, key) {
  const value = readJson(overflowFile(paths, key), MAX_OVERFLOW_BYTES);
  if (value === undefined) return undefined;
  if (!object(value) || value.schemaVersion !== 1 || value.owner_thread_id !== paths.threadId || !object(value.record)) {
    throw new Error('Manual bridge overflow has an invalid owner or format.');
  }
  return { ...value.record, overflow: true };
}

async function replaceJson(file, text, signal) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (signal) beforeWrite(signal);
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    const until = monotonicNow() + 1000;
    for (;;) {
      if (signal) beforeWrite(signal);
      try { fs.renameSync(temporary, file); return; }
      catch (error) {
        const remaining = until - monotonicNow();
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || remaining <= 0) throw error;
        try { await wait(Math.min(25, remaining), undefined, { signal }); }
        catch (error) { throwIfStopped(signal); throw error; }
      }
    }
  } finally {
    // Temp cleanup cannot turn a committed rename into a failed receipt, or mask the original failure.
    try { fs.unlinkSync(temporary); } catch {}
  }
}

export function readManualEntry(paths, key) {
  if (!findDirectories(paths)) return {};
  const overflow = readOverflow(paths, key);
  const legacy = readLedger(paths).records[key];
  return { record: overflow ?? legacy, ...(overflow ? { legacy } : {}) };
}

export function* readManualEntries(paths) {
  if (!findDirectories(paths)) return;
  const records = readLedger(paths).records;
  const overflowKeys = new Set();
  for (const name of fs.readdirSync(paths.directory)) {
    const key = overflowName.exec(name)?.[1];
    if (!key) continue;
    const record = readOverflow(paths, key);
    if (!record) continue;
    overflowKeys.add(key);
    yield [key, record, records[key]];
  }
  for (const [key, record] of Object.entries(records)) if (!overflowKeys.has(key)) yield [key, record];
}

/** Old writers synchronize on this same owner directory. Never move an existing v1
 * key out of state.json: it may contain an old writer's notice claim. New keys may
 * overflow, but only the legacy representation can authorize an owner notice. */
export async function updateManualEntry(paths, key, edit, { signal, create = true, onOverflow } = {}) {
  throwIfStopped(signal);
  checkDirectories(paths, create);
  return await withStateLockAsync(paths.directory, async () => {
    if (signal) beforeWrite(signal);
    const overflow = readOverflow(paths, key);
    const ledger = overflow ? undefined : readLedger(paths);
    const previous = overflow ?? ledger.records[key];
    const record = await edit(object(previous) ? { ...previous } : previous);
    if (!record || JSON.stringify(record) === JSON.stringify(previous)) return record;
    if (ledger) {
      ledger.records[key] = record;
      let text = JSON.stringify(ledger, null, 2) + '\n';
      // Keep the old writers' pretty-printed limit for new reservations. Compact
      // only when settling an existing key and no pretty-printed receipt fits.
      if (previous && Buffer.byteLength(text) > MAX_LEDGER_BYTES) text = JSON.stringify(ledger) + '\n';
      if (Buffer.byteLength(text) <= MAX_LEDGER_BYTES) {
        await replaceJson(paths.file, text, signal);
        return record;
      }
      if (previous || !onOverflow) throw new Error('Manual receipt did not fit the existing state. Free space and retry recording the outcome.');
      onOverflow(record);
    }
    const text = JSON.stringify({ schemaVersion: 1, owner_thread_id: paths.threadId, record }) + '\n';
    if (Buffer.byteLength(text) > MAX_OVERFLOW_BYTES) throw new Error('Manual receipt exceeds its size limit.');
    await replaceJson(overflowFile(paths, key), text, signal);
    return record;
  }, { signal });
}
