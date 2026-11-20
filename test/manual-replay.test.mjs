import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { manualSend, retryManualNotice } from '../lib/manual-service.mjs';
import { createSession, finishMessage, ledgerAt, recordMessage, routedRecord } from '../lib/store.mjs';
import { nativeFixture, mockPipe, encodeFrame, messageTool } from './native-helpers.mjs';

const windowsOnly = { skip: process.platform !== 'win32' && 'Manual native messaging requires verified Windows Desktop sessions.' };
const hash = value => createHash('sha256').update(value).digest('hex');
const direction = 'to_claude';
const changedText = 'A different manual message body.';

async function setup(t, { noticeFailure } = {}) {
  const fixture = await nativeFixture(t);
  const claude = await mockPipe(t);
  const notices = [];
  const failureMode = { current: noticeFailure };
  const codex = await mockPipe(t, { framed: true, onMessage(message, socket) {
    if (message.method === 'tools/list') {
      socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id,
        result: { tools: failureMode.current === 'schema' ? [] : [messageTool] } }));
      return;
    }
    notices.push(message.params);
    socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id, result: { success: true, contentItems: [] } }));
  } });
  const registryDir = path.join(fixture.root, 'registry');
  fs.mkdirSync(registryDir);
  const sessionId = randomUUID(), token = randomUUID().replaceAll('-', '');
  const procStart = '133700000000000000';
  const pidDomain = `win32:${os.hostname().toLowerCase()}`;
  fs.writeFileSync(path.join(registryDir, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId, name: 'Manual Claude fixture', cwd: fixture.cwd, entrypoint: 'claude-desktop',
    procStart, pidDomain, messagingSocketPath: claude.pipePath,
  }));
  const keyPath = path.join(registryDir, `${process.pid}.${hash(claude.pipePath.toLowerCase())}.key`);
  fs.writeFileSync(keyPath, JSON.stringify({ peerToken: token, procStartFt: procStart, pidDomain }));
  const owner = 'manual-owner-task';
  const env = { CODEX_APP_TOOLS_PIPE_PATH: codex.pipePath, CODEX_THREAD_ID: 'untrusted-startup-thread',
    CLAUDE_CODEX_BRIDGE_STATE_DIR: fixture.stateDir, CLAUDE_CODEX_BRIDGE_REGISTRY_DIR: registryDir };
  const processProbe = async pid => pid === process.pid ? { start: procStart } : { missing: true };
  const context = { env, processProbe, metadata: { 'x-codex-turn-metadata': { thread_id: owner } } };
  const ids = { session_id: sessionId, message_id: 'manual-fixture-one' };
  const args = { ...ids, message: 'Full user text: Unicode 🦊\nSecond line.' };
  const route = { from: { kind: 'codex', id: owner }, to: { kind: 'claude', id: sessionId } };
  const ledgerFile = path.join(fixture.stateDir, 'manual', hash(owner), 'state.json');
  const recordKey = hash(JSON.stringify([ids.session_id, ids.message_id]));
  return { ...fixture, claude, codex, notices, failureMode, owner, args, ids, context, route, ledgerFile, recordKey };
}

const ownerLedger = fixture => ({ stateDir: fixture.stateDir, threadId: fixture.owner });
const primary = fixture => routedRecord(ownerLedger(fixture), fixture.route, fixture.ids.message_id);
const fingerprint = (fixture, message) => hash(JSON.stringify({ direction, message, route: fixture.route }));
const writeLedger = (fixture, ledger) => fs.writeFileSync(fixture.ledgerFile, JSON.stringify(ledger, null, 2) + '\n');

function seedSupplementary(fixture, fields) {
  const now = Date.now();
  const row = { ...fixture.ids, fingerprint: fingerprint(fixture, fixture.args.message), manual: true,
    createdAt: now, updatedAt: now, ...fields };
  fs.mkdirSync(path.dirname(fixture.ledgerFile), { recursive: true });
  writeLedger(fixture, { schemaVersion: 1, owner_thread_id: fixture.owner, records: { [fixture.recordKey]: row } });
}

function editSupplementary(fixture, edit) {
  const ledger = JSON.parse(fs.readFileSync(fixture.ledgerFile, 'utf8'));
  edit(ledger.records[fixture.recordKey]);
  writeLedger(fixture, ledger);
  return fs.readFileSync(fixture.ledgerFile);
}

function transportCounts({ claude, codex, notices }) {
  return { claudeConnections: claude.connections.length, claudeFrames: claude.messages.length,
    codexConnections: codex.connections.length, codexFrames: codex.messages.length, notices: notices.length };
}

const noTransport = { claudeConnections: 0, claudeFrames: 0, codexConnections: 0, codexFrames: 0, notices: 0 };

async function retryFixture(t) {
  const fixture = await setup(t, { noticeFailure: 'schema' });
  const first = await manualSend(fixture.args, fixture.context);
  assert.equal(first.delivery.status, 'submitted');
  assert.equal(first.notice_status, 'failed');
  assert.equal(first.notice_retryable, true);
  fixture.failureMode.current = null;
  await turn();
  return fixture;
}

test('MU29: replay leaves a live pending notice claim alone', windowsOnly, async t => {
  const fixture = await setup(t);
  const session = createSession({ ...ownerLedger(fixture), cwd: fixture.cwd });
  const { message } = recordMessage(session, { id: fixture.ids.message_id, direction, message: fixture.args.message,
    route: fixture.route, manual: true });
  finishMessage(session, message.id, { route: fixture.route, status: 'submitted', attemptId: message.attemptId });
  // A different runtime's writer ID sharing this live PID is not interrupted.
  seedSupplementary(fixture, { send_status: 'submitted', notice_status: 'pending', notice_attempted: true,
    notice_retryable: false, sender_pid: process.pid, writer_id: randomUUID(), attempt_id: randomUUID() });
  const before = fs.readFileSync(fixture.ledgerFile);

  const replay = await manualSend(fixture.args, fixture.context);
  assert.equal(replay.delivery.status, 'submitted');
  assert.equal(replay.notice_status, 'pending');
  await turn();
  assert.deepEqual(transportCounts(fixture), noTransport);
  assert.deepEqual(fs.readFileSync(fixture.ledgerFile), before);
});

test('MU27: submitted primary binds text even without the supplementary row', windowsOnly, async t => {
  const fixture = await setup(t);
  const first = await manualSend(fixture.args, fixture.context);
  assert.equal(first.delivery.status, 'submitted');
  assert.equal(first.notice_status, 'submitted');
  fs.unlinkSync(fixture.ledgerFile);
  const saved = primary(fixture);
  assert.equal(saved.message, fixture.args.message);
  await turn();
  const counts = transportCounts(fixture);

  await assert.rejects(manualSend({ ...fixture.args, message: changedText }, fixture.context), /another recipient or message text/);
  assert.equal(fs.existsSync(fixture.ledgerFile), false);
  assert.deepEqual(primary(fixture), saved);
  await turn();
  assert.deepEqual(transportCounts(fixture), counts);
});

test('MU28: abandoned supplementary reservation still binds the original text', windowsOnly, async t => {
  const fixture = await setup(t);
  seedSupplementary(fixture, { send_status: 'sending', notice_status: 'pending', notice_attempted: false,
    sender_pid: 2_147_483_647 });
  const before = fs.readFileSync(fixture.ledgerFile);

  await assert.rejects(manualSend({ ...fixture.args, message: changedText }, fixture.context), {
    reason: 'id_conflict', message: /another message text/,
  });
  assert.deepEqual(fs.readFileSync(fixture.ledgerFile), before);
  assert.equal(fs.existsSync(ledgerAt(ownerLedger(fixture)).stateFile), false);
  await turn();
  assert.deepEqual(transportCounts(fixture), noTransport);
});

test('MU31: notice retry requires an explicit true marker', windowsOnly, async t => {
  for (const marker of [false, undefined, true]) {
    await t.test(marker === undefined ? 'missing' : String(marker), async sub => {
      const fixture = await retryFixture(sub);
      const counts = transportCounts(fixture);
      if (marker === true) {
        const retried = await retryManualNotice(fixture.ids, fixture.context);
        assert.equal(retried.notice_status, 'submitted');
        assert.equal(fixture.notices.length, counts.notices + 1);
        assert.equal(fixture.claude.messages.length, counts.claudeFrames);
        return;
      }
      const before = editSupplementary(fixture, row => {
        if (marker === undefined) delete row.notice_retryable;
        else row.notice_retryable = marker;
      });

      await assert.rejects(retryManualNotice(fixture.ids, fixture.context), /not safely retryable/);
      assert.deepEqual(fs.readFileSync(fixture.ledgerFile), before);
      await turn();
      assert.deepEqual(transportCounts(fixture), counts);
    });
  }
});

test('MU32: notice retry refuses a conflicting supplementary fingerprint', windowsOnly, async t => {
  const fixture = await retryFixture(t);
  const counts = transportCounts(fixture);
  const primaryFile = ledgerAt(ownerLedger(fixture)).stateFile;
  const bodyFile = path.join(path.dirname(fixture.ledgerFile), `body-${fixture.recordKey}.json`);
  const bodyBefore = fs.readFileSync(bodyFile);
  const wrongFingerprint = fingerprint(fixture, changedText);
  const before = editSupplementary(fixture, row => { row.fingerprint = wrongFingerprint; });

  async function assertRefused() {
    const primaryBefore = fs.readFileSync(primaryFile);
    await assert.rejects(retryManualNotice(fixture.ids, fixture.context), {
      message: 'Only a confirmed submitted manual message from this Codex task can retry its owner notice.',
    });
    assert.deepEqual(fs.readFileSync(fixture.ledgerFile), before);
    assert.deepEqual(fs.readFileSync(primaryFile), primaryBefore);
    assert.deepEqual(fs.readFileSync(bodyFile), bodyBefore);
    await turn();
    assert.deepEqual(transportCounts(fixture), counts);
  }
  await assertRefused();

  // Matching ledger fingerprints still cannot authorize retry if the saved text disagrees.
  // This separately exercises the text check, which the primary fingerprint guard masks above.
  const state = JSON.parse(fs.readFileSync(primaryFile, 'utf8'));
  const [record] = Object.values(state.messages);
  assert.equal(record.message, fixture.args.message);
  record.fingerprint = wrongFingerprint;
  fs.writeFileSync(primaryFile, JSON.stringify(state));
  await assertRefused();
});
