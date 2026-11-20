import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { canonicalClaudeSocket, discoverClaudeSessions, resolveClaudeCaller, resolveClaudeSession } from '../lib/claude-sessions.mjs';
import { getCodexHost, getCodexHosts, publishCodexHost } from '../lib/codex-host.mjs';
import { mockPipe, nativeFixture } from './native-helpers.mjs';

const windowsOnly = { skip: process.platform !== 'win32' && 'Native Claude Desktop process metadata is Windows-specific.' };
const processStart = process.platform === 'win32' ? '133700000000000000' : 'Thu Oct  8 02:03:04 2026';
const staleStart = 'Thu Oct  8 02:03:05 2026';
const localEndpoint = name => process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `/tmp/${name}.sock`;

async function callerFixture(t, entrypoint = 'claude-desktop') {
  const fixture = await nativeFixture(t);
  const registryDir = path.join(fixture.root, 'claude-registry');
  fs.mkdirSync(registryDir);
  const socketPath = localEndpoint(`cc-msg-${randomUUID().replaceAll('-', '')}`);
  const record = { pid: process.pid, sessionId: randomUUID(), entrypoint,
    procStart: processStart, pidDomain: process.platform === 'win32' ? `win32:${os.hostname().toLowerCase()}` : process.platform, messagingSocketPath: socketPath,
    cwd: fixture.cwd, name: 'Exact caller', version: '2.1.280', status: 'idle' };
  fs.writeFileSync(path.join(registryDir, `${record.pid}.json`), JSON.stringify(record));
  const hash = createHash('sha256').update(canonicalClaudeSocket(socketPath)).digest('hex');
  const keyPath = path.join(registryDir, `${record.pid}.${hash}.key`);
  const key = { peerToken: '1'.repeat(32), procStartFt: processStart, pidDomain: record.pidDomain };
  fs.writeFileSync(keyPath, JSON.stringify(key));
  const starts = new Map([[process.pid, processStart]]);
  const probe = async pid => starts.has(pid) ? { start: starts.get(pid) } : { missing: true };
  return { ...fixture, registryDir, record, socketPath, keyPath, key, starts, probe };
}

test('Claude caller matches the exact direct parent and validates its current process identity', windowsOnly, async t => {
  const setup = await callerFixture(t);
  const caller = await resolveClaudeCaller({ registryDir: setup.registryDir, probe: setup.probe, parentPid: process.pid });
  assert.equal(caller.sessionId, setup.record.sessionId);
  assert.equal(caller.pid, process.pid);
  assert.equal(caller.socketPath, canonicalClaudeSocket(setup.socketPath));
  assert.equal(caller.token, setup.key.peerToken);
  await assert.rejects(async () => resolveClaudeCaller({ registryDir: setup.registryDir, probe: setup.probe, parentPid: 2_147_483_647 }), /Cannot identify/);
  setup.key.procStartFt = '1';
  fs.writeFileSync(setup.keyPath, JSON.stringify(setup.key));
  await assert.rejects(async () => resolveClaudeCaller({ registryDir: setup.registryDir, probe: setup.probe, parentPid: process.pid }), /key does not match/);
});

test('terminal Claude Code sessions are discoverable and addressable like Desktop sessions', windowsOnly, async t => {
  const setup = await callerFixture(t, 'cli');
  const sessions = discoverClaudeSessions({ registryDir: setup.registryDir });
  assert.deepEqual(sessions.map(session => [session.sessionId, session.entrypoint]), [[setup.record.sessionId, 'cli']]);
  const endpoint = await resolveClaudeSession(setup.record.sessionId, { registryDir: setup.registryDir, probe: setup.probe });
  assert.equal(endpoint.socketPath, canonicalClaudeSocket(setup.socketPath));
  assert.equal(endpoint.token, setup.key.peerToken);
});

test('a terminal Claude Code caller is identified by its direct parent', windowsOnly, async t => {
  const setup = await callerFixture(t, 'cli');
  const caller = await resolveClaudeCaller({ registryDir: setup.registryDir, probe: setup.probe, parentPid: process.pid, socketPath: setup.socketPath });
  assert.equal(caller.sessionId, setup.record.sessionId);
  assert.equal(caller.entrypoint, 'cli');
});

test('sessions from other Claude entrypoints are not addressable', windowsOnly, async t => {
  const setup = await callerFixture(t, 'unsupported-cli');
  assert.deepEqual(discoverClaudeSessions({ registryDir: setup.registryDir }), []);
  await assert.rejects(async () => resolveClaudeSession(setup.record.sessionId, { registryDir: setup.registryDir, probe: setup.probe }), /unavailable or has no live inbox/);
  await assert.rejects(async () => resolveClaudeCaller({ registryDir: setup.registryDir, probe: setup.probe, parentPid: process.pid }), /not registered as a supported Claude Code client/);
});

test('Claude own socket must match its direct parent and cannot spoof another caller', windowsOnly, async t => {
  const setup = await callerFixture(t);
  const caller = await resolveClaudeCaller({ registryDir: setup.registryDir, probe: setup.probe, parentPid: process.pid,
    socketPath: setup.socketPath.toLowerCase() });
  assert.equal(caller.sessionId, setup.record.sessionId);
  await assert.rejects(async () => resolveClaudeCaller({ registryDir: setup.registryDir, probe: setup.probe, parentPid: 2_147_483_647,
    socketPath: setup.socketPath }), /Cannot identify/);
  await assert.rejects(async () => resolveClaudeCaller({ registryDir: setup.registryDir, probe: setup.probe, parentPid: process.pid,
    socketPath: '\\\\.\\pipe\\not-this-session' }), /exported to this bridge does not match/);
  await assert.rejects(async () => resolveClaudeCaller({ registryDir: setup.registryDir, probe: setup.probe, parentPid: process.pid,
    socketPath: 'https://example.invalid' }), /invalid messaging socket/);
});

test('a different process claiming the same socket cannot change the direct parent identity', windowsOnly, async t => {
  const setup = await callerFixture(t);
  setup.starts.set(process.ppid, '133700000000000001');
  fs.writeFileSync(path.join(setup.registryDir, `${process.ppid}.json`), JSON.stringify({
    ...setup.record, pid: process.ppid, sessionId: randomUUID(), procStart: '1',
  }));
  const caller = await resolveClaudeCaller({ registryDir: setup.registryDir, probe: setup.probe, parentPid: process.pid, socketPath: setup.socketPath });
  assert.equal(caller.sessionId, setup.record.sessionId);
  assert.equal(caller.pid, process.pid);
  await assert.rejects(async () => resolveClaudeCaller({ registryDir: setup.registryDir, probe: setup.probe, parentPid: process.ppid,
    socketPath: setup.socketPath }), /does not match its running process/);
});

test('Codex host publication is atomic, survives publisher exit without an arbitrary expiry, and drops vanished endpoints', async t => {
  const setup = await nativeFixture(t);
  const live = await mockPipe(t);
  const vanished = await mockPipe(t);
  assert.equal(getCodexHost({ stateDir: setup.stateDir }), null);
  const first = publishCodexHost({ stateDir: setup.stateDir, pipePath: live.pipePath, threadId: 'known-context' });
  assert.deepEqual(getCodexHost({ stateDir: setup.stateDir }), first);
  const file = path.join(setup.stateDir, 'codex-host.json');
  const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
  previous.pid = 2_147_483_647;
  previous.publishedAt = 1;
  fs.writeFileSync(file, JSON.stringify(previous));
  assert.equal(getCodexHost({ stateDir: setup.stateDir }).threadId, 'known-context');
  publishCodexHost({ stateDir: setup.stateDir, pipePath: vanished.pipePath, threadId: 'vanished-context' });
  await vanished.close();
  const second = publishCodexHost({ stateDir: setup.stateDir, pipePath: localEndpoint('codex-host-test-2'), threadId: 'new-context' });
  assert.deepEqual(getCodexHost({ stateDir: setup.stateDir }), second);
  assert.deepEqual(getCodexHosts({ stateDir: setup.stateDir }), [second, { ...first, pid: 2_147_483_647, publishedAt: 1 }]);
  assert.deepEqual(fs.readdirSync(setup.stateDir), ['codex-host.json']);
});

test('Codex host publication keeps a live pipe whose name Windows folds beyond ASCII', windowsOnly, async t => {
  const setup = await nativeFixture(t);
  const pipePath = `\\\\.\\pipe\\claude-codex-bridge-test-${randomUUID()}-Ä`;
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipePath, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  publishCodexHost({ stateDir: setup.stateDir, pipePath, threadId: 'unicode-context' });
  publishCodexHost({ stateDir: setup.stateDir, pipePath: localEndpoint('codex-host-test-2'), threadId: 'new-context' });
  assert.deepEqual(getCodexHosts({ stateDir: setup.stateDir }).map(host => host.threadId), ['new-context', 'unicode-context']);
});

test('Codex host publication retries Windows sharing contention', windowsOnly, async t => {
  const setup = await nativeFixture(t);
  const rename = fs.renameSync;
  let attempts = 0;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === path.join(setup.stateDir, 'codex-host.json') && attempts++ < 2) {
      throw Object.assign(new Error('Transient sharing violation'), { code: 'EPERM' });
    }
    return rename(source, destination);
  });
  const record = publishCodexHost({ stateDir: setup.stateDir, pipePath: localEndpoint('codex-host-test'), threadId: 'known-context' });
  assert.equal(attempts, 3);
  assert.deepEqual(getCodexHost({ stateDir: setup.stateDir }), record);
});

test('Codex host reader retries a replacement between stat and open', async t => {
  const setup = await nativeFixture(t);
  const record = publishCodexHost({ stateDir: setup.stateDir, pipePath: localEndpoint('codex-host-test'), threadId: 'known-context' });
  const registryFile = path.join(setup.stateDir, 'codex-host.json');
  const open = fs.openSync;
  let raced = false;
  t.mock.method(fs, 'openSync', (file, flags, mode) => {
    if (file === registryFile && !raced) {
      raced = true;
      throw Object.assign(new Error('Registry replaced'), { code: 'ENOENT' });
    }
    return open(file, flags, mode);
  });
  assert.deepEqual(getCodexHost({ stateDir: setup.stateDir }), record);
  assert.equal(raced, true);
});

test('Codex host rejects remote endpoints, invalid context, and malformed registry contents', async t => {
  const setup = await nativeFixture(t);
  const rejected = ['https://example.invalid', '\\\\remote\\pipe\\app', '\\\\.\\pipe\\trailing.'];
  if (process.platform === 'win32') rejected.push('/tmp/socket');
  else rejected.push('\\\\.\\pipe\\app', '/tmp/../app.sock', `/tmp/${'ж'.repeat(50)}.sock`);
  for (const pipePath of rejected) {
    assert.throws(() => publishCodexHost({ stateDir: setup.stateDir, pipePath, threadId: 'known' }), /named pipe/);
  }
  assert.throws(() => publishCodexHost({ stateDir: setup.stateDir, pipePath: localEndpoint('app'), threadId: '' }), /context task ID/);
  const valid = publishCodexHost({ stateDir: setup.stateDir, pipePath: localEndpoint('app'), threadId: 'known' });
  const file = path.join(setup.stateDir, 'codex-host.json');
  fs.writeFileSync(file, JSON.stringify({ ...valid, pipePath: '\\\\remote\\pipe\\app' }));
  assert.throws(() => getCodexHost({ stateDir: setup.stateDir }), /named pipe/);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => getCodexHost({ stateDir: setup.stateDir }), /Invalid Codex host registry JSON/);
  fs.writeFileSync(file, 'x'.repeat(20_000));
  assert.throws(() => getCodexHost({ stateDir: setup.stateDir }), /bounded regular file/);
});

test('Codex host returns only defined registry metadata', async t => {
  const setup = await nativeFixture(t);
  const valid = publishCodexHost({ stateDir: setup.stateDir, pipePath: localEndpoint('app'), threadId: 'known' });
  fs.writeFileSync(path.join(setup.stateDir, 'codex-host.json'), JSON.stringify({ ...valid, unrelated: 'ignore' }));
  assert.deepEqual(getCodexHost({ stateDir: setup.stateDir }), valid);
});

test('Claude socket canonicalization accepts normalized absolute Unix paths off Windows', { skip: process.platform === 'win32' }, () => {
  assert.equal(canonicalClaudeSocket('/tmp/cc-socks/123.sock'), '/tmp/cc-socks/123.sock');
  assert.equal(canonicalClaudeSocket('/tmp/cc-socks/../123.sock'), null);
  assert.equal(canonicalClaudeSocket('/tmp/cc-socks/'), null);
  assert.equal(canonicalClaudeSocket('relative/123.sock'), null);
  assert.equal(canonicalClaudeSocket(`/tmp/${'a'.repeat(120)}.sock`), null);
  assert.equal(canonicalClaudeSocket('/tmp/x\n.sock'), null);
});

test('macOS Claude inbox keys resolve only with the live UTC process token and local domain', { skip: process.platform !== 'darwin' }, async t => {
  const setup = await callerFixture(t);
  const record = { ...setup.record, entrypoint: 'claude-desktop', pidDomain: 'darwin', pid: process.pid };
  fs.writeFileSync(path.join(setup.registryDir, `${record.pid}.json`), JSON.stringify(record));
  const hash = createHash('sha256').update(canonicalClaudeSocket(record.messagingSocketPath)).digest('hex');
  const keyPath = path.join(setup.registryDir, `${record.pid}.${hash}.key`);
  fs.writeFileSync(keyPath, JSON.stringify({ peerToken: '2'.repeat(32), procStart: record.procStart, pidDomain: 'darwin' }));
  assert.equal((await resolveClaudeSession(record.sessionId, { registryDir: setup.registryDir, probe: setup.probe })).token, '2'.repeat(32));
  fs.writeFileSync(keyPath, JSON.stringify({ peerToken: '2'.repeat(32), procStart: 'other', pidDomain: 'darwin' }));
  await assert.rejects(async () => resolveClaudeSession(record.sessionId, { registryDir: setup.registryDir, probe: setup.probe }), /key does not match/);
  fs.writeFileSync(path.join(setup.registryDir, `${record.pid}.json`), JSON.stringify({ ...record, procStart: staleStart }));
  fs.writeFileSync(keyPath, JSON.stringify({ peerToken: '2'.repeat(32), procStart: staleStart, pidDomain: 'darwin' }));
  await assert.rejects(async () => resolveClaudeSession(record.sessionId, { registryDir: setup.registryDir, probe: setup.probe }), /does not match its running process/);
  fs.writeFileSync(path.join(setup.registryDir, `${record.pid}.json`), JSON.stringify({ ...record, pidDomain: 'linux' }));
  fs.writeFileSync(keyPath, JSON.stringify({ peerToken: '2'.repeat(32), procStart: record.procStart, pidDomain: 'linux' }));
  await assert.rejects(async () => resolveClaudeSession(record.sessionId, { registryDir: setup.registryDir, probe: setup.probe }), /registration for another computer/);
});

test('Codex host registry accepts an absolute Unix socket endpoint off Windows', { skip: process.platform === 'win32' }, async t => {
  const fixture = await nativeFixture(t);
  const stateDir = path.join(fixture.root, 'state');
  publishCodexHost({ stateDir, pipePath: '/tmp/codex-browser-use/abc.sock', threadId: 'thread-1' });
  assert.equal(getCodexHost({ stateDir }).pipePath, '/tmp/codex-browser-use/abc.sock');
  assert.throws(() => publishCodexHost({ stateDir, pipePath: '/tmp/../x.sock', threadId: 'thread-1' }), /named pipe or absolute Unix socket/);
  assert.throws(() => publishCodexHost({ stateDir, pipePath: 'relative.sock', threadId: 'thread-1' }), /named pipe or absolute Unix socket/);
});
