// Field cases F02 and F03 rebuilt with temporary registries and stub endpoints, and the Claude
// discovery contracts of stage C2, each named by its finding ID.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { executeBridgeTool } from '../lib/bridge-service.mjs';
import { canonicalClaudeSocket, resolveClaudeSession } from '../lib/claude-sessions.mjs';
import { listClaudeConversations } from '../lib/claude-history.mjs';
import { getCodexHosts, publishCodexHost } from '../lib/codex-host.mjs';
import { fakeDaemon } from './codex-daemon-helpers.mjs';
import { encodeFrame, messageTool, mockPipe } from './native-helpers.mjs';

const native = { skip: !['win32', 'darwin'].includes(process.platform) && 'Verified native Claude process identity supports Windows and macOS.' };
const windows = process.platform === 'win32';
const pidDomain = windows ? `win32:${os.hostname().toLowerCase()}` : 'darwin';
const starts = { [process.pid]: windows ? '133700000000000000' : 'Thu Oct  8 02:03:04 2026',
  [process.ppid]: windows ? '133700000000000001' : 'Thu Oct  8 02:03:05 2026' };
const processProbe = async pid => starts[pid] ? { start: starts[pid] } : { missing: true };
const listTool = { name: 'list_threads', namespace: 'codex_app', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } };
const codexCaller = { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'codex-caller' }) };
const unusedPipe = () => windows ? `\\\\.\\pipe\\claude-codex-bridge-test-${randomUUID()}` : `/tmp/codex-claude-test-${randomUUID()}.sock`;

/** A temporary Claude registry and bridge state beside a Codex daemon that is not running. */
async function world(t) {
  const daemon = await fakeDaemon(t, { unreachable: true });
  const registryDir = path.join(daemon.root, 'claude-registry');
  fs.mkdirSync(registryDir);
  const context = { processProbe, registryDir, stateDir: daemon.stateDir, daemon: daemon.daemon, parentPid: process.pid,
    env: { CLAUDE_CODEX_BRIDGE_STATE_DIR: daemon.stateDir, CLAUDE_CODEX_BRIDGE_REGISTRY_DIR: registryDir } };
  return { ...daemon, registryDir, context };
}

/** Register one Claude window: its PID record and its inbox key (`key: false` publishes none). */
function claudeWindow(setup, { pid = process.pid, sessionId = randomUUID(), socketPath = unusedPipe(), key = true, ...fields } = {}) {
  const record = { pid, sessionId, entrypoint: 'cli', procStart: starts[pid], pidDomain, messagingSocketPath: socketPath,
    cwd: setup.cwd, name: 'Field fixture', status: 'idle', version: '2.1.300', ...fields };
  fs.writeFileSync(path.join(setup.registryDir, `${pid}.json`), JSON.stringify(record));
  const keyFile = path.join(setup.registryDir, `${pid}.${createHash('sha256').update(canonicalClaudeSocket(socketPath)).digest('hex')}.key`);
  const valid = { peerToken: (pid === process.pid ? '1' : '2').repeat(32), [windows ? 'procStartFt' : 'procStart']: starts[pid], pidDomain };
  if (key) fs.writeFileSync(keyFile, JSON.stringify(key === true ? valid : key));
  return { record, keyFile };
}

/** A running Codex Desktop app-tools pipe with a saved registration for `contextId`. */
async function desktopApp(t, stateDir, contextId, { tools = [messageTool, listTool],
  threads = [{ id: 'live-task', kind: 'codex', hostId: 'local', title: 'Live task' }] } = {}) {
  const sent = [];
  const answer = (socket, id, result) => socket.write(encodeFrame({ jsonrpc: '2.0', id, result }));
  const app = await mockPipe(t, { framed: true, onMessage(message, socket) {
    if (message.method === 'tools/list') return answer(socket, message.id, { tools });
    if (message.params.tool === 'list_threads') {
      const listing = { threads };
      return answer(socket, message.id, { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(listing) }] });
    }
    sent.push(message.params);
    answer(socket, message.id, { success: true, contentItems: [] });
  } });
  publishCodexHost({ stateDir, pipePath: app.pipePath, threadId: contextId });
  return { ...app, sent: () => sent };
}

/** Save a registration for a Desktop pipe that has since closed, as an earlier app launch leaves it. */
async function earlierLaunch(t, stateDir) {
  const pipe = await mockPipe(t, { framed: true });
  publishCodexHost({ stateDir, pipePath: pipe.pipePath, threadId: 'earlier-context' });
  await pipe.close();
  return pipe.pipePath;
}

const sendCodex = (setup, id, context = setup.context) =>
  executeBridgeTool('send_to_codex', { thread_id: 'live-task', message: 'hello', message_id: id }, context);

test('F02: a registration from an earlier Desktop launch beside the current one neither slows nor blocks discovery and sends', native, async t => {
  const setup = await world(t);
  const inbox = await mockPipe(t);
  claudeWindow(setup, { socketPath: inbox.pipePath });
  const live = await desktopApp(t, setup.stateDir, 'live-context');
  const earlier = await earlierLaunch(t, setup.stateDir);
  assert.deepEqual((await getCodexHosts({ stateDir: setup.stateDir })).map(host => host.threadId), ['earlier-context', 'live-context'],
    'the closed pipe is the newest saved record, as after the field restart');
  const started = performance.now();
  const listed = await executeBridgeTool('list_codex_threads', {}, setup.context);
  assert.deepEqual(listed.threads.map(chat => [chat.thread_id, chat.source]), [['live-task', 'desktop']]);
  assert.deepEqual(listed.warnings, []);
  const sent = await sendCodex(setup, 'f02-live');
  assert.equal(sent.delivery.status, 'submitted');
  assert.deepEqual(live.sent().map(params => params.arguments.threadId), ['live-task']);
  const report = await executeBridgeTool('bridge_doctor', {}, setup.context);
  assert.equal(report.checks.find(check => check.name === 'codex_context').status, 'pass');
  assert.ok(performance.now() - started < 5000, `took ${Math.round(performance.now() - started)} ms; the field calls took about 20 s`);
  assert.doesNotMatch(JSON.stringify([listed, sent, report]), /ENOENT/);
  assert.ok(!JSON.stringify(report).includes(earlier));
});

test('F02: with only an earlier launch, or no registration at all, discovery and sends name that cause at once', native, async t => {
  const setup = await world(t);
  const inbox = await mockPipe(t);
  claudeWindow(setup, { socketPath: inbox.pipePath });
  await assert.rejects(sendCodex(setup, 'f02-none'), error => error.outcome.reason === 'route_unavailable' &&
    /No Codex Desktop registration is in this bridge’s state directory\. Open a Codex Desktop task with the bridge enabled, then retry\./.test(error.message));
  const earlier = await earlierLaunch(t, setup.stateDir);
  const started = performance.now();
  const stale = /1 saved Codex Desktop endpoint belongs to earlier launches\. Open a Codex Desktop task with the bridge enabled; its bridge server registers the current endpoint when it starts\./;
  await assert.rejects(sendCodex(setup, 'f02-earlier'), error => error.outcome.reason === 'route_unavailable' &&
    stale.test(error.message) && !/ENOENT/.test(error.message) && !error.message.includes(earlier));
  await assert.rejects(executeBridgeTool('list_codex_threads', {}, setup.context), error => stale.test(error.message));
  assert.ok(performance.now() - started < 5000, `took ${Math.round(performance.now() - started)} ms`);
  assert.deepEqual((await executeBridgeTool('list_deliveries', {}, setup.context)).deliveries, [], 'nothing was reserved');
});

test('F03: one Claude conversation open in two windows; each window can list, send and pass its doctor checks', native, async t => {
  const setup = await world(t);
  const first = await mockPipe(t), second = await mockPipe(t);
  const { record } = claudeWindow(setup, { socketPath: first.pipePath, statusUpdatedAt: 1000 });
  claudeWindow(setup, { pid: process.ppid, sessionId: record.sessionId, socketPath: second.pipePath, entrypoint: 'claude-desktop', statusUpdatedAt: 2000 });
  const live = await desktopApp(t, setup.stateDir, 'live-context');
  for (const parentPid of [process.pid, process.ppid]) {
    const context = { ...setup.context, parentPid };
    assert.deepEqual((await executeBridgeTool('list_codex_threads', {}, context)).threads.map(chat => chat.thread_id), ['live-task']);
    const sent = await sendCodex(setup, `f03-${parentPid}`, context);
    assert.deepEqual([sent.delivery.status, sent.delivery.from.id], ['submitted', record.sessionId]);
    const report = await executeBridgeTool('bridge_doctor', {}, context);
    for (const name of ['caller', 'claude_registry', 'claude_inbox', 'codex_context']) {
      assert.equal(report.checks.find(check => check.name === name).status, 'pass', `${name} from window ${parentPid}`);
    }
    assert.equal(report.ready, true, JSON.stringify(report.checks.filter(check => check.status === 'fail')));
  }
  assert.equal(live.sent().length, 2);
});

test('a Desktop endpoint without a message tool never takes a send from a working one (X04)', native, async t => {
  const setup = await world(t);
  const inbox = await mockPipe(t);
  claudeWindow(setup, { socketPath: inbox.pipePath });
  const working = await desktopApp(t, setup.stateDir, 'working-context');
  const readOnly = await desktopApp(t, setup.stateDir, 'read-only-context', { tools: [listTool] });
  assert.deepEqual((await executeBridgeTool('list_codex_threads', {}, setup.context)).threads.map(chat => chat.thread_id), ['live-task']);
  assert.equal((await sendCodex(setup, 'x04')).delivery.status, 'submitted');
  assert.deepEqual(working.sent().map(params => params.arguments.threadId), ['live-task']);
  assert.deepEqual(readOnly.messages.map(entry => entry.message.method), ['tools/list', 'tools/list'], 'the read-only app is only asked for its tools');
});

test('an unassigned or parked Claude process is not offered or addressable as a conversation (L02)', native, async t => {
  const setup = await world(t);
  const spare = await mockPipe(t), parked = await mockPipe(t);
  const inactive = [claudeWindow(setup, { socketPath: spare.pipePath, spare: true }),
    claudeWindow(setup, { pid: process.ppid, socketPath: parked.pipePath, parkedJobId: 'job-1' })];
  assert.deepEqual(await executeBridgeTool('list_claude_sessions', {}, setup.context), { sessions: [] });
  for (const { record } of inactive) {
    await assert.rejects(resolveClaudeSession(record.sessionId, { registryDir: setup.registryDir, probe: processProbe }), error => error.reason === 'target_unavailable');
  }
  await assert.rejects(executeBridgeTool('list_deliveries', {}, setup.context), /unassigned or parked/);
});

test('a damaged Claude title, folder or status is shown as empty text, never as another type (Z03)', native, async t => {
  const setup = await world(t);
  const inbox = await mockPipe(t);
  claudeWindow(setup, { socketPath: inbox.pipePath, name: 0, cwd: { path: 'x' }, status: 7 });
  const [session] = (await executeBridgeTool('list_claude_sessions', {}, setup.context)).sessions;
  assert.deepEqual([session.title, session.cwd, session.status], ['', '', 'unknown']);
});

test('an unreadable Claude registration makes discovery report incompleteness instead of a definitive result (R03)', native, async t => {
  const setup = await world(t);
  const inbox = await mockPipe(t);
  const { record } = claudeWindow(setup, { socketPath: inbox.pipePath });
  fs.writeFileSync(path.join(setup.registryDir, `${process.ppid}.json`), `{"pid":${process.ppid},"sessionId":"trunc`);
  const listed = await executeBridgeTool('list_claude_sessions', {}, setup.context);
  assert.deepEqual(listed.sessions.map(session => session.session_id), [record.sessionId]);
  assert.deepEqual(listed.issues, [{ source: 'claude', reason: 'state_unavailable' }]);
  fs.rmSync(path.join(setup.registryDir, `${process.pid}.json`));
  await assert.rejects(resolveClaudeSession(randomUUID(), { registryDir: setup.registryDir, probe: processProbe }),
    error => error.reason === 'state_unavailable' && /could not be read/.test(error.message));
});

test('doctor names why a registered Claude inbox is unusable instead of advising a reopen (E08)', native, async t => {
  const cases = [
    [{ key: false }, /^The chosen Claude session has published no inbox key\. Check its Peer address in \/status\.$/],
    [{ key: {} }, /^The inbox key of the chosen Claude session has an unsupported format\. Update the bridge/],
    [{}, /^The selected Claude inbox did not accept a connection\. Check its Peer address in \/status\.$/],
  ];
  for (const [options, expected] of cases) {
    const setup = await world(t);
    claudeWindow(setup, options);
    const report = await executeBridgeTool('bridge_doctor', {}, { ...setup.context, metadata: codexCaller });
    const check = name => report.checks.find(item => item.name === name);
    assert.equal(check('claude_registry').status, 'pass');
    assert.match(check('claude_registry').detail, /inbox connectivity is checked separately/);
    assert.equal(check('claude_inbox').status, 'fail');
    assert.match(check('claude_inbox').detail, expected);
  }
});

/** Replace fs.readdirSync for the registry directory only; returns the number of scans so far. */
function registryScans(t, registryDir, fault = () => {}) {
  const readdir = fs.readdirSync;
  let scans = 0;
  const mock = t.mock.method(fs, 'readdirSync', (directory, ...rest) => {
    if (path.resolve(String(directory)) === path.resolve(registryDir)) { scans++; fault(directory); }
    return readdir(directory, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  return () => scans;
}

test('a Claude registry that cannot be scanned fails with its cause and never with its path (C03)', native, async t => {
  const setup = await world(t);
  const inbox = await mockPipe(t);
  const { record, keyFile } = claudeWindow(setup, { socketPath: inbox.pipePath });
  const context = { ...setup.context, metadata: codexCaller };
  const send = id => executeBridgeTool('send_to_claude', { session_id: record.sessionId, message: 'hello', message_id: id }, context);
  const pathFree = text => !text.includes(setup.registryDir) && !text.includes(`${record.pid}.json`);
  // The field reproduction: the PID file disappears during the pre-write key read.
  const open = fs.openSync;
  let keyReads = 0;
  const opened = t.mock.method(fs, 'openSync', (...args) => {
    if (args[0] === keyFile && ++keyReads === 2) fs.rmSync(path.join(setup.registryDir, `${record.pid}.json`));
    return open(...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(send('c03-removed'), error => error.outcome.reason === 'target_changed' && pathFree(error.message));
  opened.mock.restore();
  syncBuiltinESMExports();
  const [delivery] = (await executeBridgeTool('list_deliveries', {}, context)).deliveries;
  assert.equal(delivery.status, 'failed');
  assert.ok(pathFree(JSON.stringify(delivery)));
  // The registry directory itself goes away or is denied between its check and its scan.
  let code = 'ENOENT';
  registryScans(t, setup.registryDir, directory => {
    throw Object.assign(new Error(`${code}: scandir '${directory}'`), { code, syscall: 'scandir', path: directory });
  });
  await assert.rejects(send('c03-gone'), error => error.outcome.reason === 'target_unavailable' && pathFree(error.message));
  const gone = await executeBridgeTool('list_claude_sessions', {}, setup.context);
  assert.deepEqual(gone, { sessions: [], issues: [{ source: 'claude', reason: 'target_unavailable' }] });
  code = 'EACCES';
  await assert.rejects(send('c03-denied'), error => error.outcome.reason === 'state_unavailable' &&
    /The Claude session registry could not be read\. Check access to its configured directory\./.test(error.message) && pathFree(error.message));
});

test('doctor and discovery scan the Claude registry once per call (P04)', native, async t => {
  const setup = await world(t);
  const inbox = await mockPipe(t);
  claudeWindow(setup);
  claudeWindow(setup, { pid: process.ppid, socketPath: inbox.pipePath });
  const scans = registryScans(t, setup.registryDir);
  const report = await executeBridgeTool('bridge_doctor', {}, { ...setup.context, metadata: codexCaller });
  assert.deepEqual(['caller', 'claude_inbox'].map(name => report.checks.find(check => check.name === name).status), ['pass', 'pass']);
  assert.equal(scans(), 1, 'one scan serves every inbox check');
  assert.equal((await executeBridgeTool('list_claude_sessions', {}, setup.context)).sessions.length, 1);
  assert.equal(scans(), 2);
});

test('F02: a newer running Desktop with no chats does not hide the chats and the route of an older one', native, async t => {
  const setup = await world(t);
  const inbox = await mockPipe(t);
  claudeWindow(setup, { socketPath: inbox.pipePath });
  const older = await desktopApp(t, setup.stateDir, 'older-context');
  const newer = await desktopApp(t, setup.stateDir, 'newer-context', { threads: [] });
  const listed = await executeBridgeTool('list_codex_threads', {}, setup.context);
  assert.deepEqual(listed.threads.map(chat => [chat.thread_id, chat.source]), [['live-task', 'desktop']]);
  // The fixture has no Codex daemon, so only the terminal source reports an issue.
  assert.deepEqual([listed.warnings, listed.issues.filter(issue => issue.source === 'desktop')], [[], []]);
  assert.equal((await sendCodex(setup, 'f02-older')).delivery.status, 'submitted');
  assert.deepEqual([older.sent().map(params => params.arguments.threadId), newer.sent()], [['live-task'], []]);
});

test('the conversation catalog offers a Claude registration as live only with a usable inbox key (E08)', native, async t => {
  const setup = await world(t);
  const keyless = claudeWindow(setup, { key: false });
  const keyed = claudeWindow(setup, { pid: process.ppid, name: 'Keyed window' });
  const projectsDir = path.join(setup.root, 'projects');
  fs.mkdirSync(projectsDir);
  const catalog = await listClaudeConversations({ projectsDir, registryDir: setup.registryDir, stateDir: setup.stateDir, ownerThreadId: 'catalog-owner' });
  assert.deepEqual(catalog.conversations.map(row => [row.session_id, row.live]), [[keyed.record.sessionId, true]]);
  assert.equal(catalog.conversations.some(row => row.session_id === keyless.record.sessionId), false);
});

test('the saved conversation catalog finds a conversation by its generated Claude title when it has no custom one (L05)', async t => {
  const setup = await world(t);
  fs.mkdirSync(setup.stateDir, { recursive: true });
  const project = path.join(setup.root, 'projects', 'encoded-project');
  fs.mkdirSync(project, { recursive: true });
  const write = (sessionId, records) => fs.writeFileSync(path.join(project, `${sessionId}.jsonl`),
    `${records.map(value => JSON.stringify({ sessionId, ...value })).join('\n')}\n`);
  const generated = randomUUID(), named = randomUUID();
  write(generated, [{ type: 'user', message: { content: 'PRIVATE PROMPT' } }, { type: 'ai-title', aiTitle: 'Generated title' }]);
  write(named, [{ type: 'ai-title', aiTitle: 'First generated' }, { type: 'custom-title', customTitle: 'Chosen title' }, { type: 'ai-title', aiTitle: 'Later generated' }]);
  const result = await listClaudeConversations({ projectsDir: path.join(setup.root, 'projects'), registryDir: setup.registryDir,
    stateDir: setup.stateDir, ownerThreadId: 'catalog-owner' });
  const titles = Object.fromEntries(result.conversations.map(row => [row.session_id, row.title]));
  assert.deepEqual(titles, { [generated]: 'Generated title', [named]: 'Chosen title' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE PROMPT/);
});
