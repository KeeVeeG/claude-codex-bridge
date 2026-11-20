import { connect } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { lstatSync, readdirSync } from 'node:fs';
import { readBoundedJson } from './state-files.mjs';
import { processAlive } from './state-lock.mjs';
import { homedir } from 'node:os';
import { canonicalLocalSocket } from './local-socket.mjs';
import { verifyClaudeProcess } from './claude-process.mjs';
import { beforeWrite, remainingMs, startCall, stopError, throwIfStopped } from './call-time.mjs';
import { failure } from './outcome.mjs';

// Claude Code native inbox transport. The socket and authentication remain
// stable across current releases; the peer envelope below follows the
// receiver's cross-session message format.
const MAX_FRAME_CHARS = 1_048_576;
// Class (b): connecting to a local pipe and writing at most 1 MiB to it are local operations;
// longer means the receiving window is stuck, and a write that started is then reported unconfirmed.
const MAX_CONNECT_MS = 10_000;
const MAX_WRITE_MS = 10_000;
// Connection errors that mean the inbox exists but cannot take a connection right now.
const BUSY_CODES = new Set(['EBUSY', 'EAGAIN', 'ETIMEDOUT']);
const CLAUDE_PEER_TAG = 'cross-session-message';
// `claude -p` registers as sdk-cli, including when its input is stream-json.
export const CLAUDE_ENTRYPOINTS = new Set(['claude-desktop', 'cli', 'sdk-cli', 'claude-vscode']);
// Kept out of JSON diagnostics; object spread preserves this private context
// when a resolved endpoint is passed to sendToClaude by the service.
const RESOLVED_SESSION = Symbol('resolvedClaudeSession');

// Preserve the v0.3.3 peer envelope: omitting from-mode="bypass" reintroduces
// issue #1, where Bypass recipients silently hold native bridge messages.
// This is the bridge's existing wire classification, not a detected Codex
// permission mode or a change to the recipient's settings. Explicit Claude
// inbound rules still apply. Keep nested terminators inside the outer envelope.
function claudePeerContent(message, senderName) {
  const safeName = senderName.replace(/["<>\r\n\0]/g, ' ').trim().slice(0, 64);
  const name = safeName ? ` from-name="${safeName}"` : '';
  const body = message.replace(/<\/cross-session-message\b/gi, '<\\/cross-session-message');
  return `<${CLAUDE_PEER_TAG}${name} from-mode="bypass">\n${body}\n</${CLAUDE_PEER_TAG}>`;
}

export { canonicalLocalSocket as canonicalClaudeSocket };

function checkEndpoint(socketPath) {
  if (typeof socketPath !== 'string' || !socketPath || /[\r\n\0]/.test(socketPath)) {
    throw new Error('Claude messaging socket is missing or invalid. Select the intended Claude Code session.');
  }
  if (canonicalLocalSocket(socketPath) === null) {
    throw new Error('Claude messaging endpoint must be a local named pipe on Windows or an absolute Unix socket path.');
  }
}

// Filesystem exceptions name the private registry path; none reaches a caller or a delivery record.
function registryReadError(error) {
  if (error?.reason) return error;
  return error?.code === 'ENOENT'
    ? failure('No Claude session registry was found. Open the intended conversation and check its Peer address in /status.', 'target_unavailable')
    : failure('The Claude session registry could not be read. Check access to its configured directory.', 'state_unavailable');
}

function registryLocation(registryDir) {
  const directory = resolve(registryDir ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions'));
  let stat;
  try { stat = lstatSync(directory); } catch (error) { throw registryReadError(error); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('Claude session registry must be a real directory.', 'state_unavailable');
  return directory;
}

const registryReadChecks = {
  invalid(phase, error) {
    return error ?? new Error({
      entry: 'Claude registry entry is not a regular file of the expected size.',
      open: 'Claude registry entry changed while it was opened.',
      size: 'Claude registry entry exceeds its size limit.',
      read: 'Claude registry entry changed while it was read.',
    }[phase]);
  },
  validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Claude registry entry.');
    return value;
  },
};

const readRegularJson = (file, maxBytes) => readBoundedJson(file, maxBytes, registryReadChecks);

function metadata(record) {
  return {
    sessionId: record.sessionId,
    pid: record.pid,
    name: typeof record.name === 'string' ? record.name : '',
    cwd: typeof record.cwd === 'string' ? record.cwd : '',
    status: typeof record.status === 'string' ? record.status : 'unknown',
    entrypoint: record.entrypoint,
    procStart: record.procStart,
    pidDomain: record.pidDomain,
  };
}

/** Why a registry record cannot be used, or null when it is a live native session with an inbox. */
function ineligibility(record, pid) {
  if (record.pid !== pid || !Number.isSafeInteger(record.pid) || record.pid <= 0) return 'pid';
  if (record.spare === true || record.parkedJobId) return 'inactive';
  if (!CLAUDE_ENTRYPOINTS.has(record.entrypoint) || typeof record.sessionId !== 'string' || !record.sessionId.trim()) return 'client';
  if (typeof record.procStart !== 'string' || !record.procStart || typeof record.pidDomain !== 'string') return 'metadata';
  if (!canonicalLocalSocket(record.messagingSocketPath)) return 'socket';
  if (!processAlive(record.pid)) return 'exited';
  return null;
}

function nativeRecords(directory, onUnreadable) {
  const records = [];
  let names;
  try { names = readdirSync(directory); } catch (error) { throw registryReadError(error); }
  for (const filename of names) {
    const match = /^([1-9][0-9]*)\.json$/.exec(filename);
    if (!match) continue;
    let record;
    try { record = readRegularJson(join(directory, filename), 65_536); } catch (error) {
      // A window that closed between the listing and the read is routine, not an unreadable record.
      if (error.code !== 'ENOENT') onUnreadable?.();
      continue;
    }
    const problem = ineligibility(record, Number(match[1]));
    if (!problem) records.push(record);
    else if (['pid','metadata'].includes(problem)) onUnreadable?.();
  }
  return records;
}

/** Read one known PID's registration with the same checks as a scan, without listing every window.
 * Returns { record } or { problem } ('missing', 'unreadable' or an ineligibility). */
function knownRecord(directory, pid) {
  let record;
  try { record = readRegularJson(join(directory, `${pid}.json`), 65_536); } catch (error) {
    return { problem: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  const problem = ineligibility(record, pid);
  return problem ? { problem } : { record };
}

const lastActive = record => [record.statusUpdatedAt, record.startedAt, record.updatedAt].find(Number.isSafeInteger) ?? 0;

/** One conversation can be open in several windows, for example when it was resumed in a new terminal
 * while the old one stayed open. Messages to it go to the window used last. */
function latestPerSession(records) {
  const latest = new Map();
  for (const record of records) {
    const known = latest.get(record.sessionId);
    if (!known || lastActive(record) > lastActive(known)) latest.set(record.sessionId, record);
  }
  return [...latest.values()];
}

/** List live native Claude Code sessions without exposing credentials or endpoints. */
export function discoverClaudeSessions({ registryDir, issues } = {}) {
  let directory;
  try { directory = registryLocation(registryDir); } catch (error) {
    if (error.reason === 'target_unavailable') return [];
    throw error;
  }
  let incomplete = false;
  // A registration without a usable inbox key cannot take a message, so it is not offered as live (E08).
  const usable = nativeRecords(directory, () => { incomplete = true; }).filter(record => {
    try { return Boolean(readEndpoint(directory, record, 'target', '')); } catch { return false; }
  });
  const found = latestPerSession(usable).map(metadata);
  if (incomplete) issues?.push({ source: 'claude', reason: 'state_unavailable' });
  return found;
}

function sameSessionIdentity(left, right) {
  return left.sessionId === right.sessionId && left.pid === right.pid && left.entrypoint === right.entrypoint &&
    left.procStart === right.procStart && left.pidDomain === right.pidDomain &&
    canonicalLocalSocket(left.messagingSocketPath ?? left.socketPath) === canonicalLocalSocket(right.messagingSocketPath ?? right.socketPath);
}

// Process-proof results worded for the conversation they concern. A confirmed change or exit is
// said as such; a check that could not finish says only that (FB06).
const PROOF_FAILURES = {
  target: {
    invalid: ['The selected Claude Code conversation has a registration for another computer or invalid creation metadata. Ask the user to reopen it.', 'target_unavailable'],
    changed: ['The selected Claude Code conversation\'s registration does not match its running process; its window was probably restarted. Select it again with list_claude_sessions.', 'target_changed'],
    exited: ['The selected Claude Code conversation is no longer open.', 'target_unavailable'],
    unverified: ['Could not verify the selected Claude Code conversation in time. Retry the same call.', 'target_unverified'],
    unavailable: [null, 'identity_check_unavailable'],
  },
  caller: {
    invalid: ['This Claude Code conversation has a registration for another computer or invalid creation metadata. Reload the bridge MCP server in this conversation.', 'caller_invalid'],
    changed: ['This Claude Code conversation\'s registration does not match its running process. Reload the bridge MCP server in this conversation.', 'caller_invalid'],
    exited: ['The Claude Code process that started this bridge has exited. Reload the bridge MCP server from the intended conversation.', 'caller_invalid'],
    unverified: ['Could not verify this Claude Code conversation in time. Retry the same call.', 'caller_unverified'],
    unavailable: [null, 'identity_check_unavailable'],
  },
};

/** Prove that the registered PID still belongs to the registered process, fresh on every call:
 * a PID or a remembered earlier proof does not show that the same process is still alive. */
async function proveProcess(record, role, { signal, probe }) {
  try { await verifyClaudeProcess(record, { signal, ...(probe ? { probe } : {}) }); } catch (error) {
    const known = PROOF_FAILURES[role][error.kind];
    if (!known) throw error;
    throw failure(known[0] ?? error.message, known[1], { kind: error.kind });
  }
}

/** Read the inbox key and confirm the registration did not change meanwhile. Synchronous and
 * sub-millisecond, so it can run immediately before an authenticated write. */
function readEndpoint(directory, record, role, changedMessage) {
  const socketPath = canonicalLocalSocket(record.messagingSocketPath);
  const keyHash = createHash('sha256').update(socketPath).digest('hex');
  let key;
  const keyReason = role === 'caller' ? 'caller_invalid' : 'target_unavailable';
  try { key = readRegularJson(join(directory, `${record.pid}.${keyHash}.key`), 4096); } catch (error) {
    throw error.code === 'ENOENT'
      ? failure('The chosen Claude session has published no inbox key. Check its Peer address in /status.', keyReason)
      : failure('The inbox key of the chosen Claude session could not be read as a regular key file. Check access to the session registry.', keyReason);
  }
  if (typeof key.peerToken !== 'string' || !/^[a-f0-9]{32}$/.test(key.peerToken)) {
    throw failure('The inbox key of the chosen Claude session has an unsupported format. Update the bridge to a version that supports this Claude Code release.', keyReason);
  }
  if ((key.procStartFt ?? key.procStart) !== record.procStart || key.pidDomain !== record.pidDomain) {
    throw failure('Claude inbox key does not match the selected session process.', role === 'caller' ? 'caller_invalid' : 'target_changed');
  }
  // Catch a restart or registry replacement that occurred during the key read.
  let current;
  try { current = readRegularJson(join(directory, `${record.pid}.json`), 65_536); } catch { current = null; }
  if (!current || ineligibility(current, record.pid) || !sameSessionIdentity(current, record) || !processAlive(record.pid)) {
    throw failure(changedMessage, role === 'caller' ? 'caller_changed' : 'target_changed');
  }
  const endpoint = Object.freeze({ ...metadata(record), socketPath, token: key.peerToken });
  return { ...endpoint, [RESOLVED_SESSION]: Object.freeze({ directory, endpoint }) };
}

/** Resolve one live native Claude Code session. Its key is used only for identity checks
 * and sends, never copied into bridge configuration or included in diagnostics.
 */
export async function resolveClaudeSession(sessionId, { registryDir, signal, probe } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw failure('An explicit Claude session ID is required.', 'invalid_argument');
  let directory;
  try { directory = registryLocation(registryDir); } catch (error) {
    if (error.reason === 'target_unavailable') throw failure('The chosen Claude Code session is unavailable or has no live inbox.', 'target_unavailable');
    throw error;
  }
  let unreadable = false;
  const records = nativeRecords(directory, () => { unreadable = true; }).filter(record => record.sessionId === sessionId);
  if (!records.length && unreadable) throw failure('Some Claude registrations could not be read. Check access to the session registry before selecting this conversation.', 'state_unavailable');
  return selectEndpoint(directory, records, { signal, probe, connect: records.length > 1 });
}

async function selectEndpoint(directory, records, { signal, probe, connect, skipPid, known }) {
  let first;
  for (const record of records.sort((a,b) => lastActive(b) - lastActive(a) || a.pid - b.pid)) {
    if (record.pid === skipPid) continue;
    throwIfStopped(signal);
    try {
      let endpoint = known && sameSessionIdentity(record, known) ? known : undefined;
      if (!endpoint) {
        await proveProcess(record, 'target', { signal, probe });
        endpoint = readEndpoint(directory, record, 'target', 'Claude session changed while resolving its inbox. Select its current conversation and retry.');
      }
      if (connect) await probeClaudeInbox({ socketPath: endpoint.socketPath, signal, timeoutMs: Math.min(1000, remainingMs(signal)) });
      return endpoint;
    } catch (error) { throwIfStopped(signal); first ??= error; }
  }
  throw first ?? failure('The chosen Claude Code session is unavailable or has no live inbox.', 'target_unavailable');
}

// One scan for all groups; never advertise a PID registration as a verified inbox. The
// connectivity probe sends no authentication or message and cannot test the receiver's policy.
export async function verifiedClaudeSessions({ registryDir, signal, probe, skipPid, known, firstOnly = false, budgetMs = 8000 } = {}) {
  const sessions = [], issues = [];
  const details = {};
  let directory, records, candidates = 0;
  // One issue per reason, with the first observed cause for that reason.
  const issue = (reason, message) => {
    if (!issues.some(item => item.reason === reason)) issues.push({ source: 'claude', reason });
    details[reason] ??= message;
  };
  try {
    directory = registryLocation(registryDir);
    records = nativeRecords(directory, () => issue('state_unavailable', 'Some Claude registrations could not be read. Check access to the session registry.'));
  } catch (error) {
    const known = registryReadError(error);
    issue(known.reason, known.message);
    return { sessions, issues, details, candidates };
  }
  const groups = Map.groupBy ? Map.groupBy(records, r => r.sessionId) : records.reduce((groups,r) => {
    if (!groups.has(r.sessionId)) groups.set(r.sessionId, []); groups.get(r.sessionId).push(r); return groups;
  }, new Map());
  candidates = groups.size;
  const budget = startCall({ cancelSignal: signal, deadlineMs: Math.min(remainingMs(signal), budgetMs) });
  try {
    for (const group of groups.values()) {
      try {
        if (group.every(r => r.pid === skipPid)) continue;
        const endpoint = await selectEndpoint(directory, group, { signal: budget.signal, probe, connect: true, skipPid, known });
        sessions.push(metadata(endpoint));
        if (firstOnly) break;
      } catch (error) {
        throwIfStopped(signal);
        if (error.code === 'BRIDGE_DEADLINE') { issue('target_unverified','Some Claude inboxes were not checked within the diagnostic time budget. Availability is inconclusive.'); break; }
        issue(error.reason ?? 'target_unverified', error.message);
      }
    }
  } finally { budget.dispose(); }
  return { sessions, issues, details, candidates };
}

const DESTINATION_CHANGED = 'Claude destination changed before the message was written. Select its current conversation and retry.';

/** The pre-write check of a resolved destination: the chosen window itself, so the same conversation
 * opened in another window does not redirect a send under way. A registration that already disagrees
 * fails at once, before the process check (FB05); the key and registration are reread last. */
async function verifyResolvedSession(resolved, { socketPath, token, sessionId }, { signal, probe }) {
  const expected = resolved.endpoint;
  if (canonicalLocalSocket(socketPath) !== expected.socketPath || token !== expected.token || sessionId !== expected.sessionId) {
    throw failure('Claude destination differs from the selected session. Select its current conversation and retry.', 'invalid_argument');
  }
  const { record } = knownRecord(resolved.directory, expected.pid);
  if (!record || !sameSessionIdentity(record, expected)) throw failure(DESTINATION_CHANGED, 'target_changed');
  await proveProcess(record, 'target', { signal, probe });
  const current = readEndpoint(resolved.directory, record, 'target', DESTINATION_CHANGED);
  if (!sameSessionIdentity(current, expected) || current.token !== expected.token) throw failure(DESTINATION_CHANGED, 'target_changed');
}

const CALLER_PROBLEMS = {
  missing: 'Cannot identify the calling Claude Code session from its direct parent and socket. Reload its bridge MCP server; launch it directly without an intermediary shell.',
  pid: 'Cannot identify the calling Claude Code session from its direct parent and socket. Reload its bridge MCP server; launch it directly without an intermediary shell.',
  unreadable: 'The registration of the Claude Code conversation that started this bridge could not be read. Reload the bridge MCP server in this conversation.',
  client: 'The process that started this bridge is not registered as a supported Claude Code client.',
  inactive: 'This Claude process is unassigned or parked. Open the active conversation before calling the bridge.',
  metadata: 'The registration of this Claude Code conversation has no process creation metadata. Update Claude Code, then reload the bridge MCP server.',
  socket: 'The registration of this Claude Code conversation has no valid messaging socket. Reload the bridge MCP server in this conversation.',
  exited: 'The Claude Code process that started this bridge has exited. Reload the bridge MCP server from the intended conversation.',
};

function callerDirectory(registryDir) {
  try { return registryLocation(registryDir); } catch (error) {
    if (error.reason === 'target_unavailable') throw failure('Claude caller is unavailable. Open the bridge in the intended Claude Code session.', 'caller_invalid');
    throw error;
  }
}

/** Identify the Claude Code conversation that spawned this bridge instance.
 * Only the direct registered parent is accepted. An exported socket must match
 * that parent; neither project paths nor recency identify a calling session.
 */
export async function resolveClaudeCaller({ registryDir, parentPid = process.ppid,
  socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET, signal, probe } = {}) {
  const directory = callerDirectory(registryDir);
  const ownSocket = socketPath === undefined ? null : canonicalLocalSocket(socketPath);
  if (socketPath !== undefined && !ownSocket) throw failure('Claude caller exported an invalid messaging socket. Reload the bridge in that Code session.', 'caller_invalid');
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw failure('Claude caller has no valid direct parent process. Reload the bridge from the intended Code session.', 'caller_invalid');
  }
  // The caller is its own parent process, even when its conversation is also open in another window.
  const { record, problem } = knownRecord(directory, parentPid);
  if (!record) throw failure(CALLER_PROBLEMS[problem] ?? CALLER_PROBLEMS.missing, 'caller_invalid');
  if (ownSocket && canonicalLocalSocket(record.messagingSocketPath) !== ownSocket) {
    throw failure('The messaging socket exported to this bridge does not match the Claude Code conversation that started it. Reload the bridge MCP server in this conversation.', 'caller_invalid');
  }
  await proveProcess(record, 'caller', { signal, probe });
  return readEndpoint(directory, record, 'caller', 'Claude caller changed while resolving its identity. Reload the bridge in that Code session.');
}

/** The conversation currently registered for this bridge's parent, read without any process check.
 * Used to notice that a queued call outlived the conversation that issued it (A201). */
export function callerSessionId({ registryDir, parentPid = process.ppid } = {}) {
  try { return knownRecord(registryLocation(registryDir), parentPid).record?.sessionId ?? null; } catch { return null; }
}
function checkToken(token) {
  if (typeof token !== 'string' || !token.trim() || token.length > 4096 || /[\r\n\0]/.test(token)) {
    throw new Error('Claude messaging token is missing or invalid. Select the intended Claude Code session.');
  }
}

/** Test local inbox connectivity without authenticating or sending a message. Class (b): a local
 * connect that only diagnostics use; a slow accept is reported as a warning, never as a failure. */
export async function probeClaudeInbox({ socketPath, signal, timeoutMs = 1500 }) {
  throwIfStopped(signal);
  checkEndpoint(socketPath);
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = connect({ path: socketPath });
    let finished = false;
    const timeout = setTimeout(() => finish(failure('A Claude inbox did not accept a local connection in time. Its availability is inconclusive.',
      'target_unverified')), timeoutMs);
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) rejectProbe(error);
      else resolveProbe();
    }
    function onAbort() { finish(stopError(signal)); }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    socket.once('connect', () => finish());
    socket.once('error', error => finish(BUSY_CODES.has(error.code) ? failure('The selected Claude inbox is busy. Retry the same call.', 'target_busy')
      : ['EACCES', 'EPERM'].includes(error.code) ? failure('Access to the selected Claude inbox was denied. Run the bridge as the same user as that Claude session.', 'target_unavailable')
      : failure('The selected Claude inbox did not accept a connection. Check its Peer address in /status.', 'target_unavailable')));
    socket.once('close', () => {
      if (!finished) finish(new Error('The selected Claude inbox closed during its connectivity check.'));
    });
  });
}

/** Write one authenticated message. This protocol does not acknowledge delivery
 * to the model: a successful result confirms only the completed transport write.
 * A later reply is a separate, optional bridge message.
 */
export async function sendToClaude({ socketPath, token, message, senderName = 'Codex desktop bridge', sessionId, signal,
  probe, [RESOLVED_SESSION]: resolved }) {
  throwIfStopped(signal);
  checkEndpoint(socketPath);
  checkToken(token);
  if (typeof message !== 'string' || !message.trim()) throw new Error('Claude message must be nonempty text.');
  if (typeof senderName !== 'string' || !senderName.trim() || senderName.length > 200 || /[\r\n\0]/.test(senderName)) {
    throw new Error('senderName must be one line of text, at most 200 characters.');
  }
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200)) {
    throw new Error('sessionId must identify the explicitly selected Claude session.');
  }
  const messageId = randomUUID();
  const authLine = JSON.stringify({ type: 'auth', token });
  const messageLine = JSON.stringify({
    type: 'user',
    uuid: messageId,
    priority: 'next',
    from: senderName,
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    message: { role: 'user', content: claudePeerContent(message, senderName) },
  });
  // The receiver checks the accumulated UTF-16 string before splitting lines,
  // so limit the entire write, including the auth line and delimiters.
  if (authLine.length + messageLine.length + 2 > MAX_FRAME_CHARS) {
    throw new Error('Claude message exceeds the inbox transport limit. Send a shorter message.');
  }
  const payload = `${authLine}\n${messageLine}\n`;
  return await new Promise((resolveSend, rejectSend) => {
    let finished = false;
    let writeFinished = false;
    let writeAttempted = false;
    let remoteEnded = false;
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    // A slow accept under load proves nothing about the session: it is busy, not gone.
    let timer = setTimeout(() => finish(failure('The selected Claude Code session did not accept the connection in time. Retry the same call.', 'target_busy')),
      Math.max(1, Math.min(MAX_CONNECT_MS, remainingMs(signal))));

    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) {
        error.deliveryUnknown = writeAttempted;
        rejectSend(error);
      }
      else resolveSend({ status: 'written', messageId, acknowledged: false });
    }

    function onAbort() { finish(stopError(signal)); }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    socket.on('error', error => {
      // Do not include the endpoint, token, payload, or OS error text in logs.
      const code = typeof error.code === 'string' ? error.code : 'CONNECTION_ERROR';
      finish(writeAttempted ? new Error(`The connection to the selected Claude Code session failed during the write (${code}).`)
        : BUSY_CODES.has(code) ? failure(`The selected Claude Code session is busy and did not take the connection (${code}). Retry the same call.`, 'target_busy')
        : failure(`Cannot connect to the selected Claude Code session (${code}). Select it again if that session restarted.`, 'target_unavailable'));
    });
    socket.once('connect', async () => {
      if (finished) return;
      // Connected: the checks below are bounded by the call deadline, not by the connect timer.
      clearTimeout(timer);
      try {
        // CLI /clear and /resume can replace the conversation while preserving
        // the PID, socket, and token. Recheck after connecting, before writing
        // any bytes. The native protocol has no atomic session-bound delivery
        // or acknowledgement, so this cannot cover a switch after this check.
        if (resolved) await verifyResolvedSession(resolved, { socketPath, token, sessionId }, { signal, probe });
        // Immediately before the write: a cancelled call or one past its deadline never writes.
        beforeWrite(signal);
      } catch (error) { finish(error); return; }
      if (finished) return;
      writeAttempted = true;
      timer = setTimeout(() => finish(new Error('The selected Claude Code session did not finish receiving the message in time.')), MAX_WRITE_MS);
      socket.end(payload);
    });
    socket.once('finish', () => {
      writeFinished = true;
      if (remoteEnded) finish();
    });
    socket.on('data', () => {
      // No response frames are defined by the own-child inbox protocol.
    });
    socket.once('end', () => {
      remoteEnded = true;
      if (writeFinished) finish();
    });
    socket.once('close', hadError => {
      if (finished) return;
      if (!hadError && writeFinished && remoteEnded) finish();
      else if (writeAttempted) finish(new Error('Claude inbox closed before the transport write completed.'));
      else finish(failure('The selected Claude Code session closed the connection before the message was written.', 'target_unavailable'));
    });
  });
}
