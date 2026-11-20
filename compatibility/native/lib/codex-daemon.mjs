// Codex sessions can register with the local Codex app-server daemon. Its
// control socket speaks WebSocket and is only reachable through
// `codex app-server proxy` (the socket's ACL blocks direct Node access).
// This module never starts the daemon, never resumes a thread, and never uses a shell.
import path from 'node:path';
import { debuglog } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { FrameDecoder, encodeClose, encodePong, encodeText, upgradeRequest } from './ws-jsonrpc.mjs';
import { resolveCodexExecutable } from './codex-binary.mjs';
import { beforeWrite, cancelledError, monotonicNow, throwIfAborted } from './call-time.mjs';
import { failure, tagged } from './outcome.mjs';

const runtimeVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Callers first correlate by exact ID and ignore peer requests. All Codex methods used here return objects. */
export function rpcReplyKind(reply, requireVersion = false) {
  if ((requireVersion || Object.hasOwn(reply, 'jsonrpc')) && reply.jsonrpc !== '2.0') return null;
  const hasResult = Object.hasOwn(reply, 'result');
  const hasError = Object.hasOwn(reply, 'error');
  if (hasResult === hasError) return null;
  if (hasResult) return object(reply.result) ? 'result' : null;
  const error = reply.error;
  return object(error) && Number.isInteger(error.code) && typeof error.message === 'string' ? 'error' : null;
}

export function markDeliveryUnknown(error) {
  error.deliveryUnknown = true;
  error.message += ' The message may already have arrived.';
  return error;
}

export function unconfirmedReply(source, detail, error = new Error()) {
  error.message = `${source} could not confirm delivery${detail ? ` (${detail})` : ''}.`;
  return markDeliveryUnknown(error);
}

export class DaemonUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'DaemonUnavailableError'; }
}

export const NOT_RUNNING_MESSAGE = 'No Codex daemon is running; `codex app-server daemon start` starts one. The bridge never starts it.';
const CMD_SHIM_MESSAGE ='CLAUDE_CODEX_BRIDGE_CODEX_BIN must point to a native Codex .exe, not a script or another file.';
// Node cannot spawn a .cmd/.bat shim without a shell, and this module never uses one.
const isDirectExecutable = executable => /\.exe$/i.test(executable);

// Accept the usual spellings of "off", so an opt-out is never silently ignored.
const DISABLED = /^(off|0|false|no|disabled?)$/i;
const disabledValue = env => {
  const value = String(env.CLAUDE_CODEX_BRIDGE_DAEMON ?? '').trim();
  return DISABLED.test(value) ? value : null;
};

// The injected command (tests) skips the kill switch and the .exe check.
function resolveExecutable({ effective, command }) {
  if (debuglog('child_process').enabled) throw new DaemonUnavailableError('Child-process tracing can expose private data. Restart the bridge without NODE_DEBUG child_process tracing.');
  if (command) return command;
  const disabled = disabledValue(effective);
  if (disabled !== null) {
    throw new DaemonUnavailableError(`Codex terminal support is disabled by CLAUDE_CODEX_BRIDGE_DAEMON=${disabled}.`);
  }
  const executable = resolveCodexExecutable({ env: effective });
  if (!executable) {
    if (effective.CLAUDE_CODEX_BRIDGE_CODEX_BIN) throw new DaemonUnavailableError('The configured Codex executable was not found. Correct or unset CLAUDE_CODEX_BRIDGE_CODEX_BIN.');
    throw new DaemonUnavailableError('The Codex executable was not found. Install the Codex CLI, or set CLAUDE_CODEX_BRIDGE_CODEX_BIN to the path of codex.exe.');
  }
  if (!isDirectExecutable(executable)) throw new DaemonUnavailableError(CMD_SHIM_MESSAGE);
  return process.platform === 'win32' && executable.length >= 248 ? path.toNamespacedPath(path.resolve(executable)) : executable;
}

// Class (b) default: one proxy start and handshake for a send; routing and listing pass their inquiry
// attempt's limit instead, and the call deadline bounds both.
export function openDaemon({ env = process.env, command, args, signal, timeoutMs = 10000 } = {}) {
  try { throwIfAborted(signal); } catch (error) { return Promise.reject(error); }
  // The effective environment (for example CODEX_HOME) is the supplied one layered over the process's.
  const effective = { ...process.env, ...env };
  let executable;
  try { executable = resolveExecutable({ effective, command }); } catch (error) { return Promise.reject(error); }
  return new Promise((resolveOpen, rejectOpen) => {
    let child;
    try {
      child = spawn(executable, args ?? ['app-server', 'proxy'],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: effective });
    } catch {
      rejectOpen(new DaemonUnavailableError('The Codex executable could not be started.'));
      return;
    }
    const upgrade = upgradeRequest();
    const decoder = new FrameDecoder({ accept: upgrade.accept });
    const waiting = new Map();
    let nextId = 1;
    let opened = false;
    let closed = false;
    let stderr = '';

    const connectTimer = setTimeout(() => fail(Object.assign(new DaemonUnavailableError('The Codex daemon did not answer the connection attempt.'),
      { code: 'DAEMON_TIMEOUT' })), timeoutMs);

    function fail(error) {
      if (closed) return;
      closed = true;
      clearTimeout(connectTimer);
      signal?.removeEventListener('abort', onAbort);
      child.kill();
      for (const entry of waiting.values()) {
        const copy = Object.assign(new Error(error.message), { name: error.name, code: error.code, reason: error.reason });
        if (entry.mutating && entry.written) {
          if (error.reason === 'protocol_incompatible') unconfirmedReply('Codex daemon', 'malformed response', copy);
          else markDeliveryUnknown(copy);
        }
        entry.reject(copy);
      }
      waiting.clear();
      if (!opened) rejectOpen(error);
    }

    function onAbort() { fail(cancelledError()); }
    signal?.addEventListener('abort', onAbort, { once: true });

    function write(buffer) {
      child.stdin.write(buffer);
    }

    // Class (b): one request on an open connection. A written mutation is never repeated; reads are
    // repeated only by their caller's inquiry.
    function request(method, params, { mutating = false, signal: requestSignal, timeoutMs: limit = 15000 } = {}) {
      if (closed) return Promise.reject(new DaemonUnavailableError('The Codex daemon connection is closed.'));
      try {
        throwIfAborted(requestSignal);
        if (mutating) beforeWrite(requestSignal);
      } catch (error) { return Promise.reject(error); }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const entry = { mutating, written: false, resolve: undefined, reject: undefined };
        const timer = setTimeout(() => fail(Object.assign(new Error('Codex daemon did not answer before the local request timeout.'),
          { code: 'DAEMON_TIMEOUT' })), limit);
        const onRequestAbort = () => fail(cancelledError());
        const done = () => { clearTimeout(timer); requestSignal?.removeEventListener('abort', onRequestAbort); };
        entry.resolve = value => { done(); resolve(value); };
        entry.reject = error => { done(); reject(error); };
        requestSignal?.addEventListener('abort', onRequestAbort, { once: true });
        waiting.set(id, entry);
        try {
          write(encodeText(JSON.stringify({ id, method, params })));
          entry.written = true;
        } catch (error) {
          waiting.delete(id);
          entry.reject(error);
        }
      });
    }

    function notify(method, params) {
      write(encodeText(JSON.stringify({ method, params })));
    }

    function handle(text) {
      let message;
      try { message = JSON.parse(text); } catch { return; }
      // A peer request can reuse a pending ID but can never acknowledge it.
      if (!object(message) || Object.hasOwn(message, 'method')) return;
      const entry = waiting.get(message.id);
      if (!entry) return;
      const kind = rpcReplyKind(message);
      if (!kind) {
        fail(failure('Codex daemon returned a malformed response.', 'protocol_incompatible'));
        return;
      }
      waiting.delete(message.id);
      if (kind === 'error') entry.reject(appServerError('Codex daemon', message.error));
      else entry.resolve(message.result);
    }

    async function afterUpgrade() {
      try {
        const result = await request('initialize', { clientInfo: { name: 'claude-codex-bridge', title: 'Claude–Codex Bridge', version: runtimeVersion } });
        if (typeof result.userAgent !== 'string' || !result.userAgent) {
          throw failure('Codex daemon returned an unsupported initialize result.', 'protocol_incompatible');
        }
        notify('initialized', {});
        opened = true;
        clearTimeout(connectTimer);
        resolveOpen({
          request,
          close() {
            if (closed) return;
            try { write(encodeClose()); } catch { /* the child is already gone */ }
            // One shutdown path: it settles every pending request with the right
            // delivery classification, clears timers and listeners, and stops the proxy.
            fail(new Error('The Codex daemon connection was closed.'));
          },
        });
      } catch (error) { fail(error); }
    }

    child.on('error', () => fail(new DaemonUnavailableError('The Codex executable could not be started.')));
    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.stdout.on('error', () => fail(new Error('The Codex daemon connection failed.')));
    child.stderr.on('error', () => fail(new Error('The Codex daemon connection failed.')));
    child.on('close', () => {
      if (opened) { fail(new Error('The Codex daemon connection closed unexpectedly.')); return; }
      // Only a missing or refusing socket proves that no daemon listens; other causes need other repairs.
      // The diagnostic itself never leaves this process: it can name private paths.
      const detail = /SUN_LEN|socket path (?:is )?too long/i.test(stderr)
        ? 'The Codex daemon socket path is too long. Choose a shorter CODEX_HOME.'
        : /permission denied|access is denied|os error (?:5|13)\b/i.test(stderr) ? 'Access to the Codex daemon was denied. Run the bridge as the user that runs the daemon.'
        : /failed to connect/i.test(stderr) && /connection refused|no such file or directory|cannot find the file|os error (?:2|61|111|10061)\b/i.test(stderr) ? NOT_RUNNING_MESSAGE
        : 'The Codex daemon is not reachable. Check its status in the intended Codex environment.';
      fail(new DaemonUnavailableError(detail));
    });
    child.stdout.on('data', chunk => {
      let events;
      let invalid = null;
      // Frames decoded before an invalid one in the same chunk are still handled, so a response
      // that arrived intact is not downgraded to an uncertain outcome.
      try { events = decoder.push(chunk); } catch (error) { events = error.events ?? []; invalid = error; }
      for (const event of events) {
        if (event.type === 'open') afterUpgrade();
        else if (event.type === 'text') handle(event.text);
        else if (event.type === 'ping') { try { write(encodePong(event.payload)); } catch { /* closing */ } }
        else if (event.type === 'close') fail(new Error('The Codex daemon closed the connection.'));
      }
      if (invalid) fail(invalid);
    });
    write(Buffer.from(upgrade.text, 'latin1'));
  });
}

const isThreadNotFound = (code, message) => code === -32600 && /^thread not found(?::|$)/i.test(message);

/** A validated app-server error, shared by the local proxy and SSH. Keep its structured data internal. */
export function appServerError(source, { code, message, data }) {
  const reason = isThreadNotFound(code, message) ? 'target_unavailable'
    : code === -32601 ? 'protocol_incompatible'
    : code === -32602 && /^invalid params(?::|$)/i.test(message) ? 'request_rejected' : 'internal_error';
  const detail = reason === 'target_unavailable' ? 'The selected thread was not found.' : reason === 'protocol_incompatible' ? 'The requested method is unsupported.' : reason === 'request_rejected' ? 'The request arguments were refused.' : 'The request failed. Check the application for its diagnostic.';
  return failure(`${source}: ${detail}`, reason,
    { rpcCode: code, rpcMessage: message, rpcData: data });
}

export function appServerWriteError(source, error) {
  // These replies prove the dispatcher or exact target refused before accepting input.
  return ['target_unavailable', 'protocol_incompatible', 'request_rejected'].includes(error.reason)
    ? error : unconfirmedReply(source, undefined, error);
}

const CODEX_THREAD_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const isCodexThreadUuid = threadId => typeof threadId === 'string' && threadId.length === 36 && CODEX_THREAD_UUID.test(threadId);

/** UUID casing is not part of identity; preserve non-UUID values for callers that validate separately. */
export function normalizeCodexThreadId(threadId) {
  return isCodexThreadUuid(threadId) ? threadId.toLowerCase() : threadId;
}

const THREAD_STATUSES = ['idle', 'active', 'notLoaded', 'systemError'];

const summarize = thread => ({
  thread_id: normalizeCodexThreadId(thread.id),
  title: String(thread.name || thread.preview || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  status: thread.status.type,
  cwd: thread.cwd ?? '',
  host_id: 'local',
  // Discovery transport, not the current client: originator records creation only.
  source: 'terminal',
});

export async function listTerminalThreads(connection, { limit = 30, signal, timeoutMs, budgetMs = 5000 } = {}) {
  const found = Object.assign([], { damaged: 0 });
  let cursor = null;
  const until = monotonicNow() + budgetMs;
  // Bounded: at most 40 pages of 50 stored threads, and no new page once the time budget is spent,
  // so discovery cannot stall every listing. An exact ID is still resolved by thread/read.
  // The originator is immutable creation metadata; a resumed thread may use any client.
  for (let page = 0; page < 40 && found.length < limit && (page === 0 || monotonicNow() < until); page++) {
    const result = await connection.request('thread/list', { limit: 50, sortKey: 'updated_at', ...(cursor ? { cursor } : {}) }, { signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    if (!Array.isArray(result.data) || (result.nextCursor != null && typeof result.nextCursor !== 'string')) {
      throw failure('Codex daemon returned an unsupported thread list.', 'protocol_incompatible');
    }
    // A damaged row is skipped and counted, so one bad entry neither hides the valid ones nor
    // lets the result pass for a complete catalog. A row whose status a send would refuse is
    // damaged too (E09); a thread in a system error cannot take a message.
    for (const thread of result.data) {
      if (typeof thread?.id !== 'string' || !thread.id.trim() || !THREAD_STATUSES.includes(thread.status?.type)) found.damaged++;
      else if (thread.status.type !== 'systemError') found.push(summarize(thread));
    }
    cursor = result.nextCursor ?? null;
    if (!cursor) break;
  }
  return Object.assign(found.slice(0, limit), { damaged: found.damaged });
}

export async function readTerminalThread(connection, threadId, { signal, timeoutMs } = {}) {
  threadId = normalizeCodexThreadId(threadId);
  try {
    const result = await connection.request('thread/read', { threadId, includeTurns: false }, { signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    const thread = result?.thread;
    if (!object(thread)) throw failure('Codex daemon returned an unsupported thread read.', 'protocol_incompatible');
    if (normalizeCodexThreadId(thread.id) !== threadId) throw new Error('The Codex daemon returned a different thread than the selected task. Refresh the session list before sending.');
    if (!object(thread.status) || !THREAD_STATUSES.includes(thread.status.type)) {
      throw failure('Codex daemon returned an unsupported thread status.', 'protocol_incompatible');
    }
    return thread.id !== threadId ? { ...thread, id: threadId } : thread;
  } catch (error) {
    if (isThreadNotFound(error.rpcCode, error.rpcMessage)) return null;
    throw error;
  }
}

const notSteerable = error => error.rpcData?.codexErrorInfo?.activeTurnNotSteerable;
// Only the daemon's documented stale-steer replies can permit another mutation.
const staleSteer = error => error.rpcCode === -32600 && notSteerable(error) === undefined &&
  /^(no active turn to steer|expected active turn id `[^`]+` but found `[^`]+`)$/i.test(error.rpcMessage);

export function startedTurnId(result) {
  const id = result?.turn?.id;
  return object(result?.turn) && typeof id === 'string' && id.trim() ? id : null;
}

async function writeInput(connection, method, params, signal) {
  let result;
  try {
    result = await connection.request(method, params, { mutating: true, signal });
  } catch (error) {
    // Transport-level failures already know whether the request was written.
    if (error.rpcMessage === undefined) throw error;
    if (method === 'turn/steer' && error.rpcCode === -32600 &&
        (['review', 'compact'].includes(notSteerable(error)?.turnKind) || staleSteer(error))) {
      throw tagged(error, 'target_busy');
    }
    throw appServerWriteError('Codex daemon', error);
  }
  const turnId = method === 'turn/start' ? startedTurnId(result)
    : result?.turnId === params.expectedTurnId ? result.turnId : null;
  if (!turnId) throw unconfirmedReply('Codex daemon', `unsupported ${method} receipt`);
  return { method, turnId };
}

function activeTurnId(turns) {
  const running = [...turns].reverse().find(turn => turn?.status === 'inProgress' || turn?.status?.type === 'inProgress');
  return typeof running?.id === 'string' && running.id.trim() ? running.id : null;
}

/** The thread is not attached to the daemon; nothing was written, so another route may be tried. */
export class TerminalNotLoadedError extends Error {
  constructor(message) { super(message); this.name = 'TerminalNotLoadedError'; }
}

export async function sendToTerminalThread(connection, { threadId, text, messageId, signal }) {
  threadId = normalizeCodexThreadId(threadId);
  const thread = await readTerminalThread(connection, threadId, { signal });
  if (!thread) throw failure('The selected Codex task was not found in the Codex daemon.', 'target_unavailable');
  const status = thread.status.type;
  if (status === 'notLoaded') {
    throw new TerminalNotLoadedError('The selected Codex session is not loaded in the daemon. Open it in a Codex terminal first.');
  }
  if (status === 'systemError') {
    throw failure('The selected Codex session reports a system error. Resolve it in the selected conversation before sending.', 'target_unavailable');
  }
  const input = [{ type: 'text', text }];
  const start = () => writeInput(connection, 'turn/start', { threadId, input, clientUserMessageId: messageId }, signal);
  if (status === 'idle') return start();
  // The running turn is always the newest, so a one-turn page (newest first) is enough and
  // keeps the read far below the inbound cap even for very long sessions.
  let page;
  try {
    page = await connection.request('thread/turns/list', { threadId, limit: 1 }, { signal });
  } catch (error) {
    if (/exceeds 8 MiB/.test(error.message ?? '')) {
      throw failure('The selected Codex session is busy and its running turn could not be read because the daemon response exceeds the transport limit. Repeat the same call when the session is idle.', 'target_busy');
    }
    throw error;
  }
  if (!Array.isArray(page?.data)) throw failure('Codex daemon returned an unsupported turn list.', 'protocol_incompatible');
  const expectedTurnId = activeTurnId(page.data);
  if (!expectedTurnId) throw failure('The selected Codex session is busy and its running turn could not be identified. Repeat the same call when it is idle.', 'target_busy');
  try {
    return await writeInput(connection, 'turn/steer', { threadId, expectedTurnId, input }, signal);
  } catch (error) {
    // A stale steer proves nothing was accepted; only a now-idle thread may take one new turn.
    if (!staleSteer(error)) throw error;
    const current = await readTerminalThread(connection, threadId, { signal });
    if (!current || current.status.type === 'notLoaded') throw failure('The selected session is no longer loaded. Locate it again with list_codex_threads.', 'target_unavailable');
    if (current.status.type === 'systemError') throw failure('The selected session now reports a system error. Resolve it before sending.', 'target_unavailable');
    if (current.status.type !== 'idle') throw failure('The selected Codex session changed turns while sending. Repeat the same call when it is idle.', 'target_busy');
    return start();
  }
}

// libuv doubles backslash runs and escapes every quote, so quote-heavy text can double in length;
// twice this limit plus the path and flags stays under the Windows 32767-character command line.
const QUEUE_TEXT_LIMIT = 16000;
const QUEUED = /Queued message (\S+) for thread (\S+?)\.?\s*$/m;

/** `codex queue --thread` also resolves titles; only an exact UUID is safe for bridge delivery. */
export function queueTargetRefusal(threadId) {
  return isCodexThreadUuid(threadId)
    ? null : 'The Codex queue route requires an exact session UUID; titles and aliases are not supported.';
}

/** Why the queue route cannot carry this text, or null. Only the queue route has these limits; the daemon route does not. */
export function queueRefusal(text) {
  // Windows command lines are limited to about 32 K characters.
  if (typeof text === 'string' && text.length > QUEUE_TEXT_LIMIT) {
    return `The message is too long for the Codex queue route (limit ${QUEUE_TEXT_LIMIT} characters). Send a shorter message.`;
  }
  if (typeof text === 'string' && text.includes('\0')) return 'The message contains a NUL character, which cannot be passed to the Codex queue route.';
  return null;
}

/** Deliver through `codex queue`, for terminal sessions the daemon does not hold. Never retried.
 * Class (b): one queue run that may already have queued the message, so it is never repeated. */
export function queueToTerminalThread({ threadId, text, env = process.env, signal, timeoutMs = 30000, command, args } = {}) {
  try { throwIfAborted(signal); } catch (error) { return Promise.reject(error); }
  const refusal = queueTargetRefusal(threadId) || queueRefusal(text);
  if (refusal) return Promise.reject(new Error(refusal));
  threadId = normalizeCodexThreadId(threadId);
  const effective = { ...process.env, ...env };
  let executable;
  try { executable = resolveExecutable({ effective, command }); } catch (error) { return Promise.reject(error); }
  if (process.platform === 'win32' && 2 * (text.length + executable.length + threadId.length) + 64 >= 32767) return Promise.reject(failure('The message and executable path exceed the queue command-line budget. Send a shorter message.', 'invalid_argument'));
  try { beforeWrite(signal); } catch (error) { return Promise.reject(error); }
  const unknown = detail => unconfirmedReply('Codex queue', detail);
  return new Promise((resolve, reject) => {
    try {
      execFile(executable, [...(args ?? []), 'queue', '--thread', threadId, '--message', text],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 65536, env: effective, signal }, (error, stdout, stderr) => {
          if (error) {
            // Node sets `syscall: 'spawn <file>'` on errors raised while starting the child.
            const startFailure = typeof error.syscall === 'string' && error.syscall.startsWith('spawn');
            if (startFailure) { reject(new Error('The Codex executable could not be started.')); return; }
            if (error.code === 1 && /no rollout found for thread id|No active session found matching/i.test(String(stderr))) {
              reject(failure('The selected Codex session was not found in the Codex thread store.', 'target_unavailable'));
              return;
            }
            reject(unknown('queue command did not complete'));
            return;
          }
          const match = QUEUED.exec(String(stdout));
          if (match && normalizeCodexThreadId(match[2]) === threadId) resolve({ method: 'queue', queueId: match[1] });
          else reject(unknown('unexpected queue receipt'));
        });
    } catch {
      reject(new Error('The Codex executable could not be started.'));
    }
  });
}

/** Read the CLI and daemon versions without starting anything (`codex app-server daemon version`).
 * Class (b): a diagnostic read whose failure is only a warning; doctor passes a smaller budget. */
export function readDaemonVersions({ env = process.env, command, args, timeoutMs = 5000 } = {}) {
  const effective = { ...process.env, ...env };
  let executable;
  try { executable = resolveExecutable({ effective, command }); } catch { return Promise.resolve(null); }
  return new Promise(resolve => {
    try {
      execFile(executable, args ?? ['app-server', 'daemon', 'version'],
        { windowsHide: true, timeout: timeoutMs, env: effective }, (error, stdout) => {
          if (error) { resolve(null); return; }
          try {
            const parsed = JSON.parse(stdout);
            // A short version token only: never echo arbitrary command output.
            const version = value => typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(value) ? value : null;
            resolve({ cli: version(parsed.cliVersion), server: version(parsed.appServerVersion) });
          } catch { resolve(null); }
        });
    } catch { resolve(null); }
  });
}
