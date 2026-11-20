import { legacyStage } from './fixtures/legacy-stage.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main, prepareInstallation, installApplications, PLUGIN_NAME, writeJsonAtomic } from '../scripts/install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const legacy = 'codex-claude-desktop-bridge';
const json = (name, value) => { fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, JSON.stringify(value)); };
const read = name => fs.readFileSync(name, 'utf8');
function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-install-case-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const calls = [], logs = [], stage = path.join(homeDir, 'plugins', PLUGIN_NAME), catalog = path.join(homeDir, '.agents/plugins/marketplace.json');
  return { homeDir, stage, catalog, calls, logs, options: { homeDir, env: {}, log: text => logs.push(text), execute(app, args) { calls.push([app, ...args]); return '[]'; } } };
}
const mutations = calls => calls.filter(([, command, action, verb]) => command === 'plugin' && (action === 'marketplace' ? verb !== 'list' : action !== 'list'));

test('I01: a source copy under the current plugin name is not a stage, even with matching native manifests', async t => {
  const f = fixture(t); json(path.join(f.stage, '.codex-plugin/plugin.json'), { name: PLUGIN_NAME });
  json(path.join(f.stage, '.claude-plugin/plugin.json'), { name: PLUGIN_NAME }); json(path.join(f.stage, '.git/fixture'), { keep: true });
  fs.writeFileSync(path.join(f.stage, 'notes.txt'), 'local work');
  await assert.rejects(main(['--codex'], f.options), /not a verified installer stage/);
  assert.equal(read(path.join(f.stage, 'notes.txt')), 'local work'); assert.equal(fs.existsSync(f.catalog), false);
  assert.deepEqual(mutations(f.calls), []);
});

test('A01/A02: malformed catalog and preparation-only cannot unregister or displace a legacy checkout', async t => {
  const f = fixture(t); const old = path.join(f.homeDir, 'plugins', legacy); json(path.join(old, 'work.json'), { keep: true });
  const oldRow = { name: legacy, source: { source: 'local', path: `./plugins/${legacy}` } };
  json(f.catalog, {}); await assert.rejects(main([], f.options), /marketplace/);
  assert.deepEqual(mutations(f.calls), []); assert.equal(read(path.join(old, 'work.json')), '{"keep":true}');
  json(f.catalog, { name: 'personal', plugins: [oldRow] });
  await main(['--prepare-only'], f.options); assert.deepEqual(JSON.parse(read(f.catalog)).plugins[0], oldRow);
  assert.deepEqual(mutations(f.calls), []); assert.equal(read(path.join(old, 'work.json')), '{"keep":true}');
});

test('A02: a second app refusal restores previous stage, catalog and new registrations and never unregisters the fallback', async t => {
  const f = fixture(t); prepareInstallation({ homeDir: f.homeDir, sourceRoot: root, codex: false, env: {} });
  const original = read(path.join(f.stage, 'package.json')); const catalog = JSON.stringify({ name: 'personal', plugins: [{ name: legacy, source: { source: 'local', path: `./plugins/${legacy}` } }] });
  fs.mkdirSync(path.dirname(f.catalog), { recursive: true }); fs.writeFileSync(f.catalog, catalog);
  const registered = new Set(), calls = [];
  await assert.rejects(main([], { ...f.options, execute(app, args) {
    calls.push([app, ...args]); const [, action, id] = args;
    if (app === 'codex' && action === 'add') registered.add(id);
    if (app === 'codex' && action === 'remove') registered.delete(id);
    if (app === 'claude' && action === 'marketplace') { if (id === 'add') registered.add('local-market'); if (id === 'remove') registered.delete('local-market'); }
    if (app === 'claude' && action === 'install') throw new Error('App refused fixture');
    return '[]';
  } }), /App refused fixture/);
  assert.equal(registered.size, 0); assert.equal(read(path.join(f.stage, 'package.json')), original); assert.equal(read(f.catalog), catalog);
  assert.equal(mutations(calls).some(call => call.some(arg => String(arg).includes(legacy))), false);
});

test('I03: installer follows the npm Codex shim to its native executable without a shell', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); const bin = path.join(f.homeDir, 'bin');
  const exe = path.join(bin, 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  try { fs.linkSync(process.execPath, exe); } catch { fs.copyFileSync(process.execPath, exe); }
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@exit /b 89');
  // A disposable Node binary stands in for the native CLI. Only the add event is counted.
  const preload = path.join(bin, 'fixture.cjs'), mark = path.join(bin, 'add-count');
  fs.writeFileSync(preload, `if (process.argv.includes('add')) require('node:fs').appendFileSync(${JSON.stringify(mark)}, '1'); process.exit(0);`);
  const env = { SystemRoot: process.env.SystemRoot, PATH: bin, HOME: f.homeDir, USERPROFILE: f.homeDir, TEMP: f.homeDir, TMP: f.homeDir,
    CODEX_HOME: path.join(f.homeDir, 'codex'), CLAUDE_CONFIG_DIR: path.join(f.homeDir, 'claude'), NODE_OPTIONS: `--require="${preload.split(path.sep).join('/')}"` };
  await main(['--codex'], { homeDir: f.homeDir, env, log() {} }); assert.equal(read(mark), '1');
});

test('W09: compare the registered filesystem object, not case-folded marketplace path strings', t => {
  const f = fixture(t), alias = path.join(f.homeDir, 'alternate-spelling');
  const prepared = prepareInstallation({ homeDir: f.homeDir, sourceRoot: root, codex: false, env: {} });
  fs.symlinkSync(prepared.destination, alias, process.platform === 'win32' ? 'junction' : 'dir');
  let location = alias, installed = 0;
  const options = { ...f.options, execute(app, args) {
    if (args[1] === 'marketplace') return JSON.stringify([{ name: 'claude-codex-local', source: { source: 'directory', path: location } }]);
    if (args[1] === 'install') installed++;
    return '[]';
  }, grantPermission() { return { added: false, rule: 'fixture' }; } };
  // Some filesystems retain different canonical spellings for two lookups of the very same object.
  const original = fs.realpathSync; fs.realpathSync = Object.assign(file => [alias, prepared.destination].includes(file) ? file : original(file), { native: original.native });
  try {
    installApplications(prepared, options); assert.equal(installed, 1);
    location = path.join(f.homeDir, 'distinct'); fs.mkdirSync(location);
    assert.throws(() => installApplications(prepared, options), /different or unverifiable source/); assert.equal(installed, 1);
  } finally { fs.realpathSync = original; }
});

test('I04: a held, verified old stage backup defers cleanup after successful registration', async t => {
  const f = fixture(t); const prep = () => prepareInstallation({ homeDir: f.homeDir, sourceRoot: root, env: {} });
  prep(); const held = prep().backupDirectory; const remove = fs.rmSync;
  fs.rmSync = (name, ...args) => { if (name === held) throw Object.assign(new Error('held fixture'), { code: 'EBUSY' }); return remove(name, ...args); };
  let result; try { result = await main(['--codex'], f.options); } finally { fs.rmSync = remove; }
  assert.equal(result.cleanupPending, true); assert.ok(fs.existsSync(held)); assert.ok(fs.existsSync(result.destination));
  assert.equal(f.calls.filter(call => call[0] === 'codex' && call[2] === 'add').length, 1); assert.match(f.logs.join(' '), /installed; an older installer backup/);
});

test('I05: a held legacy plugin replaces one quoted boolean and refuses an unsupported multiline edit', async t => {
  for (const key of ['"enabled"', "'enabled'", 'unsupported']) {
    const f = fixture(t); const config = path.join(f.homeDir, '.codex/config.toml'); fs.mkdirSync(path.dirname(config), { recursive: true });
    legacyStage(f.homeDir); json(f.catalog, { name: 'personal', plugins: [{ name: legacy, source: { source: 'local', path: `./plugins/${legacy}` } }] });
    const target = `${legacy}@personal`, original = `[plugins."${target}"]\n${key === 'unsupported' ? 'note = """\ninside string\n"""' : `${key} = true # keep`}\n`;
    fs.writeFileSync(config, original);
    const result = await main(['--codex'], { ...f.options, execute(app, args) { if (args[1] === 'remove') throw new Error('held fixture'); return '[]'; } });
    assert.equal(read(config), key === 'unsupported' ? original : original.replace('true', 'false'));
    if (key === 'unsupported') assert.equal(result.cleanupPending, true);
  }
});

test('PR03/PR08: private settings backup is bounded; similarly named unmanaged copies survive', t => {
  const f = fixture(t); const file = path.join(f.homeDir, 'settings.json');
  fs.writeFileSync(file, '{}\n', { mode: 0o600 }); const extra = `${file}.backup-00000000000000000-12345678-1234-4123-8123-123456789abc`; fs.writeFileSync(extra, 'keep');
  const a = writeJsonAtomic(file, { counter: 1 }); const b = writeJsonAtomic(file, { counter: 2 });
  assert.equal(a, b); assert.deepEqual(JSON.parse(read(b)), { counter: 1 }); assert.equal(read(extra), 'keep');
  assert.deepEqual(fs.readdirSync(path.dirname(b)).sort(), ['.bridge-installed', 'settings.json.previous']);
  if (process.platform !== 'win32') {
    for (const name of [path.dirname(b), file, b]) assert.equal(fs.statSync(name).mode & 0o077, 0);
  } else {
    // The fixture sibling inherits the same access as the original settings. A replacement may not add a principal.
    const program = "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User; $allowed=@((Get-Acl -LiteralPath $env:FIXTURE_ORIGINAL).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object AccessControlType -eq 'Allow' | ForEach-Object { $_.IdentityReference.Value }); foreach($r in (Get-Acl -LiteralPath $env:FIXTURE_REPLACEMENT).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if ($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin $allowed) {exit 1} };foreach($r in (Get-Acl -LiteralPath $env:FIXTURE_BACKUP).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if ($r.AccessControlType -eq 'Allow' -and $r.IdentityReference -ne $me) {exit 2} };exit 0";
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', program], { env: { ...process.env, FIXTURE_ORIGINAL: extra, FIXTURE_REPLACEMENT: file, FIXTURE_BACKUP: b }, windowsHide: true, stdio: 'ignore', timeout: 15000 });
    assert.equal(result.status, 0, 'Replacement does not grant another principal; backup grants only the fixture user.');
  }
});

test('a failed install preserves an intervening edit inside the stage and identifies the incomplete rollback', async t => {
  const f = fixture(t), module = path.join(f.stage, 'scripts/mcp.mjs');
  await assert.rejects(main(['--claude'], { ...f.options, execute(app, args) {
    if (args[1] === 'install') { fs.writeFileSync(module, 'local changes'); throw Error('refusal'); }
    return '[]';
  } }), /Rollback could not finish/);
  assert.equal(read(module), 'local changes');
});

test('subsequent installations never prune backup files with locally edited runtime content', async t => {
  const f = fixture(t); await main(['--prepare-only'], f.options);
  fs.writeFileSync(path.join(f.stage, 'scripts/mcp.mjs'), 'local changes');
  const { backupDirectory } = await main(['--prepare-only'], f.options);
  await main(['--prepare-only'], f.options);
  assert.equal(read(path.join(backupDirectory, 'scripts/mcp.mjs')), 'local changes');
});

for (const failed of ['marketplace', 'plugin']) test(`rollback inspects a Claude ${failed} registration written just before a CLI error`, async t => {
  const f = fixture(t); let market = false, plugin = false;
  const registered = { name: 'claude-codex-local', source: { source: 'directory', path: f.stage } };
  const selector = `${PLUGIN_NAME}@claude-codex-local`;
  await assert.rejects(main(['--claude'], { ...f.options, execute(app, args) {
    if (args[0] === '--version') return '1';
    if (args[1] === 'marketplace') {
      if (args[2] === 'list') return JSON.stringify(market ? [registered] : []);
      if (args[2] === 'add') { market = true; if (failed === 'marketplace') throw Error('refusal after mutation'); }
      if (args[2] === 'remove') market = false;
    } else if (args[1] === 'list') return JSON.stringify(plugin ? [{ id: selector, scope: 'user' }] : []);
    else if (args[1] === 'install') { plugin = true; throw Error('refusal after mutation'); }
    else if (args[1] === 'uninstall') plugin = false;
    return '{}';
  } }), /refusal after mutation/);
  assert.deepEqual([market, plugin], [false, false]); assert.equal(fs.existsSync(f.stage), false);
});

test('rollback removes only its own catalog row after another writer adds an unrelated row', async t => {
  const f = fixture(t), keep = { name: 'new-unrelated' };
  await assert.rejects(main([], { ...f.options, execute(app, args) {
    if (app === 'claude' && args[1] === 'install') { const catalog = JSON.parse(read(f.catalog)); catalog.plugins.push(keep); json(f.catalog, catalog); throw Error('refusal'); }
    return '[]';
  } }), /refusal/);
  assert.deepEqual(JSON.parse(read(f.catalog)).plugins, [keep]); assert.equal(fs.existsSync(f.stage), false);
});

test('an old marketplace name on a different source cannot retire user registrations', async t => {
  const f = fixture(t), foreign = path.join(f.homeDir, 'user-authored'); fs.mkdirSync(foreign);
  const result = await main(['--claude'], { ...f.options, execute(app, args) {
    f.calls.push([app, ...args]);
    if (args[1] === 'list') return JSON.stringify([{ id: `${legacy}@user-catalog`, scope: 'user' }]);
    if (args[1] === 'marketplace' && args[2] === 'list') return JSON.stringify([{ name: 'codex-claude-desktop-local', source: { source: 'directory', path: foreign } }]);
    return '[]';
  } });
  assert.equal(result.cleanupPending, true); assert.equal(f.calls.some(args => args.includes('uninstall') || args.includes('remove')), false);
});

test('Windows stages and their backups do not inherit a shared plugins-folder reader', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), parent = path.dirname(f.stage); fs.mkdirSync(parent);
  assert.equal(spawnSync('icacls.exe', [parent, '/grant', '*S-1-5-32-545:(OI)(CI)(RX)'], { stdio: 'ignore', windowsHide: true }).status, 0);
  await main(['--prepare-only'], f.options); const { backupDirectory } = await main(['--prepare-only'], f.options);
  const program = "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User;foreach($file in @($env:FIXTURE_NOW,$env:FIXTURE_OLD)){foreach($r in (Get-Acl -LiteralPath $file).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if ($r.AccessControlType -eq 'Allow' -and $r.IdentityReference -ne $me){exit 2}}};exit 0";
  const file = dir => path.join(dir, 'config/mcp-source.json');
  assert.equal(spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',program], { env: { ...process.env, FIXTURE_NOW: file(f.stage), FIXTURE_OLD: file(backupDirectory) }, stdio: 'ignore', windowsHide: true }).status, 0);
});
