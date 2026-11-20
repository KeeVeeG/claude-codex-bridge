import crypto from 'node:crypto';
import { publicDelivery } from './delivery.mjs';
import { stateDirectoryWarning, stateDirectoryPrivacyWarning } from './state-directory.mjs';
import { legacyEnvironmentWarnings } from './legacy-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverClaudeSessions, resolveClaudeSession, resolveClaudeCaller, sendToClaude, probeClaudeInbox } from './claude-sessions.mjs';
import { ensureCall, inquire, INQUIRY_ATTEMPT_MS, monotonicNow, remainingMs, startCall, throwIfStopped } from './call-time.mjs';
import { REASONS, errorOutcome, failure, outcome, sendErrorText } from './outcome.mjs';
import { listCodexTools, listCodexChats, sendToCodex } from './codex-desktop.mjs';
import { publishCodexHost, getCodexHosts } from './codex-host.mjs';
import { canonicalLocalSocket, localSocketPresence } from './local-socket.mjs';
import { defaultStateDir, ledgerAt, ownerId } from './store.mjs';
import { createSession, lookupMessage, recordMessage, finishMessage, listMessages, retainSettlement, checkSettlementCapacity, repairSettlement } from './call-store.mjs';
import { readComposerEnterBehavior } from './codex-settings.mjs';
import { openDaemon, listTerminalThreads, readDaemonVersions, readTerminalThread, sendToTerminalThread, normalizeCodexThreadId,
  queueToTerminalThread, queueRefusal, queueTargetRefusal, TerminalNotLoadedError, DaemonUnavailableError, NOT_RUNNING_MESSAGE, scrubPaths } from './codex-daemon.mjs';
import { codexPeerContent } from './codex-peer.mjs';
import { validateSshHostAlias } from './codex-ssh.mjs';

export function codexThreadId(metadata = {}) {
  let turn = metadata['x-codex-turn-metadata'];
  if (typeof turn === 'string') {
    try { turn = JSON.parse(turn); } catch { throw callerMetadataError('Invalid Codex turn metadata'); }
  }
  if (turn !== undefined && (turn === null || typeof turn !== 'object' || Array.isArray(turn))) throw callerMetadataError('Invalid Codex turn metadata');
  const candidates = [turn?.thread_id, metadata['openai/threadId'], metadata['openai/thread_id'],
    metadata['codex/threadId'], metadata.codexThreadId, metadata.codex_thread_id, metadata.threadId,
    metadata.thread_id, metadata.thread?.id].filter(v => v !== undefined);
  if (candidates.some(v => typeof v !== 'string' || !v.trim())) throw callerMetadataError('Invalid Codex task identity in MCP metadata');
  const identities = [...new Set(candidates.map(normalizeCodexThreadId))];
  if (identities.length > 1) throw callerMetadataError('Conflicting Codex task identities in MCP metadata');
  // A server can serve multiple tasks. Its startup CODEX_THREAD_ID identifies
  // the host context, not necessarily the task making this particular call.
  const threadId = identities[0];
  if (!threadId) throw callerMetadataError('The calling Codex task identity is unavailable in this tool call.');
  return ownerId(threadId);
}

export function codexIdentity(metadata = {}, env = process.env) {
  const threadId = codexThreadId(metadata);
  if (!env.CODEX_APP_TOOLS_PIPE_PATH) throw callerMetadataError('Codex Desktop did not provide its local app-tools pipe');
  return { threadId, pipePath: env.CODEX_APP_TOOLS_PIPE_PATH };
}

function settings(context) {
  const env = context.env || process.env;
  return { env, sshSpawn: context.sshSpawn, platform: context.platform ?? process.platform,
    stateDir: context.stateDir || defaultStateDir({ env }),
    registryDir: context.registryDir || env.CLAUDE_CODEX_BRIDGE_REGISTRY_DIR ||
      (env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, 'sessions') : undefined),
    daemon: context.daemon,
    daemonVersion: context.daemonVersion,
    desktop: context.desktop,
    queue: context.queue,
  };
}

function sshHost(config) {
  if (config.platform !== 'darwin' || config.env.CLAUDE_CODEX_BRIDGE_SSH_HOST === undefined) return null;
  return { sshHostAlias: validateSshHostAlias(config.env.CLAUDE_CODEX_BRIDGE_SSH_HOST),
    ...(config.sshSpawn ? { spawnImpl: config.sshSpawn } : {}) };
}

/** A Desktop-only user, without the Codex CLI or a running daemon, should not see a terminal warning on every listing;
 * bridge_doctor still reports it. */
export function shouldReportTerminalUnavailable(error, desktopSucceeded) {
  return !(desktopSucceeded === true && error instanceof DaemonUnavailableError &&
    (/executable was not found/i.test(error.message) || error.message === NOT_RUNNING_MESSAGE));
}

function callerMetadataError(message) {
  return failure(message, 'caller_invalid', { application: 'codex' });
}

const checkCancellation = throwIfStopped;

/** Run `action` on a new daemon connection and close it, unless `keep(result, connection)` takes it over. */
async function withDaemon(config, signal, action, { timeoutMs, keep } = {}) {
  const connection = await openDaemon({ env: config.env, signal, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(config.daemon ?? {}) });
  let kept = false;
  try {
    const result = await action(connection);
    kept = keep?.(result, connection) === true;
    return result;
  } finally { if (!kept) connection.close(); }
}

// Class (a): a repeatable daemon check gets the shared 3 × 15 s attempts, each on a fresh proxy.
function daemonInquiry(config, signal, action, { keep, budgetMs } = {}) {
  const until = budgetMs === undefined ? undefined : monotonicNow() + budgetMs;
  const attemptMs = Math.min(config.daemon?.timeoutMs ?? INQUIRY_ATTEMPT_MS, INQUIRY_ATTEMPT_MS);
  return inquire(async attempt => {
    try { return await withDaemon(config, attempt.signal, connection => action(connection, attempt), { timeoutMs: attempt.timeoutMs, keep }); }
    catch (error) {
      if (error.code === 'DAEMON_TIMEOUT') error.transient = true;
      throw error;
    }
  }, { signal, attemptMs, until });
}

/** Creation origin does not identify a thread's current client. A stored, unloaded
 * thread needs an explicit transport; a loaded daemon thread is directly addressable.
 * The connection that found a loaded thread is kept in `held` for its send (O02). */
async function resolveTerminalTarget(threadId, transport, config, signal, held) {
  if (!['auto', 'desktop', 'terminal'].includes(transport)) throw failure('Invalid Codex transport. Choose auto, desktop, or terminal.', 'invalid_argument');
  if (transport === 'desktop') return false;
  const keep = (thread, connection) => {
    if (!held || !thread || thread.status?.type === 'notLoaded') return false;
    held.connection?.close();
    held.connection = connection;
    return true;
  };
  try {
    const thread = await daemonInquiry(config, signal, (connection, attempt) =>
      readTerminalThread(connection, threadId, { signal: attempt.signal, timeoutMs: attempt.timeoutMs }), { keep });
    if (!thread) {
      if (transport === 'terminal') throw failure('The selected Codex session was not found in the Codex daemon thread store.', 'target_unavailable');
      return false;
    }
    const queueRoute = thread.status?.type === 'notLoaded';
    if (queueRoute && transport === 'auto') throw failure('The selected Codex session is not loaded in the daemon, so its current client cannot be determined. Set transport to desktop for Codex Desktop or terminal for Codex CLI. No message was sent.', 'target_unavailable');
    return { queueRoute, allowQueue: transport === 'terminal' };
  } catch (error) {
    checkCancellation(signal);
    // Explicit terminal selection also supports a standalone CLI without a running daemon.
    // The queue command still enforces the kill switch and validates the exact thread ID.
    if (error.inconclusive) throw failure('The Codex daemon did not answer the routing check in time. Retry the same call.', 'route_unverified');
    if (error instanceof DaemonUnavailableError) return transport === 'terminal'
      ? { queueRoute: true, queueOnly: true, allowQueue: true } : false;
    throw error;
  }
}

export function hasCodexCallerMetadata(meta) {
  return meta != null && ['x-codex-turn-metadata', 'openai/threadId', 'openai/thread_id',
    'codex/threadId', 'codexThreadId', 'codex_thread_id', 'threadId', 'thread_id', 'thread'].some(key => Object.hasOwn(meta, key));
}

async function identifyCaller(context, config) {
  const meta = context.metadata || {};
  const hasCodexMetadata = hasCodexCallerMetadata(meta);
  const notClaude = !config.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (notClaude && config.env.CODEX_APP_TOOLS_PIPE_PATH && hasCodexMetadata) {
    return { kind: 'codex', transport: 'desktop', ...codexIdentity(meta, config.env) };
  }
  if (notClaude && hasCodexMetadata) {
    const threadId = codexThreadId(meta);
    // The host supplies identity per call. Historical originator/source fields and
    // daemon availability cannot verify which client currently owns this caller.
    return { kind: 'codex', transport: 'terminal', threadId };
  }
  const endpoint = await resolveClaudeCaller({ registryDir: config.registryDir, parentPid: context.parentPid ?? process.ppid,
    socketPath: config.env.CLAUDE_CODE_MESSAGING_SOCKET, signal: context.signal, probe: context.processProbe });
  // A call admitted for one conversation never runs as another after the window switched (A201).
  if (context.callerSessionId === null) throw failure('Could not identify this Claude Code conversation when the request arrived. Retry the same call from the intended conversation.', 'caller_unverified');
  if (context.callerSessionId !== undefined && endpoint.sessionId !== context.callerSessionId) {
    throw failure('This Claude Code window switched to another conversation while the call was waiting. Repeat the call from the intended conversation.', 'caller_changed');
  }
  return { kind: 'claude', endpoint };
}

async function caller(context, config, { publish = false } = {}) {
  const who = await identifyCaller(context, config);
  // Catalog and history are read-only. Ordinary sends publish only after their replay lookup;
  // an explicit notice retry can publish here. Terminal callers have no endpoint to publish.
  if (publish && who.kind === 'codex' && who.transport === 'desktop') {
    await publishCodexHost({ signal: context.signal, stateDir: config.stateDir, pipePath: who.pipePath, threadId: who.threadId });
  }
  return who;
}

function publicThread({ thread_id, title = '', status = 'unknown', cwd = '', host_id, source }) {
  return { thread_id, title, status, cwd, host_id, source };
}

function sender(who) {
  return who.kind === 'codex'
    ? { kind: 'codex', id: who.threadId }
    : { kind: 'claude', id: who.endpoint.sessionId };
}

function senderLabel(id) {
  // Claude's native `from` field is a short, single-line display label. The
  // message notice below carries the complete, escaped reply address.
  return `Codex task ${id.replace(/[\r\n\0]/g, ' ').slice(0, 180)}`;
}

function senderLedgerId(who) {
  // Preserve existing Codex task ledgers. Prefix Claude IDs so their ledgers
  // cannot collide with a Codex task or depend on a prior one-to-one pairing.
  return who.kind === 'codex' ? who.threadId : `claude:${who.endpoint.sessionId}`;
}

function senderLedger(who, config, signal) {
  const threadId = senderLedgerId(who);
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  // A stable user-owned directory avoids binding a conversation's history to
  // the plugin cache or whichever project happened to launch its MCP server.
  return createSession({ stateDir: config.stateDir, threadId, cwd: config.stateDir }, signal);
}

// Desktop probes are repeatable reads. Bound the entire search as well as each transient attempt.
const DESKTOP_TIMEOUTS = { catalogMs: INQUIRY_ATTEMPT_MS, listMs: INQUIRY_ATTEMPT_MS, budgetMs: 3 * INQUIRY_ATTEMPT_MS };

// The context each Desktop pipe last accepted in this MCP process. A send reuses it instead of
// proving it again with chat discovery, so a stalled discovery tool cannot block delivery.
const acceptedContexts = new Map();

/** Find a saved Desktop endpoint and context, grouping records by pipe. Pipes that no
 * longer exist are skipped without a connection, and a pipe that stalls is not retried with its
 * other contexts. Returns { host, catalog, chats } on success and always a report of the rest.
 */
async function selectDesktopHost(hosts, config, signal, { limit = 1, reuse = false, compatible } = {}) {
  const timeouts = { ...DESKTOP_TIMEOUTS, ...(config.desktop ?? {}) };
  const deadline = monotonicNow() + Math.min(timeouts.budgetMs, remainingMs(signal));
  // A wait the budget cut short proves nothing about the app: its timeout counts as unchecked, not stalled.
  const read = (cap, action) => inquire(async attempt => {
    try { return await action(attempt); } catch (error) {
      if (error.code === 'DESKTOP_TIMEOUT') error.transient = true;
      throw error;
    }
  }, { signal, until: deadline, attemptMs: cap });
  const report = { budgetMs: timeouts.budgetMs, gone: 0, stalled: 0, rejected: 0, incompatible: 0, compatible: 0,
    unchecked: 0, errors: [], tools: undefined };
  const pipes = new Map();
  for (const host of hosts) {
    const pipePath = host && canonicalLocalSocket(host.pipePath);
    if (!pipePath) continue;
    if (!pipes.has(pipePath)) pipes.set(pipePath, []);
    if (typeof host.threadId === 'string' && host.threadId.trim() && !pipes.get(pipePath).includes(host.threadId)) {
      pipes.get(pipePath).push(host.threadId);
    }
  }
  const present = localSocketPresence();
  const failed = error => {
    checkCancellation(signal);
    if (error.code === 'ENDPOINT_GONE') report.gone++;
    else if (error.inconclusive || error.code === 'DESKTOP_TIMEOUT') report[monotonicNow() >= deadline - 1 ? 'unchecked' : 'stalled']++;
    else if (error.code === 'CONTEXT_REJECTED') report.rejected++;
    else report.errors.push(scrubPaths(String(error.message)).slice(0, 200));
  };
  for (const [pipePath, contexts] of pipes) {
    if (monotonicNow() >= deadline) { report.unchecked += Math.max(1, contexts.length); continue; }
    if (present(pipePath) === false) { report.gone++; continue; }
    let catalog;
    try { catalog = await read(timeouts.catalogMs, attempt => listCodexTools(pipePath, { signal: attempt.signal, timeoutMs: attempt.timeoutMs })); }
    catch (error) { failed(error); continue; }
    report.tools = catalog.map(tool => String(tool?.name ?? ''));
    if (compatible && !compatible(catalog)) { report.incompatible++; continue; }
    report.compatible++;
    const accepted = contexts.includes(acceptedContexts.get(pipePath)) ? acceptedContexts.get(pipePath) : undefined;
    if (reuse && accepted) return { host: { pipePath, threadId: accepted }, catalog, report };
    for (const threadId of accepted ? [accepted, ...contexts.filter(id => id !== accepted)] : contexts) {
      if (monotonicNow() >= deadline) { report.unchecked++; continue; }
      try {
        const chats = await read(timeouts.listMs, attempt => listCodexChats({ pipePath, contextThreadId: threadId, limit, signal: attempt.signal, catalog, timeoutMs: attempt.timeoutMs }));
        acceptedContexts.set(pipePath, threadId);
        return { host: { pipePath, threadId }, catalog, chats, report };
      } catch (error) {
        // Only a rejection disproves the context. A stalled or cut-short listing says nothing about
        // it, and dropping it there would let a doctor or discovery call block the next send.
        if (error.code === 'CONTEXT_REJECTED' && acceptedContexts.get(pipePath) === threadId) acceptedContexts.delete(pipePath);
        failed(error);
        // Every context on a stalled app waits for the same stuck tool execution, so trying the
        // pipe's other contexts only multiplies the wait. A cut wait means the budget is spent.
        if (error.inconclusive || error.code === 'DESKTOP_TIMEOUT') break;
      }
    }
  }
  return { report };
}

/** One sentence per cause, most actionable first, so a stale record never hides a stalled app. */
function desktopFailure(report) {
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const causes = [];
  if (report.stalled) causes.push('Codex Desktop is running but did not answer in time. Retry the same call; restart Codex Desktop only if it keeps not answering.');
  if (report.rejected) causes.push(`Codex Desktop rejected ${plural(report.rejected, 'saved task context')}, probably of removed tasks; call bridge_doctor once from an open Codex Desktop task to register it.`);
  if (report.incompatible) causes.push('A running Codex Desktop does not expose compatible discovery and message tools; update Codex Desktop.');
  if (report.errors.length) causes.push(`Endpoint errors: ${[...new Set(report.errors)].join(' ')}`);
  if (report.unchecked) causes.push(`${plural(report.unchecked, 'saved endpoint record')} could not be checked within ${report.budgetMs / 1000} s.`);
  if (report.gone) causes.push(`${plural(report.gone, 'saved endpoint')} belong${report.gone === 1 ? 's' : ''} to earlier Codex Desktop launches.${causes.length ? ''
    : ' Open a Codex Desktop task with the bridge enabled; its bridge server registers the current endpoint when it starts.'}`);
  return causes.length ? causes.join(' ') : 'No saved Codex Desktop endpoint has a usable task context.';
}

async function desktopRoute(who, config, signal, options) {
  checkCancellation(signal);
  if (who.kind === 'codex' && who.transport === 'desktop') return { host: { pipePath: who.pipePath, threadId: who.threadId } };
  const hosts = await getCodexHosts({ stateDir: config.stateDir, signal });
  if (hosts.length === 0) throw failure('Codex Desktop has not registered its bridge endpoint yet. Open Codex with the plugin enabled, or run the installer from an open Codex task.', 'route_unavailable');
  const selected = await selectDesktopHost(hosts, config, signal, options);
  if (!selected.host) throw failure(`No registered Codex Desktop endpoint accepted a task context. ${desktopFailure(selected.report)}`, desktopReason(selected.report));
  return selected;
}

function inspectStateDirectory(stateDir) {
  const directory = path.resolve(stateDir);
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid state directory');
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    // A writable volume can still reject the exclusive hard link used by every released writer.
    // Only probe an existing state directory; nothing is created in an unselected parent.
    const probe = fs.mkdtempSync(path.join(directory, '.link-check-'));
    const file = path.join(probe, 'source'), link = path.join(probe, 'linked');
    try {
      fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
      try { fs.linkSync(file, link); } catch {
        return { status: 'fail', detail: 'The state directory cannot create the hard links required for writer locks. Use a private writable local volume with hard-link support in both apps; stop all bridge sessions before moving state.' };
      }
    } finally {
      for (const entry of [link, file]) try { fs.unlinkSync(entry); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      fs.rmdirSync(probe);
    }
    return { status: 'pass', detail: 'The shared state directory supports reading, writing and writer locks.' };
  } catch (error) {
    if (error.code !== 'ENOENT') return { status: 'fail', detail: 'The shared state location must be a readable, writable real directory. Check its configuration and permissions.' };
  }
  let ancestor = path.dirname(directory);
  for (;;) {
    try {
      const stat = fs.lstatSync(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid state parent');
      fs.accessSync(ancestor, fs.constants.R_OK | fs.constants.W_OK);
      return { status: 'warning', detail: 'The state directory does not exist yet. Its parent is accessible; an authorized send or host registration will create it.' };
    } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) {
        return { status: 'fail', detail: 'The shared state directory cannot be created under its configured parent. Check the location and permissions.' };
      }
      ancestor = path.dirname(ancestor);
    }
  }
}

/** Diagnose local configuration and transports, registering only verified Desktop
 * callers. Never send prompts or return credentials and local addresses.
 */
const issuesOf = checks => checks.filter(check => check.status !== 'pass')
  .map(({ name, status, reason }) => ({ check: name, status, reason: reason ?? 'internal_error' }));

/** Why no Desktop endpoint worked: an app that did not answer in time is unverified, not gone (F07). */
function desktopReason(report) {
  if (!report.compatible && report.incompatible) return 'protocol_incompatible';
  if (report.stalled || report.unchecked) return 'route_unverified';
  return 'route_unavailable';
}

// Diagnostic sub-budgets: each group of checks ends inconclusive, never false, when its budget runs out.
const DOCTOR_BUDGETS = { callerMs: 20_000, claudeInboxMs: 4500 };
const DOCTOR_DAEMON_BUDGET_MS = 6000;

async function doctorCodexChecks(context, config, who, signal) {
  const checks = [];
  const add = (name, status, detail, reason) => checks.push({ name, status, detail, ...(status === 'pass' ? {} : { reason }) });
  const found = { acceptedContext: false, daemonReachable: false, terminalSessions: 0 };
  if (config.platform === 'darwin' && config.env.CLAUDE_CODEX_BRIDGE_SSH_HOST !== undefined) {
    add('codex_registry', 'pass', 'The configured SSH route does not use the local Desktop registry or daemon.');
    try {
      const chats = await listCodexChats({ ...sshHost(config), limit: 50, signal, timeoutMs: 6000 });
      add('codex_tools', 'pass', 'The configured SSH host accepts public app-server discovery.');
      found.acceptedContext = chats.some(chat => chat.status === 'idle');
      add('codex_context', found.acceptedContext ? 'pass' : 'warning', found.acceptedContext
        ? 'The configured SSH host has a loaded idle chat.'
        : 'No idle chat was found in the bounded loaded-chat catalog. Open the intended idle chat on the configured SSH host.', 'target_unavailable');
    } catch (error) {
      throwIfStopped(signal);
      const slow = error.reason === 'route_unverified';
      add('codex_tools', slow ? 'warning' : 'fail', String(error.message).slice(0, 300), slow ? 'route_unverified' : 'route_unavailable');
      add('codex_context', slow ? 'warning' : 'fail', 'SSH discovery did not complete. No local Codex transport was attempted.', slow ? 'route_unverified' : 'route_unavailable');
    }
    return { checks, ...found };
  }
  let hosts = [];
  try {
    hosts = await getCodexHosts({ stateDir: config.stateDir, signal });
    const present = localSocketPresence();
    const existing = hosts.filter(host => present(host.pipePath) !== false).length;
    add('codex_registry', existing ? 'pass' : 'warning', !hosts.length
      ? 'No saved Codex endpoint is registered. Call bridge_doctor once from an open Codex Desktop task before discovery from Claude.'
      : existing ? `Saved Codex endpoint records are valid; ${existing} of ${hosts.length} point to an existing endpoint.`
      : `None of the ${hosts.length} saved Codex endpoint records points to an existing endpoint; they belong to earlier Codex Desktop launches. Open a Codex Desktop task with the bridge enabled.`,
    'route_unavailable');
  } catch {
    add('codex_registry', 'fail', 'Saved Codex endpoint records are malformed or unreadable. Check the shared state configuration.', 'state_unavailable');
  }
  const current = who?.kind === 'codex' && who.transport === 'desktop' ? { pipePath: who.pipePath, threadId: who.threadId }
    : config.env.CODEX_APP_TOOLS_PIPE_PATH ? { pipePath: config.env.CODEX_APP_TOOLS_PIPE_PATH,
      threadId: config.env.CODEX_THREAD_ID } : null;
  const compatible = tools => {
    const messageTool = tools.find(tool => tool?.name === 'send_message_to_thread');
    const listTool = tools.find(tool => tool?.name === 'list_threads');
    return typeof messageTool?.namespace === 'string' && Boolean(messageTool.namespace) &&
      messageTool.inputSchema?.properties?.threadId?.type === 'string' &&
      messageTool.inputSchema?.properties?.prompt?.type === 'string' &&
      typeof listTool?.namespace === 'string' && Boolean(listTool.namespace) &&
      ['integer', 'number'].includes(listTool.inputSchema?.properties?.limit?.type);
  };
  // The daemon listing, the version read and the Desktop probe are independent; run them together
  // and report them in the usual order (O03).
  const [daemon, versions, desktop] = await Promise.all([
    daemonInquiry(config, signal, (connection, attempt) =>
      listTerminalThreads(connection, { limit: 1, signal: attempt.signal, timeoutMs: attempt.timeoutMs }), { budgetMs: DOCTOR_DAEMON_BUDGET_MS })
      .then(threads => ({ threads }), error => ({ error })),
    readDaemonVersions({ env: config.env, timeoutMs: 2000, ...(config.daemonVersion ?? {}) }),
    // A slower Desktop build needs seconds for one discovery; a shorter wait would report a healthy app as stalled.
    selectDesktopHost([current, ...hosts],
      { ...config, desktop: { catalogMs: 1500, listMs: 5000, budgetMs: 8000, ...config.desktop } }, signal, { compatible }),
  ]);
  throwIfStopped(signal);
  if (daemon.threads) {
    found.terminalSessions = daemon.threads.length;
    found.daemonReachable = true;
    add('codex_daemon', 'pass', found.terminalSessions
      ? 'The Codex daemon is reachable and lists stored Codex sessions. Their current client is not implied by discovery.'
      : 'The Codex daemon is reachable, but no stored Codex session is available yet. Start a Codex conversation.');
  } else {
    add('codex_daemon', 'warning', `Terminal Codex sessions are unavailable: ${daemon.error.message}`,
      daemon.error.inconclusive ? 'route_unverified' : 'route_unavailable');
  }
  if (versions) {
    const differ = versions.cli && versions.server && versions.cli !== versions.server;
    add('codex_versions', differ ? 'warning' : 'pass',
      `Codex CLI ${versions.cli ?? 'unknown'}, daemon ${versions.server ?? 'unknown'}.${differ ? ' They differ; update or restart so both run the same version.' : ''}`,
      'version_mismatch');
  }
  const { host, report } = desktop;
  found.acceptedContext = Boolean(host);
  const codexStatus = passed => passed ? 'pass' : report.stalled || report.unchecked || found.daemonReachable ? 'warning' : 'fail';
  add('codex_tools', codexStatus(report.compatible > 0), report.compatible
    ? 'Codex exposes compatible discovery and message tool schemas.'
    : report.incompatible ? `No checked Codex endpoint exposes compatible tools. Enable the bridge in Codex and check the application version. Catalog tools: ${report.tools.join(', ').slice(0, 600)}`
    : `No Codex Desktop tool catalog answered. ${desktopFailure(report)}`, desktopReason(report));
  add('codex_context', codexStatus(found.acceptedContext), found.acceptedContext
    ? 'Codex accepted a registered context for read-only chat discovery.'
    : `No checked Codex context accepted chat discovery. ${desktopFailure(report)}`, desktopReason(report));
  return { checks, ...found };
}

async function doctorClaudeChecks(context, config, who, callerProbeError, signal) {
  const checks = [];
  const add = (name, status, detail, reason) => checks.push({ name, status, detail, ...(status === 'pass' ? {} : { reason }) });
  let sessions = [];
  try {
    const issues = [];
    sessions = discoverClaudeSessions({ registryDir: config.registryDir, issues });
    if (issues.length) add('claude_registry', 'warning', 'Some Claude registrations were unreadable; this list is incomplete.', 'state_unavailable');
    else add('claude_registry', sessions.length ? 'pass' : 'fail', sessions.length
      ? 'Live Claude Code sessions are registered.'
      : 'No live Claude Code session with an inbox is registered. Open the intended session and check its Peer address in /status.',
    'target_unavailable');
  } catch {
    add('claude_registry', 'fail', 'The Claude session registry is unreadable or invalid. Check Claude configuration and reopen its Code session.', 'target_unavailable');
  }
  let inboxAvailable = false;
  let inboxProbeError;
  let incomplete = false;
  // The inbox budget caps the identity checks themselves, so one slow window cannot use up the report (FB04).
  const budget = startCall({ cancelSignal: signal, deadlineMs: Math.min(DOCTOR_BUDGETS.claudeInboxMs, remainingMs(signal)) });
  try {
    for (const session of sessions) {
      if (remainingMs(budget.signal) <= 0) { incomplete = true; break; }
      // The caller probe already used its retries; don't repeat them as an inbox check.
      if (callerProbeError && session.pid === (context.parentPid ?? process.ppid)) {
        inboxProbeError = callerProbeError;
        continue;
      }
      try {
        const endpoint = who?.kind === 'claude' && who.endpoint.sessionId === session.sessionId ? who.endpoint
          : await resolveClaudeSession(session.sessionId, { registryDir: config.registryDir, signal: budget.signal, probe: context.processProbe });
        await probeClaudeInbox({ socketPath: endpoint.socketPath, signal: budget.signal,
          timeoutMs: Math.max(1, Math.min(1500, remainingMs(budget.signal))) });
        inboxAvailable = true;
        break;
      } catch (error) {
        throwIfStopped(signal);
        if (error.code === 'BRIDGE_DEADLINE') { incomplete = true; break; }
        // A slow check proves nothing about the window, so it leaves the result inconclusive, not failed.
        if (error.reason === 'target_unverified' || error.reason === 'target_busy') inboxProbeError ??= error;
      }
    }
  } finally {
    budget.dispose();
  }
  add('claude_inbox', inboxAvailable ? 'pass' : inboxProbeError || incomplete ? 'warning' : 'fail', inboxAvailable
    ? 'A verified Claude inbox accepts local connections. This check sent no message.'
    : inboxProbeError ? inboxProbeError.message
    : incomplete ? 'Some Claude inboxes were not checked within the diagnostic time budget. Availability is inconclusive.'
    : 'No checked Claude inbox is available with a valid session key. Reopen the intended Claude Code session.',
  inboxProbeError || incomplete ? 'target_unverified' : 'target_unavailable');
  return { checks, inboxAvailable };
}

/** Diagnose local configuration and transports, registering only verified Desktop
 * callers. Never send prompts or return credentials and local addresses.
 */
async function bridgeDoctor(context, config) {
  const signal = context.signal;
  throwIfStopped(signal);
  const checks = [];
  const add = (name, status, detail, reason) => checks.push({ name, status, detail, ...(status === 'pass' ? {} : { reason }) });
  add('platform', ['win32', 'darwin'].includes(config.platform) ? 'pass' : 'fail',
    config.platform === 'win32' ? 'Claude Code and Codex transports are supported on Windows.'
      : config.platform === 'darwin' ? 'macOS uses Claude Unix inboxes and an operator-configured Codex SSH host.'
      : 'Claude process identity verification is supported on Windows and macOS.', 'setup_incomplete');
  const state = inspectStateDirectory(config.stateDir);
  checks.push({ name: 'state_directory', ...state, ...(state.status === 'pass' ? {}
    : { reason: state.status === 'fail' ? 'state_unavailable' : 'setup_incomplete' }) });
  const privacy = state.status !== 'fail' && await stateDirectoryPrivacyWarning(config.stateDir, { signal });
  if (privacy) add('state_permissions', 'warning', privacy, 'setup_incomplete');
  const migrationWarning = stateDirectoryWarning(config.stateDir);
  if (migrationWarning) add('state_migration', 'warning', migrationWarning, 'setup_incomplete');
  for (const warning of legacyEnvironmentWarnings(config.env)) add('legacy_environment', 'warning', warning, 'setup_incomplete');
  let application = config.env.CLAUDE_CODE_MESSAGING_SOCKET ? 'claude'
    : config.env.CODEX_APP_TOOLS_PIPE_PATH ? 'codex' : 'unknown';
  let who;
  let callerProbeError;
  const callerBudget = startCall({ cancelSignal: signal, deadlineMs: Math.min(DOCTOR_BUDGETS.callerMs, remainingMs(signal)) });
  try {
    who = await identifyCaller({ ...context, signal: callerBudget.signal }, config);
    application = who.kind;
    add('caller', 'pass', 'The calling conversation has a verified runtime identity.');
  } catch (error) {
    throwIfStopped(signal);
    if (error.reason === 'caller_unverified' || error.code === 'BRIDGE_DEADLINE') {
      application = 'claude';
      callerProbeError = error.reason === 'caller_unverified' ? error
        : failure('Could not verify this Claude Code conversation within the diagnostic time budget. Retry the same call.', 'caller_unverified');
      add('caller', 'warning', callerProbeError.message, 'caller_unverified');
    } else {
      if (error.application) application = error.application;
      const specific = ['caller_invalid', 'caller_changed', 'identity_check_unavailable'].includes(error.reason);
      add('caller', 'fail', specific ? error.message : application === 'unknown'
        ? 'No caller identity is available. Run this tool from the intended Claude Code or Codex conversation.'
        : application === 'codex'
        ? 'This call has no valid Codex task context. Run the tool from an open Codex task with the bridge enabled.'
        : 'The direct Claude parent session could not be verified. Open the bridge in the intended Claude Code session.',
      REASONS[error.reason] ? error.reason : 'caller_invalid');
    }
  } finally {
    callerBudget.dispose();
  }
  throwIfStopped(signal);
  if (state.status !== 'fail' && who?.kind === 'codex' && who.transport === 'desktop') {
    try { await publishCodexHost({ signal: context.signal, stateDir: config.stateDir, pipePath: who.pipePath, threadId: who.threadId }); }
    catch { add('codex_registration', 'fail', 'The verified Codex Desktop task could not be registered. Check the shared state directory and saved endpoint records.', 'state_unavailable'); }
  }
  const [codex, claude] = await Promise.all([doctorCodexChecks(context, config, who, signal),
    doctorClaudeChecks(context, config, who, callerProbeError, signal)]);
  checks.push(...codex.checks, ...claude.checks);
  const ready = Boolean(who) && (codex.acceptedContext || (codex.daemonReachable && codex.terminalSessions > 0)) &&
    claude.inboxAvailable && checks.every(check => check.status !== 'fail');
  return { application, ready, checks: checks.map(({ reason, ...check }) => check), issues: issuesOf(checks) };
}

/** Errors a transport adapter raised without naming a reason, classified by their typed fields. */
function transportReason(error, signal) {
  if (REASONS[error.reason]) return error.reason;
  if (signal?.reason?.code === 'BRIDGE_OUTPUT_BUSY') return 'server_busy';
  if (error.code === 'BRIDGE_DEADLINE') return 'deadline';
  // An adapter's own abort error does not say whether the client cancelled or the deadline passed.
  if (error.code === 'ABORT_ERR' || error.name === 'AbortError') return signal?.reason?.code === 'BRIDGE_DEADLINE' ? 'deadline' : 'cancelled';
  if (error instanceof TerminalNotLoadedError) return 'target_unavailable';
  if (error.code === 'ENDPOINT_GONE' || error instanceof DaemonUnavailableError) return 'route_unavailable';
  if (error.code === 'DESKTOP_TIMEOUT' || error.code === 'DAEMON_TIMEOUT') return 'route_unverified';
  // A JSON-RPC refusal that the adapter proved happened before acceptance.
  if (typeof error.code === 'number' || error.rpcCode !== undefined) return 'request_rejected';
  return 'internal_error';
}

/** The answer for an exact earlier attempt with this message_id; only a submitted one is a result. */
function replay(record) {
  if (record.status === 'submitted') return { delivery: publicDelivery(record), outcome: outcome('already_submitted', { record }) };
  const [text, reason] = record.status === 'sending'
    ? ['No new send was made: the first attempt with this message_id is still in progress. Let it finish, then check list_deliveries.', 'in_flight']
    : record.status === 'uncertain'
    ? ['No new send was made: this message_id has uncertain delivery, so the first attempt may have arrived. Check the receiving conversation and list_deliveries before sending again.', 'prior_uncertain']
    : ['No new send was made: this message_id has a failed attempt that an earlier bridge version recorded without its cause. Check the receiving conversation and list_deliveries; if the message did not arrive, send it again under a new message_id.', 'prior_failed'];
  throw Object.assign(new Error(text), { reason, outcome: outcome(reason, { record }) });
}

async function sendMessage(name, args, context, config, who) {
  // A loaded terminal thread's routing connection is kept for its send, and always closed here (O02).
  const held = { connection: null };
  try { return await deliver(name, args, context, config, who, held); } finally { held.connection?.close(); }
}

/** Send over the kept routing connection. A failure before the daemon answered anything falls back to a
 * fresh connection, which is the path every send took before the connection was kept (O02). */
async function overHeld(held, send, fresh, signal) {
  const connection = held.connection;
  let answered = false;
  let writing = false;
  const tracked = { ...connection, request(method, params, options) {
    if (options?.mutating) writing = true;
    const pending = connection.request(method, params, options);
    pending.then(() => { answered = true; }, error => { if (error.rpcMessage !== undefined) answered = true; });
    return pending;
  } };
  try { return await send(tracked); } catch (error) {
    if (answered || writing || error.deliveryUnknown || error.code === 'DAEMON_TIMEOUT') throw error;
    throwIfStopped(signal);
    connection.close();
    held.connection = null;
    return fresh();
  }
}

async function deliver(name, args, context, config, who, held) {
  const signal = context.signal;
  if ((name === 'send_to_claude') !== (who.kind === 'codex')) {
    throw failure(`Use ${who.kind === 'codex' ? 'send_to_claude' : 'send_to_codex'} from this application.`, 'wrong_tool');
  }
  // Refuse malformed UTF-16 before a preflight, shadow or child CLI could reinterpret it as U+FFFD.
  if (typeof args.message !== 'string' || !args.message.isWellFormed()) throw failure('Message text must be valid Unicode. Correct it before sending.', 'invalid_argument');
  const direction = who.kind === 'codex' ? 'to_claude' : 'to_codex';
  if (direction === 'to_claude' && (typeof args.session_id !== 'string' || !args.session_id.trim())) {
    throw failure('An explicit Claude session ID is required.', 'invalid_argument');
  }
  const targetThreadId = direction === 'to_codex' ? normalizeCodexThreadId(args.thread_id) : null;
  const ssh = direction === 'to_codex' ? sshHost(config) : null;
  const transport = args.transport ?? 'auto';
  if (ssh && !['auto', 'ssh'].includes(transport)) throw failure('This bridge is pinned to the configured SSH host. Use auto or ssh transport; local Desktop and terminal routes are not selected from this configuration.', 'invalid_argument');
  if (!ssh && direction === 'to_codex' && transport === 'ssh') throw failure('SSH delivery requires CLAUDE_CODEX_BRIDGE_SSH_HOST on macOS.', 'invalid_argument');
  const route = { from: sender(who), to: direction === 'to_claude'
    ? { kind: 'claude', id: args.session_id }
    : { kind: 'codex', id: targetThreadId, ...(ssh ? { host_id: `ssh:${ssh.sshHostAlias}` } : {}) } };
  const draft = { direction, message: args.message, route, manual: context.manual === true };
  // One read answers an exact earlier attempt before any recipient check: its result does not depend on
  // whether the recipient is still open (C01, A06), reading it writes nothing (D04), and the same read
  // finds the sender's ledger for the reservation below (O04).
  const lookup = await lookupMessage({ stateDir: config.stateDir, threadId: senderLedgerId(who) }, { id: args.message_id, ...draft }, { signal });
  const prior = await repairSettlement(lookup.session, lookup.prior);
  if (prior && !prior.retryable) {
    if (prior.interrupted) {
      try { await recordMessage(lookup.session, { id: args.message_id, ...draft }, { signal }); } catch { /* the reply below does not depend on it */ }
    }
    return replay(prior);
  }
  if (who.kind === 'codex' && who.transport === 'desktop') {
    await publishCodexHost({ signal: context.signal, stateDir: config.stateDir, pipePath: who.pipePath, threadId: who.threadId });
  }
  const endpoint = direction === 'to_claude'
    ? await resolveClaudeSession(args.session_id, { registryDir: config.registryDir, signal, probe: context.processProbe }) : null;
  const terminalTarget = direction === 'to_codex' && !ssh ? await resolveTerminalTarget(targetThreadId, transport, config, signal, held) : false;
  const desktop = direction === 'to_codex' && !ssh && !terminalTarget
    ? await desktopRoute(who, config, signal, { reuse: true }) : null;
  const host = ssh || desktop?.host || null;
  const messageId = args.message_id ?? crypto.randomUUID();
  const peerText = terminalTarget || ssh ? codexPeerContent({ fromKind: 'claude', fromId: route.from.id, bridgeMessageId: messageId, body: args.message }) : undefined;
  // Refuse before recordMessage reserves the ID, so a message that can never be sent does not spend it as failed.
  const queueRefused = terminalTarget?.queueRoute ? queueTargetRefusal(targetThreadId) || queueRefusal(peerText) : null;
  if (queueRefused) throw failure(queueRefused, 'invalid_argument');
  throwIfStopped(signal);
  checkSettlementCapacity();
  const session = lookup.session ?? await senderLedger(who, config, signal);
  throwIfStopped(signal);
  // The lookup above has just read this ledger, so the reservation goes straight to its lock.
  const reserved = await recordMessage(session, { id: messageId, ...draft }, { signal });
  if (!reserved.created) return replay(reserved.message);
  const record = status => ({ id: messageId, status });
  let receipt;
  try {
    throwIfStopped(signal);
    if (direction === 'to_claude') {
      const source = context.manual === true ? 'User sent from Codex Desktop task'
        : who.transport === 'terminal' ? 'From Codex terminal session' : 'From Codex Desktop task';
      const notice = `[${source} ${JSON.stringify(route.from.id)}; bridge message ${JSON.stringify(messageId)}]\n\n${args.message}`;
      receipt = await sendToClaude({ ...endpoint, message: notice, senderName: senderLabel(route.from.id), signal, probe: context.processProbe });
    } else if (terminalTarget) {
      let sent;
      try {
        if (terminalTarget.queueOnly) throw new TerminalNotLoadedError('The daemon is unavailable for this explicit terminal route.');
        const send = connection => sendToTerminalThread(connection, { threadId: route.to.id, text: peerText, messageId, signal });
        const fresh = () => withDaemon(config, signal, send);
        sent = held.connection ? await overHeld(held, send, fresh, signal) : await fresh();
      } catch (error) {
        // Thrown before anything is written, so the queue fallback can never double-deliver. An explicit
        // terminal route also queues when the daemon went away before the input was written (Q03).
        const unwritten = error instanceof TerminalNotLoadedError ||
          (terminalTarget.allowQueue && error instanceof DaemonUnavailableError && !error.deliveryUnknown);
        if (!unwritten) throw error;
        if (!terminalTarget.allowQueue) throw failure('The selected Codex session left the daemon before sending. No message was sent. Select desktop or terminal transport explicitly.', 'target_unavailable');
        sent = await queueToTerminalThread({ threadId: route.to.id, text: peerText, env: config.env, signal,
          ...(config.queue ?? {}) });
      }
      receipt = { status: 'written', method: sent.method, ...(sent.turnId ? { turn_id: sent.turnId } : {}),
        ...(sent.queueId ? { queue_id: sent.queueId } : {}), acknowledged: false };
    } else if (ssh) {
      const delivered = await sendToCodex({ ...ssh, threadId: route.to.id, message: peerText, signal });
      receipt = { ...delivered, host_id: route.to.host_id };
    } else {
      const entrypoint = who.endpoint.entrypoint;
      const client = entrypoint === 'claude-desktop' ? 'Claude Desktop' : entrypoint === 'claude-vscode' ? 'Claude Code VS Code' : 'Claude Code CLI';
      const notice = `[From ${client} session ${JSON.stringify(route.from.id)}; bridge message ${JSON.stringify(messageId)}]\n\n${args.message}`;
      try {
        await sendToCodex({ pipePath: host.pipePath, contextThreadId: host.threadId, catalog: desktop.catalog,
          threadId: route.to.id, message: notice, signal });
      } catch (error) {
        // A reused context may belong to a task removed since; prove it again before the next send.
        if (acceptedContexts.get(host.pipePath) === host.threadId) acceptedContexts.delete(host.pipePath);
        throw error;
      }
    }
  } catch (error) {
    // Only a proven non-delivery is failed; anything that may have written stays uncertain.
    const reason = error.deliveryUnknown === true ? 'delivery_unconfirmed' : transportReason(error, signal);
    const status = REASONS[reason].delivered === false ? 'failed' : 'uncertain';
    let saved = true;
    const terminal = { status, route, attemptId: reserved.message.attemptId, error: error.message, ...(status === 'failed' ? { reason } : {}) };
    try { await finishMessage(session, messageId, terminal); }
    catch { saved = false; retainSettlement(session, reserved.message, terminal); }
    // The record is still reserved until a disk-only repair. Do not suggest bypassing that repair.
    error.outcome = outcome(reason, { record: record(saved ? status : 'sending'), ...(saved || status !== 'failed' ? {} : { retry: 'inspect' }) });
    if (!saved) error.message += ' The outcome could not be saved in the delivery record.';
    throw error;
  }
  try {
    const settled = await finishMessage(session, messageId, { status: 'submitted', route, attemptId: reserved.message.attemptId, ...(receipt ? { receipt } : {}) });
    return { delivery: publicDelivery(settled), outcome: outcome('submitted', { record: settled }) };
  } catch {
    // A rename can have committed before lock or temp cleanup failed. Return the authoritative
    // submission if it is readable; otherwise never claim a stale record state we have not seen.
    let saved;
    try { saved = (await lookupMessage({ stateDir: config.stateDir, threadId: senderLedgerId(who) }, { id: messageId, ...draft })).prior; } catch {}
    if (saved?.status === 'submitted') return { delivery: publicDelivery(saved), outcome: outcome('submitted', { record: saved }) };
    retainSettlement(session, reserved.message, { status: 'submitted', route, ...(receipt ? { receipt } : {}) });
    // The transport took the message; only its record is missing or stale (R01).
    throw Object.assign(new Error('The message was submitted, but its delivery record could not be saved. Do not send it again; list_deliveries may show it as sending or uncertain.'),
      { reason: 'settlement_failed', outcome: outcome('settlement_failed', { record: saved }) });
  }
}

async function listCodexThreads(args, context, config, who) {
  const signal = context.signal;
  const limit = args.limit || 30;
  const ssh = sshHost(config);
  if (ssh) return { threads: (await listCodexChats({ ...ssh, limit, signal }))
    .map(chat => publicThread({ ...chat, source: 'ssh' })), warnings: [], issues: [] };
  // Desktop and daemon discovery are independent; the merge keeps Desktop first (O03).
  const [desktop, terminal] = await Promise.allSettled([
    (async () => {
      // The listing itself proves the context; a separate one-chat probe would double the wait.
      const found = await desktopRoute(who, config, signal, { limit });
      return found.chats ?? await listCodexChats({ pipePath: found.host.pipePath, contextThreadId: found.host.threadId, limit, signal });
    })(),
    daemonInquiry(config, signal, (connection, attempt) =>
      listTerminalThreads(connection, { limit, signal: attempt.signal, timeoutMs: attempt.timeoutMs })),
  ]);
  throwIfStopped(signal);
  const warnings = [];
  const issues = [];
  let chats = [];
  if (desktop.status === 'fulfilled') chats = desktop.value.map(chat => ({ ...chat, source: 'desktop' }));
  else {
    warnings.push(`Codex Desktop unavailable: ${desktop.reason.message}`);
    issues.push({ source: 'desktop', reason: transportReason(desktop.reason) });
  }
  if (terminal.status === 'fulfilled') {
    // Source names describe discovery transports, not the thread's current client.
    // Retain the Desktop title and metadata when both transports list the same ID.
    const desktopIds = new Set(chats.map(chat => chat.thread_id));
    chats = [...chats, ...terminal.value.filter(chat => !desktopIds.has(chat.thread_id))];
  } else if (shouldReportTerminalUnavailable(terminal.reason, desktop.status === 'fulfilled')) {
    warnings.push(`Codex terminal sessions unavailable: ${terminal.reason.message}`);
    issues.push({ source: 'terminal', reason: terminal.reason.inconclusive ? 'route_unverified' : transportReason(terminal.reason) });
  }
  if (desktop.status === 'rejected' && terminal.status === 'rejected') {
    throw failure(warnings.join(' '), issues[0]?.reason ?? transportReason(desktop.reason));
  }
  return { threads: chats.map(publicThread), warnings, issues };
}

const SEND_TOOLS = new Set(['send_to_claude', 'send_to_codex', 'panel_send']);

export async function executeBridgeTool(name, args = {}, context = {}) {
  // Library callers and tests may bring no deadline; every call gets one (D02).
  const call = ensureCall(context.signal);
  try {
    return await runBridgeTool(name, args, { ...context, signal: call.signal });
  } catch (error) {
    if (!error.outcome && !error.reason && (['EROFS', 'ENOSPC', 'EDQUOT'].includes(error.code) ||
        ['open', 'read', 'write', 'stat', 'lstat', 'unlink', 'mkdir', 'link', 'rename', 'scandir', 'realpath'].includes(error.syscall))) {
      error = failure('The bridge could not read or save its records. Check free space and write access, then run bridge_doctor.', 'state_unavailable');
    }
    // Every send error says whether the message went out, in its outcome and in its text.
    if (SEND_TOOLS.has(name) && error instanceof Error) {
      error.outcome = errorOutcome(error);
      error.message = sendErrorText(error.message, error.outcome);
    }
    throw error;
  } finally {
    call.dispose();
  }
}

async function runBridgeTool(name, args, context) {
  throwIfStopped(context.signal);
  let config;
  try { config = settings(context); } catch (error) {
    // A split or inaccessible root must not be passed to a registry check or host publication.
    if (name !== 'bridge_doctor' || error.reason !== 'state_unavailable') throw error;
    const checks = [{ name: 'state_directory', status: 'fail', detail: error.message }];
    return { application: 'unknown', ready: false, checks, issues: issuesOf([{ ...checks[0], reason: error.reason }]) };
  }
  if (name === 'bridge_doctor') return bridgeDoctor(context, config);
  if (name === 'list_claude_sessions') {
    const issues = [];
    const sessions = discoverClaudeSessions({ registryDir: config.registryDir, issues })
      .map(({ sessionId, name: title, cwd, entrypoint, status }) => ({ session_id: sessionId, title, cwd, entrypoint, status }));
    return { sessions, ...(issues.length ? { issues } : {}) };
  }
  const publishesHost = name === 'panel_retry_notice';
  const who = await caller(context, config, { publish: publishesHost });
  if (['bridge_panel', 'panel_history', 'panel_send', 'panel_retry_notice'].includes(name)) {
    if (who.kind !== 'codex' || who.transport !== 'desktop') throw failure('The conversation panel is available only from a Codex Desktop chat.', 'wrong_tool');
    if (name === 'panel_send') {
      const { manualSend } = await import('./manual-service.mjs');
      return manualSend(args, context);
    }
    if (name === 'panel_retry_notice') {
      const { retryManualNotice } = await import('./manual-service.mjs');
      return retryManualNotice(args, context);
    }
    const { listClaudeConversations } = await import('./claude-history.mjs');
    const { getBridgeConversation } = await import('./bridge-history.mjs');
    if (name === 'panel_history') return getBridgeConversation({ stateDir: config.stateDir,
      ownerThreadId: who.threadId, sessionId: args.session_id, limit: args.limit, cursor: args.cursor, signal: context.signal });
    const catalog = await listClaudeConversations({ registryDir: config.registryDir,
      projectsDir: path.join(config.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'),
      stateDir: config.stateDir, ownerThreadId: who.threadId, cursor: args.cursor, signal: context.signal });
    return { owner_thread_id: who.threadId, application: 'codex', sessions: catalog.conversations, warnings: catalog.warnings, next_cursor: catalog.next_cursor,
      composer_enter_behavior: readComposerEnterBehavior({ env: config.env }) };
  }
  if (name === 'list_codex_threads') return listCodexThreads(args, context, config, who);
  if (name === 'list_deliveries') {
    let deliveries = [], issues = [];
    try {
      ({ rows: deliveries, issues } = await listMessages(ledgerAt({ stateDir: config.stateDir, threadId: senderLedgerId(who) }), args.limit || 20, sender(who), context.signal));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { application: who.kind, sender_id: sender(who).id, deliveries: deliveries.map(publicDelivery), ...(issues.length ? { issues } : {}) };
  }
  if (name !== 'send_to_claude' && name !== 'send_to_codex') throw failure('Unknown bridge tool', 'invalid_argument');
  return sendMessage(name, args, context, config, who);
}
