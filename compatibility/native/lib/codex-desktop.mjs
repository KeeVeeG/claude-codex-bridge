// Codex Desktop's bundled app-tools pipe is a local, version-sensitive interface.
// This adapter intentionally does not start a separate Codex agent or CLI session.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { listSshCodexChats, sendSshCodex } from './codex-ssh.mjs';
import { beforeWrite, cancelledError, throwIfAborted } from './call-time.mjs';
import { markDeliveryUnknown, rpcReplyKind, unconfirmedReply } from './codex-daemon.mjs';
import { failure } from './outcome.mjs';

const maxFrameBytes = 8 * 1024 * 1024;
export const MAX_CODEX_CHAT_LIMIT = 50;

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value;
}

function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > maxFrameBytes) throw new Error('Codex Desktop request exceeds 8 MiB.');
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

// Class (b): one framed request to the local Desktop pipe. A submitted call is reported unconfirmed and
// never repeated; discovery passes the sub-budgets in DESKTOP_TIMEOUTS (bridge-service) instead.
function request(pipePath, method, params, { timeoutMs = 30000, mutating = false, signal } = {}) {
  throwIfAborted(signal);
  requiredText(pipePath, 'Codex Desktop pipe path');
  const id = 1;
  const frame = encodeFrame({ id, jsonrpc: '2.0', method, params });
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let pending = Buffer.alloc(0);
    let finished = false;
    let submitted = false;
    const timer = setTimeout(() => fail(Object.assign(new Error(submitted
      ? 'Codex Desktop did not answer before the local request timeout.'
      : 'Codex Desktop did not accept the connection before the local request timeout.'), { code: 'DESKTOP_TIMEOUT' })), timeoutMs);

    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }

    function fail(error) {
      finish(mutating && submitted ? markDeliveryUnknown(error) : error);
    }

    function malformedReply(detail) {
      finish(mutating && submitted ? unconfirmedReply('Codex Desktop', detail)
        : failure(`Codex Desktop returned ${detail}.`, 'protocol_incompatible'));
    }

    function onAbort() { fail(cancelledError()); }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    socket.on('connect', () => {
      if (finished) return;
      if (signal?.aborted) { onAbort(); return; }
      if (mutating) {
        try { beforeWrite(signal); } catch (error) { fail(error); return; }
      }
      submitted = true;
      socket.write(frame);
    });
    socket.on('error', error => {
      if (error.code === 'ENOENT') {
        fail(Object.assign(new Error('This Codex Desktop endpoint belongs to an earlier Codex Desktop launch and no longer exists.'),
          { code: 'ENDPOINT_GONE' }));
        return;
      }
      const code = error.code ? ` (${error.code})` : '';
      fail(new Error(`Could not communicate with Codex Desktop${code}.`));
    });
    socket.on('close', () => {
      if (!finished) fail(new Error('Codex Desktop closed its local connection before replying.'));
    });
    socket.on('data', chunk => {
      if (finished) return;
      pending = Buffer.concat([pending, chunk]);
      while (!finished && pending.length >= 4) {
        const length = pending.readUInt32LE(0);
        if (length === 0 || length > maxFrameBytes) {
          malformedReply('an invalid frame length');
          return;
        }
        if (pending.length < length + 4) return;
        const payload = pending.subarray(4, length + 4);
        pending = pending.subarray(length + 4);
        let response;
        try {
          response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
        } catch {
          malformedReply('an invalid JSON response');
          return;
        }
        if (!response || typeof response !== 'object' || Array.isArray(response)) {
          malformedReply('an invalid response');
          return;
        }
        // A server request can reuse our numeric ID without answering this call.
        if (Object.hasOwn(response, 'method') || response.id !== id) continue;
        const kind = rpcReplyKind(response, true);
        if (kind === 'error') {
          const { code, message } = response.error;
          const reason = code === -32602 && message === 'Invalid app tool request' ? 'request_rejected'
            : code === -32601 ? 'protocol_incompatible' : 'internal_error';
          finish(mutating && submitted && reason === 'internal_error' ? unconfirmedReply('Codex Desktop')
            : failure(reason === 'request_rejected' ? 'Codex Desktop rejected the app tool request. Check its arguments.'
              : reason === 'protocol_incompatible' ? 'Codex Desktop does not support this method. Check the app-tools configuration.'
              : 'Codex Desktop could not complete the app tool request. Run bridge_doctor from an open Desktop task.', reason, { code }));
        } else if (kind === 'result') {
          finish(null, response.result);
        } else {
          malformedReply('a malformed response');
        }
      }
    });
  });
}

export async function listCodexTools(pipePath, { signal, timeoutMs = 10000 } = {}) {
  const result = await request(pipePath, 'tools/list', { threadStartKind: 'all' }, { timeoutMs, signal });
  if (!Array.isArray(result.tools) || result.tools.some(tool => typeof tool?.name !== 'string')) {
    throw failure('Codex Desktop returned no usable app-tools catalog.', 'protocol_incompatible');
  }
  return result.tools;
}

function appToolResult(result) {
  if (typeof result.success !== 'boolean' || !Array.isArray(result.contentItems)) return false;
  return result.contentItems.every(item => {
    switch (item?.type) {
      case 'inputText': return typeof item.text === 'string';
      case 'inputImage': return typeof item.imageUrl === 'string';
      case 'inputAudio': return typeof item.audioUrl === 'string';
      default: return false;
    }
  });
}

/** Discover actual local Codex chats through the running Desktop app. */
async function listNativeCodexChats({ pipePath, contextThreadId, limit = 30, signal, timeoutMs = 10000, catalog }) {
  throwIfAborted(signal);
  requiredText(contextThreadId, 'Registered Codex context task id');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CODEX_CHAT_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_CODEX_CHAT_LIMIT}`);
  }
  const tool = (catalog ?? await listCodexTools(pipePath, { signal, timeoutMs })).find(item => item?.name === 'list_threads');
  if (typeof tool?.namespace !== 'string' || !tool.namespace) {
    throw failure('This Codex Desktop version does not expose chat discovery', 'protocol_incompatible');
  }
  const result = await request(pipePath, 'tools/call', {
    arguments: { limit }, callerSource: 'codex', namespace: tool.namespace, tool: tool.name,
    threadId: contextThreadId, callId: `bridge-list-${randomUUID()}`, turnId: `bridge-list-${randomUUID()}`,
  }, { timeoutMs, signal });
  if (!appToolResult(result)) throw failure('Codex Desktop returned an unsupported chat discovery result', 'protocol_incompatible');
  if (!result.success) throw failure('Codex Desktop could not list chats for the supplied task context. Run bridge_doctor from an open Desktop task.', 'route_unavailable');
  let listing;
  for (const item of result.contentItems) {
    if (item.type !== 'inputText' || typeof item.text !== 'string') continue;
    try {
      const parsed = JSON.parse(item.text);
      if (Array.isArray(parsed.threads)) { listing = parsed; break; }
    } catch { /* Other text items are not the structured listing. */ }
  }
  if (!listing || (listing.pinnedThreads != null && !Array.isArray(listing.pinnedThreads))) throw failure('Codex Desktop returned an unsupported chat listing.', 'protocol_incompatible');
  const seen = new Set(), rows = [];
  for (const [items, cap] of [[listing.pinnedThreads ?? [], MAX_CODEX_CHAT_LIMIT], [listing.threads, limit]]) {
    let count = 0;
    for (const item of items) {
      const id = item?.id || item?.threadId;
      if (item?.kind !== 'codex' || (item.hostId != null && item.hostId !== 'local')) continue;
      if (typeof id !== 'string' || !id.trim()) throw failure('Codex Desktop returned a chat without a usable ID.', 'protocol_incompatible');
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({ thread_id: id, title: typeof item.title === 'string' ? item.title.slice(0, 512) : '',
        status: typeof item.status === 'string' ? item.status : 'unknown', cwd: typeof item.cwd === 'string' ? item.cwd.slice(0, 4096) : '', host_id: 'local' });
      if (++count >= cap) break;
    }
  }
  return rows;
}

// The outer task context selects the caller; only the target-host tool argument constrains dispatch.
function localMessageTool(catalog) {
  return catalog.find(tool => {
    const fields = tool?.inputSchema?.properties;
    return tool?.name === 'send_message_to_thread' && typeof tool.namespace === 'string' && tool.namespace &&
      ['threadId', 'prompt','hostId'].every(key => fields?.[key]?.type === 'string') &&
      (fields.hostId.const === undefined || fields.hostId.const === 'local') &&
      (!fields.hostId.enum || (Array.isArray(fields.hostId.enum) && fields.hostId.enum.includes('local')));
  });
}

export const desktopCompatible = catalog => Boolean(localMessageTool(catalog) && catalog.some(tool =>
  tool?.name === 'list_threads' && typeof tool.namespace === 'string' && tool.namespace));

/**
 * Send a native visible prompt to the exact Codex task selected by the caller.
 * Never retry this function automatically: the Desktop tool has no documented
 * idempotency guarantee. On transport loss deliveryUnknown is set on the error.
 */
async function sendNativeToCodex({ pipePath, contextThreadId, threadId, message, turnId, callId, signal, catalog }) {
  throwIfAborted(signal);
  requiredText(contextThreadId, 'Registered Codex context task id');
  requiredText(threadId, 'Selected Codex task id');
  requiredText(message, 'Message');
  const tool = localMessageTool(catalog ?? await listCodexTools(pipePath, { signal }));
  if (!tool) throw failure('Codex Desktop message tool has an unsupported input schema: cannot pin the target host to local. Use a Desktop build with target-host support.', 'protocol_incompatible');
  const result = await request(pipePath, 'tools/call', {
    arguments: { threadId, hostId: 'local', prompt: message },
    callerSource: 'codex',
    callId: callId ?? `bridge-call-${randomUUID()}`,
    namespace: tool.namespace,
    threadId: contextThreadId,
    tool: tool.name,
    turnId: turnId ?? `bridge-turn-${randomUUID()}`,
  }, { timeoutMs: 30000, mutating: true, signal });
  if (!appToolResult(result) || !result.success) {
    // An unsuccessful tool result does not prove the prompt was refused before acceptance.
    throw unconfirmedReply('Codex Desktop');
  }
  return result;
}

export async function listCodexChats(options = {}) {
  return options.sshHostAlias !== undefined ? listSshCodexChats(options) : listNativeCodexChats(options);
}

export async function sendToCodex(options = {}) {
  return options.sshHostAlias !== undefined ? sendSshCodex(options) : sendNativeToCodex(options);
}
