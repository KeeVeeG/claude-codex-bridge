// macOS uses Codex's public app-server on the Desktop-configured SSH host.
// This never opens the protected Desktop app-tools socket or starts a server.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { encodeClientFrame, MAX_MESSAGE_BYTES as MAX_MESSAGE, readFrameLength, upgradeRequest } from './ws-jsonrpc.mjs';
import { appServerError, appServerWriteError, markDeliveryUnknown, normalizeCodexThreadId, rpcReplyKind,
  startedTurnId, unconfirmedReply } from './codex-daemon.mjs';
import { beforeWrite, cancelledError, throwIfAborted } from './call-time.mjs';
import { failure } from './outcome.mjs';

const runtimeVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const MAX_HEADER = 65536;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateSshHostAlias(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw failure('SSH host alias must be a concrete SSH configuration alias without options or shell characters.', 'setup_incomplete');
  }
  return value;
}

function text(value, name, limit = 65536) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit) {
    throw new Error(`${name} must be nonempty bounded text.`);
  }
  return value;
}

function selectedThreadId(value) {
  const id = text(value, 'Selected Codex task ID', 512);
  if (/[\r\n\0]/.test(id)) throw new Error('Selected Codex task ID contains invalid control characters.');
  return normalizeCodexThreadId(id);
}

function clientFrame(payload, opcode = 1) {
  if (payload.length > MAX_MESSAGE) throw new Error('Codex SSH request exceeds the transport limit.');
  return encodeClientFrame(opcode, payload);
}

class SshRpc {
  // Class (b): one SSH session including its connection; a written turn is never repeated.
  constructor({ sshHostAlias, signal, spawnImpl = spawn, timeoutMs = 30000 }) {
    throwIfAborted(signal);
    const alias = validateSshHostAlias(sshHostAlias);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid Codex SSH timeout.');
    this.pending = Buffer.alloc(0); this.calls = new Map(); this.id = 0;
    this.fragments = []; this.fragmentBytes = 0; this.fragmenting = false;
    this.closed = false; this.upgraded = false; this.signal = signal;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Attach rejection handling immediately, including a synchronous spawn failure.
    this.ready.catch(() => {});
    const { text: upgrade, accept } = upgradeRequest('/rpc');
    this.accept = accept;
    this.abort = () => this.fail(cancelledError());
    signal?.addEventListener('abort', this.abort, { once: true });
    this.timer = setTimeout(() => this.fail(failure('Codex SSH request timeout; the route could not be verified in time.', 'route_unverified')), timeoutMs);
    try {
      this.child = spawnImpl('/usr/bin/ssh', ['-T', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes',
        '-oControlMaster=no', '-oControlPath=none', '-oConnectTimeout=5', '--', alias, 'exec "$SHELL" -lc \'exec codex app-server proxy\''],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      if (!this.child.stdin || !this.child.stdout || !this.child.stderr) throw new Error('SSH proxy streams are unavailable.');
      this.child.on('error', () => this.fail(new Error('Could not start the configured SSH proxy.')));
      let diagnostic = '';
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
      this.child.on('close', code => {
        // Fixed operator actions only; never carry remote stderr into a result.
        const problem = !this.upgraded && /host key verification failed|remote host identification has changed/i.test(diagnostic)
          ? ['SSH host-key verification failed.', 'Verify the configured host key with its operator.', 'ssh_host_key']
          : !this.upgraded && code === 127 && /codex.*(?:not found|command not found)|command not found.*codex/i.test(diagnostic)
          ? ['The remote login shell could not find Codex.', 'Configure its login PATH to include Codex.', 'ssh_executable_missing']
          : !this.upgraded && /permission denied/i.test(diagnostic) ? ['SSH authentication was denied.', 'Check authorized noninteractive authentication for the selected alias.', 'ssh_auth_denied']
          : null;
        this.fail(problem ? failure(`${problem[0]} ${problem[1]}`, problem[2], { nextAction: problem[1] })
          : failure('The configured SSH proxy closed before replying. Check connectivity to the configured host.', 'route_unavailable'));
      });
      this.child.stdin.on('error', () => this.fail(new Error('Could not write to the configured SSH proxy.')));
      this.child.stdout.on('error', () => this.fail(new Error('Could not read from the configured SSH proxy.')));
      this.child.stderr.on('error', () => this.fail(new Error('Could not read from the configured SSH proxy.')));
      this.child.stdout.on('end', () => { if (this.upgraded) this.fail(failure('The configured SSH proxy closed before replying.', 'route_unavailable')); });
      this.child.stdout.on('data', chunk => { try { this.receive(chunk); } catch (error) { this.fail(error); } });
      // Drain stderr without exposing login banners, diagnostics, or credentials.
      this.child.stderr.resume();
      throwIfAborted(signal);
      this.child.stdin.write(upgrade);
    } catch (error) { this.fail(error); }
  }

  receive(chunk) {
    if (this.closed) return;
    if (this.pending.length + chunk.length > MAX_MESSAGE + MAX_HEADER) throw new Error('Codex SSH response exceeds the transport limit.');
    this.pending = Buffer.concat([this.pending, chunk]);
    if (!this.upgraded) {
      const end = this.pending.indexOf('\r\n\r\n');
      if (end < 0) { if (this.pending.length > MAX_HEADER) throw new Error('Codex SSH handshake exceeds the transport limit.'); return; }
      if (end > MAX_HEADER) throw new Error('Codex SSH handshake exceeds the transport limit.');
      const head = this.pending.subarray(0, end).toString('ascii');
      // A login-shell banner ends its lines with LF or CRLF before the proxy's status line (W08).
      if (!head.startsWith('HTTP/') && /\nHTTP\/1\.1 /.test(head)) throw failure('The remote shell printed output before the proxy handshake. Configure silent noninteractive shell startup.', 'protocol_incompatible');
      const lines = head.split('\r\n');
      const headers = new Map();
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon < 1) throw new Error('Invalid Codex SSH WebSocket handshake.');
        const key = line.slice(0, colon).toLowerCase();
        if (headers.has(key)) throw new Error('Duplicate Codex SSH handshake header.');
        headers.set(key, line.slice(colon + 1).trim());
      }
      if (!/^HTTP\/1\.1 101(?: |$)/.test(lines[0]) || headers.get('sec-websocket-accept') !== this.accept ||
          headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
          !headers.get('connection')?.toLowerCase().split(/\s*,\s*/).includes('upgrade') ||
          headers.has('sec-websocket-extensions') || headers.has('sec-websocket-protocol')) {
        throw new Error('Invalid Codex SSH WebSocket handshake.');
      }
      this.pending = this.pending.subarray(end + 4); this.upgraded = true; this.resolveReady();
    }
    while (this.pending.length >= 2 && !this.closed) {
      const first = this.pending[0], second = this.pending[1], opcode = first & 15, fin = !!(first & 128);
      if ((first & 112) || (second & 128)) throw new Error('Invalid Codex SSH WebSocket frame.');
      const length = readFrameLength(this.pending, 'Codex SSH response exceeds the transport limit.');
      if (!length) return;
      const { length: size, offset: header } = length;
      // SSH rejects a bad control header immediately, without waiting for its payload.
      if (opcode >= 8 && (!fin || size > 125)) throw new Error('Invalid Codex SSH WebSocket frame length.');
      if (this.pending.length < header + size) return;
      const payload = this.pending.subarray(header, header + size);
      this.pending = this.pending.subarray(header + size);
      if (opcode === 8) throw failure('The configured SSH route closed before replying. Check connectivity to the configured host.', 'route_unavailable');
      if (opcode === 9) { this.child.stdin.write(clientFrame(payload, 10)); continue; }
      if (opcode === 10) continue;
      if (opcode === 1) {
        if (this.fragmenting) throw new Error('Invalid Codex SSH fragmented message.');
        this.fragments = []; this.fragmentBytes = 0; this.fragmenting = true;
      } else if (opcode !== 0 || !this.fragmenting) throw new Error('Unsupported Codex SSH WebSocket frame.');
      this.fragmentBytes += size;
      if (this.fragmentBytes > MAX_MESSAGE) throw new Error('Codex SSH fragmented response exceeds the transport limit.');
      this.fragments.push(payload);
      if (fin) {
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(this.fragments))); }
        catch { /* handled as a malformed response below */ }
        this.fragments = []; this.fragmentBytes = 0; this.fragmenting = false;
        if (!object(value)) throw failure('Invalid Codex SSH JSON-RPC response.', 'protocol_incompatible');
        // Each peer owns its request-ID namespace. A server request may have the
        // same ID as our pending call, but can never acknowledge that call.
        if (Object.hasOwn(value, 'method')) continue;
        const call = this.calls.get(value.id);
        if (!call) continue; // Notifications and unrelated responses are not approvals.
        this.calls.delete(value.id);
        const kind = rpcReplyKind(value);
        const written = call.mutating && call.written;
        if (kind === 'error') {
          const error = appServerError('Codex SSH', value.error);
          call.reject(written ? appServerWriteError('Codex SSH', error) : error);
        } else if (kind === 'result') call.resolve(value.result);
        else call.reject(written ? unconfirmedReply('Codex SSH', 'malformed response')
          : failure('Invalid Codex SSH JSON-RPC response.', 'protocol_incompatible'));
      }
    }
  }

  request(method, params, mutating = false) {
    throwIfAborted(this.signal);
    if (this.closed) return Promise.reject(this.closeCause ?? failure('The configured SSH route is closed. Check connectivity to the configured host.', 'route_unavailable'));
    const id = ++this.id;
    const bytes = clientFrame(Buffer.from(JSON.stringify({ id, method, params })));
    return new Promise((resolve, reject) => {
      const call = { resolve, reject, mutating, written: false };
      this.calls.set(id, call);
      try { throwIfAborted(this.signal); if (mutating) beforeWrite(this.signal); call.written = true; this.child.stdin.write(bytes); }
      catch (error) { this.fail(error); }
    });
  }

  notify(method) { throwIfAborted(this.signal); this.child.stdin.write(clientFrame(Buffer.from(JSON.stringify({ method, params: {} })))); }

  fail(error) {
    if (this.closed) return;
    this.closeCause = error;
    this.rejectReady(error);
    for (const call of this.calls.values()) {
      const copy = Object.assign(new Error(error.message), { name: error.name, code: error.code, reason: error.reason });
      if (call.mutating && call.written) {
        if (error.reason === 'protocol_incompatible') unconfirmedReply('Codex SSH', 'malformed response', copy);
        else markDeliveryUnknown(copy);
      }
      call.reject(copy);
    }
    this.calls.clear(); this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); this.signal?.removeEventListener('abort', this.abort);
    this.child?.stdin?.destroy(); this.child?.kill();
  }
}

async function connected(options) {
  const rpc = new SshRpc(options);
  try {
    await rpc.ready;
    const result = await rpc.request('initialize', { clientInfo: { name: 'claude-codex-bridge',
      title: 'Claude–Codex Bridge', version: runtimeVersion } });
    if (typeof result.userAgent !== 'string' || !result.userAgent) {
      throw failure('Codex SSH returned an unsupported initialize result.', 'protocol_incompatible');
    }
    rpc.notify('initialized'); return rpc;
  } catch (error) { rpc.close(); throw error; }
}

function target(result, threadId) {
  if (!object(result?.thread) || normalizeCodexThreadId(result.thread.id) !== threadId ||
      !object(result.thread.status) || !['idle', 'active', 'notLoaded', 'systemError'].includes(result.thread.status.type)) {
    throw failure('Codex SSH returned an unsupported target thread.', 'protocol_incompatible');
  }
  return result.thread;
}

function summary(thread, threadId, sshHostAlias) {
  if ((thread.name != null && typeof thread.name !== 'string') ||
      (thread.preview != null && typeof thread.preview !== 'string') ||
      (thread.cwd != null && (typeof thread.cwd !== 'string' || Buffer.byteLength(thread.cwd) > 4096 || thread.cwd.includes('\0')))) {
    throw new Error('Codex SSH returned unsupported thread metadata.');
  }
  const title = [thread.name, thread.preview, threadId]
    .find(value => typeof value === 'string' && value.trim());
  return { thread_id: threadId, title: title.replace(/\s+/g, ' ').trim().slice(0, 200),
    status: thread.status.type, cwd: thread.cwd ?? '', host_id: `ssh:${sshHostAlias}` };
}

export async function listSshCodexChats(options = {}) {
  const limit = options.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be between 1 and 50');
  const rpc = await connected(options);
  try {
    const loaded = await rpc.request('thread/loaded/list', {});
    if (!Array.isArray(loaded.data)) throw failure('Unsupported Codex SSH loaded-thread catalog.', 'protocol_incompatible');
    const ids = [...new Set(loaded.data.map(selectedThreadId))];
    const chats = [];
    for (const id of ids.slice(0, 200)) {
      if (chats.length >= limit) break;
      const thread = target(await rpc.request('thread/read', { threadId: id, includeTurns: false }), id);
      if (thread.status.type !== 'idle') continue;
      chats.push(summary(thread, id, options.sshHostAlias));
    }
    return chats;
  } finally { rpc.close(); }
}

export async function sendSshCodex(options = {}) {
  const threadId = selectedThreadId(options.threadId);
  // The service/store already bounds user text to 64 KiB. The transport also
  // carries its verified sender notice, so enforce the frame bound here.
  const message = text(options.message, 'Message', MAX_MESSAGE);
  const rpc = await connected(options);
  try {
    const read = await rpc.request('thread/read', { threadId, includeTurns: false });
    const status = target(read, threadId).status.type;
    if (status === 'active') throw failure('The selected SSH chat is active. Repeat the same call when it is idle.', 'target_busy');
    if (status === 'systemError') throw failure('The selected SSH chat reports a system error. Resolve the error in that chat before sending.', 'target_unavailable');
    if (status !== 'idle') throw failure('The selected SSH chat is not loaded. Open it on the configured host before sending.', 'target_unavailable');
    // Input to an already-loaded thread needs no subscription. Resuming here
    // could load a conversation closed after the read and hydrate its history.
    const turnId = startedTurnId(await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: message }] }, true));
    if (!turnId) throw unconfirmedReply('Codex SSH', 'unsupported turn/start receipt');
    return { transport: 'ssh-app-server', turnId, threadId };
  } finally { rpc.close(); }
}
