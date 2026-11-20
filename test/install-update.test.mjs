import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, parseToml, CLAUDE_SEND_PERMISSION, PLUGIN_NAME } from '../scripts/install.mjs';

// Updates over an existing installation: fake application CLIs in a temporary home, never a real profile.
const root = path.resolve(import.meta.dirname, '..');
const id = `${PLUGIN_NAME}@personal`;
const read = file => fs.readFileSync(file, 'utf8');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const mutations = calls => calls.filter(([, command, action, verb]) => command === 'plugin' && (action === 'marketplace' ? verb !== 'list' : action !== 'list'));
function copyTree(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(source, target); }
  }
}
function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-install-update-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const config = path.join(homeDir, '.codex', 'config.toml'), stage = path.join(homeDir, 'plugins', PLUGIN_NAME);
  const catalog = path.join(homeDir, '.agents', 'plugins', 'marketplace.json');
  const calls = [], logs = [], state = { codex: new Set(), claude: [], failClaude: false };
  const execute = (app, args) => {
    calls.push([app, ...args]);
    if (args[0] === '--version') return '1';
    if (app === 'codex') {
      // Like Codex: add turns an existing registration on and gives a new one its own table.
      const selector = args[2], text = fs.existsSync(config) ? read(config) : '';
      if (args[1] === 'add' && state.codex.has(selector)) write(config, text.replace('enabled = false', 'enabled = true'));
      else if (args[1] === 'add') { state.codex.add(selector); write(config, `${text}\n[plugins."${selector}"]\nenabled = true\n`); }
      else if (args[1] === 'remove') { state.codex.delete(selector); write(config, text.replace(`\n[plugins."${selector}"]\nenabled = true\n`, '')); }
      return '{}';
    }
    if (args[1] === 'list') return JSON.stringify(state.claude);
    if (args[1] === 'marketplace') return args[2] === 'list' ? '[]' : '{}';
    if (args[1] === 'install' && state.failClaude) throw new Error('late refusal fixture');
    return '{}';
  };
  return { homeDir, config, stage, catalog, calls, logs, state, options: { homeDir, env: {}, log: text => logs.push(text), execute } };
}

test('TOML reader finds registrations in every TOML form and refuses what it cannot read', () => {
  const plugins = text => Object.keys(parseToml(text).plugins ?? {});
  for (const [text, expected] of [
    [`[ plugins . "${id}" ]\nenabled = true\n`, [id]],
    [`[plugins]\n"${id}".enabled = false\n`, [id]],
    [`plugins."${id}" = { enabled = true }\r\n`, [id]],
    [`﻿[plugins.'${id}'.extra] # comment\nx = 1\n`, [id]],
    [`notes = """\n[plugins."${id}"]\n"""\n[plugins."other@m"]\n`, ['other@m']],
    [`notes = '''\n[plugins.'x@y']'''\nlist = [\n  "a", # comment\n  [1, 2.5e3, 0x1F],\n]\nwhen = 1979-05-27 07:32:00Z\n"key \\" q" = """\\u00e9\\\n   tail"""\n[[servers]]\nname = "a"\n[servers.env]\nA = "b"\n[[servers]]\n`, []],
  ]) assert.deepEqual(plugins(text), expected, text);
  for (const text of [`[plugins."${id}"\nenabled = true\n`, '[a]\n[a]\n', 'a = 1\na = 2\n', 'a = {\n}\n', 'a = 1 b = 2\n',
    'a = "open\n', 'a = 07\n', 'a = { b = 1 }\n[a.c]\n', '[a]\nb.c = 1\n[a.b]\n', 'a = [1]\n[[a]]\n', 'a = """x""""""\n']) {
    assert.throws(() => parseToml(text), /^Error: line \d+:/, text);
  }
});

for (const [form, prior] of [
  ['spaced header', `[ plugins . "${id}" ]\nenabled = true\n`],
  ['dotted key under [plugins]', `[plugins]\n"${id}".enabled = true\n`],
  ['inline table', `plugins."${id}" = { enabled = true }\n`],
]) test(`IU01: a late failure keeps a prior Codex registration written as a ${form}`, async t => {
  const f = fixture(t); write(f.config, prior); f.state.codex.add(id); f.state.failClaude = true;
  await assert.rejects(main([], f.options), /late refusal fixture/);
  assert.equal(f.calls.some(([app, , action]) => app === 'codex' && action === 'remove'), false);
  assert.ok(read(f.config).includes(id)); assert.equal(fs.existsSync(f.stage), false);
});

test('IU01: a header inside a string is not a registration, so compensation removes the one this run added', async t => {
  const f = fixture(t); write(f.config, `notes = """\n[plugins."${id}"]\n"""\n`); f.state.failClaude = true;
  await assert.rejects(main([], f.options), /late refusal fixture/);
  assert.equal(f.calls.filter(([app, , action]) => app === 'codex' && action === 'remove').length, 1);
  assert.equal(f.state.codex.size, 0);
});

test('IU01: an unreadable Codex configuration stops the installer before any change', async t => {
  for (const text of [`[plugins."${id}"\nenabled = true\n`, `plugins = {\n  "${id}" = { enabled = true }\n}\n`]) {
    const f = fixture(t); write(f.config, text);
    await assert.rejects(main([], f.options), /Cannot read the Codex configuration .* changed nothing/);
    assert.deepEqual(mutations(f.calls), []); assert.equal(fs.existsSync(f.stage), false); assert.equal(fs.existsSync(f.catalog), false);
    assert.equal(read(f.config), text);
  }
});

test('IU01: native loader rejection of a scalar stops the install before staging', async t => {
  const f = fixture(t); write(f.config, 'when = 2026-13-40\n');
  const execute = (app, args) => { if (app === 'codex' && args.join(' ') === 'features list') throw new Error('invalid date'); return f.options.execute(app, args); };
  await assert.rejects(main([], { ...f.options, execute }), /Codex could not validate.*Nothing was changed.*codex features list/);
  assert.deepEqual(mutations(f.calls), []); assert.equal(fs.existsSync(f.stage), false);
});

test('IU02: disabled Codex update refuses before any mutation, even transient enablement', async t => {
  const f = fixture(t), prior = `[plugins."${id}"]\nenabled = false # my choice\n`;
  write(f.config, prior); f.state.codex.add(id);
  await assert.rejects(main([], f.options), /would turn it on.*--claude/);
  assert.equal(read(f.config), prior); assert.deepEqual(mutations(f.calls), []); assert.equal(fs.existsSync(f.stage), false);
});

test('IU02: a Claude-only rollback leaves a disabled Codex bridge alone', async t => {
  const f = fixture(t), prior = `[plugins."${id}"]\nenabled = false\n`;
  write(f.config, prior); f.state.codex.add(id); f.state.failClaude = true;
  await assert.rejects(main(['--claude'], f.options), /late refusal fixture/);
  assert.equal(read(f.config), prior); assert.equal(f.calls.some(([app]) => app === 'codex'), false);
});

test('IU03: a Codex cache with files no installer stage holds stops the update before any change', async t => {
  const f = fixture(t); await main(['--codex', '--prepare-only'], f.options);
  const version = JSON.parse(read(path.join(f.stage, 'package.json'))).version, staged = read(path.join(f.stage, 'package.json'));
  write(f.config, `[plugins."${id}"]\nenabled = true\n`); f.state.codex.add(id);
  const cache = path.join(f.homeDir, '.codex', 'plugins', 'cache', 'personal', PLUGIN_NAME, version), note = path.join(cache, 'user-note.txt');
  copyTree(f.stage, cache); write(note, 'mine');
  // A user copy (even identical to the cache) is not an installer backup.
  copyTree(cache, path.join(path.dirname(f.stage), `.${PLUGIN_NAME}.backup-manual`));
  f.calls.length = 0;
  await assert.rejects(main(['--codex'], f.options), /differs from every installer stage.*Nothing was changed.*move the folder out of the Codex cache/s);
  assert.deepEqual(mutations(f.calls), []); assert.equal(read(note), 'mine'); assert.equal(read(path.join(f.stage, 'package.json')), staged);
  fs.rmSync(note); await main(['--codex'], f.options);
  assert.ok(f.calls.some(([app, , action]) => app === 'codex' && action === 'add'), 'an exact copy of a stage is ours to replace');
});

test('IU03: compensation preserves cache edits made after a successful native add', async t => {
  const f = fixture(t); let note;
  const execute = (app, args) => {
    if (app === 'claude' && args[1] === 'install') {
      note = path.join(f.homeDir, '.codex', 'plugins', 'cache', 'personal', PLUGIN_NAME, 'new-version', 'mine');
      write(note, 'keep'); throw new Error('late refusal');
    }
    return f.options.execute(app, args);
  };
  await assert.rejects(main([], { ...f.options, execute }), /Rollback could not finish.*cache was left alone.*move the folder/);
  assert.equal(read(note), 'keep'); assert.equal(f.calls.some(([app, , action]) => app === 'codex' && action === 'remove'), false);
});

test('IU04: another enabled Claude or Codex registration of the bridge is named with its switch step before any change', async t => {
  const claude = fixture(t); claude.state.claude = [{ id: `${PLUGIN_NAME}@keeveeg`, scope: 'user', enabled: true }];
  await assert.rejects(main(['--claude'], claude.options), new RegExp(`Claude has ${PLUGIN_NAME}@keeveeg \\(user scope\\).*claude plugin uninstall ${PLUGIN_NAME}@keeveeg --scope user`));
  assert.deepEqual(mutations(claude.calls), []); assert.equal(fs.existsSync(claude.stage), false);
  claude.state.claude[0].enabled = false; await main(['--claude'], claude.options);
  const codex = fixture(t); write(codex.config, `[plugins."${PLUGIN_NAME}@keeveeg"]\nenabled = true\n`);
  await assert.rejects(main(['--codex'], codex.options), new RegExp(`Codex has ${PLUGIN_NAME}@keeveeg turned on.*codex plugin remove ${PLUGIN_NAME}@keeveeg`));
  assert.deepEqual(mutations(codex.calls), []); assert.equal(fs.existsSync(codex.catalog), false);
  write(codex.config, `[plugins."${PLUGIN_NAME}@keeveeg"]\nenabled = false\n`); await main(['--codex'], codex.options);
});

test('IU04: a project-scoped source is checked inside its project, not inferred from the home directory', async t => {
  const f = fixture(t), projectPath = path.join(f.homeDir, 'project');
  const row = { id: `${PLUGIN_NAME}@other`, projectPath, scope: 'project', enabled: false };
  f.state.claude = [row]; let projectEnabled = true;
  const execute = (app, args, options) => options?.cwd === projectPath ? JSON.stringify([{ ...row, enabled: projectEnabled }]) : f.options.execute(app, args);
  await assert.rejects(main(['--claude'], { ...f.options, execute }), /@other \(project scope\) turned on.*--scope project/);
  assert.deepEqual(mutations(f.calls), []); assert.equal(fs.existsSync(f.stage), false);
  projectEnabled = false; await main(['--claude'], { ...f.options, execute });
});

function hook(t, name, replacement) {
  const original = fs[name]; fs[name] = replacement(original); t.after(() => { fs[name] = original; });
}
const busy = () => Object.assign(new Error('EBUSY fixture'), { code: 'EBUSY' });

test('IU05: a temporary-file cleanup error after the catalog is published is not a failed installation', async t => {
  const f = fixture(t);
  hook(t, 'unlinkSync', original => file => { if (path.basename(String(file)).startsWith('marketplace.json.tmp-')) throw busy(); return original(file); });
  const prepared = await main(['--codex', '--prepare-only'], f.options);
  assert.equal(prepared.destination, f.stage); assert.ok(fs.existsSync(path.join(f.stage, 'package.json')));
  assert.ok(JSON.parse(read(f.catalog)).plugins.some(row => row.name === PLUGIN_NAME));
});

test('IU05: an error reported after publication removes the committed catalog with the stage', async t => {
  const f = fixture(t);
  hook(t, 'linkSync', original => (from, to) => { original(from, to); if (path.basename(String(to)) === 'marketplace.json') throw busy(); });
  await assert.rejects(main(['--codex', '--prepare-only'], f.options), error => /EBUSY fixture/.test(error.message) && !/Rollback could not finish/.test(error.message));
  assert.equal(fs.existsSync(f.catalog), false); assert.equal(fs.existsSync(f.stage), false);
});

test('IU05: when another writer changed the committed row, the failure reports an incomplete rollback', async t => {
  const f = fixture(t);
  hook(t, 'linkSync', original => (from, to) => {
    original(from, to);
    if (path.basename(String(to)) !== 'marketplace.json') return;
    const catalog = JSON.parse(read(to)); catalog.plugins[0].category = 'Edited'; fs.writeFileSync(to, JSON.stringify(catalog)); throw busy();
  });
  await assert.rejects(main(['--codex', '--prepare-only'], f.options), /EBUSY fixture Rollback could not finish/);
  assert.equal(JSON.parse(read(f.catalog)).plugins[0].category, 'Edited');
});

test('IU05: a competing first publication with the same bridge row belongs to the other writer', async t => {
  const f = fixture(t); let external;
  hook(t, 'linkSync', original => (from, to) => {
    if (to === f.catalog) { const catalog = JSON.parse(read(from)); catalog.plugins.push({ name: 'other' }); external = JSON.stringify(catalog); write(to, external); }
    return original(from, to);
  });
  await assert.rejects(main(['--codex', '--prepare-only'], f.options), /EEXIST/);
  assert.equal(read(f.catalog), external); assert.equal(fs.existsSync(f.stage), false);
});

test('IU05: failed restore reports incomplete rollback and the next install detects the missing stage', async t => {
  const f = fixture(t); await main(['--codex', '--prepare-only'], f.options);
  hook(t, 'renameSync', original => (from, to) => { if (to === f.stage) throw new Error('rename denied'); return original(from, to); });
  await assert.rejects(main(['--codex', '--prepare-only'], f.options), /rename denied.*Rollback could not finish.*preserved predecessor/);
  assert.equal(fs.existsSync(f.stage), false);
  await assert.rejects(main(['--codex', '--prepare-only'], f.options), /stage is missing.*backup.*interrupted.*move the intended predecessor/);
});

test('IU06: update steps stop 1.0.0-1.0.2 and unknown-source servers before the stage is replaced', () => {
  for (const file of ['README.md', 'docs/releases/v1.1.0.md']) {
    const text = read(path.join(root, file));
    assert.match(text, /1\.0\.0[–-]1\.0\.2[^\n]*(?:quit|stop)[^\n]*before/i, file);
    assert.match(text, /(?:not sure|unknown|don't know)[^\n]*(?:quit|stop)/i, file);
  }
});

// Clients that load the stage as the native ones do: Codex keeps one cached copy named by its version and replaces it
// on add. Claude copies each version it installs and lists the version and the copy; with inPlace it loads the stage
// folder itself and also lists that folder and the version it finds there, as Claude Code does for a local-path marketplace.
function clientFixture(t) {
  const f = fixture(t), market = 'claude-codex-local', selector = `${PLUGIN_NAME}@${market}`;
  const codexCache = path.join(f.homeDir, '.codex', 'plugins', 'cache', 'personal', PLUGIN_NAME);
  const claudeCache = path.join(f.homeDir, '.claude', 'plugins', 'cache', market, PLUGIN_NAME);
  const c = { claude: null, refuse: false, onRefuse: null, inPlace: false };
  const staged = () => JSON.parse(read(path.join(f.stage, 'package.json'))).version;
  const execute = (app, args) => {
    f.calls.push([app, ...args]);
    if (args[0] !== 'plugin') return '1';
    const [, action, verb] = args;
    if (app === 'codex') {
      fs.rmSync(codexCache, { recursive: true, force: true });
      if (action === 'add') { copyTree(f.stage, path.join(codexCache, staged())); write(f.config, `[plugins."${id}"]\nenabled = true\n`); }
      else write(f.config, '');
      return '{}';
    }
    if (action === 'marketplace') return verb === 'list' ? JSON.stringify(c.claude ? [{ name: market, source: { source: 'directory', path: f.stage } }] : []) : '{}';
    if (action === 'list') return JSON.stringify(c.claude ? [{ id: selector, scope: 'user', enabled: true, ...c.claude,
      ...(c.inPlace && fs.existsSync(f.stage) ? { readFromFolder: f.stage, folderVersion: staged() } : {}) }] : []);
    if (action === 'install' || action === 'update') {
      const version = staged(), installPath = path.join(claudeCache, version.replace('+', '-'));
      if (!fs.existsSync(installPath)) copyTree(f.stage, installPath);
      c.claude = { version, installPath };
      // A permission conflict that appears after Claude took the new build: the installer's last step refuses.
      if (c.refuse) { c.refuse = false; c.onRefuse?.(); write(path.join(f.homeDir, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: [CLAUDE_SEND_PERMISSION] } })); }
    }
    return '{}';
  };
  const options = { ...f.options, execute };
  // Both clients run an older build: an installer stage whose files differ from this source, as a released version's do.
  const installOlder = async () => {
    await main(['--prepare-only'], options);
    fs.appendFileSync(path.join(f.stage, 'scripts', 'mcp.mjs'), '\n// older build\n');
    execute('codex', ['plugin', 'add', id, '--json']); execute('claude', ['plugin', 'install', selector, '--scope', 'user', '--json']);
    return staged();
  };
  const retained = version => fs.readdirSync(path.dirname(f.stage)).filter(name => name.startsWith(`.${PLUGIN_NAME}.backup-`))
    .map(name => path.join(path.dirname(f.stage), name)).find(dir => JSON.parse(read(path.join(dir, 'package.json'))).version === version);
  return { ...f, c, options, codexCache, staged, installOlder, retained, codexRuns: () => fs.readdirSync(codexCache) };
}
const plainFailure = error => /already matches the outbound bridge tool/.test(error.message) && !/Version rollback|unverified|Rollback could not finish/.test(error.message);
const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('R3I01: a late refusal after --prepare-only returns both clients to the build they ran, not to the prepared stage', async t => {
  const f = clientFixture(t), older = await f.installOlder();
  await main(['--prepare-only'], f.options);
  const prepared = f.staged(), backup = f.retained(older);
  assert.notEqual(prepared, older); assert.deepEqual(f.codexRuns(), [older]);
  f.c.refuse = true;
  await assert.rejects(main([], f.options), plainFailure);
  assert.deepEqual(f.codexRuns(), [older]); assert.equal(f.c.claude.version, older);
  assert.equal(f.staged(), prepared, 'the installed stage is the one this run found');
  assert.equal(f.retained(older), backup, 'the older build is back in its own backup folder');
  assert.equal(f.calls.some(([app, , action]) => app === 'codex' && action === 'remove'), false);
});

test('R3I01: after a Claude-only update, a late refusal returns each client to its own build', async t => {
  const f = clientFixture(t), older = await f.installOlder();
  write(f.config, read(f.config).replace('enabled = true', 'enabled = false'));
  await main(['--claude'], f.options);
  const claudeBuild = f.staged();
  assert.equal(f.c.claude.version, claudeBuild); assert.deepEqual(f.codexRuns(), [older]);
  write(f.config, read(f.config).replace('enabled = false', 'enabled = true'));
  f.c.refuse = true;
  await assert.rejects(main([], f.options), plainFailure);
  assert.deepEqual(f.codexRuns(), [older]); assert.equal(f.c.claude.version, claudeBuild); assert.equal(f.staged(), claudeBuild);
});

for (const [label, args] of [['changed during the run', []], ['removed before a Claude-only run', ['--claude']]]) {
  test(`R3I01: when the build a client ran has no verified copy left (${label}), the failure names each version and the recovery source`, async t => {
    const f = clientFixture(t), older = await f.installOlder();
    await main(['--prepare-only'], f.options);
    const prepared = f.staged(), backup = f.retained(older);
    if (args.length) fs.rmSync(backup, { recursive: true });
    else f.c.onRefuse = () => fs.appendFileSync(path.join(backup, 'scripts', 'mcp.mjs'), '// edited\n');
    f.c.refuse = true;
    const error = await main(args, f.options).then(() => assert.fail('the run must fail'), e => e);
    assert.match(error.message, /already matches the outbound bridge tool/); assert.doesNotMatch(error.message, /Rollback could not finish/);
    const changed = args.length ? ['Claude'] : ['Codex', 'Claude'];
    for (const app of ['Codex', 'Claude']) {
      const note = new RegExp(`Version rollback did not complete for ${app}: before this run it loaded ${literal(older)}, and it now loads ${literal(prepared)} at its next start\\. The installer kept no verified copy of ${literal(older)}; its recovery source is the \\d+\\.\\d+\\.\\d+ release package\\.`);
      if (changed.includes(app)) assert.match(error.message, note); else assert.doesNotMatch(error.message, new RegExp(`for ${app}:|${app}'s version`));
    }
    assert.equal(f.c.claude.version, prepared); assert.equal(f.staged(), prepared);
    assert.deepEqual(f.codexRuns(), [args.length ? older : prepared]);
  });
}

test('R3I01: Claude loading the stage in place keeps the stage it loaded, and Codex returns to its own build', async t => {
  const f = clientFixture(t); f.c.inPlace = true;
  const older = await f.installOlder();
  await main(['--prepare-only'], f.options);
  const prepared = f.staged();
  f.c.refuse = true;
  await assert.rejects(main([], f.options), plainFailure);
  assert.deepEqual(f.codexRuns(), [older]); assert.equal(f.staged(), prepared);
  assert.equal(f.c.claude.version, prepared, 'Claude is refreshed from the stage it loads, not from its older cached copy');
});

test('R3I01: a rollback that cannot return a retained build to its folder names both paths, and the next run refuses until they are restored', async t => {
  const f = clientFixture(t), older = await f.installOlder();
  await main(['--prepare-only'], f.options);
  const prepared = f.staged(), backup = f.retained(older);
  f.c.refuse = true;
  hook(t, 'renameSync', original => (from, to) => { if (from === f.stage && to === backup) throw new Error('rename denied'); return original(from, to); });
  const error = await main([], f.options).then(() => assert.fail('the run must fail'), e => e);
  assert.match(error.message, /Rollback could not finish.*could not return.*rename denied.*This run's stage remains in .* and the previous stage in /s);
  assert.equal(f.staged(), older, 'the retained build still occupies the installed path');
  const predecessor = fs.readdirSync(path.dirname(f.stage)).map(name => path.join(path.dirname(f.stage), name)).find(dir => dir !== f.stage && fs.existsSync(path.join(dir, 'package.json')) && JSON.parse(read(path.join(dir, 'package.json'))).version === prepared);
  await assert.rejects(main(['--prepare-only'], f.options), new RegExp(`stopped during its rollback: the stage installed before it remains in ${literal(predecessor)}.*move ${literal(predecessor)} back to ${literal(f.stage)}`));
  assert.equal(f.staged(), older);
});

test('R3I02: an installer lock on a volume without hard links names its folder and the volume requirement, not state recovery', async t => {
  const f = fixture(t), lock = path.join(f.homeDir, 'plugins', `.${PLUGIN_NAME}-install-lock`);
  hook(t, 'linkSync', original => (from, to) => { if (path.dirname(String(to)) === lock) throw Object.assign(new Error('ENOTSUP fixture'), { code: 'ENOTSUP' }); return original(from, to); });
  const error = await main(['--prepare-only'], f.options).then(() => assert.fail('the lock must refuse'), e => e);
  assert.ok(error.message.startsWith(`The installer cannot lock ${lock}: its volume does not support hard links`), error.message);
  assert.doesNotMatch(error.message, /bridge_doctor|state directory/);
  assert.equal(fs.existsSync(f.stage), false);
});

test('R3I02: installer and catalog locks left by a dead owner and a dead recovery owner name their folder and the installer recovery', async t => {
  const dead = 2_147_483_647;
  for (const [args, folder, guarded] of [
    [['--prepare-only'], home => path.join(home, 'plugins', `.${PLUGIN_NAME}-install-lock`), /check the staged files in .* and the personal catalog /],
    [['--codex', '--prepare-only'], home => path.join(home, '.agents', 'plugins', `.${PLUGIN_NAME}-marketplace-lock`), /check .*marketplace\.json, then/],
  ]) {
    const f = fixture(t), lock = folder(f.homeDir);
    write(path.join(lock, 'state.lock'), JSON.stringify({ pid: dead, token: 'dead-installer' }));
    write(path.join(lock, 'state.lock.recovery'), JSON.stringify({ pid: dead, token: 'dead-recovery' }));
    const error = await main(args, f.options).then(() => assert.fail('the lock must refuse'), e => e);
    assert.ok(error.message.startsWith(`The installer lock ${lock} was left by an installer that stopped`), error.message);
    assert.match(error.message, guarded);
    assert.ok(error.message.includes(`stop every bridge installer`) && error.message.includes(`then delete the folder ${lock} and run the installer again`), error.message);
    assert.doesNotMatch(error.message, /offline lock recovery steps|back up the complete state|Pin both apps|bridge_doctor/);
    assert.ok(fs.existsSync(path.join(lock, 'state.lock')) && fs.existsSync(path.join(lock, 'state.lock.recovery')), 'the guard is never broken automatically');
    assert.equal(fs.existsSync(f.stage), false); assert.deepEqual(mutations(f.calls), []);
  }
});
