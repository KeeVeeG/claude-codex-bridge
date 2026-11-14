import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const sleep = new Int32Array(new SharedArrayBuffer(4));
const fallbacks = new Map();
export const defaultStatePath = (homeDir = os.homedir()) => path.join(homeDir, '.local', 'share', 'claude-codex-bridge');
const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
function stat(filename) {
  try { return fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Migrate only the default (including an installer pin of that default).
 * A contended rename keeps this process on the old ledger, never an empty one.
 */
export function defaultStateDir({ homeDir = os.homedir(), env = process.env, log = () => {} } = {}) {
  const destination = defaultStatePath(homeDir);
  const configured = env.CLAUDE_CODEX_BRIDGE_STATE_DIR;
  if (configured && !samePath(configured, destination)) return configured;
  const source = path.join(homeDir, '.local', 'share', 'codex-claude-desktop-bridge');
  const fallback = () => {
    const detail = 'State directory migration is deferred; this process is using the previous state directory to preserve delivery records. Restart after releasing the directory lock or resolving the destination conflict.';
    if (!fallbacks.has(source)) log(detail);
    fallbacks.set(source, detail);
    return source;
  };
  try {
    const old = stat(source);
    if (!old?.isDirectory() || old.isSymbolicLink()) return configured || destination;
    if (fallbacks.has(source)) return source;
    if (stat(destination)) return configured || destination;
    const until = Date.now() + 500;
    for (;;) {
      try {
        fs.renameSync(source, destination);
        log(`Moved bridge state from ${source} to ${destination}`);
        return destination;
      } catch (error) {
        // Another migrator won only when the source disappeared. If both exist,
        // keep the source rather than silently selecting a newly created ledger.
        if (!stat(source) && stat(destination)?.isDirectory()) return destination;
        if (!['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY', 'ENOENT'].includes(error.code) || Date.now() >= until) return fallback();
        Atomics.wait(sleep, 0, 0, 25);
      }
    }
  } catch {
    // Inspection may itself be locked. Do not create a replacement empty ledger.
    return fallback();
  }
}

export function stateDirectoryWarning(directory) {
  return fallbacks.get(directory);
}
