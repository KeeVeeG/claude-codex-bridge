import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { defaultStateDir, interruptedSend } from './store.mjs';
import { readHistoryLedger } from './history-ledger-reader.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const MiB = 1024 * 1024;
// The scan ceiling bounds cold I/O/CPU, not the size of a read buffer. The
// decoded projection has its own independent admission and retention bounds.
const MAX_LEDGER_SCAN_BYTES = 512 * MiB;
const MAX_VIEW_WEIGHT = 144 * MiB;
const MAX_CACHED_VIEW_WEIGHT = 2 * MAX_VIEW_WEIGHT;
const MAX_CATALOG_READ_BYTES = 96 * MiB;
const MAX_PAGE_READ_BYTES = 2 * MAX_LEDGER_SCAN_BYTES + 32 * MiB;
const MAX_LEDGERS = 1024;
const MAX_PAGE_BYTES = MiB;
const statuses = new Set(['sending', 'submitted', 'failed', 'uncertain']);
const noticeStatuses = new Set(['pending', 'submitted', 'failed', 'uncertain']);
const keyPattern = /^[a-f0-9]{64}$/;
const sessionPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stateError = code => Object.assign(new Error(code), { code });
const omitted = {
  ROOT_CHANGED: 'The shared bridge state directory changed during the scan. Refresh its location, then retry.',
  ROOT_UNAVAILABLE: 'The shared bridge state directory could not be verified. Check that it is readable, then retry.',
  LEDGER_CHANGED: 'A delivery ledger changed during the read. Refresh to try again.',
  LEDGER_UNAVAILABLE: 'Some delivery ledgers could not be read. Check access to the shared bridge state, then retry.',
  STATE_INVALID: 'Some delivery ledgers are unsafe, damaged, or use an unsupported format. Run bridge doctor and check the shared state before retrying.',
  LEDGER_TOO_LARGE: 'Some delivery ledgers exceed safe history read limits. Their histories were not checked; keep the original data when asking for help.',
  SCAN_LIMIT: 'Some delivery ledgers were not checked within this scan limit. Refresh the catalog to continue discovery.',
  ROUTING_METADATA: 'Some delivery records lack exact routing metadata and cannot be assigned to this conversation.',
  RECORD_INVALID: 'Some invalid or duplicate bridge delivery records were skipped. Check the shared state if expected records are missing.',
};

// Derived views only. Cache by guarded file identity, not by a TTL or just mtime/size.
// Cold and invalidated views always fall back to the public, old-writer-compatible ledger.
const views = new Map();
let viewWeight = 0;
const catalogPositions = new Map();
function rememberView(key, entry) {
  viewWeight -= views.get(key)?.weight ?? 0;
  views.delete(key);
  views.set(key, entry);
  viewWeight += entry.weight;
  while (viewWeight > MAX_CACHED_VIEW_WEIGHT || views.size > MAX_LEDGERS) {
    const oldest = views.keys().next().value;
    viewWeight -= views.get(oldest).weight;
    views.delete(oldest);
  }
}

export function validateHistoryOwner(ownerThreadId) {
  if (typeof ownerThreadId !== 'string' || !ownerThreadId.isWellFormed() || !ownerThreadId.trim() || Buffer.byteLength(ownerThreadId) > 512 || /[\r\n\0]/.test(ownerThreadId)) {
    throw new Error('A verified owning Codex task is required.');
  }
  return ownerThreadId;
}

export function validateClaudeHistoryId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionPattern.test(sessionId)) throw new Error('An exact Claude Code session UUID is required.');
  return sessionId;
}

function checkCancellation(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Bridge history request was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

const samePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);
const sameNode = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameVersion = (left, right) => sameNode(left, right) && left.size === right.size &&
  left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
const removed = error => ['ENOENT', 'ENOTDIR'].includes(error.code);

async function directorySnapshot(directory) {
  const before = await fs.lstat(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw stateError('STATE_INVALID');
  try {
    const realPath = await fs.realpath(directory);
    const after = await fs.lstat(directory, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameNode(before, after)) throw stateError('DIRECTORY_CHANGED');
    return { path: directory, realPath, dev: after.dev, ino: after.ino };
  } catch (error) {
    if (removed(error)) throw stateError('DIRECTORY_CHANGED');
    throw error;
  }
}

async function assertDirectory(snapshot, isRoot = false) {
  const changed = isRoot ? 'ROOT_CHANGED' : 'LEDGER_CHANGED';
  const matches = stat => stat.isDirectory() && !stat.isSymbolicLink() && sameNode(stat, snapshot);
  try {
    if (!matches(await fs.lstat(snapshot.path, { bigint: true })) ||
        !samePath(await fs.realpath(snapshot.path), snapshot.realPath) ||
        !matches(await fs.lstat(snapshot.path, { bigint: true }))) throw stateError(changed);
  } catch (error) {
    if (error.code === changed || removed(error)) throw stateError(changed);
    throw stateError(isRoot ? 'ROOT_UNAVAILABLE' : 'LEDGER_UNAVAILABLE');
  }
}

async function assertLedgerDirectories(root, directory) {
  await assertDirectory(root, true);
  await assertDirectory(directory);
  await assertDirectory(root, true);
}

const sortKey = record => `${record.direction}:${record.id}`;
const compareKeys = (left, right) => left.localeCompare(right) || (left < right ? -1 : left > right ? 1 : 0);
const order = r => Number.isSafeInteger(r.orderAt) ? r.orderAt : r.createdAt;
const compare = (left, right) => order(left) - order(right) || compareKeys(sortKey(left), sortKey(right));

// Detach retained metadata from its parsed row, whose other fields may be large.
const detached = text => Buffer.from(text, 'utf16le').toString('utf16le');
const claudeOf = thread => typeof thread === 'string' && thread.startsWith('claude:') ? thread.slice(7) : '';
const integer = value => Number.isSafeInteger(value) ? value : undefined;

function buildView(ledgerKey, owner, full, ownerLedger) {
  const outgoing = new Map();
  const incoming = new Map();
  const warnings = new Set();
  let incomingOwner;
  let weight = 1024;
  const charge = bytes => {
    weight += bytes;
    if (weight > MAX_VIEW_WEIGHT) throw stateError('LEDGER_TOO_LARGE');
  };

  function visit(key, record, threadId) {
    const claude = claudeOf(threadId);
    if (threadId !== undefined && !ownerLedger && !sessionPattern.test(claude)) return;
    if (!object(record)) { warnings.add('RECORD_INVALID'); return; }
    if (!object(record.route) || !object(record.route.from) || !object(record.route.to)) {
      warnings.add('ROUTING_METADATA'); return;
    }
    const { from, to } = record.route;
    // Same-UUID remote deliveries and apparent routes stamped by a different ledger owner are not local history.
    if (Object.hasOwn(from, 'host_id') || Object.hasOwn(to, 'host_id')) return;
    const toClaude = ownerLedger && record.direction === 'to_claude' &&
      from.kind === 'codex' && from.id === owner && to.kind === 'claude';
    const toCodex = record.direction === 'to_codex' && from.kind === 'claude' && to.kind === 'codex' &&
      typeof from.id === 'string' && sessionPattern.test(from.id) && (threadId !== undefined ? from.id === claude :
        // JSON member order is not significant. Check the ledger key provisionally
        // when messages precede the header, then verify the exact owner at finish.
        (incomingOwner === undefined ? hash(`claude:${from.id}`) === ledgerKey : from.id === incomingOwner));
    if (!toClaude && !toCodex) return;
    if ((toClaude && (typeof to.id !== 'string' || !sessionPattern.test(to.id))) ||
        (toCodex && (typeof to.id !== 'string' || !to.id.trim() || Buffer.byteLength(to.id) > 512 || /[\r\n\0]/.test(to.id))) ||
        typeof record.id !== 'string' || !idPattern.test(record.id) ||
        typeof record.message !== 'string' || Buffer.byteLength(record.message) > 65536 ||
        !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || !statuses.has(record.status)) {
      warnings.add('RECORD_INVALID'); return;
    }
    if (toCodex && incomingOwner === undefined) incomingOwner = detached(from.id);
    const pairs = toClaude ? outgoing : incoming;
    let pair = pairs.get(to.id);
    const prefix = pair?.prefix ?? 'route:' + hash(JSON.stringify({ from: { kind: from.kind, id: from.id }, to: { kind: to.kind, id: to.id } })) + ':';
    if (key !== prefix + record.id) { warnings.add('RECORD_INVALID'); return; }
    if (!pair) {
      charge(640 + 2 * to.id.length);
      pairs.set(detached(to.id), pair = { prefix, latest: record.createdAt, order: order(record), ...(full ? { byId: new Map() } : {}) });
    }
    if (pair.byId) {
      const { id, status, message, createdAt, fingerprint } = record;
      if (pair.byId.has(id)) { warnings.add('RECORD_INVALID'); return; }
      // One compact retained copy of the body; decode only messages returned on a page.
      const encoding = message.isWellFormed() ? 'utf8' : 'utf16le';
      charge(512 + 2 * id.length + Buffer.byteLength(message, encoding));
      const body = Buffer.from(message, encoding);
      const rowId = detached(id);
      pair.byId.set(rowId, { id: rowId, direction: toClaude ? 'to_claude' : 'to_codex', createdAt, status,
        orderAt: integer(record.orderAt), senderPid: integer(record.senderPid), startedTick: integer(record.startedTick),
        manual: record.manual === true, fingerprint: typeof fingerprint === 'string' && keyPattern.test(fingerprint) ? detached(fingerprint) : undefined,
        get message() { return body.toString(encoding); } });
    }
    if (order(record) >= pair.order) { pair.latest = record.createdAt; pair.order = order(record); }
  }

  function finish(state) {
    if (state.schemaVersion !== 1 || state.key !== ledgerKey || typeof state.threadId !== 'string' ||
        hash(state.threadId) !== ledgerKey || typeof state.cwd !== 'string' ||
        (ownerLedger && state.threadId !== owner)) throw stateError('STATE_INVALID');
    const claude = claudeOf(state.threadId);
    if (incomingOwner !== claude) incoming.clear();
    if (!ownerLedger && !sessionPattern.test(claude)) warnings.clear();
    if (full) for (const pairs of [outgoing, incoming]) {
      for (const pair of pairs.values()) pair.records = [...pair.byId.values()].sort(compare);
    }
    return { view: { claude, outgoing, incoming, warnings }, weight };
  }

  return { visit, finish };
}

async function safeLedger(root, key, budget, owner, full, signal) {
  const selected = path.join(root.path, key);
  let directory;
  try { directory = await directorySnapshot(selected); }
  catch (error) {
    await assertDirectory(root, true);
    if (error.code === 'ENOENT') return null;
    if (error.code === 'DIRECTORY_CHANGED') throw stateError('LEDGER_CHANGED');
    throw error;
  }
  if (!samePath(directory.realPath, path.join(root.realPath, key))) throw stateError('STATE_INVALID');
  const file = path.join(selected, 'state.json');
  // Include the exact owner for outgoing views, even for legacy hash aliases.
  const ownerLedger = key === hash(owner);
  const cacheKey = JSON.stringify([file, ownerLedger ? owner : null]);
  await assertLedgerDirectories(root, directory);
  for (let attempt = 0; attempt < 3; attempt++) {
    checkCancellation(signal);
    let before;
    try { before = await fs.lstat(file, { bigint: true }); }
    catch (error) {
      await assertLedgerDirectories(root, directory);
      if (error.code === 'ENOENT' && attempt === 0) return null;
      if (!removed(error)) throw error;
      continue;
    }
    try {
      if (!before.isFile() || before.isSymbolicLink()) throw stateError('STATE_INVALID');
      if (!samePath(await fs.realpath(file), path.join(directory.realPath, 'state.json'))) throw stateError('STATE_INVALID');
      const cached = views.get(cacheKey);
      if (cached && (cached.full || !full) && sameNode(directory, cached.directory) && sameVersion(before, cached.version)) {
        await assertLedgerDirectories(root, directory);
        const after = await fs.lstat(file, { bigint: true });
        if (!after.isFile() || after.isSymbolicLink() || !sameVersion(before, after)) continue;
        rememberView(cacheKey, cached);
        return cached.view;
      }
      if (before.size > MAX_LEDGER_SCAN_BYTES) throw stateError('LEDGER_TOO_LARGE');
      const size = Number(before.size);
      // A discovery window can admit one oversized cold ledger on a fresh
      // budget, or defer it to the next refresh via the existing resume key.
      if (size > budget.remaining && !(budget.allowLarge && budget.remaining === MAX_CATALOG_READ_BYTES)) throw stateError('SCAN_LIMIT');
      const handle = await fs.open(file, 'r');
      const builder = buildView(key, owner, full, ownerLedger);
      let state, readError;
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || !sameVersion(before, opened)) continue;
        await assertLedgerDirectories(root, directory);
        budget.remaining -= size;
        try { state = await readHistoryLedger(handle, size, () => checkCancellation(signal), builder.visit); }
        catch (error) {
          if (error.code === 'LEDGER_CHANGED') continue;
          if (error.code !== 'STATE_INVALID' && error.code !== 'LEDGER_TOO_LARGE') throw error;
          readError = error;
        }
        if (!sameVersion(opened, await handle.stat({ bigint: true }))) continue;
      } finally { await handle.close(); }
      await assertLedgerDirectories(root, directory);
      const after = await fs.lstat(file, { bigint: true });
      if (!after.isFile() || after.isSymbolicLink() || !sameVersion(before, after)) continue;
      checkCancellation(signal);
      if (readError) throw readError;
      const { view, weight } = builder.finish(state);
      rememberView(cacheKey, { directory, version: after, full, view, weight });
      return view;
    } catch (error) {
      if (!removed(error)) throw error;
      await assertLedgerDirectories(root, directory);
    }
  }
  throw stateError('LEDGER_CHANGED');
}

function effectiveStatus(record) {
  return interruptedSend(record) ? 'uncertain' : record.status;
}

const isRootError = code => code === 'ROOT_CHANGED' || code === 'ROOT_UNAVAILABLE';

async function collectViews({ stateDir, ownerThreadId, sessionId, signal, visit }) {
  validateHistoryOwner(ownerThreadId);
  if (sessionId !== undefined) validateClaudeHistoryId(sessionId);
  checkCancellation(signal);
  const warnings = new Set();
  let root;
  let incomplete = false;
  const result = () => ({ root, incomplete, warnings: [...warnings].map(code => omitted[code]) });
  try { root = await directorySnapshot(path.resolve(stateDir)); }
  catch (error) {
    if (error.code !== 'ENOENT') {
      incomplete = true;
      warnings.add(error.code === 'DIRECTORY_CHANGED' ? 'ROOT_CHANGED' : 'ROOT_UNAVAILABLE');
    }
    return result();
  }
  const ownerKey = hash(ownerThreadId);
  const positionKey = JSON.stringify([root.path, root.dev.toString(), root.ino.toString(), ownerKey]);
  const budget = sessionId === undefined ? { remaining: MAX_CATALOG_READ_BYTES, allowLarge: true } : { remaining: MAX_PAGE_READ_BYTES };
  const ownerBudget = sessionId === undefined ? { remaining: MAX_LEDGER_SCAN_BYTES } : budget;
  try {
    let keys;
    if (sessionId !== undefined) {
      // A selected page must never enumerate unrelated state directories.
      keys = [...new Set([ownerKey, hash(`claude:${sessionId}`)])];
    } else {
      await assertDirectory(root, true);
      const entries = await fs.readdir(root.path, { withFileTypes: true });
      await assertDirectory(root, true);
      const others = entries.map(entry => entry.name).filter(key => key !== ownerKey && keyPattern.test(key)).sort();
      const resume = catalogPositions.get(positionKey);
      const index = resume === undefined ? 0 : others.findIndex(key => key >= resume);
      keys = index > 0 ? [ownerKey, ...others.slice(index), ...others.slice(0, index)] : [ownerKey, ...others];
    }
    let resume;
    for (const key of keys.slice(0, MAX_LEDGERS)) {
      checkCancellation(signal);
      try {
        const view = await safeLedger(root, key, key === ownerKey ? ownerBudget : budget, ownerThreadId, sessionId !== undefined, signal);
        if (!view) continue;
        for (const warning of view.warnings) warnings.add(warning);
        visit(view);
      } catch (error) {
        checkCancellation(signal);
        if (isRootError(error.code)) throw error;
        incomplete = true;
        warnings.add(Object.hasOwn(omitted, error.code) ? error.code : 'LEDGER_UNAVAILABLE');
        if (error.code === 'SCAN_LIMIT' && key !== ownerKey) resume ??= key;
      }
    }
    if (keys.length > MAX_LEDGERS) {
      incomplete = true;
      warnings.add('SCAN_LIMIT');
      // Start at the first unverified ledger, so other cold entries cannot starve it even after eviction.
      resume ??= keys[MAX_LEDGERS];
    }
    await assertDirectory(root, true);
    checkCancellation(signal);
    if (sessionId === undefined) {
      catalogPositions.delete(positionKey);
      if (resume !== undefined) catalogPositions.set(positionKey, resume);
      if (catalogPositions.size > 64) catalogPositions.delete(catalogPositions.keys().next().value);
    }
  } catch (error) {
    checkCancellation(signal);
    root = null; // Previously collected views are no longer authorized for publication.
    incomplete = true;
    warnings.add(isRootError(error.code) ? error.code : 'ROOT_UNAVAILABLE');
  }
  return result();
}

function visitPairs(view, ownerThreadId, sessionId, visit) {
  if (sessionId === undefined) {
    for (const [peer, pair] of view.outgoing) visit(peer, pair, 'to_claude');
  } else if (view.outgoing.has(sessionId)) visit(sessionId, view.outgoing.get(sessionId), 'to_claude');
  const incoming = view.incoming.get(ownerThreadId);
  if (incoming && (sessionId === undefined || sessionId === view.claude)) visit(view.claude, incoming, 'to_codex');
}

async function manualRecords(stateDir, threadId, scan, signal, selection) {
  if (!scan.root) return [];
  try {
    const { readManualRecords } = await import('./manual-service.mjs');
    await assertDirectory(scan.root, true);
    checkCancellation(signal);
    return await readManualRecords({ stateDir, threadId, ...selection });
  } catch (error) {
    checkCancellation(signal);
    if (isRootError(error.code)) {
      scan.root = null;
      scan.incomplete = true;
      scan.warnings.push(omitted[error.code]);
    } else {
      scan.incomplete = true; // Missing shadow-only texts can fall on either side of the requested cursor.
      scan.warnings.push('Manual delivery notice metadata could not be read. Refresh to retry, or check access to the shared bridge state.');
    }
    return [];
  }
}

async function verifyPublication(scan, signal) {
  checkCancellation(signal);
  if (!scan.root) return;
  try { await assertDirectory(scan.root, true); }
  catch (error) {
    scan.root = null;
    scan.incomplete = true;
    scan.warnings.push(omitted[error.code]);
  }
  checkCancellation(signal);
}

/** A body-free projection for the catalog. */
export async function listBridgeContacts({ stateDir = defaultStateDir(), ownerThreadId, signal } = {}) {
  const contacts = new Map(), orders = new Map();
  const add = (peer, at, index = at) => {
    if (index >= (orders.get(peer) ?? 0)) { contacts.set(peer, at); orders.set(peer, index); }
  };
  const scan = await collectViews({ stateDir, ownerThreadId, signal, visit: view => {
    visitPairs(view, ownerThreadId, undefined, (peer, pair) => add(peer, pair.latest, pair.order));
  } });
  for (const record of await manualRecords(stateDir, ownerThreadId, scan, signal, { includeMessage: false })) {
    if (record.manual === true && record.send_status === 'submitted' && sessionPattern.test(record.session_id) &&
        Number.isSafeInteger(record.createdAt) && record.createdAt >= 0) add(record.session_id, record.createdAt);
  }
  await verifyPublication(scan, signal);
  return { contacts: scan.root ? contacts : new Map(), orders: scan.root ? orders : new Map(), warnings: scan.warnings };
}

function readCursor(cursor, ownerThreadId, sessionId) {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid conversation cursor.');
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!object(value) || value.v !== 1 || value.owner !== hash(ownerThreadId) || value.session !== hash(sessionId) ||
        !Number.isSafeInteger(value.at) || value.at < 0 || (value.order !== undefined && (!Number.isSafeInteger(value.order) || value.order < 0)) || typeof value.key !== 'string' ||
        !/^(to_claude|to_codex):[a-zA-Z0-9_-]{1,100}$/.test(value.key)) throw new Error('Invalid cursor');
    return value;
  } catch { throw new Error('Invalid conversation cursor.'); }
}

function makeCursor(record, ownerThreadId, sessionId) {
  return Buffer.from(JSON.stringify({ v: 1, owner: hash(ownerThreadId), session: hash(sessionId),
    at: record.createdAt, order: order(record), key: sortKey(record) })).toString('base64url');
}

function seekBefore(records, before) {
  if (!before) return records.length - 1;
  let lo = 0;
  let hi = records.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const record = records[mid];
    if (order(record) < before.at || (order(record) === before.at && compareKeys(sortKey(record), before.key) < 0)) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export async function getBridgeConversation({ stateDir = defaultStateDir(), ownerThreadId, sessionId, limit = 100, cursor, signal } = {}) {
  validateHistoryOwner(ownerThreadId);
  validateClaudeHistoryId(sessionId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Conversation limit must be between 1 and 200.');
  const before = readCursor(cursor, ownerThreadId, sessionId);
  let outgoing;
  let incoming;
  const scan = await collectViews({ stateDir, ownerThreadId, sessionId, signal, visit: view => {
    visitPairs(view, ownerThreadId, sessionId, (_peer, pair, direction) => {
      if (direction === 'to_claude') outgoing = pair;
      else incoming = pair;
    });
  } });
  const notices = new Map();
  const shadowRows = [];
  let orphans = 0;
  for (const record of await manualRecords(stateDir, ownerThreadId, scan, signal, { sessionId,
    includeMessage: row => row.send_status === 'submitted' && !outgoing?.byId.has(row.message_id) })) {
    if (record.manual !== true || record.session_id !== sessionId) continue;
    const primary = outgoing?.byId.get(record.message_id);
    if (primary?.fingerprint === record.fingerprint) notices.set(record.message_id, record);
    else if (record.send_status === 'submitted') {
      if (!primary && typeof record.message === 'string') {
        // readManualRecords verified the body against this exact route and fingerprint.
        shadowRows.push({ id: record.message_id, direction: 'to_claude', message: record.message,
          manual: true, createdAt: record.createdAt, orderAt: record.orderAt, status: 'submitted' });
        notices.set(record.message_id, record);
      } else orphans++;
    }
  }
  await verifyPublication(scan, signal);
  if (orphans && !scan.incomplete) {
    scan.warnings.push(`Manual sends confirmed without matching saved message text: ${orphans}. Check the Claude conversation; do not resend to recover the text.`);
  }
  if (scan.incomplete) {
    // An incomplete direction cannot justify moving the boundary past unknown messages.
    return { session_id: sessionId, messages: [], next_cursor: cursor ?? null, has_more: before !== null, warnings: scan.warnings };
  }
  const sources = [outgoing?.records ?? [], incoming?.records ?? [], shadowRows.sort(compare)];
  // A 1.0 writer sorted by civil time. If its boundary row has since acquired an additive
  // order stamp, seek by that exact row rather than interpreting civil time as commit order.
  let boundary = before;
  if (before) {
    const [direction, id] = before.key.split(':');
    const prior = (direction === 'to_claude' ? outgoing : incoming)?.byId.get(id);
    boundary = { ...before, at: before.order ?? (prior?.createdAt === before.at ? order(prior) : before.at) };
  }
  const positions = sources.map(rows => seekBefore(rows, boundary));
  const page = [];
  let oldest;
  let bytes = 0;
  while (page.length < limit) {
    let pick = -1;
    for (let i = 0; i < sources.length; i++) {
      if (positions[i] >= 0 && (pick < 0 || compare(sources[i][positions[i]], sources[pick][positions[pick]]) > 0)) pick = i;
    }
    if (pick < 0) break;
    const record = sources[pick][positions[pick]];
    const notice = record.direction === 'to_claude' ? notices.get(record.id) : undefined;
    const visible = { id: record.id, direction: record.direction, message: record.message, created_at: record.createdAt,
      status: effectiveStatus(record), ...(record.manual === true || notice ? { manual: true } : {}) };
    if (noticeStatuses.has(notice?.notice_status)) visible.notice_status = notice.notice_status;
    if (typeof notice?.notice_retryable === 'boolean') visible.notice_retryable = notice.notice_retryable;
    const size = Buffer.byteLength(JSON.stringify(visible));
    if (page.length && bytes + size > MAX_PAGE_BYTES) break;
    bytes += size;
    page.push(visible);
    oldest = record;
    positions[pick]--;
  }
  const hasMore = positions.some(pos => pos >= 0);
  return { session_id: sessionId, messages: page.reverse(),
    next_cursor: hasMore ? makeCursor(oldest, ownerThreadId, sessionId) : null,
    has_more: hasMore, warnings: scan.warnings };
}
