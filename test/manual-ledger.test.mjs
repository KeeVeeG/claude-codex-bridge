import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getBridgeConversation } from '../lib/bridge-history.mjs';
import { manualLedgerPaths, updateManualEntry } from '../lib/manual-ledger.mjs';
import { readManualRecords } from '../lib/manual-service.mjs';
import { nativeFixture } from './native-helpers.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const escapedText = '\u0001'.repeat(65534) + 'é'; // 64 KiB of text, almost 384 KiB on disk.
const asJson = value => JSON.stringify(value, null, 2) + '\n';
const keyFor = row => hash(JSON.stringify([row.session_id, row.message_id]));

async function setup(t) {
  const { stateDir } = await nativeFixture(t);
  const threadId = 'manual-storage-fixture';
  const paths = manualLedgerPaths(stateDir, threadId, hash(threadId));
  const sessionId = randomUUID();
  const records = {};
  const ledger = { schemaVersion: 1, owner_thread_id: threadId, records };
  fs.mkdirSync(paths.directory, { recursive: true });
  function row(message_id, message = 'Original manual text', session_id = sessionId) {
    const route = { from: { kind: 'codex', id: threadId }, to: { kind: 'claude', id: session_id } };
    const fingerprint = hash(JSON.stringify({ direction: 'to_claude', message, route }));
    return { message_id, session_id, fingerprint, message, manual: true, send_status: 'submitted',
      notice_status: 'submitted', notice_attempted: true, sender_pid: process.pid, createdAt: 100, updatedAt: 101 };
  }
  return { paths, ledger, records, sessionId, row, read: options => readManualRecords({ stateDir, threadId, ...options }),
    conversation: () => getBridgeConversation({ stateDir, ownerThreadId: threadId, sessionId }),
    body: key => path.join(paths.directory, `body-${key}.json`),
    overflow: key => path.join(paths.directory, `overflow-${key}.json`) };
}

function replace(file, value, old = fs.statSync(file)) {
  const temp = `${file}.replacement`;
  fs.writeFileSync(temp, asJson(value));
  fs.utimesSync(temp, old.atime, old.mtime);
  fs.renameSync(temp, file);
}

test('warm manual pages never reopen unchanged unrelated legacy overflow bodies; external replacements invalidate only changed files', async t => {
  const f = await setup(t);
  const legacy = f.row('embedded-v1');
  f.records[keyFor(legacy)] = legacy;
  fs.writeFileSync(f.paths.file, asJson(f.ledger));
  const selected = f.row('detached-body', 'Unicode é🦊\nThe original manual-only text.');
  await updateManualEntry(f.paths, keyFor(selected), () => selected);
  const foreignPeer = randomUUID();
  let foreignFile, last;
  // Exceed the body cache's byte budget while keeping all overflow metadata small.
  for (let i = 0; i < 45; i++) {
    const record = f.row(`embedded-overflow-${i}`, escapedText, foreignPeer);
    foreignFile = f.overflow(keyFor(record));
    last = { schemaVersion: 1, owner_thread_id: f.paths.threadId, record };
    fs.writeFileSync(foreignFile, asJson(last));
  }
  const opens = [];
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (typeof file === 'string' && path.dirname(file) === f.paths.directory && file.endsWith('.json')) opens.push(file);
    return open(file, ...args);
  });
  const catalog = f.read({ includeMessage: false });
  assert.equal(catalog.length, 47);
  assert.ok(catalog.every(record => !Object.hasOwn(record, 'message')));
  assert.equal(opens.filter(file => path.basename(file).startsWith('body-')).length, 0);
  const page = () => f.read({ sessionId: f.sessionId });
  assert.deepEqual(page().map(record => record.message), [legacy.message, selected.message]);
  opens.length = 0;
  assert.deepEqual(page().map(record => record.message), [legacy.message, selected.message]);
  assert.deepEqual(opens, []);

  last.record.notice_status = 'uncertain'; // Equal length and deliberately restore mtime on the replacement.
  const originalSize = fs.statSync(foreignFile).size;
  replace(foreignFile, last);
  assert.equal(fs.statSync(foreignFile).size, originalSize);
  assert.deepEqual(page().map(record => record.message), [legacy.message, selected.message]);
  assert.deepEqual(opens, [foreignFile]);
  assert.equal(f.read({ sessionId: foreignPeer, includeMessage: false }).find(record => record.message_id === last.record.message_id).notice_status, 'uncertain');

  // Outside writers can also edit state.json in place, with the same size.
  const ledger = JSON.parse(fs.readFileSync(f.paths.file));
  ledger.records[keyFor(legacy)].notice_status = 'uncertain';
  fs.writeFileSync(f.paths.file, asJson(ledger));
  opens.length = 0;
  assert.equal(page().find(record => record.message_id === legacy.message_id).notice_status, 'uncertain');
  assert.deepEqual(opens, [f.paths.file]);

  const body = f.body(keyFor(selected));
  const envelope = JSON.parse(fs.readFileSync(body));
  replace(body, { ...envelope, message: selected.message.replace('original', 'forged!!') });
  opens.length = 0;
  const missing = page().find(record => record.message_id === selected.message_id);
  assert.equal(missing.send_status, 'submitted');
  assert.equal(Object.hasOwn(missing, 'message'), false);
  assert.deepEqual(opens, [body]);
  const conversation = await f.conversation();
  assert.deepEqual(conversation.messages.map(record => record.message), [legacy.message]);
  assert.ok(conversation.warnings.some(warning => /without matching saved message text/.test(warning)));

  replace(body, envelope);
  assert.equal(page().find(record => record.message_id === selected.message_id).message, selected.message);
  assert.equal(f.read({ sessionId: foreignPeer, includeMessage: record => record.message_id === last.record.message_id })
    .find(record => record.message_id === last.record.message_id).message, escapedText);
  fs.rmSync(foreignFile);
  assert.equal(f.read({ includeMessage: false }).length, 46);
});

test('capacity migration leaves the prior ledger intact on a sidecar fault and preserves its claims after recovery', async t => {
  const f = await setup(t);
  for (let i = 0; i < 10; i++) {
    const record = f.row(`embedded-${i}`, escapedText);
    f.records[keyFor(record)] = record;
  }
  const cap = 4 * 1024 * 1024;
  f.ledger.padding = '';
  f.ledger.padding = 'x'.repeat(cap - 8 - Buffer.byteLength(asJson(f.ledger)));
  const before = asJson(f.ledger);
  fs.writeFileSync(f.paths.file, before);
  const next = f.row('new-compact-reservation');
  const nextKey = keyFor(next);
  const faultFile = f.body(Object.keys(f.records)[2]);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === faultFile) throw Object.assign(new Error('migration disk cut'), { code: 'ENOSPC' });
    return rename(source, destination);
  });
  await assert.rejects(updateManualEntry(f.paths, nextKey, () => next), { code: 'ENOSPC' });
  assert.ok(fs.existsSync(f.body(nextKey)));
  assert.equal(fs.readFileSync(f.paths.file, 'utf8'), before);
  assert.equal(f.read().length, 10);
  assert.ok(f.read().every(record => record.message === escapedText && record.notice_attempted));
  fs.renameSync.mock.restore();
  await updateManualEntry(f.paths, nextKey, () => next);
  const rows = JSON.parse(fs.readFileSync(f.paths.file)).records;
  assert.equal(Object.keys(rows).length, 11);
  assert.ok(Object.values(rows).every(record => record.notice_attempted && !Object.hasOwn(record, 'message')));
  assert.equal(f.read().find(record => record.message_id === next.message_id).message, next.message);
  assert.ok(f.read().filter(record => record.message_id.startsWith('embedded-')).every(record => record.message === escapedText));
});

test('a replacement during an open ledger read is rejected by the post-read path check', async t => {
  const f = await setup(t);
  const record = f.row('read-cut');
  f.records[keyFor(record)] = record;
  fs.writeFileSync(f.paths.file, asJson(f.ledger));
  const next = structuredClone(f.ledger);
  next.records[keyFor(record)].notice_status = 'uncertain';
  const temp = `${f.paths.file}.replacement`;
  fs.writeFileSync(temp, asJson(next));
  const read = fs.readSync, lstat = fs.lstatSync;
  let cut = false;
  t.mock.method(fs, 'readSync', (fd, ...args) => { cut = true; return read(fd, ...args); });
  // Windows can forbid the actual rename while fd is open. Present the replacement
  // identity precisely at the post-read lstat without altering what fd returns.
  t.mock.method(fs, 'lstatSync', (file, ...args) => lstat(cut && file === f.paths.file ? temp : file, ...args));
  assert.throws(() => f.read(), /changed while it was read/);
  assert.equal(cut, true);
  fs.lstatSync.mock.restore();
  fs.renameSync(temp, f.paths.file);
  assert.equal(f.read()[0].notice_status, 'uncertain');
});

test('a directory identity change prevents publishing even a warm manual snapshot', async t => {
  const f = await setup(t);
  const record = f.row('directory-cut');
  f.records[keyFor(record)] = record;
  fs.writeFileSync(f.paths.file, asJson(f.ledger));
  assert.equal(f.read()[0].message, record.message);
  const replacement = `${f.paths.directory}.replacement`;
  fs.mkdirSync(replacement);
  const lstat = fs.lstatSync;
  let sawLedger = false;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file === f.paths.file) sawLedger = true;
    return lstat(sawLedger && file === f.paths.directory ? replacement : file, ...args);
  });
  assert.throws(() => f.read(), /directories changed during access/);
});
