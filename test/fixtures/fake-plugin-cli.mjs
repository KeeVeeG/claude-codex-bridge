import fs from 'node:fs';
import path from 'node:path';

// A process-backed CLI fixture. All configuration lives under the supplied test home.
const [home, app, ...args] = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.0.0'); process.exit(0); }
const filename = path.join(home, 'fake-plugin-state.json');
const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
state.calls.push({ app, args, cwd: process.cwd() });
fs.writeFileSync(filename, JSON.stringify(state));
if (app === 'codex') {
  // Like Codex with an unreadable unrelated marketplace: listings fail, while adding and
  // removing still work and keep their record as tables in config.toml.
  // Synchronous writes: piped console output can be lost on an immediate exit on Windows.
  if (args[1] === 'list' || args[2] === 'list') {
    fs.writeSync(2, 'Error: failed to load configured marketplace snapshot(s)\n');
    process.exit(1);
  }
  if (args[1] === 'remove' && fs.existsSync(path.join(home, 'codex-files-in-use'))) {
    fs.writeSync(2, 'Error: failed to remove existing plugin cache entry\n\nCaused by:\n    0: file in use (os error 32)\n');
    process.exit(1);
  }
  const config = path.join(home, '.codex', 'config.toml');
  const id = args[1] === 'marketplace' ? args[3] : args[2];
  const headers = args[1] === 'marketplace' ? [`[marketplaces.${id}]`, `[marketplaces."${id}"]`] : [`[plugins."${id}"]`, `[plugins.'${id}']`];
  const tables = fs.readFileSync(config, 'utf8').split(/\n(?=\[)/).filter(table => !headers.some(header => table.startsWith(header)));
  if (args[1] === 'add') tables.push(`${headers[0]}\nenabled = true\n`);
  else if (!['remove', 'marketplace'].includes(args[1]) || (args[1] === 'marketplace' && args[2] !== 'remove')) throw new Error(`Unsupported command: ${args}`);
  fs.writeFileSync(config, tables.join('\n'));
  console.log('{}');
  process.exit(0);
}
const current = state[app];
let result = {};
if (args[1] === 'list') result = current.plugins;
else if (args[1] === 'marketplace') {
  if (args[2] === 'list') result = current.marketplaces;
  else if (args[2] === 'remove') {
    current.marketplaces = current.marketplaces.filter(entry => entry.name !== args[3]);
    const known = path.join(home, '.claude', 'plugins', 'known_marketplaces.json');
    if (fs.existsSync(known)) {
      const registry = JSON.parse(fs.readFileSync(known, 'utf8')); delete registry[args[3]];
      fs.writeFileSync(known, JSON.stringify(registry));
    }
  }
  else if (args[2] === 'add') {
    const catalog = JSON.parse(fs.readFileSync(path.join(args[3], '.claude-plugin', 'marketplace.json'), 'utf8'));
    current.marketplaces.push({ name: catalog.name, source: { source: 'directory', path: args[3] } });
  } else throw new Error(`Unsupported marketplace command: ${args}`);
} else if (['uninstall', 'remove'].includes(args[1])) {
  const scope = args.includes('--scope') ? args[args.indexOf('--scope') + 1] : undefined;
  current.plugins = current.plugins.filter(entry => !((entry.id || entry.pluginId) === args[2] && (!scope || entry.scope === scope)));
} else if (['install', 'update', 'add'].includes(args[1])) {
  if (!current.plugins.some(entry => entry.id === args[2])) current.plugins.push({ id: args[2], scope: 'user' });
} else throw new Error(`Unsupported plugin command: ${args}`);
fs.writeFileSync(filename, JSON.stringify(state));
console.log(JSON.stringify(result));
