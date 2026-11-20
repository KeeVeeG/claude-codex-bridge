import crypto from 'node:crypto';
import { publicDelivery } from './delivery.mjs';
import { inspectStateLocks } from './state-lock.mjs';
import { ensureStateDirectory, stateDirectoryWarning, stateDirectoryPrivacyWarning } from './state-directory.mjs';
import { legacyEnvironmentWarnings } from './legacy-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { verifiedClaudeSessions, resolveClaudeSession, resolveClaudeCaller, sendToClaude } from './claude-sessions.mjs';
import { beforeWrite, WRITE_RESERVE_MS, ensureCall, inquire, INQUIRY_ATTEMPT_MS, isCancelledError, monotonicNow, remainingMs, startCall, throwIfStopped, waitForSettlement } from './call-time.mjs';
import { manualSend, retryManualNotice } from './manual-service.mjs';
import { listClaudeConversations } from './claude-history.mjs';
import { getBridgeConversation, historyWarnings } from './bridge-history.mjs';
import { REASONS, errorOutcome, failure, outcome, sendErrorText } from './outcome.mjs';
import { desktopCompatible, MAX_CODEX_CHAT_LIMIT, listCodexTools, listCodexChats, sendToCodex } from './codex-desktop.mjs';
import { publishCodexHost, getCodexHosts } from './codex-host.mjs';
import { canonicalLocalSocket, localSocketPresence } from './local-socket.mjs';
import { defaultStateDir, ledgerAt, ownerId } from './store.mjs';
import { createSession, lookupMessage, recordMessage, finishMessage, listMessages, retainSettlement, checkSettlementCapacity, repairSettlement } from './call-store.mjs';
import { openDaemon, listTerminalThreads, readDaemonVersions, readTerminalThread, readTerminalPlan, writeTerminalPlan, normalizeCodexThreadId,
  queueToTerminalThread, queueRefusal, queueTargetRefusal, TerminalNotLoadedError, DaemonUnavailableError, NOT_RUNNING_MESSAGE } from './codex-daemon.mjs';
import { codexPeerContent, collaboratorNotice, quoted } from './codex-peer.mjs';
import { validateSshHostAlias } from './codex-ssh.mjs';

/** Result metadata key for the panel's full catalog; MCP hosts give `_meta` to the UI, not the model. */
export const PANEL_CATALOG = 'bridge-claude-codex/catalog';
// Only these fixed diagnostics can cross from private catalog metadata to the public v6 result.
const publicCatalogWarnings = new Set([
  'Some Claude custom title metadata was unreadable or unsafe; a fallback title is shown.',
  'Some Claude conversation metadata was unreadable or unsafe and was skipped. Check read access, then retry.',
  'Some Claude inboxes could not be verified.',
  'Some live Claude session identifiers are unsupported.',
  'The live Claude session registry could not be read.',
  'The Claude project metadata directory changed during the read; native metadata was skipped. Refresh to retry.',
  'The Claude project metadata directory could not be verified; native metadata was skipped. Check read access, then retry.',
  'Some Claude project metadata directories changed during the read and were skipped. Refresh to retry.',
  'Some Claude project metadata directories could not be verified. Check read access, then retry.',
]);

function codexThreadId(metadata = {}) {
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
  if (config.platform !== 'darwin') return null;
  if (!config.env.CLAUDE_CODEX_BRIDGE_SSH_HOST) throw failure('No SSH route is configured on macOS. Set CLAUDE_CODEX_BRIDGE_SSH_HOST to the intended SSH alias.', 'setup_incomplete');
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
    if (queueRoute && transport === 'auto') throw failure('The selected Codex session is not loaded in the daemon, so the bridge cannot tell where it is open. Ask the user whether it is open in Codex Desktop (transport desktop) or Codex CLI (transport terminal); a listing’s source does not show this.', 'invalid_argument');
    return { queueRoute, allowQueue: transport === 'terminal' };
  } catch (error) {
    checkCancellation(signal);
    // Explicit terminal selection also supports a standalone CLI without a running daemon.
    // The queue command still enforces the kill switch and validates the exact thread ID.
    if (error.reason === 'access_denied' || ['EACCES', 'EPERM'].includes(error.code)) throw failure('Access to the selected Codex route was denied. Resolve authorization before retrying.', 'access_denied');
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
  return `Codex task ${quoted(id).slice(1, -1).slice(0, 180)}`;
}

function senderLedgerId(who) {
  // Preserve existing Codex task ledgers. Prefix Claude IDs so their ledgers
  // cannot collide with a Codex task or depend on a prior one-to-one pairing.
  return who.kind === 'codex' ? who.threadId : `claude:${who.endpoint.sessionId}`;
}

function senderLedger(who, config, signal) {
  const threadId = senderLedgerId(who);
  ensureStateDirectory(config.stateDir);
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
async function selectDesktopHost(hosts, config, signal, { limit = 1, targetId, collect = false, compatible = desktopCompatible } = {}) {
  const timeouts = { ...DESKTOP_TIMEOUTS, ...(config.desktop ?? {}) };
  const deadline = monotonicNow() + Math.min(timeouts.budgetMs, remainingMs(signal));
  // A wait the budget cut short proves nothing about the app: its timeout counts as unchecked, not stalled.
  const read = (cap, action) => inquire(async attempt => {
    try { return await action(attempt); } catch (error) {
      if (error.code === 'DESKTOP_TIMEOUT') error.transient = true;
      throw error;
    }
  }, { signal, until: deadline, attemptMs: cap });
  const report = { budgetMs: timeouts.budgetMs, gone: 0, stalled: 0, incompatible: 0, compatible: 0,
    unchecked: 0, errors: [] };
  const pipes = new Map();
  let empty, chosen;
  const listed = new Map(), pinnedIds = new Set();
  for (const host of hosts) {
    const pipePath = host && canonicalLocalSocket(host.pipePath);
    if (!pipePath) continue;
    if (!pipes.has(pipePath)) pipes.set(pipePath, []);
    if (typeof host.threadId === 'string' && host.threadId.trim() && !pipes.get(pipePath).includes(host.threadId)) {
      pipes.get(pipePath).push(host.threadId);
    }
  }
  for (const key of acceptedContexts.keys()) if (!pipes.has(key)) acceptedContexts.delete(key);
  const present = localSocketPresence();
  const failed = error => {
    if (error.reason === 'access_denied' && targetId) throw error;
    checkCancellation(signal);
    if (error.code === 'ENDPOINT_GONE') report.gone++;
    else if (error.inconclusive || error.code === 'DESKTOP_TIMEOUT') report[monotonicNow() >= deadline - 1 ? 'unchecked' : 'stalled']++;
    else if (error.reason === 'protocol_incompatible') report.incompatible++;
    else report.errors.push(error.reason ?? 'route_unavailable');
  };
  for (const [pipePath, contexts] of pipes) {
    if (monotonicNow() >= deadline) { report.unchecked += Math.max(1, contexts.length); continue; }
    if (present(pipePath) === false) { report.gone++; continue; }
    let catalog;
    try { catalog = await read(timeouts.catalogMs, attempt => listCodexTools(pipePath, { signal: attempt.signal, timeoutMs: attempt.timeoutMs })); }
    catch (error) { failed(error); continue; }
    if (compatible && !compatible(catalog)) {
      report.incompatible++;
      if (!collect || !catalog.some(tool => tool.name === 'list_threads' && tool.namespace)) continue;
    }
    report.compatible++;
    const accepted = contexts.includes(acceptedContexts.get(pipePath)) ? acceptedContexts.get(pipePath) : undefined;
    if (targetId && pipes.size === 1 && accepted) return { host: { pipePath, threadId: accepted }, catalog, report };
    for (const threadId of accepted ? [accepted, ...contexts.filter(id => id !== accepted)] : contexts) {
      if (monotonicNow() >= deadline) { report.unchecked++; continue; }
      try {
        const chats = await read(timeouts.listMs, attempt => listCodexChats({ pipePath, contextThreadId: threadId, limit, pinnedIds, signal: attempt.signal, catalog, timeoutMs: attempt.timeoutMs }));
        // An empty listing proves this context but says nothing about another running app, so the
        // search goes on and settles for it only when no other app lists a chat (F02).
        if (!chats.length) { empty ??= { host: { pipePath, threadId }, catalog, chats, report }; break; }
        acceptedContexts.set(pipePath, threadId);
        const candidate = { host: { pipePath, threadId }, catalog, chats, report };
        if (collect) {
          chosen ??= candidate;
          for (const chat of chats) if (!listed.has(chat.thread_id)) listed.set(chat.thread_id, chat);
          break;
        }
        if (!targetId || pipes.size === 1 || chats.some(chat => chat.thread_id === targetId)) return candidate;
        // Another Desktop instance may own the target. A bounded listing cannot prove absence.
        break;
      } catch (error) {
        // Desktop has no explicit context-rejection reply, so a definite failure only makes the next
        // send prove the context again. A stalled or cut-short listing says nothing about it, and
        // dropping it there would let a doctor or discovery call block the next send.
        const waited = error.inconclusive || error.code === 'DESKTOP_TIMEOUT';
        if (!waited && acceptedContexts.get(pipePath) === threadId) acceptedContexts.delete(pipePath);
        failed(error);
        // Every context on a stalled app waits for the same stuck tool execution, so trying the
        // pipe's other contexts only multiplies the wait. A cut wait means the budget is spent.
        if (waited) break;
      }
    }
  }
  if (collect && chosen) {
    const rows = [...listed.values()];
    return { ...chosen, chats: [...rows.filter(row => pinnedIds.has(row.thread_id)).slice(0, MAX_CODEX_CHAT_LIMIT),
      ...rows.filter(row => !pinnedIds.has(row.thread_id)).slice(0, limit)] };
  }
  if (targetId && pipes.size > 1) {
    if (report.compatible) throw failure('Could not verify which Desktop instance knows the selected thread. Check the intended task before retrying.', 'route_unverified');
    return { report };
  }
  if (empty) acceptedContexts.set(empty.host.pipePath, empty.host.threadId);
  return empty ?? { report };
}

/** The most actionable observed cause with its one repair, then the other observations as plain
 * facts, so a stale record never hides a stalled app and no reader gets two competing steps (V08). */
function desktopFailure(report, { factsOnly = false } = {}) {
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  // No Desktop response identifies a removed task. Describe the failed operation, not an inferred cause.
  const failedRequests = (report.errors ?? []).filter(reason => reason !== 'access_denied').length;
  const causes = [
    [report.stalled, 'Codex Desktop is running but did not answer in time. Retry the same call.',
      `${plural(report.stalled, 'saved endpoint')} did not answer in time`],
    [report.unchecked, `${plural(report.unchecked, 'saved endpoint record')} could not be checked within ${report.budgetMs / 1000} s. Retry the same call.`,
      `${plural(report.unchecked, 'saved endpoint record')} could not be checked ${factsOnly ? `within ${report.budgetMs / 1000} s` : 'in time'}`],
    [report.incompatible, 'Codex Desktop does not offer local discovery and message tools this bridge can use. Check that its app tools are enabled.',
      `${plural(report.incompatible, 'endpoint')} lacked compatible local tools`],
    [report.errors?.includes('access_denied'), 'Access to a registered Desktop endpoint was denied. Check authorization before sending.', 'access to a registered endpoint was denied'],
    [failedRequests, 'Codex Desktop failed the discovery request. Restart Codex Desktop, then retry the same call.',
      `${plural(failedRequests, 'discovery request')} failed`],
    [report.gone, `${plural(report.gone, 'saved Codex Desktop endpoint')} belong${report.gone === 1 ? 's' : ''} to earlier launches. Open a Codex Desktop task with the bridge enabled; its bridge server registers the current endpoint when it starts.`,
      `${plural(report.gone, 'saved endpoint')} belong${report.gone === 1 ? 's' : ''} to earlier Codex Desktop launches`],
  ].filter(([count]) => count);
  if (factsOnly) return causes.length ? `Codex Desktop: ${causes.map(cause => cause[2]).join('; ')}.`
    : 'No saved Codex Desktop endpoint has a usable task context.';
  if (!causes.length) return 'No saved Codex Desktop endpoint has a usable task context. Open a Codex Desktop task with the bridge enabled.';
  const others = causes.slice(1).map(cause => cause[2]);
  return `${causes[0][1]}${others.length ? ` Also observed: ${others.join('; ')}.` : ''}`;
}

async function desktopRoute(who, config, signal, options) {
  checkCancellation(signal);
  if (who.kind === 'codex' && who.transport === 'desktop') return { host: { pipePath: who.pipePath, threadId: who.threadId } };
  const hosts = await getCodexHosts({ stateDir: config.stateDir, signal });
  if (hosts.length === 0) throw failure('No Codex Desktop registration is in this bridge’s state directory. Open a Codex Desktop task with the bridge enabled, then retry.', 'route_unavailable');
  const selected = await selectDesktopHost(hosts, config, signal, options);
  if (!selected.host) throw failure(desktopFailure(selected.report), desktopReason(selected.report));
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
      return { status: 'warning', detail: 'The state directory does not exist yet. An ancestor is accessible; directory creation and writer locks have not been tested.' };
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

// Native diagnostic prose leads with an observation, followed by any repair instructions.
function doctorFact(detail) {
  const end = detail?.indexOf('. ');
  return end >= 0 ? detail.slice(0, end + 1) : detail;
}

/** Why no Desktop endpoint worked: an app that did not answer in time is unverified, not gone (F07). */
function desktopReason(report) {
  if (report.stalled || report.unchecked) return 'route_unverified';
  if (report.incompatible) return 'protocol_incompatible';
  return (report.errors ?? []).find(reason => reason !== 'route_unavailable') ?? 'route_unavailable';
}

// Diagnostic sub-budgets: each group of checks ends inconclusive, never false, when its budget runs out.
const DOCTOR_BUDGETS = { callerMs: 20_000, claudeInboxMs: 4500 };
const DOCTOR_DAEMON_BUDGET_MS = 6000;

async function doctorCodexChecks(config, who, signal) {
  const checks = [];
  const add = (name, status, detail, reason) => checks.push({ name, status, detail, ...(status === 'pass' ? {} : { reason }) });
  const found = { acceptedContext: false, daemonReachable: false, terminalSessions: 0 };
  const outbound = who?.kind === 'claude';
  let diagnosis;
  if (config.platform === 'darwin') {
    let ssh;
    try { ssh = sshHost(config); } catch {
      // macOS reaches Codex only through the configured alias; no local transport is a fallback (S01).
      add('codex_registry', 'fail', 'No valid Codex SSH alias is configured on macOS.', 'setup_incomplete');
      if (outbound) diagnosis = { reason: 'setup_incomplete', next_action: 'Set CLAUDE_CODEX_BRIDGE_SSH_HOST to a valid SSH configuration alias.' };
      return { checks, ...found, diagnosis };
    }
    add('codex_registry', 'pass', 'The configured SSH route does not use the local Desktop registry or daemon.');
    try {
      const chats = await listCodexChats({ ...ssh, limit: 50, signal, timeoutMs: 6000 });
      add('codex_tools', 'pass', 'The configured SSH host accepts public app-server discovery.');
      found.acceptedContext = chats.some(chat => chat.status === 'idle');
      add('codex_context', found.acceptedContext ? 'pass' : 'warning', found.acceptedContext
        ? 'The configured SSH host has a loaded idle chat.'
        : 'No idle chat was found in the bounded loaded-chat catalog.', 'target_unavailable');
    } catch (error) {
      throwIfStopped(signal);
      const slow = error.reason === 'route_unverified';
      const reason = error.reason ?? 'route_unavailable';
      add('codex_tools', slow ? 'warning' : 'fail', doctorFact(String(error.message)).slice(0, 300), reason);
      // Only a verified connection blocker applies to direct sends too. Catalog results prove no more.
      if (outbound && error.nextAction) diagnosis = { reason, next_action: error.nextAction };
      add('codex_context', slow ? 'warning' : 'fail', 'SSH discovery did not complete. No local Codex transport was attempted.', reason);
    }
    return { checks, ...found, diagnosis };
  }
  let hosts = [];
  try {
    hosts = await getCodexHosts({ stateDir: config.stateDir, signal });
    const present = localSocketPresence();
    const states = hosts.map(host => present(host.pipePath));
    const existing = states.filter(value => value === true).length;
    const missing = states.filter(value => value === false).length;
    // Present, missing and unverified are separate observations: a name the directory lookup cannot
    // check is not evidence of a live endpoint, and a missing one does not prove an earlier launch (E05).
    add('codex_registry', existing ? 'pass' : 'warning', !hosts.length
      ? 'No Codex Desktop registration is in this bridge’s state directory.'
      : `Saved Codex Desktop registrations: ${existing} present, ${missing} missing, ${hosts.length - existing - missing} unverified by directory lookup.`,
      existing === 0 && states.includes(undefined) ? 'route_unverified' : 'route_unavailable');
  } catch (error) {
    throwIfStopped(signal);
    if (error.code === 'HOST_CHANGED') add('codex_registry', 'warning', 'Saved Codex endpoint records changed during the check.', 'route_unverified');
    else add('codex_registry', 'fail', 'Saved Codex endpoint records are malformed or unreadable.', 'state_unavailable');
  }
  const current = who?.kind === 'codex' && who.transport === 'desktop' ? { pipePath: who.pipePath, threadId: who.threadId }
    : !who && config.env.CODEX_APP_TOOLS_PIPE_PATH ? { pipePath: config.env.CODEX_APP_TOOLS_PIPE_PATH,
      threadId: config.env.CODEX_THREAD_ID } : null;
  // The daemon listing, the version read and the Desktop probe are independent; run them together
  // and report them in the usual order (O03).
  const [daemon, versions, desktop] = await Promise.all([
    daemonInquiry(config, signal, (connection, attempt) =>
      listTerminalThreads(connection, { limit: 50, signal: attempt.signal, timeoutMs: attempt.timeoutMs }), { budgetMs: DOCTOR_DAEMON_BUDGET_MS })
      .then(threads => ({ threads }), error => ({ error })),
    readDaemonVersions({ env: config.env, timeoutMs: 2000, ...(config.daemonVersion ?? {}) }),
    // A slower Desktop build needs seconds for one discovery; a shorter wait would report a healthy app as stalled.
    selectDesktopHost([current, ...hosts],
      { ...config, desktop: { catalogMs: 1500, listMs: 5000, budgetMs: 8000, ...config.desktop } }, signal),
  ]);
  throwIfStopped(signal);
  if (daemon.threads) {
    found.terminalSessions = daemon.threads.filter(thread => ['idle', 'active'].includes(thread.status)).length;
    found.daemonReachable = true;
    add('codex_daemon', 'pass', found.terminalSessions
      ? 'The Codex daemon is reachable and lists stored Codex sessions. Their current client is not implied by discovery.'
      : 'The Codex daemon is reachable, but no eligible loaded session was found in its bounded catalog.');
  } else {
    const { error } = daemon;
    const unverified = error.inconclusive || error.code === 'DAEMON_TIMEOUT';
    const detail = unverified ? 'The Codex daemon did not answer in time.'
      : error.message === NOT_RUNNING_MESSAGE ? 'No Codex daemon is running.'
      : /native Codex \.exe/.test(error.message) ? 'The configured executable is not a native Codex .exe.'
      : /executable was not found/i.test(error.message) ? 'The Codex executable was not found.'
      : /^Codex terminal support is disabled/.test(error.message) ? 'Codex terminal support is disabled.'
      : 'Codex daemon discovery is unavailable.';
    add('codex_daemon', 'warning', detail, unverified ? 'route_unverified' : 'route_unavailable');
  }
  if (versions) {
    const differ = versions.cli && versions.server && versions.cli !== versions.server;
    add('codex_versions', differ ? 'warning' : 'pass',
      `Codex CLI ${versions.cli ?? 'unknown'}, daemon ${versions.server ?? 'unknown'}.`,
      'version_mismatch');
  }
  const { host, report } = desktop;
  found.acceptedContext = Boolean(host);
  const codexStatus = passed => passed ? 'pass' : report.stalled || report.unchecked || found.daemonReachable ? 'warning' : 'fail';
  const desktopIssue = desktopReason(report);
  const desktopFacts = desktopFailure(report, { factsOnly: true });
  add('codex_tools', codexStatus(report.compatible > 0), report.compatible
    ? 'Codex exposes compatible discovery and message tool schemas.' : desktopFacts, desktopIssue);
  add('codex_context', codexStatus(found.acceptedContext), found.acceptedContext
    ? 'Codex accepted a registered context for read-only chat discovery.' : desktopFacts, desktopIssue);
  // An offline daemon still allows the explicit CLI queue. Only a shared executable/setting
  // failure rules out both CLI routes; an empty/slow catalog cannot do so.
  if (outbound && !host && daemon.error?.terminalUnavailable && desktopIssue !== 'route_unverified') {
    const registry = checks.find(check => check.name === 'codex_registry');
    if (registry.status === 'fail') {
      diagnosis = { reason: registry.reason, next_action: 'Check the shared state directory and its saved Codex Desktop endpoint records.' };
    } else if (registry.reason !== 'route_unverified' && desktopIssue === 'protocol_incompatible' && !report.errors.length) {
      diagnosis = { reason: desktopIssue, next_action: 'Check that Codex Desktop exposes the bridge’s supported app tools.' };
    } else if (registry.reason !== 'route_unverified' && desktopIssue === 'route_unavailable') {
      diagnosis = { reason: desktopIssue, next_action: 'Run bridge_doctor from an open Codex Desktop task with the bridge enabled to register its endpoint.' };
    }
  }
  return { checks, ...found, diagnosis };
}

async function doctorClaudeChecks(context, config, who, callerProbeError, signal) {
  const checks = [];
  const add = (name, status, detail, reason) => checks.push({ name, status, detail, ...(status === 'pass' ? {} : { reason }) });
  const result = await verifiedClaudeSessions({ registryDir: config.registryDir, signal, probe: context.processProbe,
    skipPid: callerProbeError ? context.parentPid ?? process.ppid : undefined, known: who?.endpoint,
    firstOnly: true, budgetMs: DOCTOR_BUDGETS.claudeInboxMs });
  const registryIssue = result.issues.find(item => item.reason === 'state_unavailable');
  add('claude_registry', registryIssue ? (result.candidates ? 'warning' : 'fail') : result.candidates ? 'pass' : 'fail',
    registryIssue ? 'Claude registrations could not all be read.'
    : result.candidates ? 'Claude registrations were found; inbox connectivity is checked separately.'
    : 'No eligible Claude session is registered.', registryIssue?.reason ?? 'target_unavailable');
  const inboxAvailable = result.sessions.length > 0;
  // A slow or busy inbox proves nothing about the window: the check is inconclusive, not failed.
  const slow = ['target_unverified', 'target_busy'].find(reason => result.details[reason]);
  const failed = result.issues.find(item => item.reason !== 'state_unavailable')?.reason;
  const reason = callerProbeError || slow ? 'target_unverified' : failed ?? 'target_unavailable';
  // An inconclusive detail is already a plain fact ("…in time. Its availability is inconclusive."),
  // so it stays whole; a definite failure keeps only its observation, the repair goes to diagnosis.
  const observation = (slow ? result.details[slow] : doctorFact(result.details[failed]))?.replace(/\b(?:chosen|selected) Claude\b/g, 'registered Claude');
  add('claude_inbox', inboxAvailable ? 'pass' : reason === 'target_unverified' ? 'warning' : 'fail',
    inboxAvailable ? 'A verified Claude inbox accepts local connections. No message was sent; inbound policy was not tested.'
    : observation ?? (reason === 'target_unverified' ? 'Claude inbox availability could not be verified.'
    : 'No eligible Claude inbox was verified.'), reason);
  let diagnosis;
  if (who?.kind === 'codex' && !inboxAvailable && !slow) {
    if (registryIssue && !result.candidates) {
      diagnosis = { reason: registryIssue.reason, next_action: 'Check read access to the Claude session registry configured for the bridge.' };
    } else if (!registryIssue && result.issues.every(issue => issue.reason === 'target_unavailable')) {
      // For a registered inbox, use the action its verifier actually observed. Distinct
      // candidates can have unrelated causes; without a target, do not choose among them.
      const next_action = !result.candidates ? 'Check the Peer address in /status from a Claude Code conversation you want to reach.'
        : result.candidates === 1 ? result.details[reason]?.slice(doctorFact(result.details[reason]).length).trim() : undefined;
      if (next_action) diagnosis = { reason, next_action };
    }
  }
  return { checks, inboxAvailable, diagnosis };
}

/** Diagnose local configuration and transports, registering only verified Desktop
 * callers. Never send prompts or return credentials and local addresses.
 */
async function bridgeDoctor(context, config) {
  const signal = context.signal;
  throwIfStopped(signal);
  const checks = [];
  const add = (name, status, detail, reason) => checks.push({ name, status, detail, ...(status === 'pass' ? {} : { reason }) });
  const supportedPlatform = ['win32', 'darwin'].includes(config.platform);
  add('platform', supportedPlatform ? 'pass' : 'fail',
    config.platform === 'win32' ? 'Claude Code and Codex transports are supported on Windows.'
      : config.platform === 'darwin' ? 'macOS uses Claude Unix inboxes and an operator-configured Codex SSH host.'
      : 'Claude process identity verification is supported on Windows and macOS.', 'setup_incomplete');
  const state = inspectStateDirectory(config.stateDir);
  checks.push({ name: 'state_directory', ...state, ...(state.status === 'pass' ? {}
    : { reason: state.status === 'fail' ? 'state_unavailable' : 'setup_incomplete' }) });
  // The ACL probe picks its directory now but waits for a PowerShell child, so it runs beside the
  // other checks and keeps its place in the report.
  const privacyAt = checks.length;
  const privacy = state.status === 'fail' ? Promise.resolve()
    : stateDirectoryPrivacyWarning(config.stateDir, { signal }).catch(error => { throwIfStopped(signal); throw error; });
  privacy.catch(() => {});
  const migrationWarning = stateDirectoryWarning(config.stateDir);
  if (migrationWarning) add('state_migration', 'warning', migrationWarning, 'setup_incomplete');
  for (const warning of legacyEnvironmentWarnings(config.env)) add('legacy_environment', 'warning', warning, 'setup_incomplete');
  let application = config.env.CLAUDE_CODE_MESSAGING_SOCKET ? 'claude'
    : config.env.CODEX_APP_TOOLS_PIPE_PATH ? 'codex' : 'unknown';
  let who;
  let callerProbeError;
  let callerDiagnosis;
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
      callerDiagnosis = { reason: 'caller_unverified', next_action: 'Run bridge_doctor again from the same conversation when it responds.' };
    } else {
      if (error.application) application = error.application;
      const specific = ['caller_invalid', 'caller_changed', 'identity_check_unavailable'].includes(error.reason);
      add('caller', 'fail', specific ? error.message : application === 'unknown'
        ? 'No caller identity is available. Run this tool from the intended Claude Code or Codex conversation.'
        : application === 'codex'
        ? 'This call has no valid Codex task context. Run the tool from an open Codex task with the bridge enabled.'
        : 'The direct Claude parent session could not be verified. Open the bridge in the intended Claude Code session.',
      REASONS[error.reason] ? error.reason : 'caller_invalid');
      const next_action = {
        caller_invalid: 'Run bridge_doctor from the intended open conversation with the bridge enabled.',
        caller_changed: 'Run bridge_doctor from the conversation you intended to use.',
        identity_check_unavailable: 'Check that the bridge can read the Claude Code process identity on this system.',
        state_unavailable: 'Check read access to the Claude session registry configured for the bridge.',
      }[error.reason];
      if (typeof next_action === 'string') callerDiagnosis = { reason: error.reason, next_action };
    }
  } finally {
    callerBudget.dispose();
  }
  throwIfStopped(signal);
  let stateDiagnosis = state.status === 'fail'
    ? { reason: 'state_unavailable', next_action: 'Check the configured state directory’s location, write access and hard-link support.' }
    : undefined;
  const desktopCaller = who?.kind === 'codex' && who.transport === 'desktop';
  if (state.status === 'pass') {
    const locations = [['host_lock', config.stateDir], ['order_lock', path.join(config.stateDir, 'order')]];
    if (who) {
      const owner = ledgerAt({ stateDir: config.stateDir, threadId: senderLedgerId(who) });
      locations.push(['sender_lock', owner.dir]);
      if (who.kind === 'codex') locations.push(['manual_lock', path.join(config.stateDir, 'manual', owner.key)]);
    }
    for (const [name, directory] of locations) {
      const issue = await inspectStateLocks(directory, { signal });
      if (!issue) continue;
      const outbound = name === 'host_lock' ? desktopCaller : who && name !== 'manual_lock';
      add(name, issue.status, outbound ? issue.detail : doctorFact(issue.detail), 'state_unavailable');
      if (outbound && issue.status === 'fail') stateDiagnosis ??= {
        reason: 'state_unavailable', next_action: 'Consult the README’s shared-state lock recovery guidance before sending.',
      };
    }
  }
  let registrationError;
  if (state.status !== 'fail' && desktopCaller) {
    try { await publishCodexHost({ signal: context.signal, stateDir: config.stateDir, pipePath: who.pipePath, threadId: who.threadId }); }
    catch (error) {
      throwIfStopped(signal);
      registrationError = error;
      const busy = error.reason === 'state_busy' || error.code === 'HOST_CHANGED';
      add('codex_registration', busy ? 'warning' : 'fail', 'The verified Codex Desktop task could not be registered.', busy ? 'state_busy' : 'state_unavailable');
    }
  }
  const [permissions, codex, claude] = await Promise.all([privacy, doctorCodexChecks(config, who, signal),
    doctorClaudeChecks(context, config, who, callerProbeError, signal)]);
  if (registrationError && (registrationError.reason === 'state_unavailable' ||
      ['EACCES', 'EROFS', 'ENOSPC', 'EDQUOT'].includes(registrationError.code) ||
      codex.checks.some(check => check.name === 'codex_registry' && check.reason === 'state_unavailable'))) {
    stateDiagnosis ??= { reason: 'state_unavailable', next_action: 'Check the shared state directory and its saved Codex Desktop endpoint records.' };
  }
  if (permissions) checks.splice(privacyAt, 0, { name: 'state_permissions', status: 'warning', detail: permissions, reason: 'setup_incomplete' });
  checks.push(...codex.checks, ...claude.checks);
  const outbound = who?.kind === 'claude' ? codex : who?.kind === 'codex' ? claude : undefined;
  const diagnosis = stateDiagnosis ?? callerDiagnosis ?? outbound?.diagnosis;
  // Keep the 1.0 overall readiness contract. A caller-specific diagnosis is additive,
  // not a new meaning for ready, and a false result need not block a one-way send.
  const ready = Boolean(who) && !registrationError && (codex.acceptedContext || (codex.daemonReachable && codex.terminalSessions > 0)) &&
    claude.inboxAvailable && checks.every(check => check.status !== 'fail');
  const client = who?.kind === 'claude' ? who.endpoint.entrypoint : who?.kind === 'codex' ? `codex-${who.transport}` : 'unknown';
  return { application, ready, checks: checks.map(({ reason, ...check }) => check), issues: issuesOf(checks),
    ...(diagnosis ? { diagnosis } : {}), ...(context.pluginUpdate ? { client } : {}) };
}

/** Errors a transport adapter raised without naming a reason, classified by their typed fields. */
function transportReason(error, signal) {
  if (REASONS[error.reason]) return error.reason;
  if (signal?.reason?.code === 'BRIDGE_OUTPUT_BUSY') return 'server_busy';
  if (error.code === 'BRIDGE_DEADLINE') return 'deadline';
  // An adapter's own abort error does not say whether the client cancelled or the deadline passed.
  if (isCancelledError(error)) return signal?.reason?.code === 'BRIDGE_DEADLINE' ? 'deadline' : 'cancelled';
  if (error instanceof TerminalNotLoadedError) return 'target_unavailable';
  if (error.code === 'ENDPOINT_GONE' || error instanceof DaemonUnavailableError) return 'route_unavailable';
  if (error.code === 'DESKTOP_TIMEOUT' || error.code === 'DAEMON_TIMEOUT') return 'route_unverified';
  // A JSON-RPC refusal that the adapter proved happened before acceptance.
  if (typeof error.code === 'number' || error.rpcCode !== undefined) return 'request_rejected';
  return 'internal_error';
}

const explicitRouteAdvice = 'Confirm with the user whether the session is open in Desktop or CLI. Send on that explicit transport with a new message_id, without the retry flag.';

/** The answer for an exact earlier attempt with this message_id; only a submitted one is a result. */
function replay(record) {
  if (record.status === 'submitted') return { delivery: publicDelivery(record), outcome: outcome('already_submitted', { record }) };
  if (record.status === 'failed' && REASONS[record.reason]?.delivered === false) {
    const repair = record.retry === 'new_id' ? explicitRouteAdvice : record.reason === 'queued_message_too_long' ? 'Shorten the message and use a new ID.' : 'To retry after fixing the cause, use retry_failed: true with the original ID, route and text.';
    throw failure(`No new send was made. This ID has a recorded no-write failure. ${repair}`, record.reason, { outcome: outcome(record.reason, { record }) });
  }
  const [text, reason] = record.status === 'sending'
    ? ['No new send was made: the first attempt with this message_id is still in progress. Let it finish, then check list_deliveries.', 'in_flight']
    : record.status === 'uncertain'
    ? ['No new send was made: this message_id has uncertain delivery, so the first attempt may have arrived. Check the receiving conversation and list_deliveries before sending again.', 'prior_uncertain']
    : ['No new send was made: this message_id has a failed attempt that an earlier bridge version recorded without its cause. It may have arrived even if it is not visible yet. Check the receiving conversation and list_deliveries.', 'prior_failed'];
  throw Object.assign(new Error(text), { reason, outcome: outcome(reason, { record }) });
}

async function sendMessage(name, args, context, config, who) {
  // A loaded terminal thread's routing connection is kept for its send, and always closed here (O02).
  const held = { connection: null };
  try { return await deliver(name, args, context, config, who, held); } finally { held.connection?.close(); }
}

/** Repeat only the final read-only routing proof. Keep its connection for a single dispatch outside
 * the inquiry, leaving the write reserve intact. A timeout never authorizes the queue. */
async function terminalPlan(held, config, threadId, signal) {
  beforeWrite(signal);
  let timedOut = false;
  try {
    return await inquire(async attempt => {
      const kept = attempt.attempt === 1 ? held.connection : null;
      if (!kept) held.connection?.close(); // A late successful proof may briefly have retained its proxy.
      held.connection = null;
      const read = async connection => {
        const plan = await readTerminalPlan(connection, { threadId, signal: attempt.signal, timeoutMs: attempt.timeoutMs });
        throwIfStopped(attempt.signal);
        return plan;
      };
      try {
        if (!kept) return await withDaemon(config, attempt.signal, read, { timeoutMs: attempt.timeoutMs,
          keep: (_plan, connection) => { held.connection = connection; return true; } });
        const plan = await read(kept); held.connection = kept; return plan;
      } catch (error) {
        kept?.close();
        if (error.code === 'DAEMON_TIMEOUT' || (kept && error instanceof DaemonUnavailableError)) error.transient = true;
        throw error;
      }
    }, { signal, attemptMs: Math.min(INQUIRY_ATTEMPT_MS, config.daemon?.timeoutMs ?? Infinity), until: monotonicNow() + remainingMs(signal) - WRITE_RESERVE_MS,
      onTransient: error => { timedOut ||= ['ATTEMPT_TIMEOUT', 'DAEMON_TIMEOUT'].includes(error.code); } });
  } catch (error) {
    throwIfStopped(signal);
    if (error.inconclusive || (timedOut && (error instanceof DaemonUnavailableError || error instanceof TerminalNotLoadedError))) {
      throw failure('The Codex daemon did not verify the final route in time. Retry the same call.', 'route_unverified');
    }
    throw error;
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
  const draft = { direction, message: args.message, route, manual: context.manual === true, ...(direction === 'to_codex' ? { requestedTransport: transport } : {}) };
  // One read answers an exact earlier attempt before any recipient check: its result does not depend on
  // whether the recipient is still open (C01, A06), reading it writes nothing (D04), and the same read
  // finds the sender's ledger for the reservation below (O04).
  const lookup = await lookupMessage({ stateDir: config.stateDir, threadId: senderLedgerId(who) }, { id: args.message_id, ...draft }, { signal });
  const prior = await repairSettlement(lookup.session, lookup.prior, signal);
  const retryFailed = args.retry_failed === true && typeof args.message_id === 'string';
  if (args.retry_failed === true && !prior) throw failure('Retry requires an existing explicit message_id with a recorded no-write failure on this route. No new send was made.', 'invalid_argument');
  if (prior && !(retryFailed && prior.retryable && prior.requestedTransport === draft.requestedTransport)) {
    if (prior.interrupted) {
      let current;
      try { current = await recordMessage(lookup.session, { id: args.message_id, ...draft, expectedAttempt: prior.attemptId, reconcileOnly: true }, { signal }); } catch { /* remain inspect-only */ }
      if (current) return replay(current.message);
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
    ? await desktopRoute(who, config, signal, { targetId: targetThreadId, limit: MAX_CODEX_CHAT_LIMIT }) : null;
  const host = ssh || desktop?.host || null;
  const messageId = args.message_id ?? crypto.randomUUID();
  const peerText = terminalTarget || ssh ? codexPeerContent({ fromKind: 'claude', fromId: route.from.id, bridgeMessageId: messageId, body: args.message, remote: Boolean(ssh) }) : undefined;
  // Refuse before recordMessage reserves the ID, so a message that can never be sent does not spend it as failed.
  const targetRefused = terminalTarget?.queueRoute && queueTargetRefusal(targetThreadId);
  if (targetRefused) throw failure(targetRefused, 'invalid_argument');
  const queueRefused = terminalTarget?.queueRoute ? queueRefusal(peerText) : null;
  if (queueRefused) throw queueRefused;
  throwIfStopped(signal);
  checkSettlementCapacity();
  const session = lookup.session ?? await senderLedger(who, config, signal);
  throwIfStopped(signal);
  // The lookup above has just read this ledger, so the reservation goes straight to its lock.
  const reserved = await recordMessage(session, { id: messageId, ...draft, retryFailed, expectedAttempt: prior?.attemptId }, { signal });
  if (!reserved.created) return replay(reserved.message);
  const record = status => ({ id: messageId, status });
  let receipt;
  try {
    throwIfStopped(signal);
    if (direction === 'to_claude') {
      const source = context.manual === true ? 'User sent from Codex Desktop task'
        : who.transport === 'terminal' ? 'From Codex terminal session' : 'From Codex Desktop task';
      // A terminal/queue return path on Windows is explicit. Neither a carrier nor a matching ID
      // identifies the caller's host across SSH; do not invent a local or remote return address.
      const hint = context.manual === true ? '' : config.platform === 'darwin' ? '; reply host unverified'
        : who.transport === 'terminal' && config.platform === 'win32' ? '; reply transport unverified' : '';
      const notice = collaboratorNotice(`[${source} ${quoted(route.from.id)}; bridge message ${quoted(messageId)}${hint}]`, args.message,
        context.manual === true ? 'human' : 'peer');
      receipt = await sendToClaude({ ...endpoint, message: notice, senderName: senderLabel(route.from.id), signal, probe: context.processProbe });
    } else if (terminalTarget) {
      let sent;
      try {
        if (terminalTarget.queueOnly) throw new TerminalNotLoadedError('The daemon is unavailable for this explicit terminal route.');
        const plan = await terminalPlan(held, config, route.to.id, signal);
        sent = await writeTerminalPlan(held.connection, plan, { text: peerText, messageId, signal });
      } catch (error) {
        // Thrown before anything is written, so the queue fallback can never double-deliver. An explicit
        // terminal route also queues when the daemon went away before the input was written (Q03).
        const unwritten = error instanceof TerminalNotLoadedError ||
          (terminalTarget.allowQueue && error instanceof DaemonUnavailableError && !error.deliveryUnknown);
        if (!unwritten) throw error;
        if (!terminalTarget.allowQueue) throw failure(`The selected Codex session left the daemon before sending. No message was sent. ${explicitRouteAdvice}`, 'target_unavailable', { retry: 'new_id' });
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
      const notice = collaboratorNotice(`[From ${client} session ${quoted(route.from.id)}; bridge message ${quoted(messageId)}]`, args.message);
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
    const terminal = { status, route, attemptId: reserved.message.attemptId, error: error.message, ...(status === 'failed' ? { reason, ...(error.retry === 'new_id' ? { retry: 'new_id' } : {}) } : {}) };
    try { await waitForSettlement(finishMessage(session, messageId, terminal), signal); }
    catch { saved = false; retainSettlement(session, reserved.message, terminal); }
    // The record is still reserved until a disk-only repair. Do not suggest bypassing that repair.
    error.outcome = outcome(reason, { record: record(saved ? status : 'sending'), retry: !saved && status === 'failed' ? 'inspect' : terminal.retry });
    if (reason === 'queued_message_too_long' && saved) error.message += ' This ID is already reserved for the original text; use a new ID for the shorter message.';
    if (!saved) error.message = (terminal.retry === 'new_id' ? 'No message was sent. Inspect the original ID with list_deliveries before considering a route change.' : error.message) + ' The outcome could not be saved in the delivery record.';
    throw error;
  }
  try {
    const settled = await waitForSettlement(finishMessage(session, messageId, { status: 'submitted', route, attemptId: reserved.message.attemptId, ...(receipt ? { receipt } : {}) }), signal);
    return { delivery: publicDelivery(settled), outcome: outcome('submitted', { record: settled }) };
  } catch {
    // A rename can have committed before lock or temp cleanup failed. Return the authoritative
    // submission if it is readable; otherwise never claim a stale record state we have not seen.
    let saved;
    try { saved = (await waitForSettlement(lookupMessage({ stateDir: config.stateDir, threadId: senderLedgerId(who) }, { id: messageId, ...draft }, { signal }), signal)).prior; } catch {}
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
      const found = await desktopRoute(who, config, signal, { limit, collect: true });
      if (found.chats) return found;
      const catalog = await listCodexTools(found.host.pipePath, { signal });
      return { report: { incompatible: desktopCompatible(catalog) ? 0 : 1 }, chats: await listCodexChats({ pipePath: found.host.pipePath, contextThreadId: found.host.threadId, limit, signal, catalog }) };
    })(),
    daemonInquiry(config, signal, (connection, attempt) =>
      listTerminalThreads(connection, { limit, signal: attempt.signal, timeoutMs: attempt.timeoutMs })),
  ]);
  throwIfStopped(signal);
  const warnings = [];
  const issues = [];
  let chats = [];
  if (desktop.status === 'fulfilled') {
    chats = desktop.value.chats.map(chat => ({ ...chat, source: 'desktop' }));
    if (desktop.value.report?.incompatible) {
      warnings.push('A registered Desktop cannot accept a host-pinned send. Its readable local chats can still be listed.');
      issues.push({ source: 'desktop', reason: 'protocol_incompatible' });
    }
    const errors = [...new Set(desktop.value.report?.errors)];
    if (errors.length) {
      warnings.push('Some registered Desktop discovery requests failed; the local chat list may be incomplete.');
      for (const reason of errors) issues.push({ source: 'desktop', reason });
    }
    // A saved endpoint that could not be checked may be a running app with more chats.
    if (desktop.value.report?.stalled || desktop.value.report?.unchecked) {
      warnings.push('Some saved Codex Desktop endpoints did not answer in time, so Desktop chats may be missing. Retry the same call.');
      issues.push({ source: 'desktop', reason: 'route_unverified' });
    }
  } else {
    warnings.push(`Codex Desktop unavailable: ${desktop.reason.message}`);
    issues.push({ source: 'desktop', reason: transportReason(desktop.reason) });
  }
  if (terminal.status === 'fulfilled') {
    // Source names describe discovery transports, not the thread's current client.
    // Retain the Desktop title and metadata when both transports list the same ID.
    const desktopIds = new Set(chats.map(chat => chat.thread_id));
    chats = [...chats, ...terminal.value.filter(chat => !desktopIds.has(chat.thread_id))];
    if (terminal.value.damaged) {
      warnings.push('Some Codex terminal sessions were omitted because the daemon returned entries without a usable ID or with an unsupported status.');
      issues.push({ source: 'terminal', reason: 'protocol_incompatible' });
    }
  } else {
    if (shouldReportTerminalUnavailable(terminal.reason, desktop.status === 'fulfilled')) warnings.push(`Codex terminal sessions unavailable: ${terminal.reason.message}`);
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
    return { application: 'unknown', ready: false, checks, issues: issuesOf([{ ...checks[0], reason: error.reason }]),
      diagnosis: { reason: error.reason, next_action: 'Check that both apps select the same usable shared state directory.' } };
  }
  if (name === 'bridge_doctor') return bridgeDoctor(context, config);
  if (name === 'list_claude_sessions') {
    const list = await verifiedClaudeSessions({ registryDir: config.registryDir, signal: context.signal, probe: context.processProbe });
    // Rows are verified inboxes only. A registration replaced by a restart is routine, not incompleteness.
    const issues = list.issues.filter(item => item.reason !== 'target_changed');
    const sessions = list.sessions.map(({ sessionId, name: title, cwd, entrypoint, status }) => ({ session_id: sessionId, title, cwd, entrypoint, status }));
    return { sessions, ...(issues.length ? { issues } : {}) };
  }
  const publishesHost = name === 'panel_retry_notice';
  const who = await caller(context, config, { publish: publishesHost });
  if (['bridge_panel', 'panel_history', 'panel_send', 'panel_retry_notice'].includes(name)) {
    if (who.kind !== 'codex' || who.transport !== 'desktop') throw failure('The conversation panel is available only from a Codex Desktop chat.', 'wrong_tool');
    if (name === 'panel_send') return manualSend(args, context);
    if (name === 'panel_retry_notice') return retryManualNotice(args, context);
    if (name === 'panel_history') return getBridgeConversation({ stateDir: config.stateDir,
      ownerThreadId: who.threadId, sessionId: args.session_id, limit: args.limit, cursor: args.cursor, historyOrder: args.history_order, signal: context.signal });
    const catalog = await listClaudeConversations({ registryDir: config.registryDir,
      projectsDir: path.join(config.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'),
      stateDir: config.stateDir, ownerThreadId: who.threadId, cursor: args.cursor, signal: context.signal, probe: context.processProbe });
    // The model sees only what opens the panel: live sessions, which list_claude_sessions already
    // shows it. Archived titles and project paths travel as UI-only result metadata (PR02).
    // config.toml is not the Enter action Codex applies (K03), so the 1.0 field names the safe mode.
    return { owner_thread_id: who.threadId, application: 'codex', sessions: catalog.conversations.filter(chat => chat.live),
      warnings: [...catalog.warnings.filter(w => publicCatalogWarnings.has(w) || historyWarnings.includes(w)),
        ...(catalog.next_cursor ? ['Some Claude metadata was omitted because the scan limit was reached.'] : [])], composer_enter_behavior: 'cmdAlways',
      [PANEL_CATALOG]: { history_order: 'commit', sessions: catalog.conversations, warnings: catalog.warnings, next_cursor: catalog.next_cursor } };
  }
  if (name === 'list_codex_threads') return listCodexThreads(args, context, config, who);
  if (name === 'list_deliveries') {
    let deliveries = [], issues = [];
    try {
      ({ rows: deliveries, issues } = await listMessages(ledgerAt({ stateDir: config.stateDir, threadId: senderLedgerId(who) }),
        { limit: args.limit ?? 20, messageId: args.message_id }, sender(who), context.signal));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { application: who.kind, sender_id: sender(who).id, deliveries: deliveries.map(publicDelivery), ...(issues.length ? { issues } : {}) };
  }
  if (name !== 'send_to_claude' && name !== 'send_to_codex') throw failure('Unknown bridge tool', 'invalid_argument');
  const sent = await sendMessage(name, args, context, config, who);
  if (context.manual) return sent;
  // The public projection is fresh: change no reserved row, transport body, or panel receipt.
  if (args.include_message === false) delete sent.delivery.message;
  return { ...sent, summary: 'Handed off; recipient outcome unknown.' };
}
