#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isMainModule } from '../lib/entry-point.mjs';

export const PLUGIN_NAME = 'bridge-claude-codex';
// The npm/archive identity is independent of the native plugin namespace.
const PACKAGE_NAME = 'claude-codex-bridge';
export const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const NATIVE_DIRECTORY = 'compatibility/native';
export const COMMON_RUNTIME_FILES = [
  '.codex-plugin/plugin.json', '.claude-plugin/plugin.json',
  'lib/entry-point.mjs', 'lib/state-files.mjs', 'lib/store.mjs', 'lib/state-lock.mjs', 'lib/call-store.mjs', 'lib/ledger-worker.mjs', 'lib/state-directory.mjs', 'lib/delivery.mjs', 'lib/legacy-environment.mjs', 'lib/claude-sessions.mjs', 'lib/claude-process.mjs', 'lib/call-time.mjs', 'lib/outcome.mjs', 'lib/local-socket.mjs', 'lib/codex-desktop.mjs', 'lib/codex-ssh.mjs',
  'lib/bridge-service.mjs', 'lib/codex-host.mjs', 'scripts/mcp.mjs',
  'lib/claude-history.mjs', 'lib/bridge-history.mjs', 'lib/history-ledger-reader.mjs', 'lib/manual-service.mjs', 'lib/manual-ledger.mjs', 'lib/codex-settings.mjs', 'lib/ws-jsonrpc.mjs', 'lib/codex-binary.mjs', 'lib/codex-daemon.mjs', 'lib/codex-peer.mjs', 'ui/bridge.html',
  'scripts/manifests.mjs', 'scripts/install.mjs', 'skills/bridge/SKILL.md',
  'package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'docs/PRIVACY.md', 'docs/PUBLISHING.md', 'docs/TERMS.md',
  'assets/bridge.svg', 'assets/bridge-dark.svg',
];
export const NATIVE_RUNTIME_FILES = ['config/plugin-source.json', 'config/mcp-source.json', ...COMMON_RUNTIME_FILES];
export const PORTABLE_RUNTIME_FILES = ['plugin.json', 'mcp.json', ...COMMON_RUNTIME_FILES];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const json = value => JSON.stringify(value, null, 2) + '\n';
const CODEX_CONTEXT_ENV_VARS = ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_THREAD_ID', 'CODEX_HOME', 'USERPROFILE', 'HOME', 'PATH',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODEX_BRIDGE_STATE_DIR', 'CLAUDE_CODEX_BRIDGE_REGISTRY_DIR',
  'CLAUDE_CODEX_BRIDGE_CODEX_BIN', 'CLAUDE_CODEX_BRIDGE_DAEMON', 'CLAUDE_CODEX_BRIDGE_SSH_HOST'];
const LOCAL_CONFIG_ENV_VARS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODEX_BRIDGE_STATE_DIR', 'CLAUDE_CODEX_BRIDGE_REGISTRY_DIR',
  'CLAUDE_CODEX_BRIDGE_CODEX_BIN', 'CLAUDE_CODEX_BRIDGE_DAEMON', 'CODEX_HOME', 'CLAUDE_CODEX_BRIDGE_SSH_HOST'];
const CLAUDE_CONTEXT_ENV_VARS = ['CLAUDE_CODE_MESSAGING_SOCKET', ...LOCAL_CONFIG_ENV_VARS];
const BUNDLED_ASSET_PATHS = new Set(COMMON_RUNTIME_FILES.filter(name => name.startsWith('assets/')).map(name => `./${name}`));
const INTERFACE_ASSET_FIELDS = ['composerIcon', 'composerIconDark', 'logo', 'logoDark'];
const INTERFACE_TEXT_FIELDS = ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category'];
const INTERFACE_LIST_FIELDS = ['capabilities', 'defaultPrompt'];
// These are publication metadata, not configurable destinations. An HTTPS scheme alone
// does not rule out private hosts, paths, or credentials in a URL.
const PUBLIC_AUTHOR_URL = 'https://github.com/KeeVeeG';
const PUBLIC_REPOSITORY_URL = `${PUBLIC_AUTHOR_URL}/claude-codex-bridge`;
const PUBLIC_INTERFACE_URLS = {
  websiteURL: PUBLIC_REPOSITORY_URL,
  supportURL: `${PUBLIC_REPOSITORY_URL}/issues`,
  privacyPolicyURL: `${PUBLIC_REPOSITORY_URL}/blob/main/docs/PRIVACY.md`,
  termsOfServiceURL: `${PUBLIC_REPOSITORY_URL}/blob/main/docs/TERMS.md`,
};
const INTERFACE_FIELDS = new Set([...INTERFACE_ASSET_FIELDS, ...INTERFACE_TEXT_FIELDS,
  ...INTERFACE_LIST_FIELDS, ...Object.keys(PUBLIC_INTERFACE_URLS)]);

// Archives, the native mirror and local stages do not ship the source commands.
export function runtimePackageJson({ scripts, ...metadata }) { return metadata; }

function readBytes(rootDirectory, relative) {
  const filename = path.join(rootDirectory, relative);
  const actual = fs.realpathSync(filename);
  const rel = path.relative(rootDirectory, actual);
  if (!fs.lstatSync(filename).isFile() || !rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Manifest must be a regular file inside the source root: ${relative}`);
  }
  return fs.readFileSync(filename);
}

function read(directory, relative) {
  const content = readBytes(directory, relative).toString('utf8').replace(/^\uFEFF/, '');
  try { return JSON.parse(content); }
  catch { throw new Error(`Invalid JSON in ${relative}.`); }
}

// Validate the closed Agent Plugins 1.0 envelopes and this bridge's stdio entry.
// Canonical schemas: https://github.com/agentplugins/agent-plugins-spec/tree/main/schemas/1.0.0
export function validateCanonical(manifest, mcp) {
  const fields = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
  if (!object(manifest) || Object.keys(manifest).some(key => !fields.includes(key)) || manifest.$schema !== PLUGIN_SCHEMA ||
      manifest.name !== PLUGIN_NAME || !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(manifest.name) ||
      manifest.name.length > 64) throw new Error('Invalid canonical Agent Plugins manifest identity or schema.');
  for (const field of ['version', 'description', 'homepage', 'repository', 'license']) {
    if (manifest[field] !== undefined && typeof manifest[field] !== 'string') throw new Error(`plugin.json ${field} must be a string.`);
  }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error('plugin.json requires a release version.');
  if (manifest.author !== undefined && (!object(manifest.author) || Object.entries(manifest.author)
    .some(([key, value]) => !['name', 'email', 'url'].includes(key) || typeof value !== 'string'))) throw new Error('Invalid plugin.json author.');
  if (manifest.keywords !== undefined && !stringArray(manifest.keywords)) throw new Error('Invalid plugin.json keywords.');
  validatePublicationMetadata(manifest);
  if (!object(mcp) || mcp.$schema !== MCP_SCHEMA || Object.keys(mcp).some(key => !['$schema', 'mcpServers'].includes(key)) ||
      !object(mcp.mcpServers) || Object.keys(mcp.mcpServers).length !== 1 || !object(mcp.mcpServers[PLUGIN_NAME])) {
    throw new Error('Invalid canonical mcp.json envelope or server name.');
  }
  const server = mcp.mcpServers[PLUGIN_NAME];
  if (Object.keys(server).some(key => !['type', 'command', 'args', 'env', 'cwd'].includes(key)) ||
      server.type !== 'stdio' || server.command !== 'node' || !isDeepStrictEqual(server.args, ['${PLUGIN_ROOT}/scripts/mcp.mjs']) ||
      server.cwd !== '${PLUGIN_ROOT}') throw new Error('This bridge requires the canonical portable Node stdio launch configuration.');
  if (server.env !== undefined && (!object(server.env) || Object.entries(server.env).some(([key, value]) =>
    ['PLUGIN_ROOT', 'PLUGIN_DATA'].includes(key.toUpperCase()) || typeof value !== 'string'))) throw new Error('Invalid portable MCP environment.');
  return { manifest, mcp };
}

function validatePublicationMetadata(manifest) {
  const extensions = manifest.extensions;
  const codex = extensions?.['com.openai'];
  const face = codex?.interface;
  if (!object(extensions) || Object.keys(extensions).some(key => key !== 'com.openai') ||
      !object(codex) || Object.keys(codex).some(key => key !== 'interface') || !object(face)) {
    throw new Error('This bridge requires only interface metadata in extensions.com.openai.');
  }
  if (Object.keys(face).some(key => !INTERFACE_FIELDS.has(key))) throw new Error('Unsupported plugin.json interface field.');
  for (const field of INTERFACE_ASSET_FIELDS) {
    if (face[field] !== undefined && !BUNDLED_ASSET_PATHS.has(face[field])) {
      throw new Error(`plugin.json interface.${field} must reference a bundled relative asset.`);
    }
  }
  for (const field of INTERFACE_TEXT_FIELDS) {
    if (face[field] !== undefined && typeof face[field] !== 'string') throw new Error(`plugin.json interface.${field} must be a string.`);
  }
  for (const field of INTERFACE_LIST_FIELDS) {
    if (face[field] !== undefined && !stringArray(face[field])) throw new Error(`plugin.json interface.${field} must be an array of strings.`);
  }
  for (const [field, value, expected] of [
    ['homepage', manifest.homepage, PUBLIC_REPOSITORY_URL],
    ['repository', manifest.repository, PUBLIC_REPOSITORY_URL],
    ['author.url', manifest.author?.url, PUBLIC_AUTHOR_URL],
    ...Object.entries(PUBLIC_INTERFACE_URLS).map(([key, url]) => [`interface.${key}`, face[key], url]),
  ]) {
    if (value !== undefined && value !== expected) throw new Error(`plugin.json ${field} must use its approved public URL.`);
  }
}

function checkMcpEnvironment({ mcpServers }, allowConfiguredSource) {
  const entries = Object.entries(mcpServers[PLUGIN_NAME].env ?? {});
  if (!allowConfiguredSource && entries.length) {
    throw new Error('The release MCP environment must be empty. Configure the local install instead.');
  }
  if (entries.some(([key, value]) => (!LOCAL_CONFIG_ENV_VARS.includes(key) && key !== 'CLAUDE_CODEX_BRIDGE_INSTALL_ROOT') || value.includes('${'))) {
    throw new Error('Invalid local MCP environment: only supported nonsecret bridge configuration may be supplied as literals.');
  }
}

/** Native launchers keep the context that portable v1 cannot express. Neither adapter
 * captures ambient values at generation time. Claude supports named env expansions,
 * not Codex's env_vars list; use empty fallbacks for optional configuration.
 */
export function compatibilityFiles(manifest, mcp) {
  validateCanonical(manifest, mcp);
  checkMcpEnvironment(mcp, true);
  const metadata = Object.fromEntries(['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']
    .filter(key => manifest[key] !== undefined).map(key => [key, manifest[key]]));
  const portable = mcp.mcpServers[PLUGIN_NAME];
  const codexEnv = portable.env === undefined ? {} : { env: { ...portable.env } };
  const codexServer = { command: portable.command, cwd: './', args: ['./scripts/mcp.mjs'], ...codexEnv, env_vars: [...CODEX_CONTEXT_ENV_VARS] };
  // Claude runs this plugin from one fixed folder and keeps a plugin server running across /reload-plugins
  // while its configuration is unchanged. The version, with the installer's build stamp, makes every install
  // a new configuration, so a reload restarts the server on the new code.
  const claudeServer = { command: portable.command, args: ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp.mjs', `--plugin-version=${manifest.version}`],
    env: { ...Object.fromEntries(CLAUDE_CONTEXT_ENV_VARS.map(name => [name, '${' + name + ':-}'])), ...portable.env } };
  return {
    '.codex-plugin/plugin.json': { ...metadata, skills: './skills/', mcpServers: { [PLUGIN_NAME]: codexServer },
      ...structuredClone(manifest.extensions['com.openai']) },
    '.claude-plugin/plugin.json': { ...metadata, skills: './skills/', mcpServers: { [PLUGIN_NAME]: claudeServer } },
  };
}

function readCanonicalBundle(sourceRoot, allowConfiguredSource = false) {
  const source = fs.realpathSync(sourceRoot);
  if (fs.lstatSync(path.join(source, '.mcp.json'), { throwIfNoEntry: false })) {
    throw new Error('The bridge source must not include a root .mcp.json; Claude MCP is declared in the plugin manifest.');
  }
  const native = !fs.existsSync(path.join(source, 'plugin.json'));
  const manifestPath = native ? 'config/plugin-source.json' : 'plugin.json';
  const mcpPath = native ? 'config/mcp-source.json' : 'mcp.json';
  const bundle = validateCanonical(read(source, manifestPath), read(source, mcpPath));
  checkMcpEnvironment(bundle.mcp, allowConfiguredSource);
  return { source, native, ...bundle, packageJson: read(source, 'package.json') };
}

export function checkManifests(sourceRoot = root, { checkNative = true, allowConfiguredSource = false } = {}) {
  const bundle = readCanonicalBundle(sourceRoot, allowConfiguredSource);
  if (bundle.packageJson.name !== PACKAGE_NAME || bundle.packageJson.version !== bundle.manifest.version) {
    throw new Error('package.json name or version differs from the product package name or canonical plugin version.');
  }
  const { env, ...launch } = bundle.mcp.mcpServers[PLUGIN_NAME];
  const files = compatibilityFiles(bundle.manifest, bundle.mcp);
  // A private canonical override need not be written into checkout files before a local install.
  const cleanFiles = allowConfiguredSource && env && compatibilityFiles(bundle.manifest, {
    ...bundle.mcp, mcpServers: { [PLUGIN_NAME]: launch },
  });
  const currentFiles = Object.fromEntries(Object.keys(files).map(relative => [relative, read(bundle.source, relative)]));
  if (!isDeepStrictEqual(currentFiles, cleanFiles)) {
    const mismatch = Object.keys(files).find(relative => !isDeepStrictEqual(currentFiles[relative], files[relative]));
    if (mismatch) throw new Error(`${mismatch} differs from the canonical plugin.json/mcp.json.`);
  }
  const checked = { ...bundle, files };
  if (checkNative && !bundle.native) checkNativeDeployment(checked);
  return checked;
}

export function nativeBundleEntries(bundle) {
  checkMcpEnvironment(bundle.mcp, false);
  return [
    { name: 'config/plugin-source.json', data: Buffer.from(json(bundle.manifest)) },
    { name: 'config/mcp-source.json', data: Buffer.from(json(bundle.mcp)) },
    ...COMMON_RUNTIME_FILES.map(name => ({ name, data: name === 'package.json'
      ? Buffer.from(json(runtimePackageJson(bundle.packageJson))) : readBytes(bundle.source, name) })),
  ].sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

function fileList(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error(`Generated native deployment contains a link: ${name}`);
    if (item.isDirectory()) return fileList(path.join(directory, item.name), name);
    if (!item.isFile()) throw new Error(`Invalid generated native entry: ${name}`);
    return [name];
  }).sort();
}

function checkNativeDeployment(bundle) {
  const destination = path.join(bundle.source, NATIVE_DIRECTORY);
  const expected = nativeBundleEntries(bundle);
  if (!fs.existsSync(destination) || !isDeepStrictEqual(fileList(destination), expected.map(entry => entry.name).sort())) {
    throw new Error('Generated compatibility/native file list differs from the native runtime allowlist. Run npm run manifests:sync.');
  }
  for (const entry of expected) {
    if (!readBytes(destination, entry.name).equals(entry.data)) {
      throw new Error(`Generated compatibility/native/${entry.name} differs from its canonical source. Run npm run manifests:sync.`);
    }
  }
}

function syncNativeDeployment(bundle) {
  const destination = path.join(bundle.source, NATIVE_DIRECTORY);
  const expected = nativeBundleEntries(bundle);
  if (fs.existsSync(destination)) {
    const extra = fileList(destination).filter(name => !expected.some(entry => entry.name === name));
    if (extra.length) throw new Error(`Refusing to remove unexpected generated native files: ${extra.join(', ')}.`);
  }
  for (const entry of expected) {
    const target = path.join(destination, entry.name);
    let directory = path.dirname(target);
    while (directory !== bundle.source) {
      try { if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Refusing to write through a linked generated native directory.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      directory = path.dirname(directory);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Refusing to replace a linked generated native file.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.writeFileSync(target, entry.data);
  }
}

function refuseNativeEnvLiterals(source, relative, expected) {
  if (!fs.lstatSync(path.join(source, relative), { throwIfNoEntry: false })) return;
  const current = read(source, relative);
  for (const [name, server] of Object.entries(current.mcpServers ?? {})) {
    if (server?.env === undefined) continue;
    const expectedEnv = expected.mcpServers[name]?.env ?? {};
    if (!object(server.env) || Object.entries(server.env).some(([key, value]) =>
      !Object.hasOwn(expectedEnv, key) || expectedEnv[key] !== value)) {
      throw new Error(`The release MCP environment in ${relative} contains a local override.`);
    }
  }
}

export function syncManifests(sourceRoot = root) {
  const bundle = readCanonicalBundle(sourceRoot);
  const files = compatibilityFiles(bundle.manifest, bundle.mcp);
  for (const [relative, expected] of Object.entries(files)) {
    refuseNativeEnvLiterals(bundle.source, relative, expected);
    if (!bundle.native) refuseNativeEnvLiterals(bundle.source, `${NATIVE_DIRECTORY}/${relative}`, expected);
  }
  if (!bundle.native) refuseNativeEnvLiterals(bundle.source, `${NATIVE_DIRECTORY}/config/mcp-source.json`, bundle.mcp);
  for (const [relative, value] of Object.entries(files)) fs.writeFileSync(path.join(bundle.source, relative), json(value));
  fs.writeFileSync(path.join(bundle.source, 'package.json'), json({ ...bundle.packageJson, name: PACKAGE_NAME, version: bundle.manifest.version }));
  if (!bundle.native) syncNativeDeployment(bundle);
  return checkManifests(bundle.source);
}

if (isMainModule(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--check', '--sync'].includes(args[0])) throw new Error('Usage: node scripts/manifests.mjs --check | --sync');
    const result = args[0] === '--sync' ? syncManifests() : checkManifests();
    console.log(`${result.manifest.name} ${result.manifest.version}: canonical and compatibility manifests are aligned.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
