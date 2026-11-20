// MCP-facing storage operations. Even a 1.0 writer must see every reservation in state.json;
// keep that authoritative projection, but parse and replace large snapshots off the control loop.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import * as store from './store.mjs';
import { failure, REASONS, outcome } from './outcome.mjs';
import { remainingMs, throwIfStopped } from './call-time.mjs';

let worker, startup, workerFailure, sequence = 0;
const jobs = new Map();
const largeBytes = 512 * 1024;
export function warmLedgerWorker() {
  if (workerFailure) return Promise.reject(workerFailure);
  if (startup) return startup;
  const running = new Worker(new URL('./ledger-worker.mjs', import.meta.url), { execArgv: [] });
  worker = running;
  startup = new Promise((resolve, reject) => {
    running.on('message', message => {
      if (message.ready) { if (!jobs.size) running.unref(); resolve(); return; }
      const job = jobs.get(message.id); if (!job) return;
      jobs.delete(message.id);
      if (message.error) job.reject(Object.assign(new Error(message.error.message), message.error)); else job.resolve(message.value);
      if (!jobs.size) running.unref();
    });
    const lost = () => {
      if (worker !== running) return;
      // A replacement would import whatever code the installer last wrote, not this server's version.
      workerFailure = failure('The storage worker stopped. Restart this bridge server and inspect saved deliveries before trying a send.', 'state_unavailable');
      const error = workerFailure; reject(error);
      for (const job of jobs.values()) job.reject(error);
      jobs.clear(); worker = startup = undefined;
    };
    running.on('error', lost); running.on('exit', lost);
  });
  return startup;
}
function large(file) {
  try { return fs.statSync(file).size >= largeBytes; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function offThread(method, args, signal) {
  await warmLedgerWorker(); throwIfStopped(signal);
  const id = ++sequence;
  // A queued worker cannot handle an abort message during parsing/serialization. Share the
  // cancellation bit so it can refuse the rename itself, without releasing the real lock early.
  const stop = signal && new Int32Array(new SharedArrayBuffer(4));
  const abort = () => Atomics.store(stop, 0, 1);
  const until = Number(process.hrtime.bigint()) / 1e6 + remainingMs(signal);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    return await new Promise((resolve, reject) => {
      jobs.set(id, { resolve, reject }); worker.ref();
      try { worker.postMessage({ id, method, args, stop, until }); }
      catch (error) { jobs.delete(id); if (!jobs.size) worker.unref(); reject(error); }
    });
  } catch (e) { throwIfStopped(signal); throw e; }
  finally { signal?.removeEventListener('abort', abort); }
}

/** Atomic replacement, including interruptible sharing-violation waits. Never rerun a callback. */
export async function saveJson(file, state, { signal, check = () => throwIfStopped(signal) } = {}) {
  check();
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 });
    const until = performance.now() + 1000;
    for (;;) {
      check();
      try { fs.renameSync(tmp, file); return; } catch (error) {
        if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || performance.now() >= until) throw error;
        await delay(15, undefined, { signal }).catch(e => { throwIfStopped(signal); throw e; });
      }
    }
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
const unlocked = (_, fn) => fn();
export function createSession(input, signal) {
  return store.createSession(input, { lock: (s, fn) => store.withStateLockAsync(s.dir, fn, { signal }), save: (file, state) => saveJson(file, state, { signal }) });
}
export function routedRecord(owner, route, id, signal) {
  throwIfStopped(signal);
  return large(store.ledgerAt(owner).stateFile) ? offThread('routedRecord', [owner, route, id], signal) : store.routedRecord(owner, route, id);
}
export function lookupMessage(owner, draft, { signal } = {}) {
  const file = store.ledgerAt(owner).stateFile; throwIfStopped(signal);
  return large(file) ? offThread('lookup', [owner, draft], signal) : store.lookupMessage(owner, draft);
}
export function recordMessage(session, input, { signal } = {}) {
  return store.withStateLockAsync(session.dir, async () => {
    const order = await store.allocateOrder(session, { lock: store.withStateLockAsync, save: saveJson, signal });
    throwIfStopped(signal);
    return large(session.stateFile) ? offThread('record', [session, input, order], signal)
      : store.recordMessage(session, input, { peek: false, lock: unlocked, order, save: (file, state) => saveJson(file, state, { signal }) });
  }, { signal });
}
export function finishMessage(session, id, result) {
  // Do not abandon a known terminal outcome because the client disconnected. Only the state write
  // is attempted; it cannot touch either transport again.
  return store.withStateLockAsync(session.dir, () => large(session.stateFile)
    ? offThread('finish', [session, id, result])
    : store.finishMessage(session, id, result, { lock: unlocked, save: saveJson }));
}
export function listMessages(session, limit, from, signal) {
  throwIfStopped(signal);
  if (large(session.stateFile)) return offThread('list', [session, limit, from], signal);
  const issues = []; const rows = store.getMessages(session, limit, undefined, from, issues);
  return { rows, issues };
}

// At capacity refuse new reservations instead of forgetting an outcome which storage has not taken.
const deferred = new Map();
const pendingKey = (session, route, id) => JSON.stringify([session.stateFile, route, id]);
export function retainSettlement(session, record, terminal) {
  deferred.set(pendingKey(session, record.route, record.id), { record, terminal: { ...terminal, attemptId: record.attemptId } });
}
export function checkSettlementCapacity() {
  if (deferred.size >= 256) throw failure('Bridge storage has unsaved delivery receipts. Restore write access and inspect the pending deliveries before sending.', 'state_unavailable');
}
export async function repairSettlement(session, prior) {
  if (!session || !prior) return prior;
  const key = pendingKey(session, prior.route, prior.id), pending = deferred.get(key);
  if (!pending) return prior;
  if (pending.record.attemptId !== prior.attemptId || !['sending','uncertain'].includes(prior.status)) { deferred.delete(key); return prior; }
  try { const repaired = await finishMessage(session, prior.id, pending.terminal); deferred.delete(key);
    return { ...repaired, retryable: repaired.status === 'failed' && REASONS[repaired.reason]?.delivered === false }; }
  catch {
    if (pending.terminal.status === 'failed') throw Object.assign(new Error('This attempt sent nothing, but its receipt still cannot be saved. Restore write access and inspect list_deliveries before retrying.'),
      { outcome: outcome(pending.terminal.reason, { record: prior, retry: 'inspect' }) });
    if (pending.terminal.status === 'submitted') throw failure('The message was submitted, but its receipt still cannot be saved. Do not send it again. Restore write access before checking the record.', 'settlement_failed', { outcome: outcome('settlement_failed', { record: prior }) });
    return { ...prior, ...pending.terminal, retryable: false, interrupted: false };
  }
}
