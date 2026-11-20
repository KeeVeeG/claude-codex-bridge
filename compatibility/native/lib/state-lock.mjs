// One on-disk protocol for sync maintenance callers, old binaries and async MCP mutations.
// The two drivers differ only in how they obtain process evidence, yield and wait for the callback.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { readProcessStart } from './claude-process.mjs';
import { inquire, remainingMs, throwIfStopped } from './call-time.mjs';
import { failure } from './outcome.mjs';

const sleep = new Int32Array(new SharedArrayBuffer(4));
const sharing = e => process.platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(e?.code);
const macStart = /^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/;
const validDate = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString() === s;
const iso = raw => macStart.test(raw) && Number.isFinite(Date.parse(`${raw} UTC`)) ? new Date(Date.parse(`${raw} UTC`)).toISOString() : null;
const winMs = ft => Number((BigInt(ft) - 116444736000000000n) / 10000n);
const isFt = s => typeof s === 'string' && /^\d{1,20}$/.test(s);
let ownStart;

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export function readMacProcessStart(pid, { spawnImpl = spawnSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const r = spawnImpl('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000, maxBuffer: 16384, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
    return !r.error && r.status === 0 && typeof r.stdout === 'string' ? iso(r.stdout.trim()) : null;
  } catch { return null; }
}
export function macLockOwnerAlive(owner, { isAlive = processAlive, readStart = readMacProcessStart } = {}) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || !isAlive(owner.pid)) return false;
  if (!validDate(owner.procStartUtc)) return true; // Civil time cannot disprove a tokenless live owner.
  try { const actual = readStart(owner.pid); return !validDate(actual) || actual === owner.procStartUtc; } catch { return true; }
}

function syncStart(pid) {
  if (process.platform === 'darwin') return readMacProcessStart(pid);
  if (process.platform !== 'win32') return null;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString()`], { encoding: 'utf8', windowsHide: true, timeout: 2500, maxBuffer: 16384 });
  return !r.error && r.status === 0 && isFt(r.stdout?.trim()) ? r.stdout.trim() : null;
}
async function asyncStart(pid, { signal, until }) {
  if (!['win32', 'darwin'].includes(process.platform)) return null;
  try {
    const value = await inquire(a => readProcessStart(pid, { signal: a.signal }), { signal, until });
    return value?.start ? (process.platform === 'win32' ? isFt(value.start) && value.start : iso(value.start)) : null;
  } catch { throwIfStopped(signal); return null; } // An inconclusive query never authorizes takeover.
}

function publish(file, owner) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
    try { fs.linkSync(tmp, file); } catch (e) {
      if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(e.code)) throw failure('Bridge storage requires a writable local volume that supports hard links. Move the state directory with all bridge sessions stopped, then run bridge_doctor.', 'state_unavailable');
      throw e;
    }
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
function readOwner(file) {
  const stat = fs.lstatSync(file);
  const data = stat.isFile() && stat.size < 8192 ? fs.readFileSync(file, 'utf8') : undefined;
  let value; try { value = JSON.parse(data); } catch {}
  if (!Number.isSafeInteger(value?.pid) || value.pid <= 0) throw failure('The saved bridge records have an unverifiable lock owner. Stop all bridge sessions and run bridge_doctor before coordinated recovery.', 'state_unavailable', { code: 'LOCK_INCOMPLETE' });
  return value;
}
function* alive(owner, io) {
  if (!processAlive(owner.pid)) return false;
  if (owner.pid === process.pid && !owner.procStartFt && !owner.procStartUtc && !Number.isSafeInteger(owner.procStartMs)) return true;
  if (process.platform === 'darwin' && validDate(owner.procStartUtc)) {
    const actual = yield io.start(owner.pid);
    return !validDate(actual) || actual === owner.procStartUtc;
  }
  if (process.platform === 'win32' && (isFt(owner.procStartFt) || Number.isSafeInteger(owner.procStartMs))) {
    const actual = yield io.start(owner.pid);
    if (!isFt(actual)) return true;
    if (isFt(owner.procStartFt)) return actual === owner.procStartFt;
    // Old writers used a wall-derived process origin, not the OS token. Preserve their tolerance;
    // the creation date of a lock is not proof of death across a clock adjustment.
    return Math.abs(winMs(actual) - owner.procStartMs) <= 5000;
  }
  return true;
}

// Only tokens this process ceased using may be reaped on its behalf. This is not stale-by-age
// recovery. Recheck the token for every unlink, including after a sharing violation.
const pendingRelease = new Map();
let cleaner;
function clean(file, token) {
  try { if (readOwner(file).token === token) fs.unlinkSync(file); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (pendingRelease.get(file) === token) pendingRelease.delete(file);
}
function remember(file, token) {
  pendingRelease.set(file, token);
  if (!cleaner) {
    cleaner = setInterval(() => {
      for (const [file, token] of pendingRelease) try { clean(file, token); } catch {}
      if (!pendingRelease.size) { clearInterval(cleaner); cleaner = undefined; }
    }, 1000);
    cleaner.unref();
  }
}
function* release(file, token, io) {
  const end = io.now() + 1000;
  for (;;) {
    try { clean(file, token); return; } catch (e) {
      if (sharing(e) && io.now() < end) { yield io.pause(15, false); continue; }
      remember(file, token); return; // The callback has finished. Do not turn a commit into a failed send.
    }
  }
}
function* transaction(directory, callback, io) {
  const busy = () => failure('Bridge state is busy. Wait for the current operation to finish, then retry.', 'state_busy');
  const check = () => { throwIfStopped(io.signal); if (io.now() >= io.until) throw busy(); };
  // Early route-compatible writers created an empty exclusive file, then wrote its PID.
  // Give the publisher a bounded chance to finish; never unlink an incomplete owner.
  let incompleteUntil;
  const retry = function* (e) {
    if (e.code === 'LOCK_INCOMPLETE') {
      incompleteUntil ??= Math.min(io.until, io.now() + 500);
      if (io.now() >= incompleteUntil) throw e;
    } else if (!sharing(e) || io.now() >= io.until) throw e;
    throwIfStopped(io.signal); yield io.pause(15, true);
  };
  throwIfStopped(io.signal);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'state.lock'), guard = path.join(directory, 'state.lock.recovery');
  for (const file of [lock, guard]) if (pendingRelease.has(file)) try { clean(file, pendingRelease.get(file)); } catch {}
  const token = randomUUID();
  const start = ownStart ?? (yield io.start(process.pid));
  if (start) ownStart = start; // Only this same process's own immutable creation token is cached.
  const owner = { pid: process.pid, token, createdAt: Date.now(), ...(process.platform === 'win32' && isFt(start) ? { procStartFt: start, procStartMs: winMs(start) } : {}), ...(process.platform === 'darwin' && validDate(start) ? { procStartUtc: start } : {}) };
  for (;;) {
    check();
    try { publish(lock, owner); break; } catch (e) { if (e.code !== 'EEXIST') { yield* retry(e); continue; } }
    let other;
    try { other = readOwner(lock); } catch (e) { if (e.code !== 'ENOENT') yield* retry(e); continue; }
    if (yield* alive(other, io)) { yield io.pause(15, true); continue; }
    check();
    try { publish(guard, owner); } catch (e) {
      if (e.code !== 'EEXIST') { yield* retry(e); continue; }
      let guardian;
      try { guardian = readOwner(guard); } catch (e) { if (e.code !== 'ENOENT') yield* retry(e); continue; }
      if (!(yield* alive(guardian, io))) throw failure('Bridge lock recovery was interrupted. Stop all bridge sessions and run bridge_doctor for coordinated recovery.', 'state_unavailable');
      yield io.pause(15, true); continue;
    }
    try {
      for (;;) {
        try {
          const current = readOwner(lock);
          if (!(yield* alive(current, io))) {
            // The async proof yielded; check that it still names this complete lock immediately
            // before unlinking. The recovery guard excludes simultaneous stale-owner reapers.
            if (JSON.stringify(readOwner(lock)) === JSON.stringify(current)) fs.unlinkSync(lock);
          }
          break;
        } catch (e) { if (e.code === 'ENOENT') break; yield* retry(e); }
      }
    } finally { yield* release(guard, token, io); }
  }
  try { throwIfStopped(io.signal); return yield callback(); } finally { yield* release(lock, token, io); }
}

const mono = () => performance.now();
function policy(async, { signal, now = mono, waitMs = 5000, probe } = {}) {
  const until = now() + Math.min(waitMs, remainingMs(signal));
  return { signal, now, until, start: probe ?? (async ? pid => asyncStart(pid, { signal, until: mono() + Math.max(0, until - now()) }) : syncStart),
    pause: async ? (ms, cancellable) => delay(ms, undefined, { signal: cancellable ? signal : undefined }).catch(error => { if (cancellable) throwIfStopped(signal); throw error; })
      : ms => Atomics.wait(sleep, 0, 0, ms) };
}
export function withStateLock(directory, callback, options) {
  const steps = transaction(directory, callback, policy(false, options));
  let state = steps.next(); while (!state.done) state = steps.next(state.value);
  return state.value;
}
export async function withStateLockAsync(directory, callback, options) {
  const steps = transaction(directory, callback, policy(true, options));
  let state = steps.next();
  while (!state.done) {
    let value; try { value = await state.value; } catch (e) { state = steps.throw(e); continue; }
    state = steps.next(value);
  }
  return state.value;
}
