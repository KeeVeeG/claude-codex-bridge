import fs from 'node:fs';
import path from 'node:path';

// A process-backed CLI fixture. All configuration lives under the supplied test home.
const [home, app, ...args] = process.argv.slice(2);
const filename = path.join(home, 'fake-plugin-state.json');
const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
state.calls.push({ app, args, cwd: process.cwd() });
const current = state[app];
let result = {};
if (args[1] === 'list') result = app === 'claude' ? current.plugins : { installed: current.plugins, available: [] };
else if (args[1] === 'marketplace') {
  if (args[2] === 'list') result = app === 'claude' ? current.marketplaces : { marketplaces: current.marketplaces };
  else if (args[2] === 'remove') current.marketplaces = current.marketplaces.filter(entry => entry.name !== args[3]);
  else if (args[2] === 'add') {
    const catalog = JSON.parse(fs.readFileSync(path.join(args[3], '.claude-plugin', 'marketplace.json'), 'utf8'));
    current.marketplaces.push({ name: catalog.name, source: { source: 'directory', path: args[3] } });
  } else throw new Error(`Unsupported marketplace command: ${args}`);
} else if (['uninstall', 'remove'].includes(args[1])) {
  const scope = args.includes('--scope') ? args[args.indexOf('--scope') + 1] : undefined;
  current.plugins = current.plugins.filter(entry => !((entry.id || entry.pluginId) === args[2] && (!scope || entry.scope === scope)));
} else if (['install', 'update', 'add'].includes(args[1])) {
  if (!current.plugins.some(entry => (entry.id || entry.pluginId) === args[2])) current.plugins.push(app === 'claude'
    ? { id: args[2], scope: 'user' } : { pluginId: args[2], installed: true });
} else throw new Error(`Unsupported plugin command: ${args}`);
fs.writeFileSync(filename, JSON.stringify(state));
console.log(JSON.stringify(result));
