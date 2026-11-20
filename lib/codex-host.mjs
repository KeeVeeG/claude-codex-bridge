import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { throwIfStopped } from './call-time.mjs';
import { ensureStateDirectory } from './state-directory.mjs';
import { saveJson } from './call-store.mjs';
import { defaultStateDir, withStateLock, withStateLockAsync } from './store.mjs';
import { canonicalLocalSocket, localSocketPresence } from './local-socket.mjs';

const HOST_FILE = 'codex-host.json';
const MAX_HOST_BYTES = 16_384;
const MAX_HOSTS = 32;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function retryContention(error, until) {
  if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return false;
  const remaining = until - performance.now();
  if (remaining <= 0) return false;
  Atomics.wait(sleepBuffer, 0, 0, Math.min(25, remaining));
  return true;
}

function retryChanged(until) {
  const remaining = until - performance.now();
  if (remaining <= 0) return false;
  Atomics.wait(sleepBuffer, 0, 0, Math.min(10, remaining));
  return true;
}

function hostChanged(message) {
  const error = new Error(message);
  error.code = 'HOST_CHANGED';
  return error;
}

function validateHost(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.schemaVersion !== 1) {
    throw new Error('Invalid Codex host registry format.');
  }
  const pipe = record.pipePath;
  const windowsPipe = process.platform === 'win32' && typeof pipe === 'string' && pipe.length <= 4096 &&
    /^\\\\\.\\pipe\\(?:LOCAL\\)?[^\\/\r\n\0]+$/i.test(pipe) && !/[. ]$/.test(pipe);
  // macOS and Linux Codex expose the app-tools endpoint as an absolute Unix socket.
  const unixSocket = process.platform !== 'win32' && canonicalLocalSocket(pipe) !== null;
  if (!windowsPipe && !unixSocket) throw new Error('Codex host endpoint must be a local named pipe or absolute Unix socket.');
  if (typeof record.threadId !== 'string' || !record.threadId.trim() ||
      Buffer.byteLength(record.threadId) > 512 || /[\r\n\0]/.test(record.threadId)) {
    throw new Error('Codex host requires a real context task ID.');
  }
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || !Number.isSafeInteger(record.publishedAt) || record.publishedAt <= 0) {
    throw new Error('Codex host registry contains invalid process metadata.');
  }
  return { schemaVersion: 1, pipePath: pipe, threadId: record.threadId, pid: record.pid, publishedAt: record.publishedAt };
}

function validateRegistry(value) {
  const primary = validateHost(value);
  if (value.hosts === undefined) return [primary];
  if (!Array.isArray(value.hosts) || value.hosts.length >= MAX_HOSTS) throw new Error('Invalid Codex host registry candidates.');
  return [primary, ...value.hosts.map(validateHost)];
}

function registryPaths(stateDir) {
  const directory = path.resolve(stateDir || defaultStateDir());
  return { directory, file: path.join(directory, HOST_FILE) };
}

function checkDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Codex host registry must use a real local state directory.');
}

/** Publish an endpoint from verified Codex context. This is a local address
 * registry, not a new task or a messaging subscription. It stores no token.
 * Records whose endpoint no longer exists are dropped: Desktop names its pipe
 * per launch, so such a record can only fail and would bury the live ones.
 */
export function publishCodexHost({ stateDir, pipePath, threadId, pid = process.pid, signal } = {}) {
  throwIfStopped(signal);
  const record = validateHost({ schemaVersion: 1, pipePath, threadId, pid, publishedAt: Date.now() });
  const { directory, file } = registryPaths(stateDir);
  ensureStateDirectory(directory);
  checkDirectory(directory);
  const persist = prior => {
    throwIfStopped(signal);
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Codex host registry entry must be a regular file.');
    }
    const key = host => `${host.pipePath}\0${host.threadId}`;
    const present = localSocketPresence();
    const candidates = [record, ...prior.filter(host => key(host) !== key(record) && present(host.pipePath) !== false)]
      .slice(0, MAX_HOSTS);
    let serialized;
    for (;;) {
      serialized = `${JSON.stringify({ ...record, hosts: candidates.slice(1) }, null, 2)}\n`;
      if (Buffer.byteLength(serialized) <= MAX_HOST_BYTES) break;
      if (candidates.length === 1) throw new Error('Codex host registry exceeds its size limit.');
      candidates.pop();
    }
    if (signal) return saveJson(file, { ...record, hosts: candidates.slice(1) }, { signal }).then(() => record);
    const temporary = path.join(directory, `${HOST_FILE}.${process.pid}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const until = performance.now() + 1000;
      for (;;) {
        try { fs.renameSync(temporary, file); break; }
        catch (error) { if (!retryContention(error, until)) throw error; }
      }
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return record;
  };
  return signal ? withStateLockAsync(directory, async () => persist(await getCodexHosts({ stateDir: directory, signal })), { signal })
    : withStateLock(directory, () => persist(getCodexHosts({ stateDir: directory })));
}

/** Read a previously published app endpoint. A stopped publisher does not make
 * the app endpoint stale: actual tool calls determine whether it is available.
 */
export function getCodexHosts({ stateDir, signal } = {}) {
  throwIfStopped(signal);
  const { directory, file } = registryPaths(stateDir);
  try {
    checkDirectory(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const until = performance.now() + 1000;
  let observedFile = false;
  const read = () => {
    throwIfStopped(signal);
    let before;
    try {
      before = fs.lstatSync(file);
      observedFile = true;
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_HOST_BYTES) {
        throw new Error('Codex host registry entry must be a bounded regular file.');
      }
      const fd = fs.openSync(file, 'r');
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_HOST_BYTES) {
          throw hostChanged('Codex host registry changed while opening it.');
        }
        const buffer = Buffer.alloc(MAX_HOST_BYTES + 1);
        const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (size > MAX_HOST_BYTES) throw new Error('Codex host registry exceeds its size limit.');
        const after = fs.lstatSync(file);
        if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
          throw hostChanged('Codex host registry changed while reading it; retry discovery.');
        }
        let record;
        try { record = JSON.parse(buffer.subarray(0, size).toString('utf8')); } catch {
          throw new Error('Invalid Codex host registry JSON.');
        }
        return validateRegistry(record);
      } finally { fs.closeSync(fd); }
    } catch (error) {
      const changed = error.code === 'HOST_CHANGED' || (error.code === 'ENOENT' && observedFile);
      const share = process.platform === 'win32' && ['EPERM','EACCES','EBUSY'].includes(error.code);
      if (changed || share) {
        if (signal && performance.now() < until) return delay(10, undefined, { signal }).then(read, e => { throwIfStopped(signal); throw e; });
        if (!signal && (changed ? retryChanged(until) : retryContention(error, until))) return read();
      }
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  return read();
}

export function getCodexHost({ stateDir } = {}) {
  return getCodexHosts({ stateDir })[0] ?? null;
}
