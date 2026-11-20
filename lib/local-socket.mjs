import fs from 'node:fs';
import { posix } from 'node:path';

const PIPE_ROOT = '\\\\.\\pipe\\';

/** A checker telling whether a local IPC endpoint still exists, or undefined when it cannot tell.
 * It never connects: a connect, and even a stat, takes one of a Windows pipe server's instances,
 * so Windows reads the pipe directory instead, once per checker.
 */
export function localSocketPresence() {
  let pipes;
  return socketPath => {
    const canonical = canonicalLocalSocket(socketPath);
    if (!canonical) return undefined;
    try {
      if (process.platform !== 'win32') return fs.lstatSync(canonical).isSocket();
      const name = canonical.slice(PIPE_ROOT.length);
      // LOCAL\ pipes are not listed at the root, and Windows folds non-ASCII case by rules
      // canonicalLocalSocket does not apply, so a live pipe could look absent.
      if (name.includes('\\') || /[^\x20-\x7e]/.test(name)) return undefined;
      pipes ??= pipeNames();
      return pipes.has(name);
    } catch (error) {
      return process.platform !== 'win32' && error.code === 'ENOENT' ? false : undefined;
    }
  };
}

// Node 20 cannot scandir the pipe root (ENOTDIR); opendir reads it on every supported version.
function pipeNames() {
  const directory = fs.opendirSync(PIPE_ROOT);
  const names = new Set();
  try {
    for (let entry; (entry = directory.readSync());) names.add(entry.name.replace(/[A-Z]/g, letter => letter.toLowerCase()));
  } finally { directory.closeSync(); }
  return names;
}

/** Canonical local IPC addresses, without probing or resolving filesystem links. */
export function canonicalLocalSocket(socketPath, platform = process.platform) {
  if (typeof socketPath !== 'string' || !socketPath || /[\r\n\0]/.test(socketPath)) return null;
  if (platform === 'win32') {
    const match = /^[\\/]{2}[.?][\\/]pipe[\\/](?:(LOCAL)[\\/])?([^\\/]+)$/i.exec(socketPath);
    if (!match || ['.', '..'].includes(match[2]) || /[. ]$/.test(match[2])) return null;
    if (socketPath.startsWith('\\\\?\\') && socketPath.includes('/')) return null;
    const name = `${match[1] ? 'LOCAL\\' : ''}${match[2]}`.replace(/[A-Z]/g, letter => letter.toLowerCase());
    return `\\\\.\\pipe\\${name}`;
  }
  // sun_path is byte-sized. Older supported Node versions truncate paths that
  // exceed this boundary, which could connect to a different local address.
  const maxBytes = platform === 'darwin' ? 103 : platform === 'linux' ? 107 : 0;
  if (!maxBytes || !posix.isAbsolute(socketPath) || Buffer.byteLength(socketPath, 'utf8') > maxBytes ||
      posix.resolve(socketPath) !== socketPath || socketPath.endsWith('/')) return null;
  return socketPath;
}
