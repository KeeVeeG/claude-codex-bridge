import { createHash, randomUUID } from 'node:crypto';
import { codexIdentity, executeBridgeTool } from './bridge-service.mjs';
import { beforeWrite, ensureCall, throwIfStopped } from './call-time.mjs';
import { sendToCodex } from './codex-desktop.mjs';
import { publicDelivery } from './delivery.mjs';
import { manualLedgerPaths, readManualEntries, readManualEntry, updateManualEntry } from './manual-ledger.mjs';
import { REASONS, errorOutcome, failure, outcome } from './outcome.mjs';
import { routedRecord, repairSettlement } from './call-store.mjs';
import { defaultStateDir, ledgerAt, ownerId, processAlive } from './store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const writerId = randomUUID();
const active = new Set();
const receipts = new Map();
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) &&
  value !== 'prototype' && !Object.hasOwn(Object.prototype, value);
const recordKey = (sessionId, messageId) => hash(JSON.stringify([sessionId, messageId]));

function requiredText(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || /\0/.test(value) || Buffer.byteLength(value) > maximum) {
    throw new Error(`${name} must be nonempty text, at most ${maximum} UTF-8 bytes.`);
  }
  return value;
}

function ledgerPaths(stateDir, threadId) {
  ownerId(threadId);
  if (/[\r\n]/.test(threadId)) throw new Error('Invalid verified Codex task ID.');
  return manualLedgerPaths(stateDir, threadId, hash(threadId));
}

const routeFor = (owner, recipient) => ({ from: { kind: 'codex', id: owner }, to: { kind: 'claude', id: recipient } });
const fingerprintFor = (route, message) => hash(JSON.stringify({ direction: 'to_claude', message, route }));

function checked(record, key, paths, includeMessage = true) {
  if (record === undefined) return undefined;
  if (!/^[a-f0-9]{64}$/.test(key) || !object(record) || !safeId(record.message_id) ||
      typeof record.session_id !== 'string' || !record.session_id.trim() || Buffer.byteLength(record.session_id) > 256 ||
      recordKey(record.session_id, record.message_id) !== key || !/^[a-f0-9]{64}$/.test(record.fingerprint) || record.manual !== true ||
      !['sending', 'submitted', 'failed', 'uncertain'].includes(record.send_status) ||
      !['pending', 'submitted', 'failed', 'uncertain'].includes(record.notice_status) ||
      typeof record.notice_attempted !== 'boolean' || !Number.isSafeInteger(record.sender_pid) || record.sender_pid <= 0 ||
      (record.notice_retryable !== undefined && typeof record.notice_retryable !== 'boolean') ||
      !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt)) {
    throw new Error('Manual bridge records contain an invalid delivery entry.');
  }
  if (includeMessage && record.message !== undefined) checkedMessage(paths, record, record.message);
  return record;
}

function checkedMessage(paths, record, message) {
  requiredText(message, 'Saved manual message', 65536);
  if (fingerprintFor(routeFor(paths.threadId, record.session_id), message) !== record.fingerprint) {
    throw new Error('Saved manual message does not match its delivery entry.');
  }
  return message;
}

function beginAttempt(record, attempts) {
  const token = randomUUID();
  attempts.add(token);
  active.add(token);
  return Object.assign(record, { sender_pid: process.pid, writer_id: writerId, attempt_id: token, updatedAt: Date.now() });
}

function interrupted(record) {
  // Wall timestamps are display data. We can also recognize a locally finished
  // attempt without assuming that a different runtime sharing our PID is ours.
  return !processAlive(record.sender_pid) ||
    (record.writer_id === writerId && !active.has(record.attempt_id));
}

function pendingReceipt(paths, record) {
  const receipt = record.writer_id === writerId && record.sender_pid === process.pid && receipts.get(record.attempt_id);
  return receipt && receipt.owner === paths.threadId && receipt.session === record.session_id &&
    receipt.id === record.message_id && receipt.fingerprint === record.fingerprint ? receipt : undefined;
}

function recoverReceipt(paths, record) {
  const receipt = pendingReceipt(paths, record);
  return receipt ? { ...record, ...receipt.patch } : record;
}

function project(paths, record, legacy) {
  const visible = { ...recoverReceipt(paths, record) };
  if (record.notice_retryable !== true) visible.notice_retryable = false;
  if (visible.send_status === 'sending' && interrupted(visible)) visible.send_status = 'uncertain';
  // An old process may have managed to fit a shadow for this overflow ID later.
  // Only its shared v1 shadow can contain a notice attempt for the overflow ID.
  const oldNotice = legacy?.fingerprint === visible.fingerprint && legacy.notice_attempted ? legacy : undefined;
  if (oldNotice) {
    for (const field of ['notice_status', 'notice_attempted', 'notice_reason', 'notice_error']) visible[field] = oldNotice[field];
    visible.notice_retryable = false; // A 1.1 overflow record cannot claim this 1.0.x notice slot.
  }
  if (visible.notice_status === 'pending' && visible.notice_attempted && interrupted(oldNotice ?? visible)) {
    visible.notice_status = 'uncertain'; visible.notice_retryable = false;
  }
  return visible;
}

/** Only a verified runtime owner may select threadId. Reads create no directories.
 * Catalogs can omit bodies; a conversation can request just its peer, and load
 * only bodies it cannot recover from primary history. Missing text stays absent. */
export function readManualRecords({ stateDir, threadId, sessionId, includeMessage = true }) {
  const paths = ledgerPaths(stateDir, threadId);
  return Array.from(readManualEntries(paths, sessionId), ([key, record, legacy, loadMessage]) => {
    const visible = project(paths, checked(record, key, paths, false), checked(legacy, key, paths, false));
    delete visible.message;
    if (typeof includeMessage === 'function' ? includeMessage(visible) : includeMessage) {
      const message = loadMessage();
      if (message !== undefined) visible.message = checkedMessage(paths, record, message);
    }
    return structuredClone(visible);
  });
}

async function originalMessage(stateDir, route, id, signal) {
  const owner = { stateDir, threadId: route.from.id };
  const original = await routedRecord(owner, route, id, signal);
  // Reconcile the authoritative primary receipt under its exact attempt before interpreting the
  // shadow. This operation cannot call either transport, including when both receipts were lost.
  return repairSettlement(ledgerAt(owner), original);
}

function primaryOutcome(args, record, { fresh, error }) {
  const saved = { id: args.message_id, status: record.send_status };
  if (record.send_status === 'submitted') return outcome(fresh ? 'submitted' : 'already_submitted', { record: saved });
  if (record.send_status === 'sending') return outcome('in_flight', { record: saved });
  if (record.send_status === 'uncertain') return outcome(fresh ? 'delivery_unconfirmed' : 'prior_uncertain', { record: saved });
  return outcome(REASONS[record.send_reason] ? record.send_reason : (fresh && error ? errorOutcome(error).reason : 'prior_failed'), { record: saved });
}

function noticeOutcome(record) {
  if (record.notice_reason === 'settlement_failed') return outcome('settlement_failed');
  if (record.notice_status === 'submitted') return outcome('submitted');
  if (record.notice_status === 'failed') return outcome(REASONS[record.notice_reason] ? record.notice_reason : 'request_rejected',
    { retry: record.notice_retryable ? 'same_id' : 'inspect' });
  if (record.notice_status === 'uncertain') return outcome('delivery_unconfirmed');
  return record.notice_attempted ? outcome('in_flight') : undefined;
}

function resultFor(args, route, record, message, submittedDelivery, { fresh = false, error, primary, notice } = {}) {
  const delivery = submittedDelivery || publicDelivery(message || {
    id: args.message_id, route, message: args.message,
    createdAt: record.createdAt, updatedAt: record.updatedAt, status: record.send_status,
  });
  const posted = notice ?? noticeOutcome(record);
  return { delivery: { ...delivery, status: record.send_status,
    ...(record.error ? { error: record.error } : {}), manual: true }, manual: true,
  notice_status: record.notice_status, notice_retryable: record.notice_retryable === true,
  ...(record.notice_error ? { notice_error: record.notice_error } : {}),
  outcome: primary ?? primaryOutcome(args, record, { fresh, error }), ...(posted ? { notice_outcome: posted } : {}) };
}

function noticeText(args) {
  return `[User sent to Claude session ${JSON.stringify(args.session_id)}; bridge message ${JSON.stringify(args.message_id)}; context only]\n\n${args.message}`;
}

const storageError = error => ['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM', 'EBUSY', 'EIO'].includes(error?.code);
const stateAdvice = 'Check that the shared bridge state is writable and has free space.';
const stateFailure = () => failure(`${stateAdvice} Retry with the same message ID.`, 'state_unavailable');
const errorText = error => storageError(error) ? stateAdvice : String(error?.message ?? 'The bridge operation failed.').slice(0, 1024);

// Retain what the transport actually said, keyed to the exact persisted attempt.
// A replay may finish only this disk write, never the transport. A different
// process cannot recover a receipt that was never saved.
async function settle(paths, key, record, patch) {
  const receipt = { owner: paths.threadId, session: record.session_id, id: record.message_id,
    fingerprint: record.fingerprint, patch: { ...patch, updatedAt: Date.now() } };
  receipts.set(record.attempt_id, receipt);
  const observed = { ...record, ...receipt.patch };
  const matches = saved => saved?.attempt_id === record.attempt_id && saved.fingerprint === record.fingerprint &&
    Object.entries(receipt.patch).every(([field, value]) => saved[field] === value);
  try {
    const saved = await updateManualEntry(paths, key, entry => {
      const current = checked(entry, key, paths);
      return current && pendingReceipt(paths, current) === receipt ? recoverReceipt(paths, current) : current;
    }, { create: false });
    receipts.delete(record.attempt_id);
    return { record: observed, durable: matches(saved) };
  } catch {
    // A commit may have succeeded before lock cleanup failed. Trust a readable
    // receipt for this exact attempt; otherwise retain it for recovery.
    try {
      if (matches(checked(readManualEntry(paths, key).record, key, paths))) {
        receipts.delete(record.attempt_id);
        return { record: observed, durable: true };
      }
    } catch {}
    return { record: observed, durable: false };
  }
}

function claimNotice(record, attempts) {
  return beginAttempt(Object.assign(record, { notice_status: 'pending', notice_attempted: true,
    notice_retryable: false, notice_error: undefined, notice_reason: undefined }), attempts);
}

async function submitNotice(args, context, identity, paths, key, claim, errorBeforeWrite) {
  let failureOutcome, error;
  try {
    if (errorBeforeWrite) throw errorBeforeWrite;
    beforeWrite(context.signal);
    await sendToCodex({ pipePath: identity.pipePath, contextThreadId: identity.threadId, threadId: identity.threadId,
      message: noticeText(args), signal: context.signal });
  } catch (cause) {
    error = cause;
    failureOutcome = errorOutcome(storageError(cause) ? stateFailure() : cause);
  }
  const { record, durable } = await settle(paths, key, claim, {
    notice_status: failureOutcome ? failureOutcome.delivered === false ? 'failed' : 'uncertain' : 'submitted',
    notice_retryable: failureOutcome?.delivered === false,
    notice_reason: failureOutcome?.reason, notice_error: error ? errorText(error) : undefined,
  });
  if (durable) return { record };
  // Keep the known submission distinct from the durable, already-claimed slot.
  // Until the receipt sticks, a rejected notice cannot authorize a retry.
  return { record: { ...record, notice_retryable: false,
    notice_error: `${stateAdvice} The owner notice result could not be recorded; inspect the owning Codex conversation before retrying.` },
  notice: failureOutcome ? { ...failureOutcome, retry: 'inspect' } : outcome('settlement_failed') };
}

function owningCodexContext(context) {
  const env = context.env || process.env;
  if (env.CLAUDE_CODE_MESSAGING_SOCKET) throw new Error('Manual sending is available only from the owning Codex Desktop task.');
  const identity = codexIdentity(context.metadata || {}, env);
  const stateDir = context.stateDir || defaultStateDir({ env });
  return { identity, stateDir };
}

const missingNotice = 'The original manual notice record is missing. Inspect the current Codex chat; no notice was repeated.';

function validatePrimary(message, fingerprint) {
  if (message && message.fingerprint !== fingerprint) {
    throw failure('This manual message_id already belongs to another recipient or message text.', 'id_conflict', { record: message });
  }
  if (message && message.manual !== true && message.origin !== 'manual') {
    throw failure(`This message_id was already used by an automatic send (status: ${message.status}). Check that delivery with list_deliveries before sending again; use a new message_id only for a deliberately new message.`,
      'id_conflict', { record: message });
  }
  return message;
}

function newRecord(args, fingerprint, message) {
  const now = Date.now();
  return { message_id: args.message_id, session_id: args.session_id, fingerprint, message: args.message, manual: true,
    send_status: message?.status ?? 'sending', notice_status: message ? 'uncertain' : 'pending',
    notice_attempted: Boolean(message), notice_retryable: false,
    sender_pid: process.pid, createdAt: now, updatedAt: now, ...(message ? { notice_error: missingNotice } : {}) };
}

function noOverflowNotice(record) {
  record.overflow = true;
  if (record.notice_status !== 'pending') return;
  // 1.0.x can only see notice claims in state.json. It could have read the
  // primary ledger before our reservation and still acquire that shadow later.
  // The shared primary prevents a repeat Claude write, but cannot fence its notice.
  Object.assign(record, { notice_status: 'failed', notice_reason: 'state_unavailable',
    notice_error: 'The owner notice was not posted: the compatible manual ledger is full. Check the owning Codex conversation; do not resend the Claude message.' });
}

function reconcile(paths, record, message, attempts) {
  record = recoverReceipt(paths, record);
  if (message?.status === 'submitted' && record.send_status !== 'submitted') {
    Object.assign(record, { send_status: 'submitted', send_reason: undefined, error: undefined });
  }
  if (!record.notice_attempted && message?.status === 'failed' && REASONS[message.reason]?.delivered === false) {
    Object.assign(record, { send_status: 'failed', send_reason: message.reason });
  }
  const retry = REASONS[record.send_reason];
  const unwritten = !message || (message.status === 'failed' && REASONS[message.reason]?.delivered === false);
  // Only an exact known rejection can re-arm a failed attempt. A stopped new
  // writer can also leave a reservation before the primary ledger ever reserved
  // the ID. Old shadow-only reservations have no such protocol marker.
  if (!record.notice_attempted && unwritten && (
    (record.send_status === 'failed' && retry?.delivered === false && ['after_fix', 'same_id'].includes(retry.retry)) ||
    (record.send_status === 'sending' && record.writer_id && !message && interrupted(record)))) {
    return beginAttempt(Object.assign(record, { send_status: 'sending', error: undefined, send_reason: undefined }), attempts);
  }
  if (record.send_status === 'sending') {
    if (message && ['failed', 'uncertain'].includes(message.status)) record.send_status = message.status;
    else if (interrupted(record)) record.send_status = 'uncertain';
  }
  if (record.notice_status === 'pending' && record.notice_attempted && interrupted(record)) {
    record.notice_status = 'uncertain'; record.notice_retryable = false;
  }
  return record;
}

/** The caller supplies only recipient, text and ID. Owner identity comes from verified runtime metadata. */
export async function manualSend(args, context = {}) {
  const call = ensureCall(context.signal);
  const attempts = new Set();
  try { return await doManualSend(args, { ...context, signal: call.signal }, attempts); }
  finally { for (const token of attempts) active.delete(token); call.dispose(); }
}

async function doManualSend(args, context, attempts) {
  const { signal } = context;
  throwIfStopped(signal);
  if (!object(args) || Object.keys(args).some(key => !['session_id', 'message', 'message_id'].includes(key))) {
    throw new Error('Manual send accepts only session_id, message, and message_id.');
  }
  requiredText(args.session_id, 'Claude session ID', 256);
  requiredText(args.message, 'Message', 65536);
  if (!args.message.isWellFormed()) throw failure('Message text must be valid Unicode. Correct it before sending.', 'invalid_argument');
  if (!safeId(args.message_id)) throw new Error('Manual send requires a stable, valid message_id.');
  const { identity, stateDir } = owningCodexContext(context);
  const paths = ledgerPaths(stateDir, identity.threadId);
  const route = routeFor(identity.threadId, args.session_id);
  const fingerprint = fingerprintFor(route, args.message);
  const key = recordKey(args.session_id, args.message_id);
  const readPrimary = async () => validatePrimary(await originalMessage(stateDir, route, args.message_id, signal), fingerprint);
  let message, record, recovered;
  try {
    record = await updateManualEntry(paths, key, async entry => {
      message = await readPrimary();
      const saved = checked(entry, key, paths);
      if (!saved) {
        const draft = newRecord(args, fingerprint, message);
        return message ? draft : beginAttempt(draft, attempts);
      }
      if (saved.fingerprint !== fingerprint) throw failure('This manual message_id already belongs to another message text.', 'id_conflict');
      if (pendingReceipt(paths, saved)) recovered = saved.attempt_id;
      const next = reconcile(paths, saved, message, attempts);
      if (attempts.has(next.attempt_id)) next.message = args.message;
      return next;
    }, { signal, onOverflow: noOverflowNotice });
    if (recovered) receipts.delete(recovered);
  } catch (error) {
    if (error.reason === 'id_conflict' || error.outcome) throw error;
    // A read-only replay can still answer a known result even if acquiring a
    // write lock or repairing the shadow was impossible. This branch never sends.
    try { message ??= await readPrimary(); } catch (readError) { if (readError.reason === 'id_conflict') throw readError; }
    let visible, unsettled;
    try {
      const read = readManualEntry(paths, key);
      const snapshot = checked(read.record, key, paths);
      if (snapshot && snapshot.fingerprint !== fingerprint) throw failure('This manual message_id already belongs to another message text.', 'id_conflict');
      if (snapshot) {
        visible = project(paths, snapshot, checked(read.legacy, key, paths));
        const patch = pendingReceipt(paths, snapshot)?.patch;
        if (patch && Object.entries(patch).some(([field, value]) => snapshot[field] !== value)) unsettled = patch;
      }
    } catch (readError) { if (readError.reason === 'id_conflict') throw readError; }
    if (message?.status === 'submitted') {
      visible ??= newRecord(args, fingerprint, message);
      visible.send_status = 'submitted';
    }
    if (visible && (visible.send_status !== 'sending' || !attempts.has(visible.attempt_id))) {
      const primary = unsettled?.send_status === 'submitted' && message?.status !== 'submitted'
        ? outcome('settlement_failed') : undefined;
      let notice;
      if (unsettled?.notice_status === 'submitted') notice = outcome('settlement_failed');
      else if (visible.send_status === 'submitted' && visible.notice_status === 'pending' && !visible.notice_attempted) {
        notice = errorOutcome(storageError(error) ? stateFailure() : error);
      }
      return resultFor(args, route, visible, message, undefined, { primary, notice });
    }
    throw storageError(error) ? stateFailure() : error;
  }
  let fresh = attempts.has(record.attempt_id);
  let submittedDelivery;
  if (fresh) {
    let sendError, primary;
    try {
      beforeWrite(signal);
      const sent = await executeBridgeTool('send_to_claude', args, { ...context, stateDir, manual: true });
      submittedDelivery = sent.delivery;
      if (submittedDelivery?.status !== 'submitted') throw Object.assign(new Error('Manual Claude send returned an unsupported outcome.'), { deliveryUnknown: true });
      primary = sent.outcome ?? outcome('submitted');
      if (primary.reason === 'already_submitted') fresh = false;
    } catch (error) {
      sendError = error;
      const reported = errorOutcome(error);
      primary = storageError(error) && reported.reason === 'internal_error' && !reported.record
        ? errorOutcome(stateFailure()) : reported;
    }
    const send_status = primary.delivered === true ? 'submitted' : primary.delivered === false ? 'failed' : 'uncertain';
    const saved = await settle(paths, key, record, { send_status,
      send_reason: send_status === 'failed' ? primary.reason : undefined,
      error: send_status === 'submitted' ? undefined : errorText(sendError) });
    record = saved.record;
    if (send_status !== 'submitted') return resultFor(args, route, record, message, undefined, { fresh, primary });
    if (!saved.durable) return resultFor(args, route, record, message, submittedDelivery, { fresh,
      primary: outcome('settlement_failed', { record: primary.record }), notice: noticeOutcome(record) ?? outcome('state_unavailable') });
  }
  if (record.overflow) {
    try {
      const { legacy } = readManualEntry(paths, key);
      record = project(paths, record, checked(legacy, key, paths));
    } catch { /* The bounded overflow receipt is independent of the legacy notice metadata. */ }
  }
  if (record.send_status !== 'submitted' || record.notice_status !== 'pending' || record.notice_attempted) {
    return resultFor(args, route, record, message, submittedDelivery, { fresh });
  }
  let claim;
  try {
    record = await updateManualEntry(paths, key, entry => {
      const saved = checked(entry, key, paths);
      if (!saved || saved.fingerprint !== fingerprint || saved.send_status !== 'submitted') throw stateFailure();
      if (saved.overflow || saved.notice_status !== 'pending' || saved.notice_attempted) return saved;
      claim = claimNotice(saved, attempts);
      return claim;
    }, { signal, create: false });
  } catch (error) {
    if (!claim) return resultFor(args, route, record, message, submittedDelivery, { fresh,
      notice: errorOutcome(storageError(error) ? stateFailure() : error) });
    const settled = await submitNotice(args, context, identity, paths, key, claim, error);
    return resultFor(args, route, settled.record, message, submittedDelivery, { fresh, notice: settled.notice });
  }
  if (!claim) return resultFor(args, route, record, message, submittedDelivery, { fresh });
  const settled = await submitNotice(args, context, identity, paths, key, claim);
  return resultFor(args, route, settled.record, message, submittedDelivery, { fresh, notice: settled.notice });
}

/** Explicit retry must claim the same durable notice slot. It cannot send another Claude message. */
export async function retryManualNotice(args, context = {}) {
  const call = ensureCall(context.signal);
  const attempts = new Set();
  try { return await doRetryManualNotice(args, { ...context, signal: call.signal }, attempts); }
  finally { for (const token of attempts) active.delete(token); call.dispose(); }
}

async function doRetryManualNotice(args, context, attempts) {
  const { signal } = context;
  throwIfStopped(signal);
  if (!object(args) || Object.keys(args).some(key => !['session_id', 'message_id'].includes(key))) {
    throw new Error('Notice retry accepts only session_id and message_id.');
  }
  requiredText(args.session_id, 'Claude session ID', 256);
  if (!safeId(args.message_id)) throw new Error('Notice retry requires the original valid message_id.');
  const { identity, stateDir } = owningCodexContext(context);
  const route = routeFor(identity.threadId, args.session_id);
  const message = await originalMessage(stateDir, route, args.message_id, signal);
  const paths = ledgerPaths(stateDir, identity.threadId);
  const key = recordKey(args.session_id, args.message_id);
  const confirmed = 'Only a confirmed submitted manual message from this Codex task can retry its owner notice.';
  let claim, originalArgs, claimError;
  try {
    await updateManualEntry(paths, key, entry => {
      const record = checked(entry, key, paths);
      if (!record || record.send_status !== 'submitted' || (message && (message.fingerprint !== record.fingerprint ||
          (message.manual !== true && message.origin !== 'manual')))) throw new Error(confirmed);
      const text = record.message ?? message?.message;
      if (text === undefined || fingerprintFor(route, text) !== record.fingerprint) throw new Error(confirmed);
      if (record.overflow || record.notice_status !== 'failed' || record.notice_retryable !== true) {
        throw new Error('This owner notice is not safely retryable. Inspect the current Codex chat before taking another action.');
      }
      originalArgs = { ...args, message: text };
      claim = claimNotice(record, attempts);
      return claim;
    }, { signal, create: false });
  } catch (error) {
    if (!claim) {
      if (error.code === 'ENOENT') throw new Error(confirmed);
      throw storageError(error) ? stateFailure() : error;
    }
    claimError = error;
  }
  const settled = await submitNotice(originalArgs, context, identity, paths, key, claim, claimError);
  return resultFor(originalArgs, route, settled.record, message, undefined, { notice: settled.notice });
}
