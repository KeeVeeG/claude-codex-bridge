// Send-path contract (stage C1): time, replay, outcome truth. Identity is answered by a fixture-owned
// process probe, so these cases never depend on how fast the OS answers a real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { executeBridgeTool } from '../lib/bridge-service.mjs';
import { manualSend } from '../lib/manual-service.mjs';
import { canonicalClaudeSocket } from '../lib/claude-sessions.mjs';
import { startCall } from '../lib/call-time.mjs';
import { getSession } from '../lib/store.mjs';
import { nativeFixture, mockPipe, encodeFrame, messageTool } from './native-helpers.mjs';

const nativeOnly = { skip: !['win32', 'darwin'].includes(process.platform) && 'Verified Claude processes require Windows or macOS.' };
const windowsOnly = { skip: process.platform !== 'win32' && 'Only Windows refuses to replace a read-only ledger file.' };
const START = process.platform === 'win32' ? '133700000000000000' : 'Thu Oct  8 02:03:04 2026';
const DOMAIN = process.platform === 'win32' ? `win32:${os.hostname().toLowerCase()}` : 'darwin';
const START_FIELD = process.platform === 'win32' ? 'procStartFt' : 'procStart';
const hash = value => createHash('sha256').update(value).digest('hex');
const missingSocket = () => process.platform === 'win32'
  ? `\\\\.\\pipe\\claude-codex-bridge-test-${randomUUID()}` : `/tmp/codex-claude-test-${randomUUID()}.sock`;

async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  assert.fail('Expected the call to fail');
}

function writeClaudeRecord(registryDir, record) {
  fs.writeFileSync(path.join(registryDir, `${record.pid}.json`), JSON.stringify(record));
  fs.writeFileSync(path.join(registryDir, `${record.pid}.${hash(canonicalClaudeSocket(record.messagingSocketPath))}.key`),
    JSON.stringify({ peerToken: 'a'.repeat(32), [START_FIELD]: START, pidDomain: DOMAIN }));
}

/** A Codex Desktop task that sends to one Claude Code session; `probe.answer` scripts the process check. */
async function codexToClaude(t, { inbox: inboxOptions } = {}) {
  const fixture = await nativeFixture(t);
  const inbox = await mockPipe(t, inboxOptions);
  const notices = [];
  const codex = await mockPipe(t, { framed: true, onMessage(message, socket) {
    if (message.method === 'tools/list') socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id, result: { tools: [messageTool] } }));
    else {
      notices.push(message.params);
      socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id, result: { success: true, contentItems: [] } }));
    }
  } });
  const registryDir = path.join(fixture.root, 'registry');
  fs.mkdirSync(registryDir);
  const record = { pid: process.pid, sessionId: randomUUID(), name: 'Send-path fixture', cwd: fixture.cwd,
    entrypoint: 'claude-desktop', procStart: START, pidDomain: DOMAIN, messagingSocketPath: inbox.pipePath };
  const writeRecord = (values = {}) => writeClaudeRecord(registryDir, Object.assign(record, values));
  writeRecord();
  const probe = async (pid, { signal }) => {
    probe.calls++;
    return probe.answer ? probe.answer(signal) : { start: START };
  };
  probe.calls = 0;
  const owner = `send-path-owner-${randomUUID()}`;
  const context = { env: { CODEX_APP_TOOLS_PIPE_PATH: codex.pipePath, CLAUDE_CODEX_BRIDGE_DAEMON: 'off' },
    metadata: { 'openai/threadId': owner }, stateDir: fixture.stateDir, registryDir, processProbe: probe };
  const send = (args, extra = {}) => executeBridgeTool('send_to_claude',
    { session_id: record.sessionId, message: 'Send-path fixture text', ...args }, { ...context, ...extra });
  const userFrames = () => inbox.messages.filter(entry => entry.message.type === 'user');
  const ledgerFile = () => path.join(getSession({ stateDir: fixture.stateDir, threadId: owner }).dir, 'state.json');
  return { ...fixture, inbox, notices, registryDir, record, writeRecord, probe, owner, context, send, userFrames, ledgerFile };
}

test('a send that wrote nothing can be repeated with the same message_id once its cause is fixed (FB03)', nativeOnly, async t => {
  const setup = await codexToClaude(t);
  const live = setup.record.messagingSocketPath;
  setup.writeRecord({ messagingSocketPath: missingSocket() });
  const failed = await rejection(setup.send({ message_id: 'fb03' }));
  assert.match(failed.message, /^Message not sent\. Cannot connect to the selected Claude Code session/);
  assert.deepEqual(failed.outcome, { delivered: false, retry: 'after_fix', reason: 'target_unavailable',
    record: { message_id: 'fb03', status: 'failed' } });
  setup.writeRecord({ messagingSocketPath: live });
  const sent = await setup.send({ message_id: 'fb03' });
  assert.equal(sent.delivery.status, 'submitted');
  assert.deepEqual(sent.outcome, { delivered: true, retry: 'no', reason: 'submitted', record: { message_id: 'fb03', status: 'submitted' } });
  assert.equal(setup.userFrames().length, 1);
});

test('a failed record from an earlier version is answered, never sent again, and asks for inspection (AX01)', nativeOnly, async t => {
  const setup = await codexToClaude(t);
  const live = setup.record.messagingSocketPath;
  setup.writeRecord({ messagingSocketPath: missingSocket() });
  await rejection(setup.send({ message_id: 'legacy' }));
  // Earlier versions saved a failure without its cause; it proves nothing about the write.
  const ledger = JSON.parse(fs.readFileSync(setup.ledgerFile(), 'utf8'));
  for (const message of Object.values(ledger.messages)) delete message.reason;
  fs.writeFileSync(setup.ledgerFile(), JSON.stringify(ledger));
  setup.writeRecord({ messagingSocketPath: live });
  const replayed = await rejection(setup.send({ message_id: 'legacy' }));
  assert.match(replayed.message, /^No new send was made: .*list_deliveries.*new message_id/);
  assert.deepEqual(replayed.outcome, { delivered: 'unknown', retry: 'inspect', reason: 'prior_failed',
    record: { message_id: 'legacy', status: 'failed' } });
  assert.equal(setup.userFrames().length, 0);
});

test('a message_id reused for different text is refused and steers to inspection, not a new send (AX01)', nativeOnly, async t => {
  const setup = await codexToClaude(t);
  await setup.send({ message_id: 'ax01' });
  const conflict = await rejection(setup.send({ message_id: 'ax01', message: 'A changed body under the same key' }));
  assert.match(conflict.message, /^Message not sent\. Message ID already belongs to different content.*list_deliveries/);
  assert.deepEqual(conflict.outcome, { delivered: false, retry: 'inspect', reason: 'id_conflict',
    record: { message_id: 'ax01', status: 'submitted' } });
  assert.equal(setup.userFrames().length, 1);
});

test('an earlier submission is answered from its record even after the recipient closed (C01, A06)', nativeOnly, async t => {
  const setup = await codexToClaude(t);
  const first = await setup.send({ message_id: 'c01' });
  const probes = setup.probe.calls;
  fs.rmSync(setup.registryDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(setup.stateDir, 'codex-host.json'), '{'); // Replaying does not publish a host either.
  const again = await setup.send({ message_id: 'c01' });
  assert.deepEqual(again.delivery, first.delivery);
  assert.deepEqual(again.outcome, { delivered: true, retry: 'no', reason: 'already_submitted',
    record: { message_id: 'c01', status: 'submitted' } });
  assert.equal(setup.probe.calls, probes, 'a replay runs no recipient check');
  assert.equal(setup.userFrames().length, 1);
});

test('replaying a settled delivery writes nothing, so a read-only ledger still answers it (D04)', windowsOnly, async t => {
  const setup = await codexToClaude(t);
  await setup.send({ message_id: 'd04' });
  const file = setup.ledgerFile();
  const before = fs.readFileSync(file);
  fs.chmodSync(file, 0o444);
  try {
    const again = await setup.send({ message_id: 'd04' });
    assert.equal(again.outcome.reason, 'already_submitted');
  } finally { fs.chmodSync(file, 0o644); }
  assert.deepEqual(fs.readFileSync(file), before);
});

test('a submitted message whose record cannot be saved is reported delivered, never failed (R01)', windowsOnly, async t => {
  let file;
  const setup = await codexToClaude(t, { inbox: { onMessage(message) {
    if (message.type === 'user' && file) fs.chmodSync(file, 0o444);
  } } });
  await setup.send({ message_id: 'warm-up' });
  file = setup.ledgerFile();
  let error;
  try { error = await rejection(setup.send({ message_id: 'r01' })); } finally { fs.chmodSync(file, 0o644); }
  assert.match(error.message, /^The message was submitted, but its delivery record could not be saved\. Do not send it again/);
  assert.deepEqual(error.outcome, { delivered: true, retry: 'no', reason: 'settlement_failed', record: { message_id: 'r01', status: 'sending' } });
  assert.equal(setup.userFrames().length, 2);
  const replay = await setup.send({ message_id: 'r01' });
  assert.equal(replay.outcome.reason, 'already_submitted');
  assert.equal(Object.values(JSON.parse(fs.readFileSync(file)).messages).find(row => row.id === 'r01').status, 'submitted');
  assert.equal(setup.userFrames().length, 2, 'repair must not write another recipient frame');
});

test('a manual send whose primary record cannot be saved stays submitted and posts its notice (Q02)', windowsOnly, async t => {
  let file;
  const setup = await codexToClaude(t, { inbox: { onMessage(message) {
    if (message.type === 'user' && file) fs.chmodSync(file, 0o444);
  } } });
  await setup.send({ message_id: 'warm-up' });
  file = setup.ledgerFile();
  let result;
  try {
    result = await manualSend({ session_id: setup.record.sessionId, message: 'Manual fixture text', message_id: 'q02' }, setup.context);
  } finally { fs.chmodSync(file, 0o644); }
  assert.equal(result.delivery.status, 'submitted');
  assert.equal(result.notice_status, 'submitted');
  assert.deepEqual(result.outcome, { delivered: true, retry: 'no', reason: 'submitted', record: { message_id: 'q02', status: 'submitted' } });
  assert.deepEqual(result.notice_outcome, { delivered: true, retry: 'no', reason: 'submitted' });
  assert.equal(setup.notices.length, 1);
  assert.equal(setup.userFrames().length, 2);
});

test('a send reads its ledger once to look up, once to reserve and once to settle; a listing once (O04)', nativeOnly, async t => {
  const setup = await codexToClaude(t);
  await setup.send({ message_id: 'o04-first' });
  const file = path.resolve(setup.ledgerFile());
  let reads = 0;
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (target, ...rest) {
    if (typeof target === 'string' && path.resolve(target) === file) reads++;
    return read.call(this, target, ...rest);
  });
  assert.equal((await setup.send({ message_id: 'o04' })).outcome.reason, 'submitted');
  assert.equal(reads, 3);
  reads = 0;
  assert.equal((await setup.send({ message_id: 'o04' })).outcome.reason, 'already_submitted');
  assert.equal(reads, 1, 'a replay is answered from one read');
  reads = 0;
  await executeBridgeTool('list_deliveries', {}, setup.context);
  assert.equal(reads, 1);
});

test('a call without time left for the write never writes, and the same message_id is sent later (FB01, D02)', nativeOnly, async t => {
  const setup = await codexToClaude(t);
  const call = startCall({ deadlineMs: 4000 });
  let error;
  try { error = await rejection(setup.send({ message_id: 'late' }, { signal: call.signal })); } finally { call.dispose(); }
  assert.match(error.message, /^Message not sent\. The bridge call ran out of time before the message was written\./);
  assert.deepEqual(error.outcome, { delivered: false, retry: 'same_id', reason: 'deadline', record: { message_id: 'late', status: 'failed' } });
  assert.equal(setup.inbox.messages.length, 0, 'neither the auth line nor the message was written');
  const sent = await setup.send({ message_id: 'late' });
  assert.equal(sent.outcome.reason, 'submitted');
  assert.equal(setup.userFrames().length, 1);
});

test('a call cancelled during the last identity check writes nothing and can be repeated (FB01)', nativeOnly, async t => {
  const setup = await codexToClaude(t);
  const controller = new AbortController();
  setup.probe.answer = () => {
    if (setup.probe.calls === 2) controller.abort();
    return { start: START };
  };
  const error = await rejection(setup.send({ message_id: 'cancel' }, { signal: controller.signal }));
  assert.deepEqual(error.outcome, { delivered: false, retry: 'same_id', reason: 'cancelled', record: { message_id: 'cancel', status: 'failed' } });
  assert.equal(setup.inbox.messages.length, 0);
  setup.probe.answer = undefined;
  assert.equal((await setup.send({ message_id: 'cancel' })).outcome.reason, 'submitted');
});

test('a destination already known to have changed fails before another process check (FB05)', nativeOnly, async t => {
  const setup = await codexToClaude(t);
  const connect = net.connect;
  let switched = false;
  const mock = t.mock.method(net, 'connect', (...args) => {
    // The conversation is resumed under another ID between resolution and the connection.
    if (!switched) { switched = true; setup.writeRecord({ sessionId: randomUUID() }); }
    return connect(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const sessionId = setup.record.sessionId;
  const error = await rejection(setup.send({ message_id: 'fb05', session_id: sessionId }));
  assert.equal(switched, true);
  assert.match(error.message, /destination changed before the message was written/);
  assert.deepEqual(error.outcome, { delivered: false, retry: 'after_fix', reason: 'target_changed', record: { message_id: 'fb05', status: 'failed' } });
  assert.equal(setup.probe.calls, 1, 'only the resolution checked the process');
  assert.equal(setup.inbox.messages.length, 0);
});

test('a window that switched conversations while the call waited never sends as the other one (A201)', nativeOnly, async t => {
  const setup = await codexToClaude(t);
  const context = { env: { CLAUDE_CODE_MESSAGING_SOCKET: setup.record.messagingSocketPath, CLAUDE_CODEX_BRIDGE_DAEMON: 'off' },
    stateDir: setup.stateDir, registryDir: setup.registryDir, parentPid: process.pid, processProbe: setup.probe };
  const args = { thread_id: randomUUID(), message: 'From the admitted conversation', message_id: 'a201' };
  const error = await rejection(executeBridgeTool('send_to_codex', args, { ...context, callerSessionId: randomUUID() }));
  assert.match(error.message, /^Message not sent\. This Claude Code window switched to another conversation/);
  assert.deepEqual(error.outcome, { delivered: false, retry: 'after_fix', reason: 'caller_changed' });
  assert.equal(fs.existsSync(setup.stateDir) && fs.readdirSync(setup.stateDir).some(name => /^[a-f0-9]{64}$/.test(name)), false,
    'no ledger of either conversation was touched');
});

test('doctor reports an inbox that is slow to accept a connection as inconclusive, not unavailable', nativeOnly, async t => {
  const setup = await codexToClaude(t);
  const connect = net.connect;
  const inbox = setup.record.messagingSocketPath.toLowerCase();
  // The window is alive but too busy to accept within the probe's budget.
  const mock = t.mock.method(net, 'connect', (options, ...rest) =>
    String(options?.path).toLowerCase() === inbox ? new net.Socket() : connect(options, ...rest));
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const result = await executeBridgeTool('bridge_doctor', {}, setup.context);
  const check = result.checks.find(item => item.name === 'claude_inbox');
  assert.equal(check.status, 'warning');
  assert.match(check.detail, /did not accept a local connection in time\. Its availability is inconclusive\./);
  assert.deepEqual(result.issues.find(issue => issue.check === 'claude_inbox'), { check: 'claude_inbox', status: 'warning', reason: 'target_unverified' });
});

test('doctor ends its inbox checks within their budget when process checks hang (FB04)', nativeOnly, async t => {
  const setup = await codexToClaude(t);
  writeClaudeRecord(setup.registryDir, { ...setup.record, pid: process.ppid, sessionId: randomUUID(), messagingSocketPath: missingSocket() });
  setup.probe.answer = signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('fixture hang'), { transient: true })), { once: true });
  });
  const started = performance.now();
  const result = await executeBridgeTool('bridge_doctor', {}, setup.context);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 12_000, `doctor took ${Math.round(elapsed)} ms`);
  const inbox = result.checks.find(check => check.name === 'claude_inbox');
  assert.equal(inbox.status, 'warning');
  assert.match(inbox.detail, /not checked within the diagnostic time budget/);
  assert.deepEqual(result.issues.find(issue => issue.check === 'claude_inbox'), { check: 'claude_inbox', status: 'warning', reason: 'target_unverified' });
  assert.equal(setup.inbox.messages.length, 0);
});

test('a panel shadow failure after both acceptances preserves both transport outcomes', nativeOnly, async t => {
  const s = await codexToClaude(t), shadowFile = path.join(s.stateDir, 'manual', hash(s.owner), 'state.json');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', function (source, dest) {
    if (s.notices.length && dest === shadowFile) throw Object.assign(new Error('Fixture shadow save failed'), { code: 'EIO' });
    return rename.call(this, source, dest);
  });
  const result = await executeBridgeTool('panel_send', { session_id: s.record.sessionId, message: 'fixture', message_id: 'panel' }, s.context);
  assert.equal(result.outcome.delivered, true); assert.equal(result.outcome.retry, 'no');
  assert.equal(result.notice_status, 'submitted');
  assert.deepEqual(result.notice_outcome, { delivered: true, retry: 'no', reason: 'settlement_failed' });
  assert.doesNotMatch(result.notice_error, /message not sent/i);
  assert.equal(s.userFrames().length, 1); assert.equal(s.notices.length, 1);
});

test('a panel send retries its durably unwritten failure with the identical ID (FB03)', nativeOnly, async t => {
  const s = await codexToClaude(t);
  s.probe.answer = () => { throw Object.assign(new Error('Fixture OS timeout'), { transient: true }); };
  const args = { session_id: s.record.sessionId, message: 'fixture', message_id: 'panel-retry' };
  const call = () => executeBridgeTool('panel_send', args, s.context);
  const first = await call(); assert.equal(first.outcome.retry, 'same_id');
  s.probe.answer = undefined;
  assert.equal((await call()).outcome.delivered, true); assert.equal((await call()).outcome.reason, 'already_submitted');
  assert.equal(s.userFrames().length, 1); assert.equal(s.notices.length, 1);
});

test('a malformed registration makes the Claude list explicitly partial', nativeOnly, async t => {
  const s = await codexToClaude(t);
  fs.writeFileSync(path.join(s.registryDir, (process.pid + 1) + '.json'), '{');
  const result = await executeBridgeTool('list_claude_sessions', {}, s.context);
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(result.issues, [{ source: 'claude', reason: 'state_unavailable' }]);
});
