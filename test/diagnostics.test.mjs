import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { executeBridgeTool } from '../lib/bridge-service.mjs';
import { canonicalClaudeSocket, resolveClaudeCaller, resolveClaudeSession, sendToClaude, probeClaudeInbox } from '../lib/claude-sessions.mjs';
import { listCodexTools, sendToCodex } from '../lib/codex-desktop.mjs';
import { getMessages, getSession } from '../lib/store.mjs';
import { getCodexHosts, publishCodexHost } from '../lib/codex-host.mjs';
import { encodeFrame, mockPipe, nativeFixture, messageTool } from './native-helpers.mjs';

const windowsOnly = { skip: process.platform !== 'win32' && 'Claude registry fixtures require Windows named pipes.' };
const nativeIdentityOnly = { skip: !['win32', 'darwin'].includes(process.platform) && 'Verified Claude processes require Windows or macOS.' };
const memoStart = process.platform === 'win32' ? '133700000000000000' : 'Thu Oct  8 02:03:04 2026';
const staleStart = process.platform === 'win32' ? '133700000000000001' : 'Thu Oct  8 02:03:05 2026';
const listTool = { name: 'list_threads', namespace: 'codex_app',
  inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } };

function answer(socket, id, result) {
  socket.write(encodeFrame({ jsonrpc: '2.0', id, result }));
}

async function claudeFixture(t, onMessage, { entrypoint = 'claude-desktop', procStart = memoStart } = {}) {
  const fixture = await nativeFixture(t);
  const inbox = await mockPipe(t, { onMessage });
  const registryDir = path.join(fixture.root, 'claude-registry');
  fs.mkdirSync(registryDir);
  const record = { pid: process.pid, sessionId: randomUUID(), entrypoint, procStart,
    pidDomain: process.platform === 'win32' ? `win32:${os.hostname().toLowerCase()}` : process.platform,
    messagingSocketPath: inbox.pipePath, cwd: fixture.cwd, name: 'Fixture Code session' };
  const token = '1234567890abcdef'.repeat(2);
  const recordPath = path.join(registryDir, `${record.pid}.json`);
  fs.writeFileSync(recordPath, JSON.stringify(record));
  const keyHash = createHash('sha256').update(canonicalClaudeSocket(inbox.pipePath)).digest('hex');
  fs.writeFileSync(path.join(registryDir, `${record.pid}.${keyHash}.key`), JSON.stringify({
    peerToken: token, [process.platform === 'win32' ? 'procStartFt' : 'procStart']: procStart, pidDomain: record.pidDomain,
  }));
  const processProbe = async pid => pid === record.pid ? { start: memoStart } : { missing: true };
  return { ...fixture, inbox, registryDir, record, recordPath, token, processProbe };
}

test('doctor reports missing configuration without registering a host or creating state', async t => {
  const fixture = await nativeFixture(t);
  const result = await executeBridgeTool('bridge_doctor', {}, { env: {}, stateDir: fixture.stateDir,
    registryDir: path.join(fixture.root, 'absent-registry'), parentPid: 2_147_483_647 });
  assert.equal(result.application, 'unknown');
  assert.equal(result.ready, false);
  assert.equal(result.checks.find(check => check.name === 'caller').status, 'fail');
  assert.equal(result.checks.find(check => check.name === 'state_directory').status, 'warning');
  assert.equal(fs.existsSync(fixture.stateDir), false);
  assert.doesNotMatch(JSON.stringify(result), /state_directory"\s*:\s*"|pipePath|socketPath|peerToken|procStart|pidDomain/);
  assert.ok(result.checks.every(check => Object.keys(check).sort().join(',') === 'detail,name,status'));
});

for (const entrypoint of ['claude-desktop', 'cli', 'sdk-cli']) test(`doctor validates ${entrypoint} endpoints without sending model messages and registers its verified Codex caller`, windowsOnly, async t => {
  const fixture = await claudeFixture(t, undefined, { entrypoint });
  const codex = await mockPipe(t, { framed: true, onMessage(message, socket) {
    if (message.method === 'tools/list') answer(socket, message.id, { tools: [messageTool, listTool] });
    else {
      assert.equal(message.params.tool, 'list_threads');
      answer(socket, message.id, { success: true, contentItems: [{ type: 'inputText',
        text: JSON.stringify({ threads: [] }) }] });
    }
  } });
  const context = { env: { CODEX_APP_TOOLS_PIPE_PATH: codex.pipePath },
    metadata: { 'openai/threadId': 'doctor-context' }, stateDir: fixture.stateDir, registryDir: fixture.registryDir, processProbe: fixture.processProbe };
  const result = await executeBridgeTool('bridge_doctor', {}, context);
  assert.equal(result.application, 'codex');
  assert.equal(result.ready, true);
  assert.equal(result.checks.find(check => check.name === 'claude_inbox').status, 'pass');
  assert.equal(getCodexHosts({ stateDir: fixture.stateDir })[0].threadId, 'doctor-context');
  assert.equal(fs.readdirSync(fixture.stateDir).some(name => /^[a-f0-9]{64}$/.test(name)), false, 'doctor creates no message ledger');
  assert.equal(fixture.inbox.messages.length, 0, 'connectivity probe sends no auth frame or user prompt');
  assert.equal(codex.messages.filter(entry => entry.message.method === 'tools/call').length, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.token));
  assert.ok(!JSON.stringify(result).includes(fixture.root));
});

test('doctor distinguishes malformed registries and unsupported native schemas safely', windowsOnly, async t => {
  const fixture = await nativeFixture(t);
  fs.mkdirSync(fixture.stateDir);
  fs.writeFileSync(path.join(fixture.stateDir, 'codex-host.json'), '{private malformed registry');
  const registryDir = path.join(fixture.root, 'registry-file');
  fs.writeFileSync(registryDir, 'private registry data');
  const codex = await mockPipe(t, { framed: true, onMessage(message, socket) {
    assert.equal(message.method, 'tools/list');
    answer(socket, message.id, { tools: [{ ...messageTool, inputSchema: { properties: { threadId: {} } } }, listTool] });
  } });
  const result = await executeBridgeTool('bridge_doctor', {}, { env: { CODEX_APP_TOOLS_PIPE_PATH: codex.pipePath },
    metadata: { 'openai/threadId': 'doctor-context' }, stateDir: fixture.stateDir, registryDir });
  for (const name of ['codex_registry', 'codex_tools', 'codex_context', 'claude_registry', 'claude_inbox']) {
    assert.equal(result.checks.find(check => check.name === name).status, 'fail', name);
  }
  assert.equal(result.ready, false);
  assert.doesNotMatch(JSON.stringify(result), /private malformed registry|private registry data/);
  assert.equal(fs.readFileSync(path.join(fixture.stateDir, 'codex-host.json'), 'utf8'), '{private malformed registry');
});

for (const entrypoint of ['claude-desktop', 'cli', 'sdk-cli']) test(`doctor verifies a ${entrypoint} caller without writing state`, windowsOnly, async t => {
  const fixture = await claudeFixture(t, undefined, { entrypoint });
  const result = await executeBridgeTool('bridge_doctor', {}, { env: { CLAUDE_CODE_MESSAGING_SOCKET: fixture.inbox.pipePath,
    CLAUDE_CODE_SESSION_ID: randomUUID() },
    parentPid: process.pid, stateDir: fixture.stateDir, registryDir: fixture.registryDir, processProbe: fixture.processProbe });
  assert.equal(result.application, 'claude');
  assert.equal(result.checks.find(check => check.name === 'caller').status, 'pass');
  assert.equal(result.checks.find(check => check.name === 'claude_inbox').status, 'pass');
  assert.equal(fs.existsSync(fixture.stateDir), false);
  assert.equal(fixture.inbox.messages.length, 0);
});

test('every caller and destination check asks the OS again (FB02)', nativeIdentityOnly, async t => {
  const fixture = await claudeFixture(t, undefined, { procStart: memoStart });
  const { registryDir, record } = fixture;
  let calls = 0;
  let start = memoStart;
  const probe = async () => { calls++; return { start }; };
  const resolveCaller = () => resolveClaudeCaller({ registryDir, parentPid: record.pid, socketPath: fixture.inbox.pipePath, probe });
  assert.equal((await resolveCaller()).sessionId, record.sessionId);
  assert.equal((await resolveCaller()).sessionId, record.sessionId);
  assert.equal(calls, 2, 'a confirmed caller is proved again on its next call');
  // The PID now belongs to another process: the next call sees it at once.
  start = staleStart;
  await assert.rejects(resolveCaller(), error => error.reason === 'caller_invalid' && /does not match its running process/.test(error.message));
  assert.equal(calls, 3);
  start = memoStart;
  const endpoint = await resolveClaudeSession(record.sessionId, { registryDir, probe });
  assert.equal(calls, 4);
  assert.equal((await sendToClaude({ ...endpoint, message: 'Fixture message', probe })).status, 'written');
  assert.equal(calls, 5, 'the pre-write destination check also asks the OS');
});

test('doctor warns a busy Claude caller to retry but fails a verified mismatch', nativeIdentityOnly, async t => {
  const fixture = await claudeFixture(t, undefined, { procStart: staleStart });
  let busy = true;
  let calls = 0;
  const processProbe = async () => {
    calls++;
    if (busy) throw Object.assign(new Error('fixture timeout'), { transient: true });
    return { start: memoStart };
  };
  const context = { ...claudeCaller(fixture), processProbe };
  const result = await executeBridgeTool('bridge_doctor', {}, context);
  assert.equal(result.application, 'claude');
  assert.equal(result.ready, false);
  assert.equal(calls, 3, 'doctor does not repeat the busy caller probe as an inbox check');
  for (const name of ['caller', 'claude_inbox']) {
    const check = result.checks.find(check => check.name === name);
    assert.equal(check.status, 'warning');
    assert.match(check.detail, /Could not verify this Claude Code conversation in time\. Retry the same call\./);
    assert.doesNotMatch(check.detail, /restart|reopen|fixture/i);
  }
  assert.deepEqual(result.issues.find(issue => issue.check === 'caller'), { check: 'caller', status: 'warning', reason: 'caller_unverified' });
  busy = false;
  const mismatch = await executeBridgeTool('bridge_doctor', {}, context);
  assert.equal(mismatch.checks.find(check => check.name === 'caller').status, 'fail');
  assert.equal(mismatch.issues.find(issue => issue.check === 'caller').reason, 'caller_invalid');
  assert.equal(fixture.inbox.messages.length, 0);
});

test('doctor reaches an older valid context after three removed Codex chats', windowsOnly, async t => {
  const fixture = await claudeFixture(t);
  const codex = await mockPipe(t, { framed: true, onMessage(message, socket) {
    if (message.method === 'tools/list') return answer(socket, message.id, { tools: [messageTool, listTool] });
    assert.equal(message.params.tool, 'list_threads');
    if (message.params.threadId !== 'retained-live-context') {
      socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id,
        error: { code: -32603, message: 'Codex app tool request failed' } }));
      return;
    }
    answer(socket, message.id, { success: true, contentItems: [{ type: 'inputText', text: '{"threads":[]}' }] });
  } });
  for (const threadId of ['retained-live-context', 'removed-a', 'removed-b', 'removed-c']) {
    publishCodexHost({ stateDir: fixture.stateDir, pipePath: codex.pipePath, threadId });
  }
  const saved = fs.readFileSync(path.join(fixture.stateDir, 'codex-host.json'));
  const result = await executeBridgeTool('bridge_doctor', {}, { stateDir: fixture.stateDir,
    registryDir: fixture.registryDir, processProbe: fixture.processProbe, parentPid: process.pid,
    env: { CLAUDE_CODE_MESSAGING_SOCKET: fixture.inbox.pipePath } });
  assert.equal(result.ready, true);
  assert.equal(result.checks.find(check => check.name === 'codex_context').status, 'pass');
  assert.deepEqual(fs.readFileSync(path.join(fixture.stateDir, 'codex-host.json')), saved);
  assert.equal(fixture.inbox.messages.length, 0);
});

test('doctor cancellation stops a stalled catalog probe after registering the caller', async t => {
  const fixture = await nativeFixture(t);
  const controller = new AbortController();
  const codex = await mockPipe(t, { framed: true, onMessage() { controller.abort('private cancellation reason'); } });
  await assert.rejects(executeBridgeTool('bridge_doctor', {}, { env: { CODEX_APP_TOOLS_PIPE_PATH: codex.pipePath },
    metadata: { 'openai/threadId': 'doctor-context' }, stateDir: fixture.stateDir,
    registryDir: path.join(fixture.root, 'absent'), signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError');
    assert.doesNotMatch(error.message, /private cancellation reason/);
    return true;
  });
  assert.equal(getCodexHosts({ stateDir: fixture.stateDir })[0].threadId, 'doctor-context');
  assert.equal(codex.messages.length, 1);
});

test('pre-cancelled transports never connect or write', async t => {
  const pipe = await mockPipe(t);
  const controller = new AbortController();
  controller.abort('private reason');
  for (const operation of [
    sendToClaude({ socketPath: pipe.pipePath, token: 'secret', message: 'no send', signal: controller.signal }),
    sendToCodex({ pipePath: pipe.pipePath, contextThreadId: 'context', threadId: 'destination', message: 'no send', signal: controller.signal }),
    probeClaudeInbox({ socketPath: pipe.pipePath, signal: controller.signal }),
  ]) {
    await assert.rejects(operation, error => {
      assert.equal(error.name, 'AbortError');
      assert.notEqual(error.deliveryUnknown, true);
      assert.doesNotMatch(error.message, /private reason/);
      return true;
    });
  }
  assert.equal(pipe.connections.length, 0);
});

test('Codex cancellation during catalog discovery sends no mutating request', async t => {
  const controller = new AbortController();
  const pipe = await mockPipe(t, { framed: true, onMessage(message) {
    assert.equal(message.method, 'tools/list');
    controller.abort();
  } });
  await assert.rejects(sendToCodex({ pipePath: pipe.pipePath, contextThreadId: 'context', threadId: 'destination',
    message: 'no send', signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError');
    assert.notEqual(error.deliveryUnknown, true);
    return true;
  });
  assert.equal(pipe.messages.length, 1);
});

test('Codex cancellation after a mutating transport write reports uncertain delivery and never retries', async t => {
  const controller = new AbortController();
  const pipe = await mockPipe(t, { framed: true, onMessage(message, socket) {
    if (message.method === 'tools/list') answer(socket, message.id, { tools: [messageTool] });
    else controller.abort();
  } });
  await assert.rejects(sendToCodex({ pipePath: pipe.pipePath, contextThreadId: 'context', threadId: 'destination',
    message: 'may already be delivered', signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.deliveryUnknown, true);
    assert.match(error.message, /may already have arrived/);
    return true;
  });
  assert.equal(pipe.messages.filter(entry => entry.message.method === 'tools/call').length, 1);
});

test('Claude cancellation after its user frame reports uncertain delivery without exposing credentials', async t => {
  const controller = new AbortController();
  const pipe = await mockPipe(t, { onMessage(message) {
    if (message.type === 'user') controller.abort('do not disclose');
  } });
  await assert.rejects(sendToClaude({ socketPath: pipe.pipePath, token: 'fixture secret', message: 'may already be delivered',
    signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.deliveryUnknown, true);
    assert.doesNotMatch(error.message, /fixture secret|do not disclose/);
    return true;
  });
  assert.equal(pipe.messages.filter(entry => entry.message.type === 'user').length, 1);
});

test('cancelled bridge sends retain an uncertain ledger and reject same-ID retry', windowsOnly, async t => {
  const controller = new AbortController();
  const fixture = await claudeFixture(t, message => {
    if (message.type === 'user') controller.abort();
  });
  const context = { env: { CODEX_APP_TOOLS_PIPE_PATH: '\\\\.\\pipe\\fixture-unused-codex' },
    metadata: { 'openai/threadId': 'sender-task' }, stateDir: fixture.stateDir, registryDir: fixture.registryDir, processProbe: fixture.processProbe,
    signal: controller.signal };
  const args = { session_id: fixture.record.sessionId, message: 'possible delivery', message_id: 'cancelled-send' };
  await assert.rejects(executeBridgeTool('send_to_claude', args, context), error => {
    assert.equal(error.outcome.delivered, 'unknown'); assert.equal(error.outcome.retry, 'inspect');
    return error.name === 'AbortError' && error.deliveryUnknown;
  });
  const ledger = getSession({ stateDir: fixture.stateDir, threadId: 'sender-task' });
  assert.equal(getMessages(ledger)[0].status, 'uncertain');
  await assert.rejects(executeBridgeTool('send_to_claude', args, { ...context, signal: undefined }), /uncertain delivery/);
  assert.equal(fixture.inbox.messages.filter(entry => entry.message.type === 'user').length, 1);
});

test('pre-cancelled bridge execution does not reserve a message or register its sender', async t => {
  const fixture = await nativeFixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executeBridgeTool('send_to_claude', { session_id: 'unused', message: 'no send' }, {
    env: { CODEX_APP_TOOLS_PIPE_PATH: '\\\\.\\pipe\\fixture-unused-codex' }, metadata: { 'openai/threadId': 'sender-task' },
    stateDir: fixture.stateDir, registryDir: path.join(fixture.root, 'absent'), signal: controller.signal,
  }), { name: 'AbortError' });
  assert.equal(fs.existsSync(fixture.stateDir), false);
});

test('catalog cancellation never reports message delivery uncertainty', async t => {
  const controller = new AbortController();
  const pipe = await mockPipe(t, { framed: true, onMessage() { controller.abort(); } });
  await assert.rejects(listCodexTools(pipe.pipePath, { signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError');
    assert.notEqual(error.deliveryUnknown, true);
    return true;
  });
});

function claudeCaller(fixture) {
  return { stateDir: fixture.stateDir, registryDir: fixture.registryDir, processProbe: fixture.processProbe, parentPid: process.pid,
    env: { CLAUDE_CODE_MESSAGING_SOCKET: fixture.inbox.pipePath, CLAUDE_CODEX_BRIDGE_DAEMON: 'off' },
    desktop: { catalogMs: 500, listMs: 400, budgetMs: 5000 } };
}

// A stalled Desktop keeps answering its catalog but never finishes list_threads, while a
// record of a long-gone launch fails instantly and would otherwise be the last error shown.
test('a stalled Desktop is reported as stalled, not hidden behind endpoints of earlier launches', windowsOnly, async t => {
  const fixture = await claudeFixture(t);
  const codex = await mockPipe(t, { framed: true, onMessage(message, socket) {
    if (message.method === 'tools/list') answer(socket, message.id, { tools: [messageTool, listTool] });
  } });
  for (const threadId of ['older-context', 'latest-context']) {
    publishCodexHost({ stateDir: fixture.stateDir, pipePath: codex.pipePath, threadId });
  }
  const earlier = await mockPipe(t);
  publishCodexHost({ stateDir: fixture.stateDir, pipePath: earlier.pipePath, threadId: 'earlier-launch' });
  await earlier.close();
  const context = claudeCaller(fixture);
  await assert.rejects(executeBridgeTool('list_codex_threads', { limit: 5 }, context), error => {
    assert.match(error.message, /running but did not answer in time. Retry the same call; restart Codex Desktop only if/);
    assert.match(error.message, /1 saved endpoint belongs to earlier Codex Desktop launches\./);
    assert.doesNotMatch(error.message, /ENOENT|Last error|Open a Codex Desktop task/);
    return true;
  });
  // Retry the repeatable read three times on the same pipe, not three times for each stale context.
  const calls = () => codex.messages.filter(entry => entry.message.method === 'tools/call').length;
  assert.equal(calls(), 3);
  const doctor = await executeBridgeTool('bridge_doctor', {}, context);
  const check = name => doctor.checks.find(entry => entry.name === name);
  assert.equal(check('codex_registry').status, 'pass');
  assert.match(check('codex_registry').detail, /2 of 3 point to an existing endpoint/);
  assert.equal(check('codex_tools').status, 'pass');
  assert.equal(check('codex_context').status, 'warning');
  assert.match(check('codex_context').detail, /did not answer in time. Retry the same call/);
  assert.equal(calls(), 6);
});

test('bridge_doctor from a Codex Desktop task registers its endpoint, as the recovery advice says', async t => {
  const fixture = await nativeFixture(t);
  const codex = await mockPipe(t, { framed: true });
  await executeBridgeTool('bridge_doctor', {}, { env: { CODEX_APP_TOOLS_PIPE_PATH: codex.pipePath, CLAUDE_CODEX_BRIDGE_DAEMON: 'off' },
    metadata: { 'openai/threadId': 'doctor-context' }, stateDir: fixture.stateDir, registryDir: path.join(fixture.root, 'absent') });
  assert.deepEqual(getCodexHosts({ stateDir: fixture.stateDir }).map(host => [host.pipePath, host.threadId]),
    [[codex.pipePath, 'doctor-context']]);
  assert.ok(codex.messages.every(entry => entry.message.method === 'tools/list'), 'registration and diagnostics send no model message');
});

test('only endpoints of earlier launches point to opening Codex Desktop', windowsOnly, async t => {
  const fixture = await claudeFixture(t);
  const earlier = await mockPipe(t);
  publishCodexHost({ stateDir: fixture.stateDir, pipePath: earlier.pipePath, threadId: 'earlier-launch' });
  await earlier.close();
  await assert.rejects(executeBridgeTool('list_codex_threads', {}, claudeCaller(fixture)),
    /1 saved endpoint belongs to earlier Codex Desktop launches\. Open a Codex Desktop task with the bridge enabled/);
});

test('a send reuses the context Desktop accepted earlier even while chat discovery stalls', windowsOnly, async t => {
  const fixture = await claudeFixture(t);
  let stalled = false;
  const codex = await mockPipe(t, { framed: true, onMessage(message, socket) {
    if (message.method === 'tools/list') return answer(socket, message.id, { tools: [messageTool, listTool] });
    if (message.params.tool !== 'list_threads') return answer(socket, message.id, { success: true, contentItems: [] });
    if (!stalled) answer(socket, message.id, { success: true, contentItems: [{ type: 'inputText',
      text: JSON.stringify({ threads: [{ id: 'target-task', kind: 'codex', title: 'Target' }] }) }] });
  } });
  publishCodexHost({ stateDir: fixture.stateDir, pipePath: codex.pipePath, threadId: 'host-context' });
  const context = claudeCaller(fixture);
  const listed = await executeBridgeTool('list_codex_threads', { limit: 5 }, context);
  assert.deepEqual(listed.threads.map(chat => chat.thread_id), ['target-task']);
  stalled = true;
  // Diagnosing the stall must not cost the context that sends still work with.
  await assert.rejects(executeBridgeTool('list_codex_threads', { limit: 5 }, context), /did not answer in time/);
  assert.equal((await executeBridgeTool('bridge_doctor', {}, context)).checks
    .find(entry => entry.name === 'codex_context').status, 'warning');
  const sent = await executeBridgeTool('send_to_codex', { thread_id: 'target-task', transport: 'desktop',
    message: 'Arrives while discovery stalls.' }, context);
  assert.equal(sent.delivery.status, 'submitted');
  const calls = codex.messages.filter(entry => entry.message.method === 'tools/call').map(entry => entry.message.params);
  assert.deepEqual(calls.map(call => call.tool), [...Array(7).fill('list_threads'), 'send_message_to_thread']);
  assert.equal(calls.at(-1).threadId, 'host-context');
  assert.equal(codex.messages.filter(entry => entry.message.method === 'tools/list').length, 4,
    'each call reads the catalog once and hands it to the tool call');
});

test('a wait the budget cut short is reported as unchecked, not as a stalled Desktop', windowsOnly, async t => {
  const fixture = await claudeFixture(t);
  const codex = await mockPipe(t, { framed: true, onMessage(message, socket) {
    if (message.method === 'tools/list') return answer(socket, message.id, { tools: [messageTool, listTool] });
    // A slow Desktop build: the removed context is rejected late and the valid one answers late too.
    if (message.params.threadId === 'removed-context') setTimeout(() => socket.write(encodeFrame({ jsonrpc: '2.0',
      id: message.id, error: { code: -32603, message: 'Codex app tool request failed' } })), 700);
    else setTimeout(() => answer(socket, message.id, { success: true,
      contentItems: [{ type: 'inputText', text: '{"threads":[]}' }] }), 950);
  } });
  for (const threadId of ['valid-context', 'removed-context']) {
    publishCodexHost({ stateDir: fixture.stateDir, pipePath: codex.pipePath, threadId });
  }
  const doctor = await executeBridgeTool('bridge_doctor', {}, { ...claudeCaller(fixture),
    desktop: { catalogMs: 500, listMs: 1000, budgetMs: 1500 } });
  const check = doctor.checks.find(entry => entry.name === 'codex_context');
  assert.equal(check.status, 'warning');
  assert.match(check.detail, /rejected 1 saved task context.*1 saved endpoint record could not be checked within 1\.5 s/);
  assert.doesNotMatch(check.detail, /restart/);
});
