import fs from 'node:fs';
import path from 'node:path';

// Stamped files written by the released 0.4 installer, not a hand-authored marketplace of the same name.
export function legacyStage(home) {
  const name = 'codex-claude-desktop-bridge', dir = path.join(home, 'plugins', name);
  const manifest = { name, version: '0.4.2+codex.20000101000000000' };
  for (const [relative, value] of Object.entries({
    'package.json': manifest, 'config/plugin-source.json': manifest, '.claude-plugin/plugin.json': manifest, '.codex-plugin/plugin.json': manifest,
    '.claude-plugin/marketplace.json': { name: 'codex-claude-desktop-local', plugins: [{ name, source: './' }] },
  })) {
    const file = path.join(dir, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value));
  }
  return dir;
}
