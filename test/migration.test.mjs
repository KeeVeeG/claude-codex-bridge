import { legacyStage } from './fixtures/legacy-stage.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, migrateLegacyInstallation, CLAUDE_SEND_PERMISSION } from '../scripts/install.mjs';
import { defaultStateDir, createSession, recordMessage, getSession, getMessages } from '../lib/store.mjs';
import { defaultStatePath, resolveStateDirectory, stateDirectoryPrivacyWarning, stateDirectoryWarning } from '../lib/state-directory.mjs';
import { getBridgeConversation } from '../lib/bridge-history.mjs';
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
    route: { from: { kind: 'codex', id: 'record-owner' }, to: { kind: 'claude', id: 'ae83616c-17ad-427f-8665-bb6e03569c8c' } } }).message;
  return { homeDir, oldState, record };
}
function put(filename, value) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, JSON.stringify(value)); }
function snapshot(home) {
  return fs.readdirSync(home, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name !== 'fake-plugin-state.json')
    .map(entry => { const f = path.join(entry.parentPath, entry.name); return [path.relative(home, f), fs.readFileSync(f, 'utf8'), fs.statSync(f).mtimeMs]; }).sort();
}

function oldInstallation(t) {
  const setup = fixture(t); const { homeDir, oldState } = setup;
  // Installer scenarios begin after the operator's offline state cutover.
  fs.renameSync(oldState, defaultStatePath(homeDir));
  const staging = legacyStage(homeDir);
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
    { id: `${oldPlugin}@${oldCatalog}`, scope: 'user' },
    { id: `${oldPlugin}@custom`, scope: 'local', projectPath: homeDir },
  ], marketplaces: [{ name: oldLocal, source: { source: 'directory', path: staging } }, { name: oldCatalog, source: { source: 'github', repo: 'KeeVeeG/codex-claude-desktop-bridge' } }, { name: 'keep' }] } });
  const codexConfig = path.join(homeDir, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
  fs.writeFileSync(codexConfig, ['model = "kept"\n', `[marketplaces.${oldCatalog}]\nsource_type = "git"\nsource = "https://github.com/KeeVeeG/codex-claude-desktop-bridge.git"\n`, "[marketplaces.keep]\nsource_type = \"local\"\nsource = 'C:\\missing'\n",
    `[plugins."${oldPlugin}@personal"]\nenabled = true\n`, `[plugins.'${oldPlugin}@${oldCatalog}']\nenabled = false\n`, '[plugins."unrelated@keep"]\nenabled = true\n'].join('\n'));
  const logs = [];
  const options = { homeDir, env: {}, log: value => logs.push(value), execute(app, args, { cwd = homeDir } = {}) {
    const result = spawnSync(process.execPath, [path.join(root, 'test', 'fixtures', 'fake-plugin-cli.mjs'), homeDir, app, ...args],
      { cwd, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`${app} ${args.slice(0, 3).join(' ')} failed (${result.status}).\n${result.stderr.trim()}`);
    return result.stdout;
  } };
  return { ...setup, staging, backup, marketplacePath, settingsPath, stateFile, codexConfig, logs, options };
}

test('installer migrates every released artifact through fake CLIs, preserving choices and records; repeated migration is a no-op', async t => {
  // The fake Codex cannot list plugins, as with an unreadable unrelated marketplace.
  const f = oldInstallation(t);
  const beforeCatalog = fs.readFileSync(f.marketplacePath, 'utf8');
  const prepared = await main([], f.options);
  assert.ok(fs.existsSync(f.staging)); assert.ok(fs.existsSync(f.backup), 'The old name and prefix are not proof of ownership.');
  assert.equal(fs.existsSync(f.oldState), false); assert.equal(prepared.stateDir, defaultStatePath(f.homeDir));
  assert.equal(prepared.destination, path.join(f.homeDir, 'plugins', 'bridge-claude-codex'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(prepared.destination, '.claude-plugin/marketplace.json'))).name, 'claude-codex-local');
  assert.equal(getMessages(getSession({ stateDir: prepared.stateDir, threadId: 'record-owner' }))[0].message, f.record.message);
  assert.equal(fs.readFileSync(prepared.marketplaceBackup, 'utf8'), beforeCatalog);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.marketplacePath)).plugins.map(entry => entry.name), ['unrelated', 'bridge-claude-codex']);
  const settings = JSON.parse(fs.readFileSync(f.settingsPath));
  assert.deepEqual(settings.enabledPlugins, { 'unrelated@personal': false });
  assert.deepEqual(settings.permissions, { allow: ['Read', `${oldPrefix}__send_to_codex`, CLAUDE_SEND_PERMISSION], ask: [`${oldPrefix}__list_deliveries(suffix)`, `${newPrefix}__list_deliveries(suffix)`, 'Write'], deny: [`${oldPrefix}__send_to_claude`, `${newPrefix}__send_to_claude`, 'Bash(rm *)'] });
  const cli = JSON.parse(fs.readFileSync(f.stateFile));
  assert.equal(cli.calls.filter(call => ['uninstall', 'remove'].includes(call.args[1])).length, 4);
  assert.equal(cli.calls.filter(call => call.args[1] === 'marketplace' && call.args[2] === 'remove').length, 3);
  assert.ok(cli.claude.plugins.some(row => row.id === `${oldPlugin}@custom` && row.scope === 'local'));
  assert.equal(prepared.cleanupPending, true);
  assert.ok(cli.claude.marketplaces.some(entry => entry.name === 'keep'));
  assert.deepEqual(fs.readFileSync(f.codexConfig, 'utf8').match(/^\[.+\]$/gm),
    ['[marketplaces.keep]', '[plugins."unrelated@keep"]', '[plugins."bridge-claude-codex@personal"]']);
  assert.match(fs.readFileSync(f.codexConfig, 'utf8'), /^model = "kept"/);
  assert.ok(f.logs.some(line => line.includes('Removed old bridge entry')));
  const before = snapshot(f.homeDir); const callCount = cli.calls.length; f.logs.length = 0;
  migrateLegacyInstallation(f.options);
  assert.deepEqual(snapshot(f.homeDir), before); assert.ok(f.logs.every(line => line.includes('Unverified registrations')));
  assert.ok(JSON.parse(fs.readFileSync(f.stateFile)).calls.slice(callCount).every(call => call.args.includes('list')));
});

for (const first of ['--claude', '--codex']) test(`${first} alone keeps the old staged files the other application still installs from`, async t => {
  const f = oldInstallation(t);
  put(path.join(f.homeDir, '.claude', 'plugins', 'known_marketplaces.json'), { [oldLocal]: { source: { source: 'directory', path: f.staging } } });
  await main([first], f.options);
  assert.ok(fs.existsSync(f.staging)); assert.ok(fs.existsSync(f.backup));
  await main([first === '--claude' ? '--codex' : '--claude'], f.options);
  assert.ok(fs.existsSync(f.staging), 'Unmarked legacy directories survive both migrations.');
});

test('an old Codex plugin held open by running Codex is turned off, and a later run removes it', async t => {
  const f = oldInstallation(t); const inUse = path.join(f.homeDir, 'codex-files-in-use'); fs.writeFileSync(inUse, '');
  await main(['--codex'], f.options);
  const config = fs.readFileSync(f.codexConfig, 'utf8');
  assert.match(config, new RegExp(`\\[plugins\\."${oldPlugin}@personal"\\]\\nenabled = false\\n`));
  assert.match(config, new RegExp(`\\[plugins\\.'${oldPlugin}@${oldCatalog}'\\]\\nenabled = false\\n`));
  assert.match(config, /\[plugins\."bridge-claude-codex@personal"\]\nenabled = true/);
  assert.ok(f.logs.some(line => line.startsWith(`Turned off codex plugin ${oldPlugin}@personal`) && line.includes('os error 32')));
  fs.rmSync(inUse);
  await main(['--codex'], f.options);
  assert.doesNotMatch(fs.readFileSync(f.codexConfig, 'utf8'), new RegExp(oldPlugin));
});

for (const field of ['ask', 'deny']) test(`legacy ${field} blocks the renamed send tool after migration`, async t => {
  const f = oldInstallation(t);
  put(f.settingsPath, { permissions: { [field]: [oldPrefix, `${oldPrefix}__send_to_codex`, `${oldPrefix}__*`] } });
  await assert.rejects(main([], f.options), /already matches the outbound bridge tool/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settingsPath)).permissions, { [field]: [oldPrefix, `${oldPrefix}__send_to_codex`, `${oldPrefix}__*`] });
});

for (const pin of [false, true]) test(`legacy default blocks until offline cutover${pin ? ' with an installer pin' : ''}`, t => {
  const f = fixture(t);
  const destination = defaultStatePath(f.homeDir);
  const env = pin ? { CLAUDE_CODEX_BRIDGE_STATE_DIR: destination } : {};
  assert.throws(() => defaultStateDir({ homeDir: f.homeDir, env }), {
    reason: 'state_unavailable', message: /stop bridge servers and installers/,
  });
  assert.equal(fs.existsSync(destination), false);
  const directory = defaultStateDir({ homeDir: f.homeDir, env: { CLAUDE_CODEX_BRIDGE_STATE_DIR: f.oldState } });
  assert.equal(directory, f.oldState);
  assert.match(stateDirectoryWarning(directory, { homeDir: f.homeDir }), /unpinned 1\.0\.x/);
  assert.equal(getMessages(getSession({ stateDir: directory, threadId: 'record-owner' }))[0].id, 'preserved');
  const selectedBeforeMove = getSession({ stateDir: directory, threadId: 'record-owner' });
  fs.renameSync(f.oldState, destination); // Operator cutover or a released 1.0.x online move.
  assert.throws(() => recordMessage(selectedBeforeMove, { id: 'late', direction: 'to_claude', message: 'Not reserved.' }, { peek: false }), { reason: 'state_unavailable' });
  const legacyPin = { CLAUDE_CODEX_BRIDGE_STATE_DIR: f.oldState };
  assert.throws(() => defaultStateDir({ homeDir: f.homeDir, env: legacyPin }), { reason: 'state_unavailable', message: /Do not recreate/ });
  assert.equal(fs.existsSync(f.oldState), false);
  assert.equal(defaultStateDir({ homeDir: f.homeDir, env }), destination);
  assert.equal(getMessages(getSession({ stateDir: destination, threadId: 'record-owner' }))[0].id, 'preserved');
});

test('an explicit nondefault state path never triggers migration', t => {
  const f = fixture(t); const chosen = path.join(f.homeDir, 'chosen');
  assert.equal(defaultStateDir({ homeDir: f.homeDir, env: { CLAUDE_CODEX_BRIDGE_STATE_DIR: chosen } }), chosen);
  assert.ok(fs.existsSync(f.oldState)); assert.equal(fs.existsSync(defaultStatePath(f.homeDir)), false);
});

test('a case-only explicit override on case-sensitive NTFS does not select the legacy default', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const destination = defaultStatePath(f.homeDir);
  const share = path.dirname(destination);
  const result = spawnSync('fsutil.exe', ['file', 'SetCaseSensitiveInfo', share, 'enable'], { windowsHide: true });
  if (result.status !== 0) return t.skip('Cannot enable per-directory case sensitivity on this test volume');
  const configured = path.join(share, 'Claude-Codex-Bridge');
  fs.mkdirSync(configured);
  // Some Windows/volume combinations treat Win32 opens as case insensitive even
  // with the directory flag set. That is an alias, not two distinct paths.
  if (fs.existsSync(destination)) return t.skip('Win32 still resolves the case-only path on this test volume');
  const env = { CLAUDE_CODEX_BRIDGE_STATE_DIR: configured };
  for (let call = 0; call < 2; call++) assert.equal(defaultStateDir({ homeDir: f.homeDir, env }), configured);
  assert.ok(fs.existsSync(f.oldState));
  assert.equal(fs.existsSync(destination), false);
});

test('an existing Windows case alias selects the exact same real default', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const destination = defaultStatePath(f.homeDir);
  const configured = path.join(path.dirname(destination), 'Claude-Codex-Bridge');
  fs.renameSync(f.oldState, destination);
  if (!fs.existsSync(configured)) return t.skip('The test volume does not resolve a case alias');
  const env = { CLAUDE_CODEX_BRIDGE_STATE_DIR: configured };
  assert.equal(defaultStateDir({ homeDir: f.homeDir, env }), destination);
  fs.mkdirSync(f.oldState);
  assert.throws(() => defaultStateDir({ homeDir: f.homeDir, env }), /separate/);
});

test('Unicode case folding does not redirect a different explicit state directory', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const homeDir = path.join(f.homeDir, 'İ-home');
  fs.mkdirSync(homeDir);
  fs.renameSync(path.join(f.homeDir, '.local'), path.join(homeDir, '.local'));
  const configured = defaultStatePath(path.join(f.homeDir, 'i̇-home'));
  fs.mkdirSync(configured, { recursive: true });
  const destination = defaultStatePath(homeDir);
  assert.equal(configured.toLowerCase(), destination.toLowerCase());
  assert.equal(fs.existsSync(destination), false);
  const env = { CLAUDE_CODEX_BRIDGE_STATE_DIR: configured };
  assert.equal(defaultStateDir({ homeDir, env }), configured);
  fs.mkdirSync(destination);
  assert.equal(defaultStateDir({ homeDir, env }), configured);
});

test('an explicit state junction resolves to one target for the writer and history reader', async t => {
  const f = fixture(t);
  const alias = path.join(f.homeDir, 'state-alias');
  fs.symlinkSync(f.oldState, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const stateDir = defaultStateDir({ homeDir: f.homeDir, env: { CLAUDE_CODEX_BRIDGE_STATE_DIR: alias } });
  assert.equal(stateDir, f.oldState);
  assert.equal(resolveStateDirectory(alias), stateDir);
  const sessionId = '57d26635-4071-4ce2-9d75-1c882e9534ea';
  const session = getSession({ stateDir, threadId: 'record-owner' });
  recordMessage(session, { id: 'through-alias', direction: 'to_claude', message: 'History is visible.',
    route: { from: { kind: 'codex', id: 'record-owner' }, to: { kind: 'claude', id: sessionId } } });
  const page = await getBridgeConversation({ stateDir, ownerThreadId: 'record-owner', sessionId });
  assert.deepEqual(page.messages.map(message => message.id), ['through-alias']);
  assert.deepEqual(page.warnings, []);
});

test('Windows privacy diagnostic warns on inherited read access without changing ACLs', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const parent = path.join(f.homeDir, 'shared-parent');
  fs.mkdirSync(parent);
  const options = { encoding: 'utf8', windowsHide: true };
  const grant = spawnSync('icacls.exe', [parent, '/grant', '*S-1-5-32-545:(OI)(CI)(RX)'], options);
  assert.equal(grant.status, 0, grant.stderr);
  const directory = path.join(parent, 'state');
  // Exercise the real ACL result independently of the doctor's shorter interactive budget:
  // on a loaded host, an honest timeout is inconclusive, not evidence of a missing grant.
  const probe = () => stateDirectoryPrivacyWarning(directory, { timeoutMs: 15_000 });
  assert.match(await probe(), /may grant other accounts access.*private per-user/);
  fs.mkdirSync(directory);
  const before = spawnSync('icacls.exe', [directory], options);
  assert.equal(before.status, 0, before.stderr);
  const warning = await probe();
  assert.match(warning, /may grant other accounts access.*private per-user/);
  assert.ok(!warning.includes(f.homeDir));
  assert.equal(spawnSync('icacls.exe', [directory], options).stdout, before.stdout);
});

test('separate default trees block selection, but two aliases of one directory share it', t => {
  const f = fixture(t); const destination = defaultStatePath(f.homeDir); fs.mkdirSync(destination);
  assert.throws(() => defaultStateDir({ homeDir: f.homeDir, env: {} }), /Do not resend from either copy/);
  fs.rmdirSync(destination);
  fs.renameSync(f.oldState, destination);
  fs.symlinkSync(destination, f.oldState, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(defaultStateDir({ homeDir: f.homeDir, env: {} }), destination);
  assert.ok(fs.lstatSync(f.oldState).isSymbolicLink());
  assert.equal(getMessages(getSession({ stateDir: destination, threadId: 'record-owner' }))[0].id, 'preserved');
});

test('two current selectors cannot escape a legacy-only root after a transient inspection fault', t => {
  const f = fixture(t);
  const stat = fs.lstatSync;
  fs.lstatSync = (file, ...args) => {
    if (file === f.oldState) throw Object.assign(new Error('held'), { code: 'EBUSY' });
    return stat(file, ...args);
  };
  try { assert.throws(() => defaultStateDir({ homeDir: f.homeDir, env: {} }), /could not verify/); }
  finally { fs.lstatSync = stat; }
  const entry = new URL('../lib/state-directory.mjs', import.meta.url).href;
  const script = `import { defaultStateDir } from ${JSON.stringify(entry)};
    try { process.stdout.write(defaultStateDir({ homeDir: process.argv[1], env: {} })); }
    catch (error) { process.stdout.write(error.reason ?? 'unexpected'); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.homeDir], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'state_unavailable');
  assert.equal(fs.existsSync(defaultStatePath(f.homeDir)), false);
  assert.ok(fs.existsSync(f.oldState));
});

test('a legacy root moved between stat and realpath cannot cause a stale selection', t => {
  const f = fixture(t); const destination = defaultStatePath(f.homeDir);
  const realpath = fs.realpathSync.native;
  fs.realpathSync.native = (file, ...args) => {
    if (file === f.oldState) fs.renameSync(f.oldState, destination); // Released writer wins its rename.
    return realpath(file, ...args);
  };
  try { assert.throws(() => defaultStateDir({ homeDir: f.homeDir, env: {} }), { reason: 'state_unavailable' }); }
  finally { fs.realpathSync.native = realpath; }
  assert.equal(defaultStateDir({ homeDir: f.homeDir, env: {} }), destination);
  assert.equal(getMessages(getSession({ stateDir: destination, threadId: 'record-owner' }))[0].id, 'preserved');
  assert.equal(fs.existsSync(f.oldState), false);
});

test('an obsolete state setting cannot silently select a different default', t => {
  const f = fixture(t);
  const destination = defaultStatePath(f.homeDir);
  fs.renameSync(f.oldState, destination);
  const chosen = path.join(f.homeDir, 'previous-custom');
  const env = { CODEX_CLAUDE_BRIDGE_STATE_DIR: chosen };
  assert.throws(() => defaultStateDir({ homeDir: f.homeDir, env }), /old state setting points away/);
  assert.equal(defaultStateDir({ homeDir: f.homeDir, env: { ...env, CLAUDE_CODEX_BRIDGE_STATE_DIR: chosen } }), chosen);
  assert.equal(fs.existsSync(chosen), false);
});

test('old environment names are diagnosed and refused before installer changes', async t => {
  const f = fixture(t); const env = { CODEX_CLAUDE_BRIDGE_STATE_DIR: path.join(f.homeDir, 'wrong'), CODEX_CLAUDE_BRIDGE_DAEMON: 'off', CLAUDE_CODEX_BRIDGE_DAEMON: 'off' };
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
