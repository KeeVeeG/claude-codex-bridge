import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const isWindowsSharingError = error => process.platform === 'win32' &&
  ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);

const sleep = new Int32Array(new SharedArrayBuffer(4));

export function waitForSharingRetry(error, until, now = () => performance.now()) {
  const remaining = until - now();
  if (!isWindowsSharingError(error) || remaining <= 0) return false;
  Atomics.wait(sleep, 0, 0, Math.min(25, remaining));
  return true;
}

/** Replace a prepared document without repeating the caller's mutation or releasing its lock. */
export function replaceTextSync(file, text, { now = () => performance.now() } = {}) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    const until = now() + 1000;
    for (;;) {
      try { fs.renameSync(tmp, file); return; }
      catch (error) { if (!waitForSharingRetry(error, until, now)) throw error; }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

const regular = stat => stat.isFile() && !stat.isSymbolicLink();
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** One small registry read. Callers own format validation, public errors and retries. */
export function readBoundedJson(file, maxBytes, { invalid, found, validate }) {
  const before = fs.lstatSync(file);
  found?.();
  if (!regular(before) || before.size > maxBytes) throw invalid('entry');
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameFile(opened, before) || opened.size > maxBytes) throw invalid('open');
    const data = Buffer.alloc(maxBytes + 1);
    const bytesRead = fs.readSync(fd, data, 0, data.length, 0);
    if (bytesRead > maxBytes) throw invalid('size');
    const after = fs.lstatSync(file);
    if (!regular(after) || !sameFile(after, opened)) throw invalid('read');
    let value;
    const text = data.subarray(0, bytesRead).toString('utf8');
    try { value = JSON.parse(text); }
    catch (error) { throw invalid('json', error); }
    return validate(value);
  } finally { fs.closeSync(fd); }
}
