import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { discoverClaudeSessions } from './claude-sessions.mjs';
import { listBridgeContacts, validateHistoryOwner, validateClaudeHistoryId } from './bridge-history.mjs';

const MAX_PROJECTS = 256;
const MAX_HISTORY_FILES = 4096;
const WINDOW_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const UUID_FILE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.jsonl$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const cleanText = value => typeof value === 'string' && !/[\r\n\0]/.test(value) ? value.trim().toWellFormed() : '';
function safeText(value, maximum = 512) {
  const text = cleanText(value);
  if (text.length <= maximum) return text;
  let end = 0;
  for (const { index, segment } of graphemes.segment(text)) {
    if (index + segment.length > maximum) break;
    end = index + segment.length;
  }
  return text.slice(0, end);
}
const searchKey = value => value.normalize('NFC').toLowerCase().normalize('NFC');
const metadataError = code => Object.assign(new Error(code), { code });
const directoryWarnings = {
  root: {
    changed: 'The Claude project metadata directory changed during the read; native metadata was skipped. Refresh to retry.',
    unavailable: 'The Claude project metadata directory could not be verified; native metadata was skipped. Check read access, then retry.',
  },
  project: {
    changed: 'Some Claude project metadata directories changed during the read and were skipped. Refresh to retry.',
    unavailable: 'Some Claude project metadata directories could not be verified. Check read access, then retry.',
  },
};
const directoryWarning = (error, scope) => directoryWarnings[scope][error.code === 'DIRECTORY_CHANGED' ? 'changed' : 'unavailable'];

function checkCancellation(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Claude catalog request was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function contained(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function directoryIdentity(directory, parent) {
  if (parent) await verifyDirectory(parent);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid metadata directory');
  const realPath = await fs.realpath(directory);
  if (parent && !contained(parent.realPath, realPath)) throw new Error('Metadata directory escapes its parent');
  const identity = { directory, realPath, dev: stat.dev, ino: stat.ino, parent };
  await verifyDirectory(identity);
  return identity;
}

async function verifyDirectory(identity) {
  if (identity.parent) await verifyDirectory(identity.parent);
  try {
    const stat = await fs.lstat(identity.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino ||
        await fs.realpath(identity.directory) !== identity.realPath ||
        (identity.parent && !contained(identity.parent.realPath, identity.realPath))) throw metadataError('DIRECTORY_CHANGED');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw metadataError('DIRECTORY_CHANGED');
    throw error;
  }
}

async function verifyFileLocation(file, directory) {
  await verifyDirectory(directory);
  if (!contained(directory.realPath, await fs.realpath(file))) throw new Error('Metadata file escapes its directory');
}

async function readMetadataWindow(handle, size, offset, budget, totalSize) {
  const boundaryBytes = offset > 0 ? 1 : 0;
  if (size + boundaryBytes > budget.remaining) throw new Error('Metadata scan limit reached');
  budget.remaining -= size + boundaryBytes;
  const buffer = Buffer.alloc(size + boundaryBytes);
  let read = 0;
  while (read < buffer.length) {
    const { bytesRead } = await handle.read(buffer, read, buffer.length - read, offset - boundaryBytes + read);
    if (!bytesRead) throw metadataError('FILE_CHANGED');
    read += bytesRead;
  }
  const startsAtBoundary = offset === 0 || buffer[0] === 10;
  let text = buffer.subarray(boundaryBytes).toString('utf8');
  // Neither a partial leading JSON record nor a trailing unterminated record
  // is needed for the catalog. Large native tool outputs are never returned.
  if (!startsAtBoundary) {
    const newline = text.indexOf('\n');
    if (newline < 0) return [];
    text = text.slice(newline + 1);
  }
  const lines = text.split('\n');
  return offset + size === totalSize ? lines : lines.slice(0, -1);
}

async function sidecarTitle(projectIdentity, sessionId, budget) {
  await verifyDirectory(projectIdentity);
  const folder = path.join(projectIdentity.directory, sessionId);
  const folderIdentity = await directoryIdentity(folder, projectIdentity);
  const file = path.join(folder, 'custom-title.json');
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 8192 || before.size > budget.remaining) {
    throw new Error('Invalid title metadata');
  }
  await verifyFileLocation(file, folderIdentity);
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('Title changed');
    budget.remaining -= opened.size;
    const buffer = Buffer.alloc(opened.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await fs.lstat(file);
    await verifyFileLocation(file, folderIdentity);
    if (bytesRead !== opened.size || after.isSymbolicLink() || !after.isFile() ||
        after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size) throw new Error('Title changed');
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    return object(value) ? safeText(value.customTitle) : '';
  } finally { await handle.close(); }
}

async function historyMetadata(projectIdentity, filename, budget, signal, warnings) {
  checkCancellation(signal);
  await verifyDirectory(projectIdentity);
  const sessionId = filename.slice(0, -6);
  const file = path.join(projectIdentity.directory, filename);
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Invalid history file');
  await verifyFileLocation(file, projectIdentity);
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('History changed');
    // Adjacent head/tail windows are one contiguous read, including any split UTF-8 title.
    const contiguous = opened.size <= 2 * WINDOW_BYTES;
    const lines = await readMetadataWindow(handle, contiguous ? opened.size : WINDOW_BYTES, 0, budget, opened.size);
    if (!contiguous) {
      for (const line of await readMetadataWindow(handle, WINDOW_BYTES, opened.size - WINDOW_BYTES, budget, opened.size)) lines.push(line);
    }
    let title = '';
    let cwd = '';
    let lastActivity = Math.trunc(opened.mtimeMs);
    for (const line of lines) {
      checkCancellation(signal);
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!object(record) || (record.sessionId !== undefined && record.sessionId !== sessionId)) continue;
      // Deliberately omit summaries, firstPrompt, lastPrompt, message.content,
      // assistant outputs, attachments, and tool results.
      if (record.type === 'custom-title') title = safeText(record.customTitle) || title;
      if (!cwd) cwd = safeText(record.cwd, 32768);
      const timestamp = typeof record.timestamp === 'number' ? record.timestamp
        : typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
      if (Number.isFinite(timestamp) && timestamp >= 0) lastActivity = Math.max(lastActivity, Math.trunc(timestamp));
    }
    try { title = await sidecarTitle(projectIdentity, sessionId, budget) || title; }
    catch (error) { if (error.code !== 'ENOENT') warnings.add('Some Claude custom title metadata was unreadable or unsafe; a fallback title is shown.'); }
    const after = await fs.lstat(file);
    await verifyFileLocation(file, projectIdentity);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error('History changed');
    return { session_id: sessionId, title, cwd, live: false, last_activity_at: lastActivity, last_contact_at: null };
  } finally { await handle.close(); }
}

const hash = value => createHash('sha256').update(value).digest('hex');
const byKey = (left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
const nextToken = (scope, position) => Buffer.from(JSON.stringify({ v: 1, scope, ...position })).toString('base64url');
function readCatalogCursor(cursor, scope) {
  if (cursor == null) return null;
  if (typeof cursor === 'string' && cursor.length <= 512 && /^[A-Za-z0-9_-]+$/.test(cursor)) {
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (value?.v === 1 && value.scope === scope && typeof value.project === 'string' && /^[0-9a-f]{64}$/.test(value.project) &&
          typeof value.file === 'string' && (value.file === '' || UUID_FILE.test(value.file))) return value;
    } catch { /* invalid opaque cursor */ }
  }
  throw new Error('Invalid Claude catalog cursor.');
}

// Keep a bounded window of names, independent of filesystem enumeration order.
// The extra name identifies the first unprocessed entry, even across empty pages of search results.
async function nameWindow(directory, limit, keyOf, from, signal) {
  const names = [];
  const handle = await fs.opendir(directory);
  for await (const entry of handle) {
    checkCancellation(signal);
    const key = keyOf(entry);
    if (key === null || key < from) continue;
    names.push({ name: entry.name, key });
    if (names.length === 2 * limit) {
      names.sort(byKey);
      names.length = limit;
    }
  }
  return names.sort(byKey).slice(0, limit);
}

async function scanNative(root, before, signal, warnings) {
  const nativeProjects = [];
  let rootIdentity;
  let next;
  const budget = { remaining: MAX_SCAN_BYTES };
  let totalFiles = 0;
  try {
    rootIdentity = await directoryIdentity(root);
    const projects = await nameWindow(root, MAX_PROJECTS + 1,
      entry => entry.isDirectory() && !entry.isSymbolicLink() ? hash(entry.name) : null, before?.project ?? '', signal);
    await verifyDirectory(rootIdentity);
    for (const [index, project] of projects.entries()) {
      if (index === MAX_PROJECTS) {
        next = { project: project.key, file: '' };
        break;
      }
      const directory = path.join(root, project.name);
      try {
        const projectIdentity = await directoryIdentity(directory, rootIdentity);
        const values = [];
        const files = await nameWindow(directory, MAX_HISTORY_FILES - totalFiles + 1,
          entry => UUID_FILE.test(entry.name) ? entry.name : null, project.key === before?.project ? before.file : '', signal);
        await verifyDirectory(projectIdentity);
        for (const file of files) {
          if (totalFiles >= MAX_HISTORY_FILES || budget.remaining < WINDOW_BYTES * 2 + 8193) {
            next = { project: project.key, file: file.name };
            break;
          }
          totalFiles++;
          try { values.push(await historyMetadata(projectIdentity, file.name, budget, signal, warnings)); }
          catch (error) {
            checkCancellation(signal);
            if (error.code === 'DIRECTORY_CHANGED') throw error;
            warnings.add('Some Claude conversation metadata was unreadable or unsafe and was skipped. Check read access, then retry.');
          }
        }
        await verifyDirectory(projectIdentity);
        nativeProjects.push({ identity: projectIdentity, values });
      } catch (error) {
        checkCancellation(signal);
        warnings.add(directoryWarning(error, 'project'));
      }
      if (next) break;
    }
  } catch (error) {
    checkCancellation(signal);
    if (error.code !== 'ENOENT' || rootIdentity) warnings.add(directoryWarning(error, 'root'));
  }
  return { rootIdentity, nativeProjects, next };
}

/** Metadata-only catalog. A cursor advances the bounded native discovery, not
 * the live sessions or bridge contacts, which are always current observations.
 */
export async function listClaudeConversations({ registryDir, projectsDir = path.join(os.homedir(), '.claude', 'projects'),
  stateDir, ownerThreadId, search = '', cursor, signal } = {}) {
  validateHistoryOwner(ownerThreadId);
  if (typeof search !== 'string' || search.length > 256) throw new Error('Conversation search must be at most 256 characters.');
  checkCancellation(signal);
  const warnings = new Set();
  const conversations = new Map();
  const query = searchKey(search.trim());
  const root = path.resolve(projectsDir);
  const scope = hash(JSON.stringify([root, ownerThreadId, query]));
  const { rootIdentity, nativeProjects, next } = await scanNative(root, readCatalogCursor(cursor, scope), signal, warnings);
  checkCancellation(signal);
  const liveSessions = [];
  try {
    for (const live of discoverClaudeSessions({ registryDir })) {
      try { validateClaudeHistoryId(live.sessionId); } catch { warnings.add('Some live Claude session identifiers are unsupported.'); continue; }
      liveSessions.push(live);
    }
  } catch { warnings.add('The live Claude session registry could not be read.'); }
  const exchange = await listBridgeContacts({ stateDir, ownerThreadId, signal });
  for (const warning of exchange.warnings) warnings.add(warning);
  // Keep native metadata private until final ancestor checks pass. A root or
  // project replacement cannot authorize following a new junction and cannot
  // turn earlier snapshots into catalog results for a different directory.
  let rootUnchanged = true;
  if (rootIdentity) {
    try { await verifyDirectory(rootIdentity); }
    catch (error) { rootUnchanged = false; warnings.add(directoryWarning(error, 'root')); }
  }
  if (rootUnchanged) for (const project of nativeProjects) {
    checkCancellation(signal);
    try {
      await verifyDirectory(project.identity);
      for (const value of project.values) {
        const existing = conversations.get(value.session_id);
        if (!existing || (value.last_activity_at ?? 0) > (existing.last_activity_at ?? 0)) conversations.set(value.session_id, value);
      }
    } catch (error) { warnings.add(directoryWarning(error, 'project')); }
  }
  if (rootIdentity && rootUnchanged) {
    try { await verifyDirectory(rootIdentity); }
    catch (error) {
      conversations.clear();
      rootUnchanged = false;
      warnings.add(directoryWarning(error, 'root'));
    }
  }
  checkCancellation(signal);
  for (const live of liveSessions) {
    const prior = conversations.get(live.sessionId);
    conversations.set(live.sessionId, { session_id: live.sessionId,
      title: safeText(live.name) || prior?.title || '', cwd: safeText(live.cwd, 32768) || prior?.cwd || '', live: true,
      entrypoint: live.entrypoint,
      last_activity_at: prior?.last_activity_at ?? null, last_contact_at: null });
  }
  for (const [sessionId, lastContact] of exchange.contacts) {
    const prior = conversations.get(sessionId) ?? { session_id: sessionId, title: '', cwd: '', live: false,
      last_activity_at: null, last_contact_at: null };
    prior.last_contact_at = lastContact;
    conversations.set(sessionId, prior);
  }
  const result = [...conversations.values()].filter(value => !query ||
    searchKey(`${value.title}\n${value.cwd}\n${value.session_id}`).includes(query))
    .sort((left, right) => (exchange.orders.get(right.session_id) ?? 0) - (exchange.orders.get(left.session_id) ?? 0) ||
      (right.last_activity_at ?? 0) - (left.last_activity_at ?? 0) || left.session_id.localeCompare(right.session_id));
  const nextCursor = rootUnchanged && next ? nextToken(scope, next) : null;
  if (nextCursor) warnings.add('The catalog scan is incomplete. Continue discovery to search more archived Claude conversations.');
  return { conversations: result, warnings: [...warnings], next_cursor: nextCursor };
}
