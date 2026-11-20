import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { REASONS } from '../lib/outcome.mjs';
import { inquire, startCall, waitForSettlement } from '../lib/call-time.mjs';
import { inspectStateLocks } from '../lib/state-lock.mjs';
import { interruptedSend, createSession, recordMessage, finishMessage, getMessages, readSession, messageIndex } from '../lib/store.mjs';
import * as ledger from '../lib/call-store.mjs';
import { openDaemon } from '../lib/codex-daemon.mjs';
import { fakeDaemon } from './codex-daemon-helpers.mjs';
import { nativeFixture } from './native-helpers.mjs';

const draft = { id: 'original', direction: 'to_claude', message: 'fixture', route: { from: { id: 'sender', kind: 'codex' }, to: { id: 'recipient', kind: 'claude' } } };

test('EC09: README documents each outcome code once, with a cause and a repair', () => {
  const section = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8').split('### Outcome reasons\n')[1]?.split('\n### ')[0] ?? '';
  const codes = [...section.matchAll(/^\| `([a-z_]+)` \| [^|\n]+ \| [^|\n]+ \|$/gm)].map(match => match[1]);
  assert.deepEqual(codes.sort(), Object.keys(REASONS).sort());
});

test('SP01: framing that crosses the write boundary sends no mutating frame', async t => {
  const fake = await fakeDaemon(t, { threads: [] });
  let tick = 0;
  const client = await openDaemon(fake.daemon);
  t.mock.method(performance, 'now', () => tick);
  const call = startCall();
  try {
    tick = 49_999;
    await assert.rejects(client.request('turn/start', { toJSON() { tick = 56_000; return {}; } }, { mutating: true, signal: call.signal }), { reason: 'deadline' });
    assert.ok(!fake.requests().some(entry => entry.method === 'turn/start'));
  } finally { client.close(); call.dispose(); }
});

test('SP02: an overdue read result is not proof, even before its timeout callback runs', async t => {
  let tick = 0; t.mock.method(performance, 'now', () => tick);
  const call = startCall();
  try {
    const late = () => { tick += 20; return 'missing'; };
    await assert.rejects(inquire(late, { signal: call.signal, attemptMs: 10, attempts: 2 }), { inconclusive: true });
    await assert.rejects(inquire(() => { tick += 60_000; return 'gone'; }, { signal: call.signal }), { reason: 'deadline' });
  } finally { call.dispose(); }
});

test('SP08: an unresponsive receipt cannot consume the remaining client reply margin', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const call = startCall({ deadlineMs: 5100 });
  try {
    const waiting = assert.rejects(waitForSettlement(new Promise(() => {}), call.signal), /settlement is pending/);
    t.mock.timers.tick(1001); await waiting;
  } finally { call.dispose(); }
});

test('LF01: an interrupted reconciliation that arrives after terminal failure cannot reserve another attempt', async t => {
  const fixture = await nativeFixture(t), session = createSession({ ...fixture, threadId: 'sender' });
  const first = recordMessage(session, draft).message;
  finishMessage(session, draft.id, { route: draft.route, status: 'failed', reason: 'cancelled', attemptId: first.attemptId });
  const stale = recordMessage(session, { ...draft, reconcileOnly: true, expectedAttempt: first.attemptId });
  assert.equal(stale.created, false); assert.equal(stale.message.status, 'failed');
  assert.equal(stale.message.attemptId, first.attemptId);
});

test('LF03: a legacy reservation with only a reused PID is not in flight forever', () => {
  const now = Date.now(), row = { status: 'sending', senderPid: process.pid, createdAt: now };
  assert.equal(interruptedSend(row), false);
  assert.equal(interruptedSend({ ...row, createdAt: now - 3 * 3600_000 }), true);
});

test('ST06: the lock inspector reports a reused guard PID, distinguishes an inconclusive check, and never unlinks', { skip: process.platform !== 'win32' }, async t => {
  const f = await nativeFixture(t), file = path.join(f.root, 'state.lock.recovery');
  const bytes = JSON.stringify({ pid: process.pid, procStartFt: '133700000000000123' }); fs.writeFileSync(file, bytes);
  assert.equal((await inspectStateLocks(f.root, { probe: async () => '133700000000000456' })).status, 'fail');
  assert.equal((await inspectStateLocks(f.root, { probe: async () => null })).status, 'warning');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('ST01: a real 1.0.6 contender recognizes the published Mac owner across a rollback with no start token', { skip: !process.env.BRIDGE_TEST_106_ROOT && 'Requires the pinned release export.' }, async t => {
  const root = process.env.BRIDGE_TEST_106_ROOT, f = await nativeFixture(t);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '1.0.6');
  const released = await import(pathToFileURL(path.join(root, 'lib/store.mjs')).href);
  const actual = '2026-03-14T15:09:26.000Z', platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.mock.method(Date, 'now', () => Date.parse(actual) - 120_000);
  // Exercise actual publication and the released reader; only Darwin's platform and OS probe are simulated on Windows.
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    for (const token of [actual, null]) {
      const { withStateLock } = await import(`../lib/state-lock.mjs?mac-owner=${Boolean(token)}`);
      withStateLock(f.root, () => {
        const owner = JSON.parse(fs.readFileSync(path.join(f.root, 'state.lock'), 'utf8'));
        assert.equal(released.macLockOwnerAlive(owner, { readStart: () => actual }), true);
        assert.equal(owner.procStartUtc, token);
      }, { probe: () => token });
    }
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('ST07: warm exact selection uses only the indexed ID but retains independent damage reporting', async t => {
  const f = await nativeFixture(t), session = createSession({ ...f, threadId: 'sender' });
  recordMessage(session, draft); recordMessage(session, { ...draft, id: 'other' });
  const state = readSession(session); state.messages.damaged = null;
  const index = messageIndex(state.messages); let scans = 0;
  const protectedMessages = new Proxy(state.messages, { ownKeys() { scans++; throw new Error('warm lookup rescanned the snapshot'); } });
  const issues = [];
  const rows = getMessages(session, { limit: 1, messageId: draft.id }, undefined, draft.route.from, issues,
    { load: () => ({ ...state, messages: protectedMessages }), index: () => index });
  assert.deepEqual(rows.map(row => row.id), [draft.id]); assert.equal(scans, 0); assert.equal(issues[0]?.reason, 'state_unavailable');
});

test('ST05: the bounded disk-only reconciler frees capacity without a send or a changed listing API', async t => {
  const f = await nativeFixture(t), session = createSession({ ...f, threadId: 'sender' });
  const row = recordMessage(session, draft).message, terminal = { status: 'submitted', route: draft.route };
  ledger.retainSettlement(session, row, terminal);
  for (let i = 1; i < 256; i++) ledger.retainSettlement(session, { ...row, id: `other-${i}` }, terminal);
  assert.throws(ledger.checkSettlementCapacity, { reason: 'state_unavailable' });
  for (let i = 0; i < 50; i++) {
    if ((await ledger.listMessages(session, { limit: 1, messageId: draft.id }, draft.route.from)).rows[0].status === 'submitted') break;
    await delay(50);
  }
  assert.equal(getMessages(session)[0].status, 'submitted'); assert.doesNotThrow(ledger.checkSettlementCapacity);
});

test('CR01/CR02: inspection names both checks and UUID creation belongs to the first call', () => {
  const skill = fs.readFileSync(new URL('../skills/bridge/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /For `inspect`[^\n]*check the recipient and outgoing record/);
  const source = fs.readFileSync(new URL('../scripts/mcp.mjs', import.meta.url), 'utf8');
  assert.match(source, /UUID before the first send; reuse that ID for lookup or retry/);
});

test('EC06: an unverifiable lock owner is repaired offline, not through the stopped server', async t => {
  const f = await nativeFixture(t); fs.writeFileSync(path.join(f.root, 'state.lock'), '{}');
  const { withStateLockAsync } = await import('../lib/store.mjs');
  await assert.rejects(withStateLockAsync(f.root, () => {}), error => /offline lock recovery steps/.test(error.message) && !/bridge_doctor/.test(error.message));
  assert.match(fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /^### Offline lock recovery$/m);
  assert.equal(fs.readFileSync(path.join(f.root, 'state.lock'), 'utf8'), '{}');
});
