import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { canonicalClaudeSocket } from '../lib/claude-sessions.mjs';
import { WRITE_RESERVE_MS } from '../lib/call-time.mjs';
import { encodeFrame, messageTool, mockPipe } from './native-helpers.mjs';

const childFile = fileURLToPath(new URL('./fixtures/contention-mcp-child.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const processStart = '133700000000000000';
const deadlineMs = 3_000;
const progressMs = 1_500;
const stepMs = 5_000;

function startChild(root, env) {
  const child = fork(childFile, { cwd: root, env, execArgv: [], silent: true, windowsHide: true });
  const events = new EventEmitter();
  const replies = new Map(), signals = new Map();
  let next = 0, stopped, stderr = '';
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    stop(new Error(`MCP child closed (${code ?? signal}): ${stderr}`));
    resolve({ code, signal });
  }));
  function stop(error) { stopped ??= error; events.emit('update'); }
  child.on('error', stop);
  child.stdin.on('error', stop);
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const reply = JSON.parse(line);
      replies.set(reply.id, reply);
      events.emit('update');
    } catch (error) { stop(error); }
  });
  child.on('message', message => { signals.set(message.event, message); events.emit('update'); });
  async function waitFor(map, key, ms) {
    const signal = AbortSignal.timeout(Math.ceil(ms));
    while (!map.has(key)) {
      if (stopped) throw stopped;
      await once(events, 'update', { signal }).catch(error => {
        const lastToolReply = [...replies.values()].findLast(reply => reply.id?.startsWith('tools/call:'));
        throw new Error(`Timed out waiting for ${key} from the MCP child: ${stderr}` +
          (map === signals && lastToolReply ? `\nLast tool reply: ${JSON.stringify(lastToolReply)}` : ''), { cause: error });
      });
    }
    return map.get(key);
  }
  function send(method, params, id) {
    if (stopped) throw stopped;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  }
  return { child, closed, replies, signals, notify: send,
    request(method, params) {
      const id = `${method}${params?.name ? `:${params.name}` : ''}#${++next}`;
      send(method, params, id);
      return { id, response: (ms = stepMs) => waitFor(replies, id, ms) };
    },
    event: (name, ms = stepMs) => waitFor(signals, name, ms),
  };
}

function toolValue(reply) {
  assert.ok(reply.result && !reply.result.isError, JSON.stringify(reply));
  return reply.result.structuredContent;
}

for (const ledger of ['sender', 'manual', 'host']) for (const mode of ['cancel', 'deadline']) {
  test(`child MCP ${mode} during ${ledger} lock contention`, {
    skip: process.platform !== 'win32' && 'Exercises Windows named pipes and process identity.', timeout: 20_000,
  }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mcp-contention-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const dirs = Object.fromEntries(['state', 'registry', 'claude', 'codex', 'home', 'roaming', 'local', 'config', 'tmp']
      .map(name => [name, fs.mkdirSync(path.join(root, name), { recursive: true })]));
    const sockets = [];
    const bytes = { claude: 0, codex: 0 };
    const observe = recipient => socket => {
      sockets.push(new Promise(resolve => socket.once('close', resolve)));
      socket.on('data', chunk => { bytes[recipient] += chunk.length; });
    };
    const claude = await mockPipe(t, { onConnection: observe('claude') });
    const codex = await mockPipe(t, { framed: true, onConnection: observe('codex'), onMessage(message, socket) {
      socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id,
        result: message.method === 'tools/list' ? { tools: [messageTool] } : { success: true, contentItems: [] } }));
    } });

    // A live fixture parent pins the child to the fake recipient registration and
    // suppresses unrelated host publication at initialize. Calls supply Codex metadata.
    const sessionId = randomUUID(), owner = `contention-owner-${randomUUID()}`;
    const pidDomain = `win32:${os.hostname().toLowerCase()}`;
    writeJson(path.join(dirs.registry, `${process.pid}.json`), { pid: process.pid, sessionId, name: 'Contention fixture',
      cwd: root, entrypoint: 'claude-desktop', procStart: processStart, pidDomain, messagingSocketPath: claude.pipePath });
    writeJson(path.join(dirs.registry, `${process.pid}.${hash(canonicalClaudeSocket(claude.pipePath))}.key`),
      { peerToken: 'a'.repeat(32), procStartFt: processStart, pidDomain });

    const locations = { sender: path.join(dirs.state, hash(owner)), manual: path.join(dirs.state, 'manual', hash(owner)), host: dirs.state };
    for (const dir of [locations.sender, locations.manual]) fs.mkdirSync(dir, { recursive: true });
    const [senderFile, manualFile] = [locations.sender, locations.manual].map(dir => path.join(dir, 'state.json'));
    writeJson(senderFile, { schemaVersion: 1, key: hash(owner), threadId: owner, cwd: root, createdAt: Date.now(), desktop: null, messages: {} });
    writeJson(manualFile, { schemaVersion: 1, owner_thread_id: owner, records: {} });
    const lock = path.join(locations[ledger], 'state.lock');
    const hostFile = path.join(dirs.state, 'codex-host.json');
    writeJson(lock, { pid: process.pid, token: 'fixture', createdAt: Date.now() });
    const held = fs.readFileSync(lock);
    const files = [senderFile, manualFile];
    const snapshot = () => files.map(file => fs.readFileSync(file));
    const initial = snapshot();

    // Allowlist only OS necessities; no inherited credentials, runtime IDs,
    // executable overrides, endpoints, profiles or Node preload settings.
    const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: dirs.home, USERPROFILE: dirs.home, APPDATA: dirs.roaming, LOCALAPPDATA: dirs.local,
      XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.local, XDG_STATE_HOME: dirs.state, XDG_CACHE_HOME: dirs.tmp,
      TEMP: dirs.tmp, TMP: dirs.tmp, CLAUDE_CONFIG_DIR: dirs.claude, CODEX_HOME: dirs.codex,
      CLAUDE_CODEX_BRIDGE_STATE_DIR: dirs.state, CLAUDE_CODEX_BRIDGE_REGISTRY_DIR: dirs.registry,
      CLAUDE_CODEX_BRIDGE_DAEMON: 'off', CODEX_APP_TOOLS_PIPE_PATH: codex.pipePath,
      FIXTURE_PROCESS_START: processStart, FIXTURE_HELD_LOCK: lock,
      ...(mode === 'deadline' && { FIXTURE_DEADLINE_MS: String(deadlineMs) }),
      // Optional file URL to scripts/mcp.mjs in the source tree being tested.
      BRIDGE_TEST_MCP_MODULE_URL: process.env.BRIDGE_TEST_MCP_MODULE_URL,
    };
    const client = startChild(root, env);
    try {
      const initialized = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'contention-test', version: '1' } }).response();
      assert.equal(initialized.result?.protocolVersion, '2025-06-18');
      client.notify('notifications/initialized');
      const call = (name, args = {}) => client.request('tools/call', { name, arguments: args, _meta: { 'openai/threadId': owner } });
      const checkReads = async () => {
        const [ping, deliveries, history] = await Promise.all([client.request('ping').response(progressMs),
          call('list_deliveries').response(progressMs), call('panel_history', { session_id: sessionId }).response(progressMs)]);
        assert.deepEqual(ping.result, {});
        assert.equal(toolValue(deliveries).sender_id, owner);
        assert.deepEqual(toolValue(deliveries).deliveries, []);
        assert.deepEqual(toolValue(history).messages, []);
      };
      const startedAt = performance.now();
      const send = call(ledger === 'manual' ? 'panel_send' : 'send_to_claude',
        { session_id: sessionId, message: 'Not sent while contended.', message_id: 'contended' });
      await client.event('contending');
      await checkReads();
      if (mode === 'cancel') {
        client.notify('notifications/cancelled', { requestId: send.id });
        const settled = await client.event('settled', progressMs);
        assert.equal(settled.aborted, true, 'the real executor observed cancellation while the lock was still held');
        assert.ok(settled.remainingMs > WRITE_RESERVE_MS, 'the write reserve was not the reason no write started');
        assert.ok(!client.replies.has(send.id), 'a cancelled call has no reply');
      } else {
        const result = (await send.response(Math.max(1, deadlineMs + progressMs - (performance.now() - startedAt)))).result;
        assert.ok(performance.now() - startedAt < deadlineMs + progressMs, 'deadline reply arrived within the bound');
        assert.equal(result?.isError, true);
        const machine = { outcome: { reason: 'deadline', delivered: false, retry: 'same_id' } };
        assert.deepEqual(JSON.parse(result.content[1].text), machine);
        assert.deepEqual(result._meta['bridge-claude-codex/outcome'], machine);
        assert.match(result.content[0].text, /message not sent|no message was sent/i);
        const settled = await client.event('settled');
        assert.ok(settled.stop === 'BRIDGE_DEADLINE' || settled.remainingMs <= 0, 'the deadline timer or monotonic check stopped the call');
      }
      assert.deepEqual(bytes, { claude: 0, codex: 0 });
      assert.deepEqual(fs.readFileSync(lock), held, 'the fixture owner still holds the original lock');
      fs.unlinkSync(lock);
      await checkReads();
      // Drain the child and its pipe connections instead of using a quiet-period sleep.
      const drained = once(client.child, 'close', { signal: AbortSignal.timeout(stepMs) });
      client.child.stdin.end();
      assert.deepEqual(await drained, [0, null]);
      await Promise.all(sockets);
      assert.ok(!client.signals.has('acquired'), 'no abandoned attempt later acquired the released lock');
      assert.deepEqual(bytes, { claude: 0, codex: 0 }, 'neither recipient received even a partial frame');
      assert.deepEqual(snapshot(), initial, 'neither sender nor manual persisted a record');
      if (ledger === 'host') assert.ok(!fs.existsSync(hostFile), 'no delayed host publication');
      if (mode === 'cancel') assert.ok(!client.replies.has(send.id), 'no delayed cancellation reply');
    } finally {
      client.child.kill();
      await client.closed;
    }
  });
}
