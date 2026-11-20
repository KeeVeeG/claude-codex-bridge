import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { executeBridgeTool } from '../lib/bridge-service.mjs';
import { canonicalClaudeSocket } from '../lib/claude-sessions.mjs';
import { publishCodexHost } from '../lib/codex-host.mjs';
import { manualSend, readManualRecords, retryManualNotice } from '../lib/manual-service.mjs';
import { fakeDaemon, fakeQueue } from './codex-daemon-helpers.mjs';
import { encodeFrame, messageTool, mockPipe, nativeFixture } from './native-helpers.mjs';
import { sshFixture } from './ssh-helpers.mjs';

const nativeOnly = { skip: !['win32', 'darwin'].includes(process.platform) && 'Requires native Claude caller identity.' };
const target = '01a13000-abcd-7000-8000-000000000001';
const owner = 'fixture-desktop-owner';
const start = process.platform === 'win32' ? '133700000000000000' : 'Thu Oct  8 02:03:04 2026';

async function actor(t) {
  const { root, stateDir, cwd } = await nativeFixture(t);
  const inbox = await mockPipe(t);
  const sessionId = randomUUID();
  const pidDomain = process.platform === 'win32' ? `win32:${os.hostname().toLowerCase()}` : 'darwin';
  const registryDir = path.join(root, 'registry');
  fs.mkdirSync(registryDir);
  fs.writeFileSync(path.join(registryDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId,
    messagingSocketPath: inbox.pipePath, entrypoint: 'claude-desktop', cwd, procStart: start, pidDomain }));
  const hash = createHash('sha256').update(canonicalClaudeSocket(inbox.pipePath)).digest('hex');
  fs.writeFileSync(path.join(registryDir, `${process.pid}.${hash}.key`), JSON.stringify({ peerToken: 'a'.repeat(32),
    [process.platform === 'win32' ? 'procStartFt' : 'procStart']: start, pidDomain }));
  const context = { stateDir, registryDir, parentPid: process.pid, processProbe: async () => ({ start }), env: {} };
  return { context, inbox, sessionId };
}

async function desktop(t, actor, mutationReply) {
  const listTool = { name: 'list_threads', namespace: messageTool.namespace };
  const receipt = { success: true, contentItems: [] };
  const pipe = await mockPipe(t, { framed: true, onMessage(request, socket) {
    const reply = fields => socket.write(encodeFrame({ jsonrpc: '2.0', id: request.id, ...fields }));
    if (request.method === 'tools/list') reply({ result: { tools: [messageTool, listTool] } });
    else if (request.params.tool === 'list_threads') reply({ result: { success: true,
      contentItems: [{ type: 'inputText', text: JSON.stringify({ threads: [{ id: owner, kind: 'codex' }] }) }] } });
    else if (mutationReply) mutationReply(request, reply, receipt, socket);
    else reply({ result: receipt });
  } });
  publishCodexHost({ stateDir: actor.context.stateDir, pipePath: pipe.pipePath, threadId: owner });
  return { ...pipe, writes: () => pipe.messages.filter(({ message }) => message.params?.tool === messageTool.name)
    .map(({ message }) => message.params.arguments.threadId) };
}

const send = (context, messageId, transport = 'auto') => executeBridgeTool('send_to_codex', {
  thread_id: target, message: 'Transport fixture input', message_id: messageId, transport,
}, context);
const mutations = requests => requests.filter(({ method }) => /^turn\/(start|steer)$/.test(method))
  .map(({ method, params }) => [method, params.threadId]);

async function settled(context, id, expected, sendAttempt = send(context, id)) {
  await assert.rejects(sendAttempt, error => {
    assert.deepEqual(error.outcome, { ...expected, record: { message_id: id,
      status: expected.delivered === false ? 'failed' : 'uncertain' } }, error.message);
    return true;
  });
  const { deliveries } = await executeBridgeTool('list_deliveries', {}, context);
  assert.deepEqual(deliveries.map(({ message_id, status }) => [message_id, status]),
    [[id, expected.delivered === false ? 'failed' : 'uncertain']]);
}
const uncertain = { delivered: 'unknown', reason: 'delivery_unconfirmed', retry: 'inspect' };
const unavailable = { delivered: false, reason: 'target_unavailable', retry: 'after_fix' };

for (const turnKind of ['review', 'compact']) {
  test(`K02: a verified ${turnKind} steer refusal is retryable as busy, never a new turn`, nativeOnly, async t => {
    const caller = await actor(t), app = await desktop(t, caller), queue = await fakeQueue(t);
    const data = { codexErrorInfo: { activeTurnNotSteerable: { turnKind } } };
    const daemon = await fakeDaemon(t, { threads: [{ id: target, status: { type: 'active' },
      turns: [{ id: 'running-turn', status: 'inProgress' }], becomesIdleAfterSteer: true }],
    errors: { 'turn/steer': { code: -32600, message: 'Active turn is not steerable', data } } });
    const context = { ...caller.context, daemon: daemon.daemon, queue: queue.queue };
    let detail;
    const attempt = send(context, 'busy', 'terminal').catch(error => { detail = error.rpcData; throw error; });
    await settled(context, 'busy', { delivered: false, reason: 'target_busy', retry: 'same_id' }, attempt);
    assert.deepEqual(detail, data);
    assert.deepEqual(mutations(daemon.requests()), [['turn/steer', target]]);
    assert.deepEqual(app.messages, []);
    assert.deepEqual(queue.queueCalls(), []);
  });
}

test('X01: Desktop ignores a same-ID server request, then honors a verified dispatcher refusal', nativeOnly, async t => {
  const caller = await actor(t);
  const app = await desktop(t, caller, (_request, reply, receipt) => {
    reply({ method: 'server/query', result: receipt });
    reply({ error: { code: -32602, message: 'Invalid app tool request' } });
  });
  await settled(caller.context, 'same-id', { delivered: false, reason: 'request_rejected', retry: 'after_fix' },
    send(caller.context, 'same-id', 'desktop'));
  assert.deepEqual(app.writes(), [target]);
});

for (const [name, fields] of Object.entries({
  'string ID': request => ({ id: String(request.id), result: { success: true, contentItems: [] } }),
  'two outcomes': () => ({ result: { success: true, contentItems: [] }, error: { code: -32602, message: 'Invalid app tool request' } }),
  'coerced error message': () => ({ error: { code: -32602, message: ['Invalid app tool request'] } }),
  'coerced error code': () => ({ error: { code: '-32602', message: 'Invalid app tool request' } }),
})) {
  test(`X01: Desktop cannot settle from a reply with ${name}`, nativeOnly, async t => {
    const caller = await actor(t);
    const app = await desktop(t, caller, (request, reply, _receipt, socket) => { reply(fields(request)); socket.end(); });
    const attempt = () => send(caller.context, 'bad-envelope', 'desktop');
    await settled(caller.context, 'bad-envelope', uncertain, attempt());
    await assert.rejects(attempt(), error => error.outcome.reason === 'prior_uncertain');
    assert.deepEqual(app.writes(), [target]);
  });
}

// The daemon and SSH clients speak the same app-server WebSocket dialect. Reuse the
// in-memory SSH peer as a fake local proxy for reply shapes the subprocess fixture cannot emit.
function daemonVia(t, peer) {
  const spawn = t.mock.method(childProcess, 'spawn', (...args) => {
    const child = peer.spawnImpl(...args);
    const write = child.stdin.write.bind(child.stdin);
    // Adapt the upgrade path and keep replies asynchronous like a subprocess.
    let upgrade = true;
    child.stdin.write = chunk => {
      const bytes = upgrade ? chunk.toString().replace(/^GET \/ HTTP/, 'GET /rpc HTTP') : chunk;
      upgrade = false;
      queueMicrotask(() => { if (!child.stdin.destroyed) write(bytes); });
      return true;
    };
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  return { command: 'fixture-proxy', args: [] };
}

function contradictoryTurn(peerError) {
  return sshFixture({ onTurn({ id }, child) {
    const body = Buffer.from(JSON.stringify({ id, result: { turn: { id: 'turn' } }, error: peerError }));
    assert.ok(body.length < 126);
    child.stdout.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
  } });
}

test('X01: contradictory daemon reply cannot prove a pre-acceptance refusal', nativeOnly, async t => {
  const caller = await actor(t);
  const peer = contradictoryTurn({ code: -32600, message: 'thread not found' });
  const context = { ...caller.context, daemon: daemonVia(t, peer) };
  await settled(context, 'daemon-envelope', uncertain);
  assert.deepEqual(mutations(peer.requests), [['turn/start', target]]);
});

test('X01: contradictory SSH reply with a null error cannot confirm a send', nativeOnly, async t => {
  const caller = await actor(t), app = await desktop(t, caller);
  const peer = contradictoryTurn(null);
  const context = { ...caller.context, platform: 'darwin', sshSpawn: peer.spawnImpl,
    env: { CLAUDE_CODEX_BRIDGE_SSH_HOST: 'fixture-ssh' } };
  await settled(context, 'ssh-envelope', uncertain);
  assert.deepEqual(mutations(peer.requests), [['turn/start', target]]);
  assert.deepEqual(app.messages, []);
});

test('A05: daemon turn/start without a turn id is uncertain and not sent again', nativeOnly, async t => {
  const caller = await actor(t), app = await desktop(t, caller);
  const peer = sshFixture({ malformedTurn: true });
  const context = { ...caller.context, daemon: daemonVia(t, peer) };
  await settled(context, 'missing-turn-id', uncertain);
  await assert.rejects(send(context, 'missing-turn-id'), error => error.outcome.reason === 'prior_uncertain');
  assert.deepEqual(mutations(peer.requests), [['turn/start', target]]);
  assert.deepEqual(app.messages, []);
});

test('A05: an internal thread/read error is not absence and cannot select Desktop', nativeOnly, async t => {
  const caller = await actor(t), app = await desktop(t, caller);
  const daemon = await fakeDaemon(t, { errors: { 'thread/read': { code: -32603, message: 'thread not found: internal database failure' } } });
  const context = { ...caller.context, daemon: daemon.daemon };
  await assert.rejects(send(context, 'read-failure'), error => error.rpcCode === -32603 && error.outcome.delivered === false);
  assert.deepEqual((await executeBridgeTool('list_deliveries', {}, context)).deliveries, []);
  assert.deepEqual(daemon.requests().filter(r => r.method.startsWith('thread/')).map(r => r.method), ['thread/read']);
  assert.deepEqual(mutations(daemon.requests()), []);
  assert.deepEqual(app.messages, []);
});

test('Q01: null Desktop content cannot make a written owner notice retryable', nativeOnly, async t => {
  const caller = await actor(t);
  const app = await desktop(t, caller, (_request, reply) => reply({ result: { success: false, contentItems: [null] } }));
  const context = { ...caller.context, metadata: { threadId: owner }, env: { CODEX_APP_TOOLS_PIPE_PATH: app.pipePath } };
  const ids = { session_id: caller.sessionId, message_id: 'owner-notice' };
  const result = await manualSend({ ...ids, message: 'Manual transport fixture' }, context);
  assert.equal(result.delivery.status, 'submitted');
  const [notice] = readManualRecords({ stateDir: context.stateDir, threadId: owner });
  assert.equal(notice.notice_status, 'uncertain');
  assert.equal(notice.notice_retryable, false);
  assert.match(notice.notice_error, /could not confirm delivery.*may (?:already )?have arrived/i);
  await assert.rejects(retryManualNotice(ids, context), /not safely retryable/);
  assert.deepEqual(app.writes(), [owner]);
  assert.equal(caller.inbox.messages.filter(({ message }) => message.type === 'user').length, 1);
});

test('E14: an unsuccessful Desktop tool result says unconfirmed, not rejected', nativeOnly, async t => {
  const caller = await actor(t);
  const app = await desktop(t, caller, (_request, reply) => reply({ result: { success: false,
    contentItems: [{ type: 'inputText', text: 'Tool could not answer' }] } }));
  const attempt = send(caller.context, 'unconfirmed-text', 'desktop').catch(error => {
    assert.match(error.message, /could not confirm delivery.*may (?:already )?have arrived/i);
    assert.doesNotMatch(error.message, /rejected|Message not sent/i);
    assert.equal(error.message.match(/before sending again|before retrying/g)?.length, 1);
    throw error;
  });
  await settled(caller.context, 'unconfirmed-text', uncertain, attempt);
  assert.deepEqual(app.writes(), [target]);
});

test('a verified SSH thread-not-found after the read is a definite failure, not a local fallback', nativeOnly, async t => {
  const caller = await actor(t), app = await desktop(t, caller);
  const peer = sshFixture({ unloadAfterRead: true });
  const context = { ...caller.context, platform: 'darwin', sshSpawn: peer.spawnImpl,
    env: { CLAUDE_CODEX_BRIDGE_SSH_HOST: 'fixture-ssh' } };
  await settled(context, 'ssh-missing', unavailable);
  assert.deepEqual(mutations(peer.requests), [['turn/start', target]]);
  assert.deepEqual(app.messages, []);
});
