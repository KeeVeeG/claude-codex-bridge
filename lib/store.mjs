import fs from 'node:fs';
import path from 'node:path';
import { defaultStateDir } from './state-directory.mjs';
import crypto from 'node:crypto';
import { withStateLock, processAlive } from './state-lock.mjs';
export { withStateLock, withStateLockAsync, processAlive, macLockOwnerAlive, readMacProcessStart } from './state-lock.mjs';
import { performance } from 'node:perf_hooks';
import { REASONS, failure, outcome } from './outcome.mjs';
import { replaceTextSync } from './state-files.mjs';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
// New attempts carry elapsed time since boot. Civil timestamps are audit fields, not ownership evidence.
export function interruptedSend(record) {
  if (record.status !== 'sending') return false;
  const pid = Number.isSafeInteger(record.senderPid) && record.senderPid > 0;
  if (pid && !processAlive(record.senderPid)) return true;
  const elapsed = Number(process.hrtime.bigint() / 1000000n) - record.startedTick;
  if (Number.isSafeInteger(record.startedTick)) return elapsed < 0 || elapsed > 60_000;
  // Released reservations carry no boot tick. A recycled live PID is not indefinite proof of a send.
  const age = Date.now() - record.createdAt;
  // A future date beside a live PID is a wall-clock rollback, not abandonment (R3D03): age it here.
  if (pid && age < 0) return /^[a-f0-9]{64}$/.test(record.fingerprint ?? '') && legacyAge(record) > 60_000;
  return !Number.isFinite(age) || age < 0 || age > 60_000;
}
// First sight of each exact legacy reservation on this process's monotonic clock; bounded, oldest out.
const legacySeen = new Map();
function legacyAge({ senderPid, createdAt, id, direction, fingerprint }) {
  const key = JSON.stringify([senderPid, createdAt, id, direction, fingerprint ?? null]), now = performance.now();
  if (!legacySeen.has(key)) {
    legacySeen.set(key, now);
    if (legacySeen.size > 4096) legacySeen.delete(legacySeen.keys().next().value);
  }
  return now - legacySeen.get(key);
}

export { defaultStateDir } from './state-directory.mjs';

export function ownerId(value) {
  text(value, 'threadId', 512);
  if (!value.isWellFormed()) throw failure('The conversation ID contains invalid Unicode. Select the conversation again.', 'caller_invalid');
  return value;
}

function text(value, name, max = 65536) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) {
    throw new Error(`${name} must be nonempty text, at most ${max} UTF-8 bytes`);
  }
  return value;
}

function sessionAt(stateDir, key) {
  if (!/^[a-f0-9]{64}$/.test(key || '')) throw new Error('Invalid session key');
  const dir = path.join(path.resolve(stateDir || defaultStateDir()), key);
  return { key, dir, stateFile: path.join(dir, 'state.json') };
}

function atomicJson(file, data, options) {
  replaceTextSync(file, JSON.stringify(data, null, 2) + '\n', options);
}

// The small root-wide clock orders new reservations across sender ledgers and process restarts.
// It contains no delivery facts: losing it cannot free a message ID. Old rows use civil time.
export function allocateOrder(session, { lock = withStateLock, save = atomicJson, signal } = {}) {
  const directory = path.join(path.dirname(session.dir), 'order');
  return lock(directory, () => {
    const file = path.join(directory, 'clock.json');
    let previous = 0;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 64) throw new Error();
      previous = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) throw new Error();
    } catch (e) { if (e.code !== 'ENOENT') throw failure('The delivery ordering clock cannot be read. Stop both apps and check the shared state before sending.', 'state_unavailable'); }
    const order = Math.max(Math.floor(performance.timeOrigin + performance.now()), previous + 1);
    const saved = save(file, order, { signal });
    return saved ? saved.then(() => order) : order;
  }, { signal });
}

function withLock(session, fn, options) { return withStateLock(session.dir, fn, options); }

export function readSession(session) {
  const file = session.stateFile || path.join(session.dir, 'state.json');
  const raw = fs.readFileSync(file, 'utf8');
  let state; try { state = JSON.parse(raw); } catch { throw failure('Invalid bridge state: the saved delivery records could not be read. Run bridge_doctor before sending.', 'state_unavailable'); }
  if (!state || typeof state !== 'object' || state.schemaVersion !== 1 || state.key !== session.key ||
      typeof state.threadId !== 'string' || hash(state.threadId) !== state.key || (session.threadId !== undefined && session.threadId !== state.threadId) || typeof state.cwd !== 'string') {
    throw failure('Invalid bridge state: the saved delivery ledger does not match its owner or format. Check the configured state directory and run bridge_doctor.', 'state_unavailable');
  }
  // Earlier builds stored tasks under requests. Retain that history without
  // allowing old tasks or deadlines to affect asynchronous messaging.
  if (state.messages === undefined) state.messages = {};
  if (!state.messages || typeof state.messages !== 'object' || Array.isArray(state.messages)) throw failure('Invalid bridge messages: the saved deliveries cannot be read. Run bridge_doctor.', 'state_unavailable');
  if (state.desktop === undefined) state.desktop = null;
  return state;
}

function update(session, fn, { lock = withLock, load = readSession, save = atomicJson, ...options } = {}) {
  return lock(session, () => {
    const state = load(session);
    const result = fn(state);
    const written = save(session.stateFile || path.join(session.dir, 'state.json'), state, options);
    return written ? written.then(() => result) : result;
  }, options);
}

export function createSession({ stateDir, threadId, cwd }, { lock = withLock, save = atomicJson } = {}) {
  ownerId(threadId);
  const realCwd = fs.realpathSync(text(cwd, 'cwd', 32768));
  if (!fs.statSync(realCwd).isDirectory()) throw new Error('cwd must be a directory');
  const session = { ...sessionAt(stateDir, hash(threadId)), threadId };
  return lock(session, () => {
    let state;
    if (fs.existsSync(session.stateFile)) {
      state = readSession(session);
      if (state.cwd !== realCwd) throw failure('This chat is already bound to a different directory. Check the configured state location before sending.', 'state_unavailable');
    } else {
      state = { schemaVersion: 1, key: session.key, threadId, cwd: realCwd,
        createdAt: Date.now(), desktop: null, messages: {} };
      const written = save(session.stateFile, state);
      if (written) return written.then(() => ({ ...session, cwd: state.cwd }));
    }
    return { ...session, threadId: state.threadId, cwd: state.cwd };
  });
}

export function loadSession({ stateDir, sessionKey }) {
  const session = sessionAt(stateDir, sessionKey);
  const state = readSession(session);
  return { ...session, threadId: state.threadId, cwd: state.cwd };
}

export function getSession({ stateDir, threadId }) {
  ownerId(threadId);
  try { const at = ledgerAt({ stateDir, threadId }); const state = readSession(at); return { ...at, cwd: state.cwd }; }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function messageId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value) ||
      value === 'prototype' || Object.hasOwn(Object.prototype, value)) throw new Error('Invalid message ID');
  return value;
}

function validatePairId(pairId) {
  if (pairId !== undefined && (typeof pairId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(pairId) ||
      pairId === 'prototype' || Object.hasOwn(Object.prototype, pairId))) throw new Error('Invalid pair ID');
  return pairId;
}

function validateEndpoint(endpoint, name) {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint) ||
      Object.keys(endpoint).some(key => !['kind', 'id', 'host_id'].includes(key)) ||
      !Object.hasOwn(endpoint, 'kind') || !Object.hasOwn(endpoint, 'id') ||
      !['codex', 'claude'].includes(endpoint.kind)) throw new Error('Invalid message route');
  const hosted = Object.hasOwn(endpoint, 'host_id');
  if (hosted && (endpoint.kind !== 'codex' || typeof endpoint.host_id !== 'string' ||
      !/^ssh:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(endpoint.host_id) || /[\r\n]/.test(endpoint.host_id))) {
    throw new Error('Invalid message route host');
  }
  // Omit the host field for local routes so their existing persisted keys remain stable.
  return { kind: endpoint.kind, id: text(endpoint.id, `${name}.id`, 512),
    ...(hosted ? { host_id: endpoint.host_id } : {}) };
}

function validateRoute(route) {
  if (route === undefined) return undefined;
  if (!route || typeof route !== 'object' || Array.isArray(route) ||
      Object.keys(route).length !== 2 || !Object.hasOwn(route, 'from') || !Object.hasOwn(route, 'to')) {
    throw new Error('Invalid message route');
  }
  const endpoints = ['from', 'to'].map(name => validateEndpoint(route[name], `route.${name}`));
  if (endpoints[0].kind === endpoints[1].kind) throw new Error('Invalid message route');
  return { from: endpoints[0], to: endpoints[1] };
}

function messageKey(id, pairId, route) {
  messageId(id);
  validatePairId(pairId);
  if (route !== undefined) {
    if (pairId !== undefined) throw new Error('Message route and pair ID cannot be combined');
    return `route:${hash(JSON.stringify(route))}:${id}`;
  }
  return pairId === undefined ? id : `${pairId}:${id}`;
}

// A failed record written by this version names its reason; one that proves nothing was delivered
// may be attempted again under the same ID (FB03). Older failed records carry no reason and stay final.
export function retryableFailure(record) {
  return record.status === 'failed' && record.retry !== 'new_id' && record.reason !== 'queued_message_too_long' && REASONS[record.reason]?.delivered === false;
}

function validRecord(key, record) {
  if (!record || typeof record !== 'object' || typeof record.message !== 'string' || !Number.isSafeInteger(record.createdAt) ||
      !['sending', 'submitted', 'failed', 'uncertain'].includes(record.status) || !['to_claude','to_codex'].includes(record.direction)) return false;
  try { return key === messageKey(record.id, record.pairId, validateRoute(record.route)) && (!record.route || record.direction === 'to_' + record.route.to.kind); }
  catch { return false; }
}
function damagedReservation() {
  return failure('The saved delivery for this ID is damaged. Do not repeat it; inspect the receiving conversation and run bridge_doctor.', 'state_unavailable',
    { outcome: outcome('state_unavailable', { delivered: 'unknown', retry: 'inspect' }) });
}
/** Read a routed receipt without trusting an ID or route from its stored body. */
export function routedRecord(owner, route, id, { load = readSession } = {}) {
  const key = messageKey(id, undefined, validateRoute(route));
  let state;
  try { state = load(ledgerAt(owner)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!Object.hasOwn(state.messages, key)) return null;
  const record = state.messages[key];
  if (!validRecord(key, record)) throw damagedReservation();
  return record;
}
function matchExisting(existing, { key, pairId, savedRoute, direction, message, manual }) {
  if (!validRecord(key, existing)) throw damagedReservation();
  const conflict = text => failure(text, 'id_conflict', { record: { id: existing.id, status: interruptedSend(existing) ? 'uncertain' : existing.status } });
  if (existing.pairId !== pairId) throw new Error('Message does not belong to this pair');
  if (JSON.stringify(existing.route) !== JSON.stringify(savedRoute)) {
    throw conflict('Message ID already belongs to a different route. A message_id names one message to one recipient; check it with list_deliveries, and send this one without message_id or under a new one.');
  }
  if (existing.direction !== direction || existing.message !== message) {
    throw conflict('Message ID already belongs to different content or direction. A message_id names one message, not a task or thread; check it with list_deliveries, and send this text without message_id or under a new one.');
  }
  if (Boolean(existing.manual) !== manual) {
    throw conflict(`Message ID already belongs to a different sending origin (${existing.manual ? 'the conversation panel' : 'an automatic send'}). Check that delivery with list_deliveries before sending again.`);
  }
}

function messageInput({ id, pairId, direction, message, route, manual }) {
  if (typeof manual !== 'boolean') throw new Error('manual must be a boolean');
  const savedRoute = validateRoute(route);
  const key = messageKey(id, pairId, savedRoute);
  if (!['to_claude', 'to_codex'].includes(direction)) throw new Error('direction must be to_claude or to_codex');
  if (savedRoute && savedRoute.to.kind !== direction.slice(3)) throw new Error('direction does not match message route');
  text(message, 'message');
  if (!message.isWellFormed()) throw failure('Message text contains invalid Unicode. Correct the text before sending.', 'invalid_argument');
  return { id, pairId, direction, message, manual, savedRoute, key };
}

/** A ledger's location without reading it; reads through it throw ENOENT while the ledger does not exist. */
export function ledgerAt({ stateDir, threadId }) {
  ownerId(threadId);
  return { ...sessionAt(stateDir, hash(threadId)), threadId };
}

/** One read for a send: the sender's ledger (null before its first message) and the exact earlier
 * attempt with `id` on this route (null when the ID is unused). An interrupted send reads as uncertain.
 * Throws id_conflict when the ID belongs to other content. Writes nothing (D04). */
export function lookupMessage({ stateDir, threadId }, { id, pairId, direction, message, route, manual = false } = {}, { load = readSession } = {}) {
  const at = ledgerAt({ stateDir, threadId });
  let state;
  try { state = load(at); } catch (error) { if (error.code === 'ENOENT') return { session: null, prior: null }; throw error; }
  const session = { ...at, threadId: state.threadId, cwd: state.cwd };
  if (id === undefined) return { session, prior: null };
  const input = messageInput({ id, pairId, direction, message, route, manual });
  if (!Object.hasOwn(state.messages, input.key)) return { session, prior: null };
  const existing = state.messages[input.key];
  matchExisting(existing, input);
  const interrupted = interruptedSend(existing);
  return { session, prior: { ...existing, status: interrupted ? 'uncertain' : existing.status, interrupted,
    retryable: retryableFailure(existing) } };
}

/** Reserve `id` for a send, or return its existing record. `peek: false` skips the unlocked read when the
 * caller has just looked the ID up and found nothing to replay. */
export function recordMessage(session, { id = crypto.randomUUID(), pairId, direction, message, route, manual = false, retryFailed = false, reconcileOnly = false, expectedAttempt, requestedTransport } = {},
  { peek: early = true, lock = withLock, save = atomicJson, load = readSession, order } = {}) {
  const input = messageInput({ id, pairId, direction, message, route, manual });
  const { key, savedRoute } = input;
  const fingerprint = hash(JSON.stringify({ direction, message, ...(savedRoute === undefined ? {} : { route: savedRoute }) }));
  const stamp = priorOrder => {
    return { createdAt: Date.now(), orderAt: priorOrder ?? order ?? allocateOrder(session), startedTick: Number(process.hrtime.bigint() / 1000000n), attemptId: crypto.randomUUID(), senderPid: process.pid, status: 'sending' };
  };
  const decide = state => {
    if (Object.hasOwn(state.messages, key)) {
      const existing = state.messages[key];
      matchExisting(existing, input);
      if ((reconcileOnly || retryFailed) && expectedAttempt !== undefined && existing.attemptId !== expectedAttempt) {
        return { result: { message: existing, created: false }, changed: false };
      }
      if (interruptedSend(existing)) {
        existing.status = 'uncertain';
        existing.updatedAt = Date.now();
        existing.error = 'The sending process ended or did not record an outcome; delivery is uncertain.';
        return { result: { message: existing, created: false }, changed: true };
      }
      if (!reconcileOnly && retryFailed && existing.requestedTransport === requestedTransport && retryableFailure(existing)) {
        // A new attempt of the same message: it starts now, so an older peer's staleness rule still holds.
        for (const field of ['error', 'receipt', 'reason', 'retry', 'updatedAt']) delete existing[field];
        // Keep the message's page position across attempts; only the attempt and audit clock restart.
        Object.assign(existing, stamp(existing.orderAt ?? existing.createdAt));
        return { result: { message: existing, created: true, retried: true }, changed: true };
      }
      return { result: { message: existing, created: false }, changed: false };
    }
    if (reconcileOnly || retryFailed) throw failure('The prior reservation is no longer present. Inspect the recipient and sender history.', 'prior_uncertain');
    const record = { id, ...(pairId === undefined ? {} : { pairId }), ...(savedRoute === undefined ? {} : { route: savedRoute }),
      direction, message, ...(requestedTransport ? { requestedTransport } : {}), ...(manual ? { manual: true } : {}), ...stamp(), fingerprint };
    state.messages[key] = record;
    return { result: { message: record, created: true }, changed: true };
  };
  // A replay that changes nothing is answered from one read, so a full disk or a read-only ledger
  // cannot hide a known result (D04). Anything that writes is decided again under the lock.
  if (early) {
    const messages = load(session).messages;
    if (Object.hasOwn(messages, key)) {
      const existing = messages[key];
      matchExisting(existing, input);
      if (!interruptedSend(existing) && !(retryFailed && retryableFailure(existing))) return { message: existing, created: false };
    }
  }
  return lock(session, () => {
    const state = load(session);
    const { result, changed } = decide(state);
    const written = changed && save(session.stateFile || path.join(session.dir, 'state.json'), state);
    return written ? written.then(() => result) : result;
  });
}

function jsonValue(value, name) {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized) > 131072) throw new Error('Invalid JSON value');
    return JSON.parse(serialized);
  } catch {
    throw new Error(`${name} must be JSON-serializable and at most 131072 UTF-8 bytes`);
  }
}

export function finishMessage(session, id, { status, error, receipt, pairId, route, reason, retry, attemptId } = {}, options) {
  const savedRoute = validateRoute(route);
  const key = messageKey(id, pairId, savedRoute);
  if (!['submitted', 'failed', 'uncertain'].includes(status)) throw new Error('status must be submitted, failed, or uncertain');
  if (reason !== undefined && (status !== 'failed' || REASONS[reason]?.delivered !== false)) {
    throw new Error('Only a failed record names a reason, and only one that proves no delivery');
  }
  const savedError = jsonValue(error, 'error');
  const savedReceipt = jsonValue(receipt, 'receipt');
  return update(session, state => {
    if (!Object.hasOwn(state.messages, key)) throw new Error('Message does not belong to this session or pair');
    const record = state.messages[key];
    if (!validRecord(key, record)) throw damagedReservation();
    if (record.pairId !== pairId) throw new Error('Message does not belong to this pair');
    if (JSON.stringify(record.route) !== JSON.stringify(savedRoute)) throw new Error('Message does not belong to this route');
    if (attemptId !== undefined && (record.attemptId !== attemptId || !['sending', 'uncertain'].includes(record.status))) {
      throw failure('The saved reservation no longer matches this attempt. Inspect the receiving conversation and list_deliveries.', 'state_unavailable');
    }
    if (retry === 'new_id' && status === 'failed') record.retry = retry; else delete record.retry;
    record.status = status;
    record.updatedAt = Math.max(Date.now(), record.createdAt);
    if (savedError === undefined) delete record.error;
    else record.error = savedError;
    if (savedReceipt === undefined) delete record.receipt;
    else record.receipt = savedReceipt;
    if (reason === undefined) delete record.reason;
    else record.reason = reason;
    return record;
  }, options);
}

// Built lazily only by the warm reader. The owner discards this index with the validated generation.
export function messageIndex(messages) {
  const byId = new Map(); let damaged = false;
  for (const [key, row] of Object.entries(messages)) {
    if (!validRecord(key, row)) { damaged = true; continue; }
    if (!byId.has(row.id)) byId.set(row.id, []);
    byId.get(row.id).push(row);
  }
  return { byId, damaged };
}
export function getMessages(session, selection = 20, pairId, from, issues, { load = readSession, index } = {}) {
  // Both the worker and inline reader pass this selection to the same verified ledger projection.
  const { limit, messageId: exactId } = selection && typeof selection === 'object' && Object.hasOwn(selection, 'limit') ? selection : { limit: selection };
  if (exactId !== undefined) messageId(exactId);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('limit must be a nonnegative integer');
  validatePairId(pairId);
  if (from !== undefined && pairId !== undefined) throw new Error('Message sender and pair ID cannot be combined');
  const savedFrom = from === undefined ? undefined : validateEndpoint(from, 'from');
  const messages = load(session).messages;
  let rows, damaged = false;
  if (exactId !== undefined && index) {
    const found = index(messages);
    rows = [...(found.byId.get(exactId) ?? [])]; damaged = found.damaged;
  } else {
    rows = [];
    for (const [key, row] of Object.entries(messages)) {
      if (!validRecord(key, row)) { damaged = true; continue; }
      if (exactId === undefined || row.id === exactId) rows.push(row);
    }
  }
  if (damaged) issues?.push({ source: 'ledger', reason: 'state_unavailable' });
  return rows.reverse()
    .filter(record => (exactId === undefined || record.id === exactId) && (pairId === undefined || record.pairId === pairId) &&
      (savedFrom === undefined || (record.route?.from?.kind === savedFrom.kind && record.route.from.id === savedFrom.id &&
        record.route.from.host_id === savedFrom.host_id)))
    .sort((left, right) => (right.orderAt ?? right.createdAt) - (left.orderAt ?? left.createdAt)).slice(0, limit)
    .map(record => {
      const visible = Object.fromEntries(
        ['id', 'pairId', 'route', 'direction', 'message', 'manual', 'createdAt', 'status', 'fingerprint', 'updatedAt', 'error', 'receipt']
          .filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]),
      );
      if (interruptedSend(record)) {
        visible.status = 'uncertain';
        visible.error = 'The sending process ended or did not record an outcome; delivery is uncertain.';
      }
      return visible;
    });
}

// Fixture seam for reproducing older states and exercising the ledger lock directly.
export function updateSession(session, fn, options) { return update(session, fn, options); }
