import os from 'node:os';
import path from 'node:path';

export function codexHome({ env = process.env, homeDir = os.homedir() } = {}) {
  const configured = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim();
  return path.resolve(configured || path.join(homeDir, '.codex'));
}
