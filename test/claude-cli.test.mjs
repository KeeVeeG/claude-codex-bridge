import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { canonicalClaudeSocket, discoverClaudeSessions, resolveClaudeCaller, resolveClaudeSession, sendToClaude } from '../lib/claude-sessions.mjs';
import { mockPipe, nativeFixture } from './native-helpers.mjs';

const nativeIdentityOnly = { skip: !['win32', 'darwin'].includes(process.platform) && 'Verified native Claude process identity supports Windows and macOS.' };
const processDomain = process.platform === 'win32' ? `win32:${os.hostname().toLowerCase()}` : 'darwin';
const keyStartField = process.platform === 'win32' ? 'procStartFt' : 'procStart';
const processStart = process.platform === 'win32' ? '133700000000000000' : 'Thu Oct  8 02:03:04 2026';
const otherStart = process.platform === 'win32' ? '133700000000000001' : 'Thu Oct  8 02:03:05 2026';
const socketName = () => process.platform === 'win32'
  ? `\\\\.\\pipe\\LOCAL\\cc-msg-${randomUUID().replaceAll('-', '')}`
  : `/tmp/cc-msg-${randomUUID()}.sock`;

async function fixture(t, { entrypoint = 'cli', socketPath } = {}) {
  const setup = await nativeFixture(t);
  const registryDir = path.join(setup.root, 'claude-registry');
  fs.mkdirSync(registryDir);
  socketPath ??= socketName();
  const record = { pid: process.pid, sessionId: randomUUID(), entrypoint,
    procStart: processStart, pidDomain: processDomain,
    messagingSocketPath: socketPath, cwd: setup.cwd, name: 'CLI fixture', status: 'idle', version: '2.1.299' };
  const recordPath = path.join(registryDir, `${record.pid}.json`);
  const keyPath = path.join(registryDir,
    `${record.pid}.${createHash('sha256').update(canonicalClaudeSocket(socketPath)).digest('hex')}.key`);
  const key = { peerToken: '1'.repeat(32), [keyStartField]: processStart, pidDomain: record.pidDomain };
  fs.writeFileSync(recordPath, JSON.stringify(record));
  fs.writeFileSync(keyPath, JSON.stringify(key));
  const rewrite = values => {
    Object.assign(record, values);
    fs.writeFileSync(recordPath, JSON.stringify(record));
  };
  const starts = new Map([[process.pid, processStart]]);
  const probe = async pid => starts.has(pid) ? { start: starts.get(pid) } : { missing: true };
  const resolve = (sessionId = record.sessionId) => resolveClaudeSession(sessionId, { registryDir, probe });
  const caller = options => resolveClaudeCaller({ registryDir, parentPid: process.pid, probe, ...options });
  return { ...setup, registryDir, record, recordPath, socketPath, keyPath, key, rewrite, starts, probe, resolve, caller };
}

function onOpen(t, callback) {
  const open = fs.openSync;
  const mock = t.mock.method(fs, 'openSync', (...args) => {
    callback(args[0]);
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

test('Claude discovery includes CLI and SDK CLI alongside Desktop and exposes only session metadata', async t => {
  const setup = await fixture(t);
  const desktop = { ...setup.record, pid: process.ppid, sessionId: randomUUID(), entrypoint: 'claude-desktop' };
  fs.writeFileSync(path.join(setup.registryDir, `${desktop.pid}.json`), JSON.stringify(desktop));
  fs.writeFileSync(path.join(setup.registryDir,
    `${desktop.pid}.${createHash('sha256').update(canonicalClaudeSocket(setup.socketPath)).digest('hex')}.key`), JSON.stringify(setup.key));
  for (const entrypoint of ['cli', 'sdk-cli', 'claude-vscode']) {
    setup.rewrite({ entrypoint });
    const sessions = discoverClaudeSessions({ registryDir: setup.registryDir });
    assert.equal(sessions.length, 2);
    assert.deepEqual(new Set(sessions.map(session => session.entrypoint)), new Set([entrypoint, 'claude-desktop']));
    assert.equal(sessions.find(session => session.sessionId === setup.record.sessionId).cwd, setup.cwd);
    assert.doesNotMatch(JSON.stringify(sessions), /peerToken|messagingSocketPath|socketPath|resolvedClaudeSession/);
    assert.ok(sessions.every(session => Object.getOwnPropertySymbols(session).length === 0));
  }
});

test('Claude discovery rejects unknown entrypoints even with a live parent and valid key', async t => {
  const setup = await fixture(t);
  for (const entrypoint of ['sdk', 'CLI', 'claude-desktop-other', '', null]) {
    setup.rewrite({ entrypoint });
    assert.deepEqual(discoverClaudeSessions({ registryDir: setup.registryDir }), []);
    await assert.rejects(async () => setup.resolve(), /unavailable/);
    await assert.rejects(async () => setup.caller(), /not registered as a supported Claude Code client/);
  }
});

test('Claude CLI and SDK CLI callers require their exact direct parent and matching exported inbox', nativeIdentityOnly, async t => {
  for (const entrypoint of ['cli', 'sdk-cli']) {
    await t.test(entrypoint, async sub => {
      const setup = await fixture(sub, { entrypoint });
      const caller = await setup.caller({ socketPath: setup.socketPath });
      assert.equal(caller.entrypoint, entrypoint);
      assert.equal(caller.sessionId, setup.record.sessionId);
      assert.equal(caller.token, setup.key.peerToken);
      await assert.rejects(async () => setup.caller({ parentPid: process.ppid, socketPath: setup.socketPath }), /Cannot identify/);
      await assert.rejects(async () => setup.caller({ socketPath: socketName() }), /exported to this bridge does not match/);
      setup.key[keyStartField] = '1';
      fs.writeFileSync(setup.keyPath, JSON.stringify(setup.key));
      await assert.rejects(async () => setup.caller(), /key does not match/);
    });
  }
});

test('CLI clear and resume follow the current exact session ID without retaining an old destination', nativeIdentityOnly, async t => {
  const setup = await fixture(t);
  const originalId = setup.record.sessionId;
  assert.equal((await setup.caller()).sessionId, originalId);
  const nextId = randomUUID();
  setup.rewrite({ sessionId: nextId });
  await assert.rejects(async () => setup.resolve(originalId), /unavailable/);
  assert.equal((await setup.caller()).sessionId, nextId);
  setup.rewrite({ sessionId: originalId });
  await assert.rejects(async () => setup.resolve(nextId), /unavailable/);
  assert.equal((await setup.caller()).sessionId, originalId);
});

test('a conversation open in two windows takes messages in the one used last, and each window can call the bridge', nativeIdentityOnly, async t => {
  const pipe = await mockPipe(t);
  const otherPipe = await mockPipe(t);
  const setup = await fixture(t, { socketPath: pipe.pipePath });
  const other = { ...setup.record, pid: process.ppid, entrypoint: 'claude-desktop', procStart: otherStart,
    messagingSocketPath: otherPipe.pipePath, name: 'Older window' };
  setup.starts.set(other.pid, otherStart);
  const otherKey = `${other.pid}.${createHash('sha256').update(canonicalClaudeSocket(other.messagingSocketPath)).digest('hex')}.key`;
  fs.writeFileSync(path.join(setup.registryDir, otherKey), JSON.stringify({ ...setup.key, peerToken: '2'.repeat(32), [keyStartField]: other.procStart }));
  const writeOther = values => fs.writeFileSync(path.join(setup.registryDir, `${other.pid}.json`), JSON.stringify(Object.assign(other, values)));
  // Status activity decides; a metadata-only update in the other window does not redirect (L04).
  writeOther({ statusUpdatedAt: 1000, updatedAt: 9000 });
  setup.rewrite({ statusUpdatedAt: 2000, updatedAt: 2000 });
  const endpoint = await setup.resolve();
  assert.equal(endpoint.pid, process.pid);
  assert.deepEqual(discoverClaudeSessions({ registryDir: setup.registryDir }).map(session => session.pid), [process.pid]);
  writeOther({ statusUpdatedAt: 3000 });
  assert.equal((await setup.resolve()).token, '2'.repeat(32));
  // A newer window whose inbox does not accept connections never takes the send from a working one (A09a).
  await otherPipe.close();
  assert.equal((await setup.resolve()).pid, process.pid);
  for (const pid of [process.pid, process.ppid]) {
    assert.equal((await setup.caller({ parentPid: pid })).pid, pid);
  }
  const receipt = await sendToClaude({ ...endpoint, probe: setup.probe, message: 'Stays with the window it was sent to' });
  assert.equal(receipt.status, 'written', 'the other window becoming active does not redirect a send under way');
});

test('resolving a CLI inbox revalidates registry identity changes during the key read', nativeIdentityOnly, async t => {
  const cases = {
    'unsupported entrypoint': { entrypoint: 'sdk' },
    'different supported entrypoint': { entrypoint: 'claude-desktop' },
    'session ID': { sessionId: randomUUID() },
    'process start': { procStart: otherStart },
    'process domain': { pidDomain: `${processDomain}-other` },
    'canonical socket': { messagingSocketPath: socketName() },
  };
  for (const [name, replacement] of Object.entries(cases)) {
    await t.test(name, async sub => {
      const setup = await fixture(sub);
      const selectedId = setup.record.sessionId;
      let changed = false;
      onOpen(sub, file => {
        if (file === setup.keyPath && !changed) {
          changed = true;
          setup.rewrite(replacement);
        }
      });
      await assert.rejects(setup.resolve(selectedId), /session changed while resolving/);
      assert.equal(changed, true);
    });
  }
});

test('a Windows socket case change during the key read still resolves the same inbox', { skip: process.platform !== 'win32' }, async t => {
  const setup = await fixture(t);
  const alternate = setup.socketPath.toLowerCase();
  assert.notEqual(alternate, setup.socketPath);
  let changed = false;
  onOpen(t, file => {
    if (file === setup.keyPath && !changed) {
      changed = true;
      setup.rewrite({ messagingSocketPath: alternate });
    }
  });
  const endpoint = await setup.resolve();
  assert.equal(changed, true);
  assert.equal(endpoint.socketPath, canonicalClaudeSocket(setup.socketPath));
  assert.equal(endpoint.token, setup.key.peerToken);
});

test('Claude caller and destination resolution require a 32-character lowercase hex inbox token', nativeIdentityOnly, async t => {
  const setup = await fixture(t);
  const valid = '0123456789abcdef'.repeat(2);
  const writeToken = peerToken => fs.writeFileSync(setup.keyPath, JSON.stringify({ ...setup.key, peerToken }));
  writeToken(valid);
  assert.equal((await setup.caller()).token, valid);
  assert.equal((await setup.resolve()).token, valid);

  for (const [name, token] of [
    ['short hex', valid.slice(1)],
    ['nonhex', 'g'.repeat(32)],
    ['uppercase hex', valid.toUpperCase()],
  ]) {
    await t.test(name, async () => {
      writeToken(token);
      await Promise.all([
        assert.rejects(setup.caller(), /inbox key of the chosen Claude session has an unsupported format/),
        assert.rejects(setup.resolve(), /inbox key of the chosen Claude session has an unsupported format/),
      ]);
    });
  }
});

test('a quoted bridge tag reaches Claude as written, except the envelope escape of its closing tag kept from 1.0 (M02)', nativeIdentityOnly, async t => {
  const pipe = await mockPipe(t);
  const setup = await fixture(t, { socketPath: pipe.pipePath });
  const quotedTag = 'See <cross-session-message from-name="Earlier">quoted</cross-session-message> above.';
  await sendToClaude({ ...await setup.resolve(), probe: setup.probe, message: quotedTag });
  const lines = pipe.messages[1].message.message.content.split('\n');
  assert.deepEqual([lines.length, lines[1]], [3, 'See <cross-session-message from-name="Earlier">quoted<\\/cross-session-message> above.']);
});

test('caller rejects an entrypoint replacement between matching the parent and resolving its inbox', nativeIdentityOnly, async t => {
  const setup = await fixture(t);
  let reads = 0;
  onOpen(t, file => {
    if (file === setup.recordPath && ++reads === 2) setup.rewrite({ entrypoint: 'claude-desktop' });
  });
  await assert.rejects(async () => setup.caller(), /caller changed/);
});

test('resolved Desktop and CLI endpoints preserve issue #1 and send only while the selected identity is current', nativeIdentityOnly, async t => {
  for (const entrypoint of ['claude-desktop', 'cli', 'sdk-cli']) {
    await t.test(entrypoint, async sub => {
      const pipe = await mockPipe(sub);
      const setup = await fixture(sub, { entrypoint, socketPath: pipe.pipePath });
      const endpoint = await setup.resolve();
      const receipt = await sendToClaude({ ...endpoint, probe: setup.probe, message: 'CLI transport fixture' });
      assert.equal(receipt.status, 'written');
      assert.equal(receipt.acknowledged, false);
      assert.equal(pipe.messages[1].message.session_id, setup.record.sessionId);
      assert.match(pipe.messages[1].message.message.content, /^<cross-session-message\b[^>]* from-mode="bypass">/);
      assert.equal(Object.hasOwn(pipe.messages[1].message, 'from-mode'), false, 'the classification belongs in the peer envelope, not the JSON frame');
      setup.rewrite({ sessionId: randomUUID() });
      await assert.rejects(sendToClaude({ ...endpoint, probe: setup.probe, message: 'Do not send to the replacement' }), error => {
        assert.equal(error.deliveryUnknown, false);
        return true;
      });
      assert.equal(pipe.messages.length, 2, 'the stale send must not write another auth or user frame');
    });
  }
});

test('a supplied token cannot override the resolved Claude destination token', nativeIdentityOnly, async t => {
  const pipe = await mockPipe(t);
  const setup = await fixture(t, { socketPath: pipe.pipePath });
  const endpoint = await setup.resolve();
  const send = { ...endpoint, message: 'fixture', probe: setup.probe };
  await assert.rejects(sendToClaude({ ...send, token: '2'.repeat(32) }), error => {
    assert.match(error.message, /destination differs/);
    assert.equal(error.deliveryUnknown, false);
    return true;
  });
  assert.deepEqual(pipe.messages, []);
  assert.equal((await sendToClaude(send)).status, 'written');
  assert.deepEqual(pipe.messages.map(({ message }) => message.type), ['auth', 'user']);
  assert.equal(pipe.messages[0].message.token, endpoint.token);
});

test('CLI destination changes after resolution fail before writing credentials or message bytes', nativeIdentityOnly, async t => {
  for (const change of ['session', 'entrypoint', 'process-start', 'domain', 'key-token', 'key-start', 'key-domain', 'socket']) {
    await t.test(change, async sub => {
      const pipe = await mockPipe(sub);
      const setup = await fixture(sub, { socketPath: pipe.pipePath });
      const endpoint = await setup.resolve();
      if (change === 'session') setup.rewrite({ sessionId: randomUUID() });
      else if (change === 'entrypoint') setup.rewrite({ entrypoint: 'claude-desktop' });
      else if (change === 'process-start') setup.rewrite({ procStart: '1' });
      else if (change === 'domain') setup.rewrite({ pidDomain: `${processDomain}:different-host` });
      else if (change === 'socket') setup.rewrite({ messagingSocketPath: socketName() });
      else {
        if (change === 'key-token') setup.key.peerToken = '2'.repeat(32);
        if (change === 'key-start') setup.key[keyStartField] = '1';
        if (change === 'key-domain') setup.key.pidDomain = `${processDomain}:different-host`;
        fs.writeFileSync(setup.keyPath, JSON.stringify(setup.key));
      }
      await assert.rejects(sendToClaude({ ...endpoint, probe: setup.probe, message: 'Must not reach a replacement conversation' }), error => {
        assert.equal(error.deliveryUnknown, false);
        assert.doesNotMatch(error.message, /11111111111111111111111111111111|22222222222222222222222222222222/);
        return true;
      });
      assert.equal(pipe.messages.length, 0);
    });
  }
});

test('a session resumed in another valid process cannot replace a resolved destination', nativeIdentityOnly, async t => {
  const pipe = await mockPipe(t);
  const setup = await fixture(t, { socketPath: pipe.pipePath });
  const endpoint = await setup.resolve();
  const start = otherStart;
  setup.starts.set(process.ppid, start);
  const replacement = { ...setup.record, pid: process.ppid, procStart: start };
  fs.unlinkSync(setup.recordPath);
  fs.writeFileSync(path.join(setup.registryDir, `${replacement.pid}.json`), JSON.stringify(replacement));
  fs.writeFileSync(path.join(setup.registryDir,
    `${replacement.pid}.${createHash('sha256').update(endpoint.socketPath).digest('hex')}.key`),
  JSON.stringify({ ...setup.key, [keyStartField]: start }));
  assert.equal((await setup.resolve(replacement.sessionId)).pid, process.ppid);
  await assert.rejects(sendToClaude({ ...endpoint, probe: setup.probe, message: 'Keep the original process identity' }), error => {
    assert.match(error.message, /destination changed/);
    assert.equal(error.deliveryUnknown, false);
    return true;
  });
  assert.equal(pipe.messages.length, 0);
});

test('CLI switch during socket connection is rejected before the payload write', nativeIdentityOnly, async t => {
  const pipe = await mockPipe(t);
  const setup = await fixture(t, { socketPath: pipe.pipePath });
  const endpoint = await setup.resolve();
  const connect = net.connect;
  let switched = false;
  const mock = t.mock.method(net, 'connect', (...args) => {
    const socket = connect(...args);
    socket.once('connect', () => {
      switched = true;
      setup.rewrite({ sessionId: randomUUID() });
    });
    return socket;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(sendToClaude({ ...endpoint, probe: setup.probe, message: 'Do not cross a clear/resume boundary' }), error => {
    assert.equal(error.deliveryUnknown, false);
    return true;
  });
  assert.equal(switched, true);
  assert.equal(pipe.messages.length, 0);
});
