import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareInstallation } from '../scripts/install.mjs';
import { buildPackages, zipEntries } from '../scripts/package.mjs';
import { PLUGIN_NAME, PLUGIN_SCHEMA, MCP_SCHEMA, PORTABLE_RUNTIME_FILES, NATIVE_RUNTIME_FILES,
  checkManifests, compatibilityFiles, syncManifests, validateCanonical } from '../scripts/manifests.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(root, 'work');
const json = value => JSON.stringify(value, null, 2) + '\n';

function fixture(t) {
  fs.mkdirSync(work, { recursive: true });
  const directory = fs.mkdtempSync(path.join(work, 'packaging-'));
  t.after(() => {
    const actual = fs.realpathSync(directory);
    assert.equal(path.dirname(actual), fs.realpathSync(work));
    assert.ok(path.basename(actual).startsWith('packaging-'));
    fs.rmSync(actual, { recursive: true, force: true });
  });
  return directory;
}

function copySource(t) {
  const directory = fixture(t);
  const source = path.join(directory, 'source');
  for (const relative of PORTABLE_RUNTIME_FILES) {
    const target = path.join(source, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
  }
  syncManifests(source);
  return { directory, source };
}

function isolatedEnv(directory) {
  const env = Object.fromEntries(['SystemRoot', 'SystemDrive', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH']
    .filter(name => process.env[name]).map(name => [name, process.env[name]]));
  return { ...env, USERPROFILE: directory, HOME: directory, LOCALAPPDATA: directory, APPDATA: directory,
    TMPDIR: directory, TEMP: directory, TMP: directory, CLAUDE_CONFIG_DIR: path.join(directory, 'claude'),
    CODEX_HOME: path.join(directory, 'codex'), CLAUDE_CODEX_BRIDGE_DAEMON: 'off' };
}

function unzipStored(buffer) {
  const files = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0, 'release ZIP entries use stored data');
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    assert.ok(!files.has(name), 'ZIP must not contain duplicate names');
    const start = offset + 30 + nameLength + extraLength;
    files.set(name, buffer.subarray(start, start + size));
    offset = start + size;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'local entries must be followed by a central directory');
  return files;
}

test('canonical Agent Plugins metadata generates the checked-in native adapters and exact runtime subtree', () => {
  const bundle = checkManifests(root);
  assert.equal(bundle.manifest.name, 'bridge-claude-codex');
  assert.equal(bundle.packageJson.name, 'claude-codex-bridge');
  assert.equal(bundle.manifest.$schema, PLUGIN_SCHEMA);
  assert.equal(bundle.mcp.$schema, MCP_SCHEMA);
  assert.equal(bundle.files['.codex-plugin/plugin.json'].name, bundle.manifest.name);
  assert.equal(bundle.files['.claude-plugin/plugin.json'].version, bundle.manifest.version);
  assert.deepEqual(bundle.files['.codex-plugin/plugin.json'].interface, bundle.manifest.extensions['com.openai'].interface);
  assert.deepEqual(bundle.manifest.extensions['com.openai'].interface.capabilities, ['Read', 'Write']);
  assert.ok(bundle.files['.codex-plugin/plugin.json'].mcpServers[PLUGIN_NAME].env_vars.includes('CODEX_APP_TOOLS_PIPE_PATH'));
  assert.equal(bundle.mcp.mcpServers[PLUGIN_NAME].env_vars, undefined, 'portable 1.0 rejects native env_vars');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(catalog.plugins[0].source.source, 'git-subdir');
  assert.equal(catalog.plugins[0].source.path, './compatibility/native');
  const claude = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(claude.plugins[0].source, './compatibility/native');
});

// The bridge serves every Claude Code and Codex client, so no listing may read as one client's add-on:
// short texts name no client, and the long description names them all.
test('manifest and catalog texts name every supported client or none', () => {
  const { manifest, files } = checkManifests(root);
  const face = manifest.extensions['com.openai'].interface;
  const codex = files['.codex-plugin/plugin.json'];
  const catalog = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const claudeCatalog = catalog('.claude-plugin/marketplace.json');
  for (const text of [manifest.description, face.displayName, face.shortDescription, ...face.defaultPrompt,
    codex.description, codex.interface.displayName, files['.claude-plugin/plugin.json'].description,
    claudeCatalog.description, claudeCatalog.plugins[0].description, catalog('.agents/plugins/marketplace.json').interface.displayName,
  ]) assert.doesNotMatch(text, /desktop|terminal|\bcli\b|vs ?code/i, text);
  for (const text of [face.longDescription, codex.interface.longDescription]) {
    for (const client of [/desktop apps/, /terminals/]) assert.match(text, client, text);
  }
  assert.ok(['desktop', 'terminal'].every(keyword => manifest.keywords.includes(keyword)));
});

test('portable configuration rejects native-only fields, unknown schemas, and reserved environment overrides', () => {
  const bundle = checkManifests(root);
  for (const mutate of [
    (manifest, mcp) => { mcp.mcpServers[PLUGIN_NAME].env_vars = ['CODEX_APP_TOOLS_PIPE_PATH']; },
    (manifest, mcp) => { mcp.$schema = 'https://agent-plugins.org/schemas/2.0.0/mcp.schema.json'; },
    (manifest, mcp) => { mcp.mcpServers[PLUGIN_NAME].env = { plugin_root: 'override' }; },
    (manifest, mcp) => { mcp.mcpServers[PLUGIN_NAME].cwd = '../outside'; },
    manifest => { manifest.skills = './skills'; },
  ]) {
    const manifest = structuredClone(bundle.manifest), mcp = structuredClone(bundle.mcp);
    mutate(manifest, mcp);
    assert.throws(() => validateCanonical(manifest, mcp), /Invalid|requires/);
  }
});

test('packaging stops on manifest identity/version drift or generated native runtime drift', async t => {
  for (const [name, relative, mutate] of [
    ['package version', 'package.json', value => { value.version = '99.0.0'; }],
    ['Claude identity', '.claude-plugin/plugin.json', value => { value.name = 'another-plugin'; }],
    ['Codex command', '.codex-plugin/plugin.json', value => { value.mcpServers[PLUGIN_NAME].args = ['./unreviewed.mjs']; }],
    ['Claude command', '.claude-plugin/plugin.json', value => { value.mcpServers[PLUGIN_NAME].command = 'unreviewed'; }],
  ]) {
    await t.test(name, sub => {
      const { directory, source } = copySource(sub);
      const filename = path.join(source, relative);
      const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      mutate(value); fs.writeFileSync(filename, json(value));
      const outputDir = path.join(directory, 'output');
      assert.throws(() => buildPackages({ sourceRoot: source, outputDir }), /differs/);
      assert.equal(fs.existsSync(outputDir), false, 'drift must fail before release artifacts are written');
    });
  }
  await t.test('native source drift', sub => {
    const { directory, source } = copySource(sub);
    fs.appendFileSync(path.join(source, 'compatibility/native/lib/codex-desktop.mjs'), '\n// stale copy\n');
    assert.throws(() => buildPackages({ sourceRoot: source, outputDir: path.join(directory, 'output') }), /differs/);
  });
});

test('release ZIPs contain exactly the native or portable allowlist and reproducible bytes with verified checksums', t => {
  const { directory, source } = copySource(t);
  fs.writeFileSync(path.join(source, 'credentials.key'), 'not-a-real-secret');
  fs.writeFileSync(path.join(source, 'state.json'), '{"local":"not-for-release"}');
  const first = buildPackages({ sourceRoot: source, outputDir: path.join(directory, 'first') });
  const second = buildPackages({ sourceRoot: source, outputDir: path.join(directory, 'second') });
  assert.deepEqual(first.archives.map(filename => path.basename(filename)), [
    `claude-codex-bridge-${first.version}.zip`,
    `claude-codex-bridge-marketplace-${first.version}.zip`,
    `claude-codex-bridge-portable-${first.version}.zip`,
  ]);
  for (let index = 0; index < first.archives.length; index++) {
    assert.deepEqual(fs.readFileSync(first.archives[index]), fs.readFileSync(second.archives[index]));
  }
  const native = unzipStored(fs.readFileSync(first.archives[0]));
  assert.deepEqual([...native.keys()].sort(), [...NATIVE_RUNTIME_FILES].sort());
  assert.equal(native.has('plugin.json'), false);
  assert.equal(native.has('mcp.json'), false);
  assert.equal(JSON.parse(native.get('config/plugin-source.json').toString()).version, first.version);
  assert.equal(JSON.parse(native.get('config/plugin-source.json').toString()).name, 'bridge-claude-codex');
  const nativePackage = JSON.parse(native.get('package.json'));
  assert.equal(nativePackage.name, 'claude-codex-bridge');
  assert.equal(nativePackage.scripts, undefined, 'runtime does not advertise source-only commands');
  const marketplace = unzipStored(fs.readFileSync(first.archives[1]));
  assert.deepEqual([...marketplace.keys()].sort(), [
    '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json',
    ...NATIVE_RUNTIME_FILES.map(relative => `plugins/${PLUGIN_NAME}/${relative}`),
  ].sort());
  const codexCatalog = JSON.parse(marketplace.get('.agents/plugins/marketplace.json').toString());
  assert.equal(codexCatalog.plugins[0].source.path, `./plugins/${PLUGIN_NAME}`);
  const portable = unzipStored(fs.readFileSync(first.archives[2]));
  assert.deepEqual([...portable.keys()].sort(), [...PORTABLE_RUNTIME_FILES].sort());
  assert.equal(JSON.parse(portable.get('plugin.json').toString()).version, first.version);
  assert.equal(JSON.parse(portable.get('mcp.json').toString()).mcpServers[PLUGIN_NAME].type, 'stdio');
  assert.equal(JSON.parse(portable.get('package.json')).scripts, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).scripts.package, 'node scripts/package.mjs');
  assert.equal(native.has('.mcp.json'), false);
  assert.equal(portable.has('.mcp.json'), false);
  const sums = fs.readFileSync(first.sha256, 'utf8').trim().split('\n');
  assert.deepEqual(sums, first.archives.map(filename => `${createHash('sha256').update(fs.readFileSync(filename)).digest('hex')}  ${path.basename(filename)}`));
});

test('Claude MCP is plugin-only and forwards nonsecret context with supported env mappings', () => {
  assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false);
  const { files, manifest } = checkManifests(root);
  const claude = files['.claude-plugin/plugin.json'].mcpServers[PLUGIN_NAME];
  assert.deepEqual(claude.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp.mjs', `--plugin-version=${manifest.version}`]);
  assert.equal(claude.env_vars, undefined);
  for (const name of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODEX_BRIDGE_REGISTRY_DIR', 'CODEX_HOME',
    'CLAUDE_CODEX_BRIDGE_CODEX_BIN', 'CLAUDE_CODEX_BRIDGE_DAEMON', 'CLAUDE_CODEX_BRIDGE_SSH_HOST',
    'CLAUDE_CODEX_BRIDGE_STATE_DIR', 'CLAUDE_CODE_MESSAGING_SOCKET']) {
    assert.equal(claude.env[name], '${' + name + ':-}');
  }
  assert.doesNotMatch(JSON.stringify(claude), /TOKEN|PASSWORD|API_KEY/);
});

test('publication metadata permits only bundled asset references and reviewed public links', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json')));
  const mcp = JSON.parse(fs.readFileSync(path.join(root, 'mcp.json')));
  assert.doesNotThrow(() => validateCanonical(manifest, mcp));
  const marker = 'synthetic-private';
  for (const [field, value] of [
    ['logo', `/${marker}/logo.svg`],
    ['logoDark', `C:\\${marker}\\logo.svg`],
    ['composerIcon', `\\\\${marker}\\share\\logo.svg`],
    ['composerIconDark', './../assets/bridge-dark.svg'],
    ['logo', './assets/not-bundled.svg'],
    ['logo', './scripts/mcp.mjs'],
    ['logo', 'https://example.invalid/logo.svg'],
    ['screenshots', [`/${marker}/screenshot.png`]],
    ['displayName', { path: `/${marker}/name` }],
    ['defaultPrompt', [{ path: `/${marker}/prompt` }]],
    ['websiteURL', `file:///${marker}/index.html`],
    ['supportURL', `https://localhost/${marker}`],
    ['privacyPolicyURL', `https://github.com/${marker}/privacy`],
    ['termsOfServiceURL', `${manifest.extensions['com.openai'].interface.termsOfServiceURL}?token=${marker}`],
  ]) {
    const candidate = structuredClone(manifest);
    candidate.extensions['com.openai'].interface[field] = value;
    assert.throws(() => validateCanonical(candidate, mcp), error =>
      /interface/.test(error.message) && !error.message.includes(marker), field);
  }
  for (const mutate of [
    value => { value.extensions[marker] = { path: `/${marker}/source` }; },
    value => { value.extensions['com.openai'].path = `/${marker}/source`; },
    value => { value.homepage = `/${marker}/index.html`; },
    value => { value.repository = `https://${marker}.example.invalid/repo`; },
    value => { value.author.url = `file:///${marker}/author`; },
  ]) {
    const candidate = structuredClone(manifest);
    mutate(candidate);
    assert.throws(() => validateCanonical(candidate, mcp), error =>
      /extensions|homepage|repository|author\.url/.test(error.message) && !error.message.includes(marker));
  }
});

test('publication gates reject even an aligned native adapter with a private logo path', t => {
  const source = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json')));
  const mcp = JSON.parse(fs.readFileSync(path.join(root, 'mcp.json')));
  const adapters = compatibilityFiles(manifest, mcp);
  const marker = 'synthetic-private';
  const logo = `C:\\${marker}\\logo.svg`;
  for (const [relative, value] of Object.entries({ ...adapters, 'config/plugin-source.json': manifest,
    'config/mcp-source.json': mcp, 'package.json': { name: 'claude-codex-bridge', version: manifest.version } })) {
    const filename = path.join(source, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, json(value));
  }
  const configPath = path.join(source, 'config/mcp-source.json');
  const configuredMcp = structuredClone(mcp);
  const env = { CODEX_HOME: `C:\\${marker}\\codex` };
  configuredMcp.mcpServers[PLUGIN_NAME].env = env;
  fs.writeFileSync(configPath, json(configuredMcp));
  assert.deepEqual(checkManifests(source, { allowConfiguredSource: true }).mcp.mcpServers[PLUGIN_NAME].env, env);
  assert.throws(() => checkManifests(source), /release MCP environment/);
  fs.writeFileSync(configPath, json(mcp));

  manifest.extensions['com.openai'].interface.logo = logo;
  adapters['.codex-plugin/plugin.json'].interface.logo = logo;
  fs.writeFileSync(path.join(source, 'config/plugin-source.json'), json(manifest));
  fs.writeFileSync(path.join(source, '.codex-plugin/plugin.json'), json(adapters['.codex-plugin/plugin.json']));
  const rejectsLogo = error => /interface\.logo/.test(error.message) && !error.message.includes(marker);
  assert.throws(() => checkManifests(source), rejectsLogo);
  assert.throws(() => syncManifests(source), rejectsLogo); // Native-source fixture: no generated mirror.
  for (const [relative, value] of Object.entries(adapters)) {
    assert.equal(fs.readFileSync(path.join(source, relative), 'utf8'), json(value));
  }
  fs.writeFileSync(path.join(source, 'plugin.json'), json(manifest));
  fs.writeFileSync(path.join(source, 'mcp.json'), json(mcp));
  const outputDir = path.join(source, 'output');
  assert.throws(() => buildPackages({ sourceRoot: source, outputDir }), rejectsLogo);
  assert.equal(fs.existsSync(outputDir), false);
});

test('release gates reject private canonical env before writing or echoing it; local install may read path overrides', t => {
  const { directory, source } = copySource(t);
  const serverFile = path.join(source, 'mcp.json');
  const mcp = JSON.parse(fs.readFileSync(serverFile));
  const server = mcp.mcpServers[PLUGIN_NAME];
  const marker = 'synthetic-private-marker';
  const adapter = path.join(source, '.claude-plugin/plugin.json');
  const before = fs.readFileSync(adapter);
  server.env = { CLAUDE_CODEX_BRIDGE_STATE_DIR: path.join(directory, marker, 'state') };
  fs.writeFileSync(serverFile, json(mcp));
  const local = checkManifests(source, { checkNative: false, allowConfiguredSource: true });
  assert.deepEqual(local.mcp.mcpServers[PLUGIN_NAME].env, server.env);
  const prepared = prepareInstallation({ sourceRoot: source, homeDir: path.join(directory, 'profile'), env: {}, codex: false });
  assert.equal(prepared.stateDir, server.env.CLAUDE_CODEX_BRIDGE_STATE_DIR);
  for (const name of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
    const launch = JSON.parse(fs.readFileSync(path.join(prepared.destination, name))).mcpServers[PLUGIN_NAME];
    assert.equal(launch.env.CLAUDE_CODEX_BRIDGE_STATE_DIR, prepared.stateDir);
  }
  const outputDir = path.join(directory, 'output');
  for (const action of [() => checkManifests(source), () => syncManifests(source), () => buildPackages({ sourceRoot: source, outputDir })]) {
    assert.throws(action, error => /release.*MCP environment/i.test(error.message) && !error.message.includes(marker));
  }
  assert.deepEqual(fs.readFileSync(adapter), before);
  assert.equal(fs.existsSync(outputDir), false);
  for (const env of [{ CLAUDE_CODE_MESSAGING_TOKEN: marker }, { CODEX_HOME: '${ANTHROPIC_API_KEY}' }]) {
    server.env = env;
    fs.writeFileSync(serverFile, json(mcp));
    assert.throws(() => checkManifests(source, { checkNative: false, allowConfiguredSource: true }),
      error => /local MCP environment/i.test(error.message) && !error.message.includes(marker));
  }
  fs.writeFileSync(serverFile, `{"env":"${marker}`);
  assert.throws(() => checkManifests(source), error => /Invalid JSON.*mcp\.json/.test(error.message) && !error.message.includes(marker));
});

test('release gates refuse env overrides in native source adapters without replacing them', t => {
  const { directory, source } = copySource(t);
  for (const file of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'compatibility/native/config/mcp-source.json']) {
    const filename = path.join(source, file);
    const before = fs.readFileSync(filename);
    const config = JSON.parse(before);
    config.mcpServers[PLUGIN_NAME].env = { CLAUDE_CODEX_BRIDGE_SSH_HOST: 'synthetic-private-alias' };
    const privateConfig = json(config);
    fs.writeFileSync(filename, privateConfig);
    const outputDir = path.join(directory, 'output');
    for (const action of [() => checkManifests(source), () => syncManifests(source), () => buildPackages({ sourceRoot: source, outputDir })]) {
      assert.throws(action, error => /differs|release MCP environment/.test(error.message) && !error.message.includes('synthetic-private'));
    }
    assert.equal(fs.readFileSync(filename, 'utf8'), privateConfig);
    assert.equal(fs.existsSync(outputDir), false);
    fs.writeFileSync(filename, before);
  }
});

test('a root project MCP file blocks release rather than being read or overwritten', t => {
  const { source } = copySource(t);
  const projectMcp = path.join(source, '.mcp.json');
  fs.writeFileSync(projectMcp, 'synthetic-private-project-config');
  for (const action of [() => checkManifests(source), () => syncManifests(source)]) {
    assert.throws(action, error => /root \.mcp\.json/.test(error.message) && !error.message.includes('synthetic-private'));
  }
  assert.equal(fs.readFileSync(projectMcp, 'utf8'), 'synthetic-private-project-config');
});

test('manifest and package commands run through a linked entry with preserve-symlinks-main', t => {
  const { directory, source } = copySource(t);
  fs.copyFileSync(path.join(root, 'scripts/package.mjs'), path.join(source, 'scripts/package.mjs'));
  const link = path.join(directory, 'linked source');
  fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const [script, args, output] of [['manifests.mjs', ['--check'], /are aligned/], ['package.mjs', [], /"archives"/]]) {
    const entry = path.join(link, 'scripts', script);
    const launch = spawnSync(process.execPath, ['--preserve-symlinks-main', entry, ...args],
      { cwd: directory, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(launch.status, 0, launch.stderr);
    assert.match(launch.stdout, output);
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
      `await import(${JSON.stringify(new URL(`./scripts/${script}`, pathToFileURL(`${link}${path.sep}`)).href)});`, 'nonexistent-entry'],
    { cwd: directory, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, '');
  }
});

test('ZIP writer rejects duplicate names and paths that escape the archive root', () => {
  for (const name of ['../escape', '/absolute', 'C:/drive', 'dir/../escape', 'dir\\file', './file', 'double//separator', 'nul\0file']) {
    assert.throws(() => zipEntries([{ name, data: Buffer.from('hello') }]), /safe relative paths/);
  }
  assert.throws(() => zipEntries([{ name: 'file', data: 'a' }, { name: 'file', data: 'b' }]), /unique/);
  const zip = zipEntries([{ name: 'file', data: Buffer.from('hello') }]);
  assert.equal(zip.readUInt32LE(14), 0x3610a686, 'known CRC-32 for hello');
});

test('portable archive expands PLUGIN_ROOT to a cached Unicode installation and starts MCP from an unrelated cwd', async t => {
  const { directory, source } = copySource(t);
  const built = buildPackages({ sourceRoot: source, outputDir: path.join(directory, 'output') });
  const cache = path.join(directory, 'cached plugin copy', 'plugin café');
  for (const [relative, data] of unzipStored(fs.readFileSync(built.archives[2]))) {
    const target = path.join(cache, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
  }
  const config = JSON.parse(fs.readFileSync(path.join(cache, 'mcp.json'), 'utf8')).mcpServers[PLUGIN_NAME];
  const dataDirectory = path.join(directory, 'plugin-data');
  const unrelated = path.join(directory, 'unrelated project');
  fs.mkdirSync(unrelated); fs.mkdirSync(dataDirectory);
  const expand = value => value.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_, name) => name === 'ROOT' ? cache : dataDirectory);
  assert.equal(expand(config.cwd), cache);
  const env = { ...isolatedEnv(directory), PLUGIN_ROOT: cache, PLUGIN_DATA: dataDirectory };
  const child = spawn(config.command, config.args.map(expand), { cwd: unrelated, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const result = await new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Portable MCP startup timeout')); }, 10_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve(stdout) : reject(new Error(stderr)); });
    child.stdin.end([
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'portable-startup-test', version: '1' } } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
    ].map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n');
  });
  const replies = result.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.find(reply => reply.id === 1).result.serverInfo.version, built.version);
  assert.deepEqual(replies.find(reply => reply.id === 2).result.tools.map(tool => tool.name).sort(),
    ['bridge_doctor', 'bridge_panel', 'list_claude_sessions', 'list_codex_threads', 'list_deliveries', 'panel_history', 'panel_retry_notice', 'panel_send', 'send_to_claude', 'send_to_codex']);
  assert.equal(fs.existsSync(path.join(directory, '.local/share', 'claude-codex-bridge')), false, 'probe must not register a real app endpoint');
});

function probeInitialize(command, args, { cwd, env }) {
  const request = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'packaging-test', version: '0' } } })}\n`;
  const result = spawnSync(command, args, { cwd, env, input: request, encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).result.serverInfo.version;
}

test('the generated native runtime starts from an unrelated cwd and reports the packaged version', t => {
  const directory = fixture(t);
  const script = fileURLToPath(new URL('../compatibility/native/scripts/mcp.mjs', import.meta.url));
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
  assert.equal(probeInitialize(process.execPath, [script], { cwd: directory, env: isolatedEnv(directory) }), version);
});

test('the native archive installer stages an inline Claude server that starts from an unrelated cwd', t => {
  const { directory, source } = copySource(t);
  const built = buildPackages({ sourceRoot: source, outputDir: path.join(directory, 'output') });
  const unpacked = path.join(directory, 'unpacked plugin café');
  const profile = path.join(directory, 'synthetic profile');
  fs.mkdirSync(profile);
  for (const [relative, data] of unzipStored(fs.readFileSync(built.archives[0]))) {
    const target = path.join(unpacked, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
  }
  const env = isolatedEnv(profile);
  const prepared = spawnSync(process.execPath, [path.join(unpacked, 'scripts/install.mjs'), '--claude', '--prepare-only'],
    { cwd: directory, env, encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.equal(prepared.status, 0, prepared.stderr);
  const installed = path.join(profile, 'plugins', PLUGIN_NAME);
  assert.equal(fs.existsSync(path.join(installed, '.mcp.json')), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, '.claude-plugin/plugin.json')));
  const server = manifest.mcpServers[PLUGIN_NAME];
  const expand = value => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', installed)
    .replace(/\$\{([A-Z_]+):-\}/g, (_, name) => env[name] ?? '');
  const forwarded = Object.fromEntries(Object.entries(server.env).map(([name, value]) => [name, expand(value)]));
  assert.match(manifest.version, /\+codex\./);
  assert.equal(probeInitialize(server.command, server.args.map(expand), { cwd: directory, env: { ...env, ...forwarded } }), manifest.version);
  const configured = checkManifests(installed, { allowConfiguredSource: true });
  assert.equal(configured.manifest.version, manifest.version);
  assert.equal(configured.packageJson.scripts, undefined);
  const forbiddenOutput = path.join(directory, 'must-not-package');
  assert.throws(() => buildPackages({ sourceRoot: installed, outputDir: forbiddenOutput }), /release MCP environment/i);
  assert.throws(() => buildPackages({ sourceRoot: unpacked, outputDir: forbiddenOutput }), /clean source checkout/);
  assert.equal(fs.existsSync(forbiddenOutput), false);
});
