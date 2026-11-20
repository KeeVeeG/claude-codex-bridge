import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import test from 'node:test';
import { getBridgeConversation } from '../lib/bridge-history.mjs';
import { listClaudeConversations } from '../lib/claude-history.mjs';
import { nativeFixture } from './native-helpers.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const ownerThreadId = 'history-view-owner';
const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-000000000010';
const otherSession = 'aaaaaaaa-bbbb-cccc-dddd-000000000011';
const MiB = 1024 * 1024;
const outgoing = (id, createdAt, more = {}) => ({ id, createdAt, direction: 'to_claude', status: 'submitted', message: id,
  route: { from: { kind: 'codex', id: ownerThreadId }, to: { kind: 'claude', id: sessionId } }, ...more });
const incoming = (id, createdAt) => ({ id, createdAt, direction: 'to_codex', status: 'submitted', message: id,
  route: { from: { kind: 'claude', id: sessionId }, to: { kind: 'codex', id: ownerThreadId } } });

function writeLedger(fixture, owner, records, { diskBytes } = {}) {
  const key = hash(owner);
  const directory = path.join(fixture.stateDir, key);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'state.json');
  const temp = `${file}.fixture.tmp`;
  const messages = Object.fromEntries(records.map((record, i) => [record?.route
    ? `route:${hash(JSON.stringify(record.route))}:${record.id}` : `record-${i}`, record]));
  fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, key, threadId: owner, cwd: fixture.cwd, messages }));
  if (diskBytes) {
    const padding = Buffer.alloc(MiB, 0x20);
    const fd = fs.openSync(temp, 'a');
    try {
      for (let left = diskBytes - fs.fstatSync(fd).size; left > 0; left -= padding.length) {
        fs.writeSync(fd, padding, 0, Math.min(left, padding.length));
      }
    } finally { fs.closeSync(fd); }
  }
  fs.renameSync(temp, file);
  return file;
}
// Same layout as the schema-1 writer, with real message content, no oversized padding.
function writeLargeLedger(fixture, { newest = 'latest', incomingLedger = false } = {}) {
  const owner = incomingLedger ? `claude:${sessionId}` : ownerThreadId;
  const key = hash(owner);
  const directory = path.join(fixture.stateDir, key);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'state.json');
  const fd = fs.openSync(file + '.fixture.tmp', 'w');
  const message = 'ASCII with delimiters [}], and \\". '.repeat(2100).slice(0, 62990) + ' — 東京 😀';
  const body = JSON.stringify(message);
  try {
    // Put the headers after messages in one direction to exercise format independence.
    const header = JSON.stringify({ schemaVersion: 1, key, threadId: owner, cwd: fixture.cwd }).slice(1, -1);
    fs.writeSync(fd, incomingLedger ? '{\n  "messages": {' : `{${header},\n  "messages": {`);
    for (let i = 0; i < 1590; i++) {
      const record = { ...(incomingLedger ? incoming(`reply-${i}`, 2 * i + 1) : outgoing(`sent-${i}`, 2 * i)),
        message: undefined, orderAt: 2 * i + Number(incomingLedger), fingerprint: 'a'.repeat(64) };
      if (!incomingLedger && i === 1589) record.id = newest;
      const rowKey = `route:${hash(JSON.stringify(record.route))}:${record.id}`;
      fs.writeSync(fd, `${i ? ',' : ''}\n    ${JSON.stringify(rowKey)}: ${JSON.stringify(record).slice(0, -1)},"message":${body}}`);
    }
    fs.writeSync(fd, incomingLedger ? `\n  },${header}\n}\n` : '\n  }\n}\n');
  } finally { fs.closeSync(fd); }
  fs.renameSync(file + '.fixture.tmp', file);
  assert.ok(fs.statSync(file).size > 96 * MiB);
  return { file, message };
}

const args = fixture => ({ stateDir: fixture.stateDir, ownerThreadId, sessionId, projectsDir: path.join(fixture.root, 'projects'),
  registryDir: path.join(fixture.root, 'absent-registry') });
const ids = result => result.messages.map(record => record.id);

function writeManual(fixture, rows) {
  const directory = path.join(fixture.stateDir, 'manual', hash(ownerThreadId));
  fs.mkdirSync(directory, { recursive: true });
  const records = Object.fromEntries(rows.map(record => [hash(JSON.stringify([record.session_id, record.message_id])), record]));
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({ schemaVersion: 1, owner_thread_id: ownerThreadId, records }));
}

function writeTitle(fixture, project, id, title, prefix = '') {
  const directory = path.join(args(fixture).projectsDir, project);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${id}.jsonl`), prefix + JSON.stringify({ type: 'custom-title', sessionId: id, customTitle: title }) + '\n');
}

test('page uses only exact paths and cached file generations; catalog reuses the owner view', async t => {
  const fixture = await nativeFixture(t);
  const file = writeLedger(fixture, ownerThreadId, [outgoing('first', 1), outgoing('second', 2)]);
  const list = fsp.readdir;
  const open = fsp.open;
  let listed = 0;
  let opens = 0;
  t.mock.method(fsp, 'readdir', async (...call) => { listed++; return list(...call); });
  t.mock.method(fsp, 'open', async (...call) => { if (file === call[0]) opens++; return open(...call); });
  const first = await getBridgeConversation({ ...args(fixture), limit: 1 });
  assert.deepEqual(ids(first), ['second']);
  assert.deepEqual(ids(await getBridgeConversation({ ...args(fixture), limit: 1, cursor: first.next_cursor })), ['first']);
  assert.equal(listed, 0);
  assert.equal(opens, 1);
  const catalog = await listClaudeConversations(args(fixture));
  assert.equal(catalog.conversations[0].last_contact_at, 2);
  assert.equal(opens, 1);
  // Same-size legacy-style atomic replacement must invalidate even when mtime is restored.
  const prior = fs.statSync(file);
  writeLedger(fixture, ownerThreadId, [outgoing('first', 1), outgoing('latest', 3)]);
  fs.utimesSync(file, prior.atime, prior.mtime);
  assert.equal(fs.statSync(file).size, prior.size);
  assert.deepEqual(ids(await getBridgeConversation({ ...args(fixture), limit: 1 })), ['latest']);
  assert.equal((await listClaudeConversations(args(fixture))).conversations[0].last_contact_at, 3);
  assert.equal(opens, 2);
});

test('read history over the former 32 MiB cutoff without changing the ledger', async t => {
  const fixture = await nativeFixture(t);
  const file = writeLedger(fixture, ownerThreadId, [outgoing('old', 1), outgoing('new', 2)], { diskBytes: 34 * MiB });
  const before = fs.statSync(file, { bigint: true });
  assert.deepEqual(ids(await getBridgeConversation(args(fixture))), ['old', 'new']);
  assert.equal((await listClaudeConversations(args(fixture))).conversations[0].last_contact_at, 2);
  const after = fs.statSync(file, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.size, before.size);
});

test('real schema-1 bodies over 96 MiB page repeatedly with bounded reads', async t => {
  const fixture = await nativeFixture(t);
  const { file, message } = writeLargeLedger(fixture);
  const stat = fs.statSync(file, { bigint: true });
  const open = fsp.open;
  let opens = 0, reads = 0, maxRead = 0;
  t.mock.method(fsp, 'open', async (...call) => {
    const handle = await open(...call);
    if (call[0] === file) {
      opens++;
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (buffer, offset, length, position) => {
        reads++;
        maxRead = Math.max(maxRead, length);
        return read(buffer, offset, length, position);
      });
    }
    return handle;
  });
  const delay = monitorEventLoopDelay({ resolution: 2 });
  const start = performance.now();
  delay.enable();
  let first;
  try { first = await getBridgeConversation({ ...args(fixture), limit: 1 }); }
  finally { delay.disable(); }
  const coldMs = performance.now() - start;
  assert.deepEqual(ids(first), ['latest']);
  assert.equal(first.messages[0].message, message);
  assert.deepEqual(first.warnings, []);
  const warmStart = performance.now();
  const second = await getBridgeConversation({ ...args(fixture), limit: 1, cursor: first.next_cursor });
  const third = await getBridgeConversation({ ...args(fixture), limit: 1, cursor: second.next_cursor });
  const warmMs = (performance.now() - warmStart) / 2;
  assert.deepEqual(ids(second), ['sent-1588']);
  assert.deepEqual(ids(third), ['sent-1587']);
  assert.equal(third.has_more, true);
  assert.equal((await listClaudeConversations(args(fixture))).conversations[0].last_contact_at, 3178);
  assert.equal(opens, 1);
  assert.ok(maxRead <= MiB);
  assert.ok(reads < 1590, 'reads are by window, not by row');
  assert.equal(fs.statSync(file, { bigint: true }).ctimeNs, stat.ctimeNs);
  t.diagnostic(`${stat.size} bytes, ${reads} reads (max ${maxRead} B): cold ${coldMs.toFixed(1)} ms, ` +
    `warm mean ${warmMs.toFixed(1)} ms, cold event-loop delay max ${(delay.max / 1e6).toFixed(1)} ms`);
});

test('unsafe single values cannot advance an exact history cursor', async t => {
  const fixture = await nativeFixture(t);
  const file = writeLedger(fixture, ownerThreadId, [outgoing('old', 1), outgoing('new', 2)]);
  const first = await getBridgeConversation({ ...args(fixture), limit: 1 });
  writeLedger(fixture, ownerThreadId, [outgoing('old', 1), outgoing('new', 2, { metadata: 'x'.repeat(3 * MiB) })]);
  const blocked = await getBridgeConversation({ ...args(fixture), cursor: first.next_cursor });
  assert.deepEqual(blocked.messages, []);
  assert.equal(blocked.next_cursor, first.next_cursor);
  assert.equal(blocked.has_more, true);
  assert.match(blocked.warnings.join(), /exceed safe history read limits/);
  assert.ok(fs.statSync(file).size > 3 * MiB);
});

test('an abort during a large read closes the handle and never admits the partial generation', async t => {
  const fixture = await nativeFixture(t);
  const { file } = writeLargeLedger(fixture);
  const controller = new AbortController();
  const open = fsp.open;
  let opens = 0, reads = 0, closes = 0;
  t.mock.method(fsp, 'open', async (...call) => {
    const handle = await open(...call);
    if (call[0] === file && ++opens === 1) {
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'read', async (...readArgs) => {
        const result = await read(...readArgs);
        if (++reads === 3) controller.abort();
        return result;
      });
      t.mock.method(handle, 'close', async () => { closes++; await close(); });
    }
    return handle;
  });
  await assert.rejects(getBridgeConversation({ ...args(fixture), signal: controller.signal }), { name: 'AbortError' });
  assert.equal(reads, 3);
  assert.equal(closes, 1);
  assert.deepEqual(ids(await getBridgeConversation({ ...args(fixture), limit: 1 })), ['latest']);
  assert.equal(opens, 2);
});

test('both large directions stay warm and a same-size replacement before publication is retried', async t => {
  const fixture = await nativeFixture(t);
  const primary = writeLargeLedger(fixture);
  const secondary = writeLargeLedger(fixture, { incomingLedger: true });
  const open = fsp.open;
  let opens = 0;
  t.mock.method(fsp, 'open', async (...call) => {
    const handle = await open(...call);
    if (++opens === 1 && call[0] === primary.file) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => {
        await close(); // Windows may prevent an atomic rename over an open handle.
        const before = fs.statSync(primary.file);
        writeLargeLedger(fixture, { newest: 'swapin' });
        fs.utimesSync(primary.file, before.atime, before.mtime);
        assert.equal(fs.statSync(primary.file).size, before.size);
      });
    }
    return handle;
  });
  const first = await getBridgeConversation({ ...args(fixture), limit: 1 });
  assert.deepEqual(ids(first), ['reply-1589'], first.warnings.join());
  assert.equal(first.messages[0].message, secondary.message);
  assert.deepEqual(first.warnings, []);
  const second = await getBridgeConversation({ ...args(fixture), limit: 1, cursor: first.next_cursor });
  assert.deepEqual(ids(second), ['swapin']);
  assert.equal(opens, 3);
});

test('catalog can discover an unknown Claude peer after cold unrelated ledgers fill the scan budget', async t => {
  const fixture = await nativeFixture(t);
  const peerKey = hash(`claude:${sessionId}`);
  const unrelated = Array.from({ length: 32 }, (_, i) => `unrelated-codex-${i}`).filter(id => hash(id) < peerKey).slice(0, 3);
  assert.equal(unrelated.length, 3);
  for (const id of unrelated) writeLedger(fixture, id, [], { diskBytes: 30 * MiB });
  writeLargeLedger(fixture, { incomingLedger: true });
  const first = await listClaudeConversations(args(fixture));
  assert.deepEqual(first.conversations, []);
  assert.ok(first.warnings.some(warning => /scan limit.*Refresh/.test(warning)));
  const next = await listClaudeConversations(args(fixture));
  assert.deepEqual(next.conversations.map(peer => [peer.session_id, peer.last_contact_at]), [[sessionId, 3179]]);
  assert.deepEqual(next.warnings, []);
});

test('requests-only and compact ledgers survive fragmented JSON; an invalid suffix suppresses partial rows', async t => {
  const fixture = await nativeFixture(t);
  const file = writeLedger(fixture, ownerThreadId, []);
  const key = hash(ownerThreadId);
  const header = { schemaVersion: 1, key, threadId: ownerThreadId, cwd: fixture.cwd };
  fs.writeFileSync(file, JSON.stringify({ requests: { legacy: ['old', { text: '\\"}[],\n東京😀' }] }, ...header }, null, 2));
  const open = fsp.open;
  t.mock.method(fsp, 'open', async (...call) => {
    const handle = await open(...call);
    if (call[0] === file) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', (buffer, offset, length, position) => read(buffer, offset, Math.min(length, 7), position));
    }
    return handle;
  });
  const legacy = await getBridgeConversation(args(fixture));
  assert.deepEqual(legacy.messages, []);
  assert.deepEqual(legacy.warnings, []);
  const message = '\\"}[],\n\u0000東京😀';
  writeLedger(fixture, ownerThreadId, [outgoing('compact', 1, { message })]);
  const compact = await getBridgeConversation(args(fixture));
  assert.equal(compact.messages[0].message, message);
  fs.appendFileSync(file, ' [false]');
  const invalid = await getBridgeConversation(args(fixture));
  assert.deepEqual(invalid.messages, []);
  assert.match(invalid.warnings.join(), /unsafe, damaged, or use an unsupported format/);
});

test('a replacement between lstat and open retries before advancing past either direction', async t => {
  const fixture = await nativeFixture(t);
  writeLedger(fixture, ownerThreadId, [outgoing('oldest', 1), outgoing('middle', 2)]);
  const file = writeLedger(fixture, `claude:${sessionId}`, [incoming('newest', 3)]);
  const open = fsp.open;
  let replaced = false;
  t.mock.method(fsp, 'open', async (...call) => {
    if (call[0] === file && !replaced) {
      writeLedger(fixture, `claude:${sessionId}`, [incoming('newest', 3), incoming('just-added', 4)]);
      replaced = true;
    }
    return open(...call);
  });
  const first = await getBridgeConversation({ ...args(fixture), limit: 1 });
  assert.equal(replaced, true);
  assert.deepEqual(ids(first), ['just-added']);
  assert.deepEqual(first.warnings, []);
  const next = await getBridgeConversation({ ...args(fixture), limit: 2, cursor: first.next_cursor });
  assert.deepEqual(ids(next), ['middle', 'newest']);
});

test('a released v1 keyset boundary survives newly appended records above it', async t => {
  const fixture = await nativeFixture(t);
  writeLedger(fixture, ownerThreadId, [outgoing('older', 1), outgoing('boundary', 3), outgoing('appended', 5)]);
  writeLedger(fixture, `claude:${sessionId}`, [incoming('tie', 3), incoming('between', 2)]);
  const cursor = Buffer.from(JSON.stringify({ v: 1, owner: hash(ownerThreadId), session: hash(sessionId),
    at: 3, key: 'to_claude:boundary' })).toString('base64url');
  const earlier = await getBridgeConversation({ ...args(fixture), cursor });
  assert.deepEqual(ids(earlier), ['older', 'between']);
  assert.equal(earlier.has_more, false);
});

test('when bounded retry cannot verify a direction the earlier cursor can be retried', async t => {
  const fixture = await nativeFixture(t);
  writeLedger(fixture, ownerThreadId, [outgoing('older', 1), outgoing('latest', 3)]);
  const first = await getBridgeConversation({ ...args(fixture), limit: 1 });
  const file = writeLedger(fixture, `claude:${sessionId}`, [incoming('between', 2)]);
  const open = fsp.open;
  let replacements = 0;
  let racing = true;
  t.mock.method(fsp, 'open', async (...call) => {
    if (call[0] === file && racing) {
      replacements++;
      writeLedger(fixture, `claude:${sessionId}`, [incoming('between', 2)]);
    }
    return open(...call);
  });
  const pageArgs = { ...args(fixture), limit: 1, cursor: first.next_cursor };
  const incomplete = await getBridgeConversation(pageArgs);
  assert.equal(replacements, 3);
  assert.deepEqual(incomplete.messages, []);
  assert.equal(incomplete.next_cursor, first.next_cursor);
  assert.equal(incomplete.has_more, true);
  assert.match(incomplete.warnings.join(), /ledger changed.*Refresh/);
  racing = false;
  assert.deepEqual(ids(await getBridgeConversation(pageArgs)), ['between']);
});

test('every continuation honors the row and byte bounds without dropping the boundary row', async t => {
  const fixture = await nativeFixture(t);
  const records = Array.from({ length: 27 }, (_, i) => outgoing(`id-${String(i).padStart(2, '0')}`, i, { message: '\\'.repeat(60000) }));
  writeLedger(fixture, ownerThreadId, records);
  let cursor;
  let seen = [];
  for (let n = 0; n < 27; n++) {
    const limit = n === 0 ? 3 : 200;
    const page = await getBridgeConversation({ ...args(fixture), limit, cursor });
    const expectedCount = Math.min(limit, 8, 27 - seen.length);
    assert.equal(page.messages.length, expectedCount);
    assert.ok(page.messages.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0) <= MiB);
    seen = [...ids(page), ...seen];
    assert.equal(page.has_more, seen.length !== records.length);
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, records.map(record => record.id));
});

test('missing manual primary is a body-free omission; exact text and fingerprint restore the row', async t => {
  const fixture = await nativeFixture(t);
  const fingerprint = 'a'.repeat(64);
  const row = { manual: true, message_id: 'manual', session_id: sessionId, fingerprint, send_status: 'submitted', notice_status: 'submitted',
    notice_attempted: true, sender_pid: process.pid, createdAt: 7, updatedAt: 8 };
  writeManual(fixture, [row, { ...row, session_id: otherSession, send_status: 'uncertain' }]);
  const page = await getBridgeConversation(args(fixture));
  assert.deepEqual(page.messages, []);
  assert.match(page.warnings.join(), /confirmed without matching saved message text: 1.*do not resend/);
  assert.doesNotMatch(JSON.stringify(page), new RegExp(fingerprint));
  const catalog = await listClaudeConversations(args(fixture));
  assert.deepEqual(catalog.conversations.map(peer => [peer.session_id, peer.last_contact_at]), [[sessionId, 7]]);
  writeLedger(fixture, ownerThreadId, [outgoing('manual', 7, { fingerprint, message: 'Body from primary only.' })]);
  const joined = await getBridgeConversation(args(fixture));
  assert.deepEqual(joined.warnings, []);
  assert.equal(joined.messages[0].message, 'Body from primary only.');
  assert.equal(joined.messages[0].notice_status, 'submitted');
  writeLedger(fixture, ownerThreadId, []);
  const message = 'Verified manual body without a primary copy.';
  const route = outgoing('manual', 7).route;
  writeManual(fixture, [{ ...row, message, fingerprint: hash(JSON.stringify({ direction: 'to_claude', message, route })) }]);
  const shadow = await getBridgeConversation(args(fixture));
  assert.deepEqual(shadow.warnings, []); assert.equal(shadow.messages.length, 1);
  assert.equal(shadow.messages[0].message, message); assert.equal(shadow.messages[0].notice_status, 'submitted');
  writeLedger(fixture, ownerThreadId, [outgoing('newest', 9), outgoing('oldest', 3)]);
  const first = await getBridgeConversation({ ...args(fixture), limit: 1 });
  assert.deepEqual(ids(first), ['newest']);
  const folder = path.join(fixture.stateDir, 'manual'), backup = path.join(fixture.root, 'manual-backup');
  fs.renameSync(folder, backup); fs.writeFileSync(folder, 'not a directory');
  const interrupted = await getBridgeConversation({ ...args(fixture), cursor: first.next_cursor });
  assert.deepEqual(ids(interrupted), []); assert.equal(interrupted.next_cursor, first.next_cursor);
  fs.unlinkSync(folder); fs.renameSync(backup, folder);
  assert.deepEqual(ids(await getBridgeConversation({ ...args(fixture), cursor: interrupted.next_cursor })), ['oldest', 'manual']);
});

test('history distinguishes unverifiable, invalid and unassignable history without printing file paths', async t => {
  const fixture = await nativeFixture(t);
  const file = writeLedger(fixture, ownerThreadId, [outgoing('valid', 1), null, { id: 'no-route' }]);
  const valid = await getBridgeConversation(args(fixture));
  assert.deepEqual(ids(valid), ['valid']);
  assert.match(valid.warnings.join(), /invalid or duplicate/);
  assert.match(valid.warnings.join(), /lack exact routing/);
  const lstat = fsp.lstat;
  let deny = false;
  const open = fsp.open;
  t.mock.method(fsp, 'open', async (...call) => {
    const handle = await open(...call);
    if (call[0] === file) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { await close(); deny = true; });
    }
    return handle;
  });
  t.mock.method(fsp, 'lstat', async (...call) => {
    if (deny && call[0] === fixture.stateDir) throw Object.assign(new Error(fixture.stateDir), { code: 'EACCES' });
    return lstat(...call);
  });
  writeLedger(fixture, ownerThreadId, [outgoing('new', 2)]);
  const inaccessible = await getBridgeConversation(args(fixture));
  assert.deepEqual(inaccessible.messages, []);
  assert.match(inaccessible.warnings.join(), /directory could not be verified/);
  assert.doesNotMatch(inaccessible.warnings.join(), /directory changed/);
  assert.ok(!inaccessible.warnings.join().includes(fixture.stateDir));
  deny = false;
  t.mock.restoreAll();
  fs.writeFileSync(file, '{damaged and secret');
  const invalid = await getBridgeConversation(args(fixture));
  assert.match(invalid.warnings.join(), /unsafe, damaged, or use an unsupported format/);
  assert.doesNotMatch(invalid.warnings.join(), /secret|changed/);
});

test('native bounded discovery yields a cursor even when the first search window is empty', async t => {
  const fixture = await nativeFixture(t);
  const projects = Array.from({ length: 257 }, (_, i) => `project-${String(i).padStart(3, '0')}`).sort((a, b) => hash(a).localeCompare(hash(b)));
  for (const project of projects) fs.mkdirSync(path.join(args(fixture).projectsDir, project), { recursive: true });
  writeTitle(fixture, projects.at(-1), sessionId, 'Hidden archived title');
  const query = { ...args(fixture), search: 'archived title' };
  const first = await listClaudeConversations(query);
  assert.deepEqual(first.conversations, []);
  assert.equal(typeof first.next_cursor, 'string');
  assert.match(first.warnings.join(), /catalog scan is incomplete/);
  await assert.rejects(listClaudeConversations({ ...query, ownerThreadId: 'different', cursor: first.next_cursor }), /Invalid Claude catalog cursor/);
  const next = await listClaudeConversations({ ...query, cursor: first.next_cursor });
  assert.deepEqual(next.conversations.map(peer => peer.session_id), [sessionId]);
  assert.equal(next.next_cursor, null);
});

test('a native UTF-8 title spanning adjacent windows is retained', async t => {
  const fixture = await nativeFixture(t);
  const title = 'Résumé — 東京';
  const head = ' '.repeat(65536 - 19) + '\n';
  writeTitle(fixture, 'project', sessionId, title, head);
  const result = await listClaudeConversations(args(fixture));
  assert.deepEqual(result.conversations.map(peer => peer.title), [title]);
});

test('native search matches canonically equivalent text without rewriting the title', async t => {
  const fixture = await nativeFixture(t);
  const title = 'Résumé — 東京';
  writeTitle(fixture, 'project', sessionId, title);
  const result = await listClaudeConversations({ ...args(fixture), search: title.normalize('NFD').toUpperCase() });
  assert.deepEqual(result.conversations.map(peer => peer.title), [title]);
});

test('native titles keep complete graphemes and the original NFC or NFD spelling', async t => {
  const fixture = await nativeFixture(t);
  writeTitle(fixture, 'project', sessionId, 'a'.repeat(510) + '👩‍💻');
  writeTitle(fixture, 'project', otherSession, 'é'.repeat(255) + '😀');
  const result = await listClaudeConversations(args(fixture));
  assert.equal(result.conversations.find(peer => peer.session_id === sessionId).title, 'a'.repeat(510));
  assert.equal(result.conversations.find(peer => peer.session_id === otherSession).title, 'é'.repeat(255) + '😀');
});

test('native final root verification reports access failure, not a move', async t => {
  const fixture = await nativeFixture(t);
  writeTitle(fixture, 'project', randomUUID(), 'Do not return this title under an unverifiable root');
  writeLedger(fixture, ownerThreadId, []);
  const list = fsp.readdir;
  const stat = fsp.lstat;
  let deny = false;
  t.mock.method(fsp, 'readdir', async (...call) => {
    if (call[0] === fixture.stateDir) deny = true;
    return list(...call);
  });
  t.mock.method(fsp, 'lstat', async (...call) => {
    if (deny && call[0] === args(fixture).projectsDir) throw Object.assign(new Error('Injected access failure'), { code: 'EACCES' });
    return stat(...call);
  });
  const result = await listClaudeConversations(args(fixture));
  assert.deepEqual(result.conversations, []);
  assert.match(result.warnings.join(), /metadata directory could not be verified/);
  assert.doesNotMatch(result.warnings.join(), /directory changed/);
});
