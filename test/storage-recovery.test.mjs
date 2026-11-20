import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { createSession, ledgerAt, lookupMessage, recordMessage, getMessages, readSession, finishMessage, updateSession, withStateLockAsync } from '../lib/store.mjs';
import * as calls from '../lib/call-store.mjs';
import { executeBridgeTool } from '../lib/bridge-service.mjs';
import { nativeFixture } from './native-helpers.mjs';
import { startCall } from '../lib/call-time.mjs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

async function setup(t) {
  const root = await nativeFixture(t), owner = { ...root, threadId: randomUUID() };
  const session = createSession(owner);
  const draft = { id: 'test-id', direction: 'to_claude', message: 'example', route: { from: { kind: 'codex', id: owner.threadId }, to: { kind: 'claude', id: 'peer' } } };
  return { owner, session, draft };
}

for (const status of ['submitted', 'failed']) test(`a known ${status} receipt survives a full disk and repairs only its own attempt`, async t => {
  const { owner, session, draft } = await setup(t);
  const { message } = await calls.recordMessage(session, draft);
  const terminal = { status, route: draft.route, ...(status === 'failed' ? { reason: 'target_unavailable' } : { receipt: { status: 'written' } }) };
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (a, b) => {
    if (b === session.stateFile) throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    return rename(a, b);
  });
  await assert.rejects(calls.finishMessage(session, draft.id, { ...terminal, attemptId: message.attemptId }), { code: 'ENOSPC' });
  calls.retainSettlement(session, message, terminal);
  const read = () => lookupMessage(owner, draft).prior;
  await assert.rejects(calls.repairSettlement(session, read()), e => {
    assert.equal(e.outcome.delivered, status === 'submitted'); assert.equal(e.outcome.record.status, 'sending');
    assert.equal(e.outcome.retry, status === 'submitted' ? 'no' : 'inspect'); return true;
  });
  assert.equal(read().status, 'sending');
  fault.mock.restore();
  const recovered = await calls.repairSettlement(session, read());
  assert.equal(recovered.retryable, status === 'failed'); assert.equal(read().status, status);
  assert.equal(read().attemptId, message.attemptId);
  if (status === 'submitted') assert.deepEqual(read().receipt, terminal.receipt);
  if (status === 'failed') {
    const next = await calls.recordMessage(session, { ...draft, retryFailed: true });
    assert.notEqual(next.message.attemptId, message.attemptId);
    calls.retainSettlement(session, message, terminal);
    assert.equal((await calls.repairSettlement(session, read())).status, 'sending');
    await assert.rejects(calls.finishMessage(session, draft.id, { ...terminal, attemptId: message.attemptId }), { reason: 'state_unavailable' });
    assert.equal(read().status, 'sending');
  }
});

test('an invalid row cannot free a key, impersonate a different message, or hide healthy siblings', async t => {
  const { owner, session, draft } = await setup(t);
  recordMessage(session, draft); recordMessage(session, { ...draft, id: 'healthy' });
  updateSession(session, s => { Object.values(s.messages).find(r => r.id === draft.id).id = 'wrong-id'; s.messages.broken = null; });
  const before = fs.readFileSync(session.stateFile);
  const invalid = { reason: 'state_unavailable', outcome: { delivered: 'unknown', retry: 'inspect', reason: 'state_unavailable' } };
  assert.throws(() => lookupMessage(owner, draft), invalid);
  assert.throws(() => recordMessage(session, draft), invalid);
  assert.throws(() => finishMessage(session, draft.id, { route: draft.route, status: 'submitted' }), invalid);
  const { rows, issues } = await calls.listMessages(session, 20, draft.route.from);
  assert.deepEqual(rows.map(r => r.id), ['healthy']); assert.deepEqual(issues, [{ source: 'ledger', reason: 'state_unavailable' }]);
  assert.deepEqual(fs.readFileSync(session.stateFile), before);
  fs.writeFileSync(session.stateFile, '{"x":"fixture-private-content",@@}');
  assert.throws(() => lookupMessage(owner, draft), e => e.reason === 'state_unavailable' && !e.message.includes('fixture-private-content') && /doctor/.test(e.message));
});

test('invalid UTF-16 cannot alias an owner or be delivered as replacement text', async t => {
  const { owner, session, draft } = await setup(t);
  createSession({ ...owner, threadId: '�' });
  assert.throws(() => ledgerAt({ ...owner, threadId: '\ud800' }), { reason: 'caller_invalid' });
  assert.throws(() => recordMessage(session, { ...draft, message: '\udc00' }), { reason: 'invalid_argument' });
  const context = { env: { CLAUDE_CODEX_BRIDGE_DAEMON: 'off' }, stateDir: owner.stateDir, metadata: { 'openai/threadId': owner.threadId } };
  await assert.rejects(executeBridgeTool('send_to_claude', { message: '\ud800', session_id: 'peer' }, context), { reason: 'invalid_argument' });
  assert.deepEqual(getMessages(session), []);
});

test('wall steps do not move a recent attempt out of the latest page or prove it abandoned', async t => {
  const { session, draft } = await setup(t);
  const wall = Date.now(); let time = wall + 3600_000;
  t.mock.method(Date, 'now', () => time);
  recordMessage(session, draft); time -= 7200_000;
  const later = recordMessage(session, { ...draft, id: 'later' });
  assert.equal(later.message.createdAt, time); assert.equal(getMessages(session, 1)[0].id, 'later');
  time += 7200_000; assert.equal(getMessages(session, 1)[0].status, 'sending');
  updateSession(session, state => { Object.values(state.messages).find(r => r.id === 'later').startedTick -= 61_000; });
  assert.equal(getMessages(session, 1)[0].status, 'uncertain');
});

for (const guard of [false, true]) test(`restore ${guard ? 'recovery' : 'main'} lock release after a read-only interval without repeating any mutation`, async t => {
  const { session } = await setup(t); const lock = path.join(session.dir, 'state.lock'), recovery = lock + '.recovery';
  if (guard) fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: 'dead' }));
  const unlink = fs.unlinkSync; let count = 0, denied = true;
  t.mock.method(fs, 'unlinkSync', file => {
    if (denied && (file === lock || file === recovery)) throw Object.assign(new Error('temporary read-only state'), { code: 'EROFS' });
    return unlink(file);
  });
  const change = () => withStateLockAsync(session.dir, () => ++count);
  if (guard) await assert.rejects(change(), { code: 'EROFS' }); else assert.equal(await change(), 1);
  assert.ok(fs.existsSync(guard ? recovery : lock)); denied = false;
  assert.equal(await change(), guard ? 1 : 2);
  assert.ok(!fs.existsSync(lock) && !fs.existsSync(recovery));
});

test('an exact Windows start token mismatch under five seconds is rechecked before taking the lock', { skip: process.platform !== 'win32' }, async t => {
  const { session } = await setup(t); const lock = path.join(session.dir, 'state.lock');
  const original = JSON.stringify({ pid: process.pid, token: 'fixture', procStartFt: '133700000000000010' });
  fs.writeFileSync(lock, original); let reads = 0;
  const probe = () => { reads++; return reads === 1 ? '133700000000000011' : '133700000000000010'; };
  await assert.rejects(withStateLockAsync(session.dir, () => assert.fail('stale first result must not rob the new owner'), { probe, waitMs: 1, now: () => reads > 2 ? 2 : 0 }), { reason: 'state_busy' });
  assert.equal(fs.readFileSync(lock, 'utf8'), original);
  await withStateLockAsync(session.dir, () => {}, { probe: () => '133700000000000011' });
  assert.ok(!fs.existsSync(lock));
});

test('a cancelled reservation queued to the storage worker cannot commit its key', async t => {
  const { session, draft } = await setup(t), controller = new AbortController();
  updateSession(session, state => { state.legacyPadding = 'x'.repeat(600_000); });
  const original = Worker.prototype.postMessage;
  t.mock.method(Worker.prototype, 'postMessage', function(message, ...rest) {
    if (message.method === 'record') controller.abort(); // after cross-version lock and parent preflight
    return original.call(this, message, ...rest);
  });
  await assert.rejects(calls.recordMessage(session, draft, { signal: controller.signal }), { code: 'ABORT_ERR' });
  assert.deepEqual(readSession(session).messages, {});
});

test('a released-writer replacement invalidates a warm large-ledger snapshot', async t => {
  const { owner, session, draft } = await setup(t);
  recordMessage(session, draft); updateSession(session, state => { state.legacyPadding = 'x'.repeat(600_000); });
  const first = await calls.lookupMessage(owner, draft);
  assert.equal(first.prior.status, 'sending');
  finishMessage(session, draft.id, { route: draft.route, status: 'submitted' }); // ordinary full schema-1 replacement
  const second = await calls.lookupMessage(owner, draft);
  assert.equal(second.prior.status, 'submitted');
  assert.equal((await calls.recordMessage(session, draft)).created, false);
  assert.equal(readSession(session).legacyPadding.length, 600_000);
});

test('rollback preserves bidirectional page boundaries and catalog recency while showing the real civil time', async t => {
  const { owner, session, draft } = await setup(t);
  const { getBridgeConversation } = await import('../lib/bridge-history.mjs');
  const { listClaudeConversations } = await import('../lib/claude-history.mjs');
  const opts = { stateDir: owner.stateDir, ownerThreadId: owner.threadId,
    registryDir: path.join(owner.root, 'absent'), projectsDir: path.join(owner.root, 'absent-projects') };
  const sessionId = randomUUID(), other = randomUUID(); let wall = Date.now();
  const recipient = id => ({ kind: 'claude', id });
  const incoming = createSession({ ...owner, threadId: `claude:${sessionId}` });
  t.mock.method(Date, 'now', () => wall);
  const send = id => recordMessage(session, { ...draft, id, route: { from: draft.route.from, to: recipient(id) } });
  send(sessionId); send(other); wall -= 3_600_000;
  recordMessage(incoming, { ...draft, direction: 'to_codex', route: { from: recipient(sessionId), to: draft.route.from } });
  const page = await getBridgeConversation({ ...opts, sessionId, limit: 1, historyOrder: 'commit' });
  assert.deepEqual(page.messages.map(m => [m.direction, m.created_at]), [['to_codex', wall]]);
  const older = await getBridgeConversation({ ...opts, sessionId, cursor: page.next_cursor });
  assert.deepEqual(older.messages.map(m => m.id), [sessionId]);
  const legacyBoundary = JSON.parse(Buffer.from(page.next_cursor, 'base64url'));
  assert.equal(legacyBoundary.v, 2); legacyBoundary.v = 1; legacyBoundary.at = wall;
  const oldCursor = Buffer.from(JSON.stringify(legacyBoundary)).toString('base64url');
  assert.deepEqual((await getBridgeConversation({ ...opts, sessionId, cursor: oldCursor })).messages.map(m => m.id), []);
  const catalog = await listClaudeConversations(opts);
  assert.deepEqual(catalog.conversations.map(c => c.session_id), [sessionId, other]);
  assert.equal(catalog.conversations[0].last_contact_at, wall);
});

test('doctor distinguishes unsupported hard links from an unusable state selector without publishing', async t => {
  const { owner } = await setup(t);
  t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('fixture volume'), { code: 'ENOTSUP' }); });
  const result = await executeBridgeTool('bridge_doctor', {}, { env: { CLAUDE_CODEX_BRIDGE_DAEMON: 'off' }, stateDir: owner.stateDir,
    registryDir: path.join(owner.root, 'no-registry'), parentPid: 2147483647 });
  assert.match(result.checks.find(c => c.name === 'state_directory').detail, /hard links/);
  assert.deepEqual(result.issues.find(c => c.check === 'state_directory'), { check: 'state_directory', status: 'fail', reason: 'state_unavailable' });
  assert.deepEqual(result.diagnosis, { reason: 'state_unavailable',
    next_action: 'Check the configured state directory’s location, write access and hard-link support.' });
  assert.ok(!fs.readdirSync(owner.stateDir).some(n => n.startsWith('.link-check-')));
  const notDirectory = path.join(owner.root, 'file'); fs.writeFileSync(notDirectory, 'fixture');
  const invalid = await executeBridgeTool('bridge_doctor', {}, { env: { CLAUDE_CODEX_BRIDGE_STATE_DIR: notDirectory } });
  assert.equal(invalid.ready, false); assert.equal(invalid.issues[0].reason, 'state_unavailable');
  assert.deepEqual(invalid.diagnosis, { reason: 'state_unavailable',
    next_action: 'Check that both apps select the same usable shared state directory.' });
  assert.ok(!JSON.stringify(invalid).includes(notDirectory));
});

test('rearming an older failed delivery does not jump across an issued page cursor', async t => {
  const { owner, session, draft } = await setup(t);
  const sessionId = randomUUID(), route = { ...draft.route, to: { kind: 'claude', id: sessionId } };
  const { getBridgeConversation } = await import('../lib/bridge-history.mjs');
  const options = { stateDir: owner.stateDir, ownerThreadId: owner.threadId, sessionId, limit: 1, historyOrder: 'commit' };
  recordMessage(session, { ...draft, route });
  finishMessage(session, draft.id, { route, status: 'failed', reason: 'target_unavailable' });
  recordMessage(session, { ...draft, route, id: 'latest' });
  const first = await getBridgeConversation(options);
  assert.equal(first.messages[0].id, 'latest');
  const retry = recordMessage(session, { ...draft, route, retryFailed: true });
  assert.equal(retry.retried, true);
  assert.deepEqual((await getBridgeConversation({ ...options, cursor: first.next_cursor })).messages.map(r => r.id), [draft.id]);
});

test('doctor reports dead sender and manual recovery owners without changing locks', async t => {
  const { owner, session } = await setup(t);
  const manual = path.join(owner.stateDir, 'manual', session.key); fs.mkdirSync(manual, { recursive: true });
  const contents = JSON.stringify({ pid: 2147483647, token: 'fixture-only' });
  for (const dir of [session.dir, manual]) for (const lock of ['state.lock', 'state.lock.recovery']) fs.writeFileSync(path.join(dir, lock), contents);
  const report = await executeBridgeTool('bridge_doctor', {}, { stateDir: owner.stateDir, env: { CLAUDE_CODEX_BRIDGE_DAEMON: 'off' },
    metadata: { 'openai/threadId': owner.threadId }, registryDir: path.join(owner.root, 'absent') });
  const sender = report.checks.find(c => c.name === 'sender_lock');
  assert.equal(sender.status, 'fail');
  assert.match(sender.detail, /back up.*offline lock recovery/i);
  assert.deepEqual(report.checks.find(c => c.name === 'manual_lock'), { name: 'manual_lock', status: 'fail',
    detail: 'Recovery was interrupted and its owner no longer runs.' });
  assert.deepEqual(report.diagnosis, { reason: 'state_unavailable',
    next_action: 'Consult the README’s shared-state lock recovery guidance before sending.' });
  for (const dir of [session.dir, manual]) for (const lock of ['state.lock', 'state.lock.recovery']) assert.equal(fs.readFileSync(path.join(dir, lock), 'utf8'), contents);
});

test('R4O01: a recovery guard with no order lock does not block an acquisition or prescribe offline migration', async t => {
  const { owner } = await setup(t), dir = path.join(owner.stateDir, 'order'); fs.mkdirSync(dir, { recursive: true });
  const guard = path.join(dir, 'state.lock.recovery'), bytes = JSON.stringify({ pid: 2147483647, token: 'stopped-reaper' });
  fs.writeFileSync(guard, bytes);
  const doctor = () => executeBridgeTool('bridge_doctor', {}, { stateDir: owner.stateDir, env: { CLAUDE_CODEX_BRIDGE_DAEMON: 'off' },
    metadata: { 'openai/threadId': owner.threadId }, registryDir: path.join(owner.root, 'absent') });
  const check = report => { const lock = report.checks.find(c => c.name === 'order_lock');
    assert.equal(lock?.status, 'pass'); assert.match(lock.detail, /no owner lock/i); assert.doesNotMatch(lock.detail, /quit both|offline recovery/i);
    assert.notEqual(report.diagnosis?.reason, 'state_unavailable'); assert.equal(fs.readFileSync(guard, 'utf8'), bytes); };
  check(await doctor());
  assert.equal(await withStateLockAsync(dir, () => 'acquired'), 'acquired');
  check(await doctor());
  fs.writeFileSync(path.join(dir, 'state.lock'), bytes);
  await assert.rejects(withStateLockAsync(dir, () => assert.fail('no takeover')), { code: 'LOCK_RECOVERY_INTERRUPTED' });
  const blocked = await doctor(); assert.equal(blocked.checks.find(c => c.name === 'order_lock').status, 'fail');
  assert.equal(blocked.diagnosis?.reason, 'state_unavailable'); assert.equal(fs.readFileSync(guard, 'utf8'), bytes);
});

test('TL04: a manual-only recovery lock is observed without diagnosing a primary sender failure', async t => {
  const { owner, session } = await setup(t), manual = path.join(owner.stateDir, 'manual', session.key);
  fs.mkdirSync(manual, { recursive: true });
  for (const name of ['state.lock', 'state.lock.recovery']) fs.writeFileSync(path.join(manual, name), '{"pid":2147483647}');
  const report = await executeBridgeTool('bridge_doctor', {}, { stateDir: owner.stateDir, env: { CLAUDE_CODEX_BRIDGE_DAEMON: 'off' },
    metadata: { 'openai/threadId': owner.threadId }, registryDir: path.join(owner.root, 'absent') });
  assert.equal(report.checks.find(entry => entry.name === 'manual_lock')?.status, 'fail');
  assert.notEqual(report.diagnosis?.reason, 'state_unavailable');
});

test('SP08: a replay blocked by a held ledger lock answers its known handoff within the call budget', async t => {
  const { owner, session, draft } = await setup(t);
  const { message } = await calls.recordMessage(session, draft);
  calls.retainSettlement(session, message, { status: 'submitted', route: draft.route, receipt: { status: 'written' } });
  let release; const locked = new Promise(resolve => { release = resolve; });
  let entered; const holding = new Promise(resolve => { entered = resolve; });
  const held = withStateLockAsync(session.dir, () => { entered(); return locked; });
  await holding;
  const call = startCall({ deadlineMs: 400 }), started = performance.now();
  try {
    await assert.rejects(executeBridgeTool('send_to_claude', { session_id: 'peer', message: draft.message, message_id: draft.id },
      { stateDir: owner.stateDir, env: { CLAUDE_CODEX_BRIDGE_DAEMON: 'off' }, metadata: { 'openai/threadId': owner.threadId }, signal: call.signal }),
      error => error.outcome.delivered === true && error.outcome.reason === 'settlement_failed' && error.outcome.retry === 'no');
    assert.ok(performance.now() - started < 400, 'the client wait ended inside the call budget');
  } finally { call.dispose(); release(); await held; }
  for (let i = 0; i < 100 && lookupMessage(owner, draft).prior.status !== 'submitted'; i++) await delay(20);
  assert.equal(lookupMessage(owner, draft).prior.status, 'submitted', 'disk repair continued after the reply');
});
