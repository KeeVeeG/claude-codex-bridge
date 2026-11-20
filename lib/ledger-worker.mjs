// Storage only: no transport or process launch. The parent owns the real directory lock through
// the entire mutation. The cache is disposable and covers one snapshot, never a lock or a receipt.
import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import * as store from './store.mjs';
import { CallDeadlineError, cancelledError } from './call-time.mjs';
import { saveJson } from './call-store.mjs';
let cached;
function stamp(file) {
  const s = fs.lstatSync(file, { bigint: true });
  if (!s.isFile()) throw new Error('The saved ledger must be a regular file.');
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}
function load(session) {
  const file = session.stateFile;
  const before = stamp(file);
  if (cached?.file === file && cached.stamp === before && cached.value.threadId === session.threadId) return cached.value;
  cached = undefined;
  const value = store.readSession(session);
  if (stamp(file) === before) cached = { file, stamp: before, value };
  return value;
}
async function run({ id, method, args, stop, until }) {
  const check = () => {
    if (Number(process.hrtime.bigint()) / 1e6 >= until) throw new CallDeadlineError();
    if (stop && Atomics.load(stop, 0)) throw cancelledError();
  };
  const io = { load, lock: (_, fn) => fn(), async save(file, value) {
    cached = undefined;
    await saveJson(file, value, { check });
    cached = { file, stamp: stamp(file), value };
  } };
  try {
    check();
    let value;
    if (method === 'lookup') value = store.lookupMessage(...args, io);
    else if (method === 'routedRecord') value = store.routedRecord(...args, io);
    else if (method === 'record') value = await store.recordMessage(args[0], args[1], { ...io, peek: false, order: args[2] });
    else if (method === 'finish') value = await store.finishMessage(...args, io);
    else if (method === 'list') {
      const issues = [], [session, limit, from] = args;
      value = { rows: store.getMessages(session, limit, undefined, from, issues, io), issues };
    } else throw new Error('Unknown saved-record operation.');
    parentPort.postMessage({ id, value });
  } catch (e) {
    cached = undefined;
    parentPort.postMessage({ id, error: { message: e.syscall ? 'Bridge storage could not be read or saved. Check space and permissions and run bridge_doctor.' : e.message,
      code: e.code, reason: e.reason ?? 'state_unavailable', record: e.record, outcome: e.outcome } });
  }
}
let work = Promise.resolve();
parentPort.on('message', message => { work = work.then(() => run(message)); });
parentPort.postMessage({ ready: true });
