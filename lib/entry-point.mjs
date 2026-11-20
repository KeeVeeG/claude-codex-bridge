import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node can keep the link spelling in import.meta.url under --preserve-symlinks-main.
export function isMainModule(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl)); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}
