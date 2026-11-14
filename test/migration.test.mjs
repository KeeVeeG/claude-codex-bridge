import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, migrateLegacyInstallation, CLAUDE_SEND_PERMISSION } from '../scripts/install.mjs';
import { defaultStateDir, createSession, recordMessage, getSession, getMessages } from '../lib/store.mjs';
import { defaultStatePath, stateDirectoryWarning } from '../lib/state-directory.mjs';
import { executeBridgeTool } from '../lib/bridge-service.mjs';
import { publicDelivery } from '../lib/delivery.mjs';

const oldPlugin = 'codex-claude-desktop-bridge';
const oldLocal = 'codex-claude-desktop-local';
const oldCatalog = 'keeveeg-desktop-bridge';
const oldPrefix = `mcp__plugin_${oldPlugin}_${oldPlugin}`;
const newPrefix = 'mcp__plugin_bridge-claude-codex_bridge-claude-codex';
const root = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const work = path.join(root, 'work'); fs.mkdirSync(work, { recursive: true });
  const homeDir = fs.mkdtempSync(path.join(work, 'migration-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const oldState = path.join(homeDir, '.local', 'share', oldPlugin);
  const session = createSession({ stateDir: oldState, threadId: 'record-owner', cwd: homeDir });
  const record = recordMessage(session, { id: 'preserved', direction: 'to_claude', message: 'Keep this record.',
    route: { from: { kind: 'codex', id: 'record-owner' }, to: { kind: 'claude', id: 'recipient' } } }).message;
  return { homeDir, oldState, record };
}
function put(filename, value) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, JSON.stringify(value)); }
function snapshot(home) {
  return fs.readdirSync(home, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name !== 'fake-plugin-state.json')
    .map(entry => { const f = path.join(entry.parentPath, entry.name); return [path.relative(home, f), fs.readFileSync(f, 'utf8'), fs.statSync(f).mtimeMs]; }).sort();
}

function oldInstallation(t) {
  const setup = fixture(t); const { homeDir } = setup;
  const staging = path.join(homeDir, 'plugins', oldPlugin);
  const backup = path.join(homeDir, 'plugins', `.${oldPlugin}.backup-previous`);
  put(path.join(staging, 'old.json'), { previous: true }); put(path.join(backup, 'old.json'), { previous: true });
  const marketplacePath = path.join(homeDir, '.agents', 'plugins', 'marketplace.json');
  put(marketplacePath, { name: 'personal', plugins: [{ name: 'unrelated', source: { source: 'local', path: './other' } },
    { name: oldPlugin, source: { source: 'local', path: `./plugins/${oldPlugin}` } }] });
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  put(settingsPath, { keep: 'unchanged', enabledPlugins: { [`${oldPlugin}@${oldLocal}`]: true, 'unrelated@personal': false }, permissions: {
    allow: ['Read', `${oldPrefix}__send_to_codex`], ask: [`${oldPrefix}__list_deliveries(suffix)`, 'Write'],
    deny: [`${oldPrefix}__send_to_claude`, 'Bash(rm *)'],
  } });
  const stateFile = path.join(homeDir, 'fake-plugin-state.json');
  put(stateFile, { calls: [], claude: { plugins: [
    { id: `${oldPlugin}@${oldLocal}`, scope: 'user' },
    { id: `${oldPlugin}@${oldCatalog}`, scope: 'project', projectPath: homeDir },
    { id: `${oldPlugin}@custom`, scope: 'local', projectPath: homeDir },
  ], marketplaces: [{ name: oldLocal }, { name: oldCatalog }, { name: 'keep' }] },
  codex: { plugins: [{ pluginId: `${oldPlugin}@personal` }, { pluginId: `${oldPlugin}@${oldCatalog}` }], marketplaces: [{ name: oldCatalog }, { name: 'keep' }] } });
  const logs = [];
  const options = { homeDir, env: {}, log: value => logs.push(value), execute(app, args, { cwd = homeDir } = {}) {
    const result = spawnSync(process.execPath, [path.join(root, 'test', 'fixtures', 'fake-plugin-cli.mjs'), homeDir, app, ...args],
      { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  } };
  return { ...setup, staging, backup, marketplacePath, settingsPath, stateFile, logs, options };
}

test('installer migrates every released artifact through fake CLIs, preserving choices and records; repeated migration is a no-op', async t => {
  const f = oldInstallation(t);
  const beforeCatalog = fs.readFileSync(f.marketplacePath, 'utf8');
  const prepared = await main([], f.options);
  assert.equal(fs.existsSync(f.staging), false); assert.equal(fs.existsSync(f.backup), false);
  assert.equal(fs.existsSync(f.oldState), false); assert.equal(prepared.stateDir, defaultStatePath(f.homeDir));
  assert.equal(prepared.destination, path.join(f.homeDir, 'plugins', 'bridge-claude-codex'));
  assert.equal(prepared.claudeMarketplace, 'claude-codex-local');
  assert.equal(getMessages(getSession({ stateDir: prepared.stateDir, threadId: 'record-owner' }))[0].message, f.record.message);
  assert.equal(fs.readFileSync(prepared.marketplaceBackup, 'utf8'), beforeCatalog);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.marketplacePath)).plugins.map(entry => entry.name), ['unrelated', 'bridge-claude-codex']);
  const settings = JSON.parse(fs.readFileSync(f.settingsPath));
  assert.deepEqual(settings.enabledPlugins, { 'unrelated@personal': false });
  assert.deepEqual(settings.permissions, { allow: ['Read', CLAUDE_SEND_PERMISSION], ask: [`${newPrefix}__list_deliveries(suffix)`, 'Write'], deny: [`${newPrefix}__send_to_claude`, 'Bash(rm *)'] });
  const cli = JSON.parse(fs.readFileSync(f.stateFile));
  assert.equal(cli.calls.filter(call => ['uninstall', 'remove'].includes(call.args[1])).length, 5);
  assert.equal(cli.calls.filter(call => call.args[1] === 'marketplace' && call.args[2] === 'remove').length, 3);
  assert.ok(cli.calls.some(call => call.app === 'claude' && call.args.includes('local') && call.cwd === f.homeDir));
  assert.ok(cli.claude.marketplaces.some(entry => entry.name === 'keep'));
  assert.ok(cli.codex.marketplaces.some(entry => entry.name === 'keep'));
  assert.ok(f.logs.some(line => line.includes('Moved bridge state')));
  assert.ok(f.logs.some(line => line.includes('Removed old bridge entry')));
  const before = snapshot(f.homeDir); const callCount = cli.calls.length; f.logs.length = 0;
  migrateLegacyInstallation(f.options);
  assert.deepEqual(snapshot(f.homeDir), before); assert.deepEqual(f.logs, []);
  assert.ok(JSON.parse(fs.readFileSync(f.stateFile)).calls.slice(callCount).every(call => call.args.includes('list')));
});

for (const field of ['ask', 'deny']) test(`legacy ${field} blocks the renamed send tool after migration`, async t => {
  const f = oldInstallation(t);
  put(f.settingsPath, { permissions: { [field]: [oldPrefix, `${oldPrefix}__send_to_codex`, `${oldPrefix}__*`] } });
  await assert.rejects(main([], f.options), /already matches the outbound bridge tool/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settingsPath)).permissions, { [field]: [newPrefix, CLAUDE_SEND_PERMISSION, `${newPrefix}__*`] });
});

for (const pin of [false, true]) test(`runtime resolves and migrates default records${pin ? ' with an installer pin' : ''}`, t => {
  const f = fixture(t); const env = pin ? { CLAUDE_CODEX_BRIDGE_STATE_DIR: defaultStatePath(f.homeDir) } : {};
  const directory = defaultStateDir({ homeDir: f.homeDir, env });
  assert.equal(directory, defaultStatePath(f.homeDir)); assert.equal(fs.existsSync(f.oldState), false);
  assert.equal(getMessages(getSession({ stateDir: directory, threadId: 'record-owner' }))[0].id, 'preserved');
  assert.equal(defaultStateDir({ homeDir: f.homeDir, env }), directory);
});

test('an explicit nondefault state path never triggers migration', t => {
  const f = fixture(t); const chosen = path.join(f.homeDir, 'chosen');
  assert.equal(defaultStateDir({ homeDir: f.homeDir, env: { CLAUDE_CODEX_BRIDGE_STATE_DIR: chosen } }), chosen);
  assert.ok(fs.existsSync(f.oldState)); assert.equal(fs.existsSync(defaultStatePath(f.homeDir)), false);
});

test('state migration leaves an existing destination and a symlink source untouched', t => {
  const f = fixture(t); const destination = defaultStatePath(f.homeDir); fs.mkdirSync(destination);
  assert.equal(defaultStateDir({ homeDir: f.homeDir, env: {} }), destination); assert.ok(fs.existsSync(f.oldState));
  fs.rmSync(destination, { recursive: true });
  const actual = path.join(f.homeDir, 'actual-state'); fs.renameSync(f.oldState, actual);
  fs.symlinkSync(actual, f.oldState, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(defaultStateDir({ homeDir: f.homeDir, env: {} }), destination);
  assert.ok(fs.lstatSync(f.oldState).isSymbolicLink()); assert.ok(fs.existsSync(actual));
});

test('a lost migration race uses the winner, while transient locks are retried', t => {
  for (const race of [false, true]) {
    const f = fixture(t); const rename = fs.renameSync; let calls = 0;
    fs.renameSync = (from, to) => {
      if (from === f.oldState && ++calls <= 2) {
        if (race && calls === 1) rename(from, to);
        throw Object.assign(new Error('held'), { code: race ? 'ENOENT' : 'EPERM' });
      }
      return rename(from, to);
    };
    try { assert.equal(defaultStateDir({ homeDir: f.homeDir, env: {} }), defaultStatePath(f.homeDir)); }
    finally { fs.renameSync = rename; }
    assert.equal(calls, race ? 1 : 3);
  }
});

test('persistent contention keeps the old records for this process and doctor reports it', async t => {
  const f = fixture(t); const rename = fs.renameSync; let calls = 0;
  fs.renameSync = (from, to) => { if (from === f.oldState) { calls++; throw Object.assign(new Error('held'), { code: 'EBUSY' }); } return rename(from, to); };
  let directory;
  try { directory = defaultStateDir({ homeDir: f.homeDir, env: {} }); } finally { fs.renameSync = rename; }
  assert.equal(directory, f.oldState); assert.ok(calls > 1); assert.ok(stateDirectoryWarning(directory));
  assert.equal(defaultStateDir({ homeDir: f.homeDir, env: {} }), f.oldState);
  assert.equal(getMessages(getSession({ stateDir: directory, threadId: 'record-owner' }))[0].id, 'preserved');
  const doctor = await executeBridgeTool('bridge_doctor', {}, { stateDir: directory, registryDir: path.join(f.homeDir, 'absent'), parentPid: 2147483647,
    env: { CLAUDE_CODEX_BRIDGE_DAEMON: 'off' }, daemonVersion: { spawnImpl: () => ({ status: 1 }) } });
  assert.equal(doctor.checks.find(check => check.name === 'state_migration').status, 'warning');
});

test('old environment names are ignored at runtime, diagnosed, and refused before installer changes', async t => {
  const f = fixture(t); const env = { CODEX_CLAUDE_BRIDGE_STATE_DIR: path.join(f.homeDir, 'wrong'), CODEX_CLAUDE_BRIDGE_DAEMON: 'off', CLAUDE_CODEX_BRIDGE_DAEMON: 'off' };
  assert.equal(defaultStateDir({ homeDir: f.homeDir, env }), defaultStatePath(f.homeDir));
  const doctor = await executeBridgeTool('bridge_doctor', {}, { stateDir: defaultStatePath(f.homeDir), registryDir: path.join(f.homeDir, 'absent'), parentPid: 2147483647, env,
    daemonVersion: { spawnImpl: () => ({ status: 1 }) } });
  const warnings = doctor.checks.filter(check => check.name === 'legacy_environment'); assert.equal(warnings.length, 2);
  assert.ok(warnings.every(check => check.status === 'warning' && /use CLAUDE_CODEX_BRIDGE_/.test(check.detail)));
  const before = snapshot(f.homeDir);
  await assert.rejects(main([], { homeDir: f.homeDir, env, execute() { assert.fail('Must refuse before invoking a CLI'); } }), /use CLAUDE_CODEX_BRIDGE_STATE_DIR/);
  assert.deepEqual(snapshot(f.homeDir), before);
});

test('list_deliveries never registers a Desktop caller or mutates records', async t => {
  const f = fixture(t);
  const before = snapshot(f.homeDir);
  const context = { stateDir: f.oldState, metadata: { threadId: 'record-owner' },
    env: { CODEX_APP_TOOLS_PIPE_PATH: process.platform === 'win32' ? '\\\\.\\pipe\\never-opened' : '/tmp/never-opened.sock' } };
  const result = await executeBridgeTool('list_deliveries', { limit: 1 }, context);
  assert.deepEqual(Object.keys(result).sort(), ['application', 'deliveries', 'sender_id']);
  assert.equal(result.deliveries[0].message_id, 'preserved');
  assert.deepEqual(snapshot(f.homeDir), before);
  assert.equal(fs.existsSync(path.join(f.oldState, 'codex-host.json')), false);
  const empty = path.join(f.homeDir, 'empty-state');
  assert.deepEqual((await executeBridgeTool('list_deliveries', {}, { ...context, stateDir: empty })).deliveries, []);
  assert.equal(fs.existsSync(empty), false);
});

test('public deliveries expose only the stable shape and turn legacy errors into text', () => {
  const record = { id: 'm', route: { from: { kind: 'claude', id: 'c' }, to: { kind: 'codex', id: 'x', host_id: 'ssh:host' } }, message: 'text', status: 'failed', manual: true,
    createdAt: 1, updatedAt: 2, error: { message: 'Readable failure', code: 42 }, pairId: 'private', senderPid: 5, fingerprint: 'private', receipt: {}, direction: 'to_codex' };
  assert.deepEqual(publicDelivery(record), { message_id: 'm', from: { app: 'claude', id: 'c' }, to: { app: 'codex', id: 'x', host_id: 'ssh:host' }, message: 'text', status: 'failed', manual: true,
    created_at: 1, updated_at: 2, error: 'Readable failure' });
  for (const error of [42, false, [], { code: 42 }]) assert.equal(typeof publicDelivery({ ...record, error }).error, 'string');
});
