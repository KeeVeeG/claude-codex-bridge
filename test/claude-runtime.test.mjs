import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalLocalSocket } from '../lib/local-socket.mjs';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { readProcessStart, stopProcessProbe, testing, verifyClaudeProcess } from '../lib/claude-process.mjs';
import { inquire, startCall } from '../lib/call-time.mjs';

test('Unix endpoint byte boundaries preserve exact addresses on each supported OS', () => {
  for (const [platform, maxBytes] of [['darwin', 103], ['linux', 107]]) {
    const exact = `/tmp/${'ж'.repeat((maxBytes - 5) / 2)}`;
    assert.equal(Buffer.byteLength(exact), maxBytes);
    assert.equal(canonicalLocalSocket(exact, platform), exact);
    assert.equal(canonicalLocalSocket(exact + 'a', platform), null);
    assert.equal(canonicalLocalSocket(`/tmp/${'ж'.repeat(50)}.sock`, platform), null);
  }
});

test('Unix endpoints reject foreign pipe syntax, aliases and malformed paths', () => {
  for (const platform of ['darwin', 'linux']) {
    for (const value of ['\\\\.\\pipe\\app', '//./pipe/app', '/tmp/../x.sock', '/tmp/./x.sock',
      '/tmp//x.sock', '/tmp/', '/', 'relative.sock', '/tmp/a\n.sock', '/tmp/a\0.sock', '', null]) {
      assert.equal(canonicalLocalSocket(value, platform), null, `${platform}: ${JSON.stringify(value)}`);
    }
    assert.equal(canonicalLocalSocket('/tmp/cc-socks/123.sock', platform), '/tmp/cc-socks/123.sock');
  }
  assert.equal(canonicalLocalSocket('/tmp/a.sock', 'freebsd'), null);
});

test('Windows pipe canonicalization remains case-insensitive and rejects Unix and remote endpoints', () => {
  assert.equal(canonicalLocalSocket('\\\\.\\pipe\\LOCAL\\Case', 'win32'), '\\\\.\\pipe\\local\\case');
  assert.equal(canonicalLocalSocket('//./pipe/Case', 'win32'), '\\\\.\\pipe\\case');
  for (const value of ['/tmp/a.sock', '\\\\remote\\pipe\\app', '\\\\.\\pipe\\trailing.', '\\\\.\\pipe\\..']) {
    assert.equal(canonicalLocalSocket(value, 'win32'), null);
  }
});

const darwinRecord = { pid: 123, pidDomain: 'darwin', procStart: 'Thu Oct  8 02:03:04 2026' };
const windowsRecord = { pid: 123, pidDomain: 'win32:fixture', procStart: '133700000000000000' };
const fixtureTimeout = () => Object.assign(new Error('fixture timeout'), { transient: true });

function counted(answer) {
  const probe = async (pid, options) => { probe.calls++; return answer(probe.calls, pid, options); };
  probe.calls = 0;
  return probe;
}

test('invalid identity metadata and foreign hosts fail before any process probe (MU03)', async () => {
  const cases = [['darwin', { ...darwinRecord, pidDomain: 'linux' }], ['darwin', { ...darwinRecord, pid: '123;bad' }],
    ['darwin', { ...darwinRecord, pid: -1 }], ['darwin', { ...darwinRecord, procStart: '' }],
    ['win32', { ...windowsRecord, pidDomain: 'win32:other' }], ['win32', { ...windowsRecord, procStart: 'Thu Oct  8 02:03:04 2026' }]];
  for (const [platform, record] of cases) {
    const probe = counted(() => assert.fail('Invalid identity must fail before probing'));
    await assert.rejects(verifyClaudeProcess(record, { platform, hostName: 'fixture', probe }),
      error => error.kind === 'invalid' && /another computer or has invalid creation metadata/.test(error.message));
    assert.equal(probe.calls, 0);
  }
});

test('unsupported operating systems cannot verify a Claude process and never fall back to PID liveness', async () => {
  for (const platform of ['linux', 'freebsd']) {
    const probe = counted(() => assert.fail('Unsupported process identity must not be probed'));
    await assert.rejects(verifyClaudeProcess({ ...darwinRecord, pidDomain: platform }, { platform, probe }),
      error => error.reason === 'identity_check_unavailable' && error.kind === 'unavailable');
    assert.equal(probe.calls, 0);
  }
});

for (const [platform, record, differentStart] of [
  ['win32', windowsRecord, '133700000000000001'],
  ['darwin', darwinRecord, 'Thu Oct  8 02:03:05 2026'],
]) {
  test(`${platform} reports an inconclusive probe as unverified after three attempts, never as changed`, async () => {
    for (const answer of [() => { throw fixtureTimeout(); }, () => ({ start: 'other-start' }), () => ({ start: ' \n' }), () => ({})]) {
      const probe = counted(answer);
      await assert.rejects(verifyClaudeProcess(record, { platform, hostName: 'fixture', probe }), error => {
        assert.equal(error.kind, 'unverified');
        assert.doesNotMatch(error.message, /changed|exited|offline|reopen|restart|fixture/i);
        return true;
      });
      assert.equal(probe.calls, 3);
    }
  });

  test(`${platform} retries an inconclusive probe and stops at the first definite answer`, async () => {
    for (const start of [record.procStart, differentStart]) {
      const probe = counted(calls => { if (calls === 1) throw fixtureTimeout(); return { start }; });
      const verify = verifyClaudeProcess(record, { platform, hostName: 'fixture', probe });
      if (start === record.procStart) await verify;
      else await assert.rejects(verify, error => error.kind === 'changed');
      assert.equal(probe.calls, 2);
    }
  });

  test(`${platform} fails a verified mismatch, an exited process and an unusable check at once`, async () => {
    for (const [answer, kind] of [[() => ({ start: differentStart }), 'changed'], [() => ({ missing: true }), 'exited'],
      [() => { throw Object.assign(new Error('fixture refused'), { permanent: true }); }, 'unavailable']]) {
      const probe = counted(answer);
      await assert.rejects(verifyClaudeProcess(record, { platform, hostName: 'fixture', probe }), error => error.kind === kind);
      assert.equal(probe.calls, 1, kind);
    }
  });
}

test('a hung process check ends with the call deadline, not after its own attempts (FB01)', async () => {
  const call = startCall({ deadlineMs: 300 });
  const probe = (pid, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(fixtureTimeout()), { once: true });
  });
  const started = performance.now();
  try {
    await assert.rejects(verifyClaudeProcess(windowsRecord, { platform: 'win32', hostName: 'fixture', probe, signal: call.signal }),
      error => error.code === 'BRIDGE_DEADLINE');
  } finally { call.dispose(); }
  assert.ok(performance.now() - started < 2000, 'the probe is abandoned at the deadline');
});

/** A scripted PowerShell helper: `reply(pid)` returns the line it prints, or null to stay silent. */
function fakeHelper(reply) {
  const spawned = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.stdin = new EventEmitter();
    child.stdin.write = line => {
      const answer = reply(Number(line.trim()));
      if (answer !== null) queueMicrotask(() => child.stdout.emit('data', `${answer}\r\n`));
    };
    child.stdin.end = () => {};
    spawned.push({ command, args, options, child });
    queueMicrotask(() => child.stdout.emit('data', 'R\r\n'));
    return child;
  };
  return { spawned, helper: new testing.WindowsProcessHelper({ spawnImpl, idleMs: 60_000 }) };
}

test('one Windows helper process answers every identity query, without a shell per check (FB01)', async () => {
  const { spawned, helper } = fakeHelper(pid => pid === 1 ? 'S:133700000000000000' : pid === 2 ? 'E:N' : 'E:F');
  try {
    assert.deepEqual(await helper.query(1), { start: '133700000000000000' });
    assert.deepEqual(await helper.query(2), { missing: true });
    await assert.rejects(helper.query(3), error => error.permanent === true);
    assert.deepEqual(await Promise.all([helper.query(1), helper.query(2)]), [{ start: '133700000000000000' }, { missing: true }]);
    assert.equal(spawned.length, 1);
    const [{ command, args, options }] = spawned;
    assert.equal(command, 'powershell.exe');
    assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    assert.match(args[4], /GetProcessById\(\$n\)\.StartTime\.ToFileTimeUtc\(\)/);
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, undefined);
  } finally { helper.stop(); }
});

test('a Windows helper that answers out of protocol or is abandoned mid-query is replaced', async () => {
  let silent = false;
  const { spawned, helper } = fakeHelper(pid => silent ? null : pid === 7 ? 'garbage' : 'S:133700000000000000');
  try {
    await assert.rejects(helper.query(7), error => error.transient === true);
    assert.equal(spawned[0].child.killed, true);
    assert.deepEqual(await helper.query(8), { start: '133700000000000000' });
    assert.equal(spawned.length, 2);
    silent = true;
    const controller = new AbortController();
    const waiting = helper.query(9, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(waiting, error => error.transient === true);
    assert.equal(spawned[1].child.killed, true, 'a late answer can never be read as the next query\'s');
    silent = false;
    assert.deepEqual(await helper.query(10), { start: '133700000000000000' });
    assert.equal(spawned.length, 3);
  } finally { helper.stop(); }
});

test('the real Windows helper reads this process and reports a missing one', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  try {
    const own = await readProcessStart(process.pid, { platform: 'win32' });
    assert.match(own.start, /^[0-9]+$/);
    assert.deepEqual(await readProcessStart(2_147_483_644, { platform: 'win32' }), { missing: true });
  } finally { stopProcessProbe(); }
});

test('a helper that never becomes ready is replaced before the next attempt', async () => {
  let spawns = 0;
  const helper = new testing.WindowsProcessHelper({ spawnImpl() {
    const child = Object.assign(new EventEmitter(), { stdin: new EventEmitter(), stdout: new EventEmitter(), kill() {} });
    child.stdin.write = () => queueMicrotask(() => child.stdout.emit('data', 'S:123\n'));
    child.stdin.end = () => {}; child.stdout.setEncoding = () => {};
    if (++spawns > 1) queueMicrotask(() => child.stdout.emit('data', 'R\n'));
    return child;
  } });
  try {
    assert.deepEqual(await inquire(({ signal }) => helper.query(1, signal), { attemptMs: 30 }), { start: '123' });
    assert.equal(spawns, 2);
  } finally { helper.stop(); }
});
