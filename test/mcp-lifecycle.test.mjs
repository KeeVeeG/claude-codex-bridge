import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import { nativeFixture } from './native-helpers.mjs';
import { beforeWrite } from '../lib/call-time.mjs';
import path from 'node:path';
import { once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import { CALL_DEADLINE_MS, WRITE_RESERVE_MS } from '../lib/call-time.mjs';
import { outcome } from '../lib/outcome.mjs';
import { runMcpServer } from '../scripts/mcp.mjs';

// Promise.withResolvers is not available on the supported Node 20 runtime.
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const notification = (method, params) => request(undefined, method, params);
const tool = (id, name, args, extra) => request(id, 'tools/call', { name, arguments: args, ...extra });
const send = id => tool(id, 'send_to_codex', { thread_id: 'fixture', message: String(id) });

function server(t, executor = () => assert.fail('unexpected executor call'), { holdOutput = false, env = { CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), randomUUID()) } } = {}) {
  const input = new PassThrough();
  const replies = [];
  let buffer = '';
  let writes = 0;
  let release;
  let holdNext = holdOutput;
  const output = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) {
    writes++;
    const consume = () => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        replies.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
        output.emit('reply');
      }
      callback();
    };
    if (holdNext) { holdNext = false; release = consume; }
    else consume();
  } });
  const done = runMcpServer({ input, output, executor, env });
  t.after(async () => {
    if (input.listenerCount('error')) input.destroy(new Error('test teardown'));
    await done;
  });
  const write = (...messages) => input.write(`${messages.map(message => JSON.stringify(message)).join('\n')}\n`);
  async function waitFor(find) {
    const signal = AbortSignal.timeout(WRITE_RESERVE_MS);
    let result;
    while (!(result = find())) await once(output, 'reply', { signal });
    return result;
  }
  async function initialize(protocolVersion = '2025-11-25') {
    write(request('init', 'initialize', { protocolVersion }), notification('notifications/initialized'));
    return (await waitFor(() => replies.find(reply => reply.id === 'init'))).result;
  }
  return { input, output, replies, write, done, initialize, waitFor, writes: () => writes,
    stall: () => { holdNext = true; }, release: () => release(),
    response: id => waitFor(() => replies.find(reply => reply.id === id)) };
}

test('MCP catalogs, resources, and tools progress while sends retain order', async t => {
  const held = deferred();
  const started = deferred();
  t.after(() => held.resolve());
  const calls = [];
  const client = server(t, async (name, args) => {
    calls.push(args.message ?? name);
    if (args.message === 'first') { started.resolve(); await held.promise; }
    return {};
  });
  await client.initialize();
  client.write(send('first'));
  await started.promise;
  client.write(send('second'), send('third'), request('ping', 'ping'), request('tools', 'tools/list'),
    request('resources', 'resources/list'), request('read', 'resources/read', { uri: 'ui://bridge/panel-v6.html' }),
    tool('read-only', 'list_deliveries'));
  assert.deepEqual((await client.response('ping')).result, {});
  const [tools, resources, read, readOnly] = await Promise.all(['tools', 'resources', 'read', 'read-only'].map(client.response));
  assert.ok(tools.result.tools.length);
  assert.equal(read.result.contents[0].uri, resources.result.resources[0].uri);
  assert.deepEqual(readOnly.result.structuredContent, {});
  assert.deepEqual(calls, ['first', 'list_deliveries']);
  held.resolve();
  await client.response('third');
  assert.deepEqual(calls, ['first', 'list_deliveries', 'second', 'third']);
});

for (const disconnect of ['stdin EOF', 'stdin error', 'stdout error']) {
  test(`MCP ${disconnect} aborts all running requests and discards queued sends`, async t => {
    const held = deferred();
    t.after(() => held.resolve());
    const started = [];
    const client = server(t, async (name, args, { signal }) => {
      started.push({ name, message: args.message, signal });
      await held.promise;
      return {};
    });
    await client.initialize();
    client.write(send('running'), send('queued'), tool('reading', 'list_deliveries'), request('ready', 'ping'));
    assert.deepEqual((await client.response('ready')).result, {});
    await turn();
    if (disconnect === 'stdin EOF') client.input.end();
    else (disconnect === 'stdin error' ? client.input : client.output).destroy(new Error('test disconnect'));
    await turn();
    assert.equal(started.find(call => call.message === 'running')?.signal.aborted, true, 'running send aborts before it settles');
    assert.deepEqual(started.map(call => call.message ?? call.name).sort(), ['list_deliveries', 'running']);
    assert.ok(started.every(call => call.signal.aborted));
    await client.done;
    held.resolve();
    await turn();
    assert.deepEqual(client.replies.map(reply => reply.id), ['init', 'ready']);
    assert.equal(started.length, 2);
  });
}

test('a queued send expires at the production deadline even while the earlier send is held', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = deferred();
  const started = deferred();
  t.after(() => held.resolve());
  const calls = [];
  const client = server(t, async (name, args) => { calls.push(args.message); started.resolve(); await held.promise; return {}; });
  await client.initialize();
  client.write(send('held'));
  await started.promise;
  client.write(send('expired'), request('ready', 'ping'));
  assert.deepEqual((await client.response('ready')).result, {}, 'the server received the queued send');
  t.mock.timers.tick(CALL_DEADLINE_MS);
  await turn();
  const expired = client.replies.find(reply => reply.id === 'expired');
  assert.equal(expired?.result.isError, true);
  const machine = { outcome: outcome('deadline') };
  assert.deepEqual(JSON.parse(expired.result.content[1].text), machine);
  assert.deepEqual(expired.result._meta['bridge-claude-codex/outcome'], machine);
  assert.deepEqual(calls, ['held']);
  held.resolve();
  await client.response('held');
  assert.deepEqual(calls, ['held']);
});

for (const [limit, count, size] of [['request count', 64, 0], ['UTF-8 bytes', 4, 630_000]]) {
  test(`MCP rejects work beyond the ${limit} bound and reopens capacity after cancellation`, async t => {
    const held = deferred();
    t.after(() => held.resolve());
    const calls = [];
    const client = server(t, async (name, args) => { calls.push(args.message); await held.promise; return {}; });
    await client.initialize();
    const work = id => ({ ...send(id), params: { ...send(id).params, _meta: { padding: '界'.repeat(size) } } });
    for (let i = 0; i <= count; i++) client.write(work(i));
    const excess = await client.response(count);
    assert.equal(excess.error.code, -32000);
    assert.deepEqual(excess.error.data, { outcome: outcome('server_busy') });
    await turn();
    assert.deepEqual(calls, ['0']);
    client.write(notification('notifications/cancelled', { requestId: 1 }), work(count));
    held.resolve();
    await client.waitFor(() => client.replies.filter(reply => reply.id === count)[1]);
    assert.deepEqual(calls, [0, ...Array.from({ length: count - 1 }, (_, i) => i + 2)].map(String));
  });
}

test('MCP stops consuming lines on stdout backpressure and resumes only after drain', async t => {
  const calls = [];
  const client = server(t, async name => { calls.push(name); return {}; }, { holdOutput: true });
  client.write(request('init', 'initialize', { protocolVersion: '2025-11-25' }), notification('notifications/initialized'),
    tool('read', 'list_deliveries'));
  client.write(request('ping', 'ping'));
  await turn();
  assert.equal(client.writes(), 1, 'first write reached the stalled peer');
  assert.deepEqual(calls, [], 'a request already in the input chunk must still wait for drain');
  client.release();
  await client.response('read');
  assert.deepEqual((await client.response('ping')).result, {});
  assert.deepEqual(calls, ['list_deliveries']);
});

test('concurrent completions do not inflate the writable backlog when stdout is blocked', async t => {
  const held = deferred();
  t.after(() => held.resolve());
  const calls = [];
  const client = server(t, async (name, args) => { calls.push(args.limit); await held.promise; return {}; });
  await client.initialize();
  client.write(tool('one', 'list_deliveries', { limit: 1 }), tool('two', 'list_deliveries', { limit: 2 }), request('ready', 'ping'));
  await client.response('ready');
  assert.deepEqual(calls, [1, 2]);
  client.stall();
  client.write(request('stalled', 'ping'));
  await turn();
  const pendingWrite = client.output.writableLength;
  assert.ok(pendingWrite > 0);
  held.resolve();
  await turn();
  assert.equal(client.output.writableLength, pendingWrite, 'only the blocked write is in the stream buffer');
  client.release();
  await Promise.all(['stalled', 'one', 'two'].map(client.response));
});

test('MCP validates params before method dispatch, including control messages', async t => {
  const client = server(t);
  client.write(request('early-ping', 'ping', null), request('invalid-init', 'initialize', []),
    request('init', 'initialize', { protocolVersion: '2025-11-25' }), notification('notifications/initialized', []),
    request('not-ready', 'tools/list'), notification('notifications/initialized'));
  assert.equal((await client.response('early-ping')).error.code, -32602);
  assert.equal((await client.response('invalid-init')).error.code, -32602);
  assert.equal((await client.response('not-ready')).error.code, -32000);
  for (const method of ['ping', 'tools/list', 'resources/list', 'resources/read', 'tools/call', 'unknown']) {
    for (const [id, params] of [[1, null], [2, []], [3, 'string'], [4, false], [5, 1]]) {
      client.write(request(`${method}-${id}`, method, params));
      const { error } = await client.response(`${method}-${id}`);
      assert.equal(error.code, -32602);
      if (method === 'tools/call') assert.deepEqual(error.data, { outcome: outcome('invalid_argument') });
    }
  }
  client.write(request('ready', 'ping'));
  assert.deepEqual((await client.response('ready')).result, {});
});

test('MCP 2025-03-26 batches return one array, omit notifications, and apply normal validation', async t => {
  const client = server(t);
  client.write([request('before', 'ping')]);
  assert.equal((await client.response(null)).error.code, -32600);
  assert.equal((await client.initialize('2025-03-26')).protocolVersion, '2025-03-26');
  client.write([request('ping', 'ping'), notification('noop'), false, request('list', 'tools/list'),
    request('bad-ping', 'ping', [])]);
  const replies = await client.waitFor(() => client.replies.find(Array.isArray));
  assert.deepEqual(replies.map(reply => [reply.id, reply.error?.code]),
    [['ping', undefined], [null, -32600], ['list', undefined], ['bad-ping', -32602]]);
  assert.deepEqual(replies[0].result, {});
  assert.ok(replies[2].result.tools.length);
  client.write([], [notification('noop')], request('after', 'ping'));
  await client.response('after');
  assert.deepEqual(client.replies.slice(3).map(reply => [reply.id, reply.error?.code]), [[null, -32600], ['after', undefined]]);
});

for (const version of ['2024-11-05', '2025-06-18', '2025-11-25']) {
  test(`MCP ${version} refuses batches without running a member`, async t => {
    const client = server(t);
    assert.equal((await client.initialize(version)).protocolVersion, version);
    client.write([tool('tool', 'list_deliveries'), request('inner', 'ping')], request('outside', 'ping'));
    await client.response('outside');
    assert.deepEqual(client.replies.slice(1).map(reply => [reply.id, reply.error?.code]), [[null, -32600], ['outside', undefined]]);
  });
}

test('an oversized 2025-03-26 batch gets one busy response array with the original IDs', async t => {
  const client = server(t);
  await client.initialize('2025-03-26');
  const messages = Array.from({ length: 65 }, (_, id) => tool(id, 'list_deliveries'));
  client.write([...messages, notification('noop')]);
  const replies = await client.waitFor(() => client.replies.find(Array.isArray));
  assert.deepEqual(replies.map(reply => [reply.id, reply.error.code, reply.error.data.outcome.reason]),
    messages.map(({ id }) => [id, -32000, 'server_busy']));
});

for (const action of ['cancel', 'EOF', 'work before cancellation']) test('backpressure does not hide ' + action + ' from a pending write', async t => {
  const held = deferred(), started = deferred(); let writes = 0;
  t.after(() => held.resolve());
  const client = server(t, async (name, args, { signal }) => {
    started.resolve(); await held.promise; beforeWrite(signal); writes++; return {};
  });
  await client.initialize(); client.write(send('pending')); await started.promise;
  client.stall(); client.write(request('blocked', 'ping')); await turn();
  if (action === 'EOF') client.input.end();
  else {
    if (action === 'work before cancellation') client.write(request('more-work', 'ping'));
    client.write(notification('notifications/cancelled', { requestId: 'pending' }));
  }
  await turn(); held.resolve(); await turn(); client.release();
  assert.equal(writes, 0);
});

test('admission binds a queued parent-only Claude window, including a missing registration (A201)', async t => {
  const fixture = await nativeFixture(t), registry = path.join(fixture.root, 'sessions');
  fs.mkdirSync(registry);
  const file = path.join(registry, process.ppid + '.json');
  const register = sessionId => fs.writeFileSync(file, JSON.stringify({ sessionId, pid: process.ppid, entrypoint: 'cli', procStart: '123', pidDomain: 'fixture',
    messagingSocketPath: process.platform === 'win32' ? '\\\\.\\pipe\\fixture' : '/tmp/fixture.sock' }));
  register('A');
  const seen = [], started = deferred(), hold = deferred(); t.after(() => hold.resolve());
  const client = server(t, async (_, args, ctx) => { seen.push(ctx.callerSessionId); if (seen.length === 1) { started.resolve(); await hold.promise; } return {}; },
    { env: { CLAUDE_CODEX_BRIDGE_REGISTRY_DIR: registry, CLAUDE_CODEX_BRIDGE_DAEMON: 'off' } });
  await client.initialize(); client.write(send('held')); await started.promise;
  client.write(send('bound'), request('seen-a', 'ping')); await client.response('seen-a');
  fs.unlinkSync(file); client.write(send('missing'), request('seen-none', 'ping')); await client.response('seen-none');
  register('B'); hold.resolve(); await client.response('missing');
  assert.deepEqual(seen, ['A', 'A', null]);
});
