#!/usr/bin/env node
import fs from 'node:fs';
import { isMainModule } from '../lib/entry-point.mjs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultStateDir, withStateLock } from '../lib/store.mjs';
import { isDeepStrictEqual } from 'node:util';
import { legacyEnvironmentWarnings } from '../lib/legacy-environment.mjs';
import { validateSshHostAlias } from '../lib/codex-ssh.mjs';
import { waitForSharingRetry } from '../lib/state-files.mjs';
import { resolveCodexExecutable } from '../lib/codex-binary.mjs';
import { codexHome } from '../lib/codex-settings.mjs';
import { PLUGIN_NAME, COMMON_RUNTIME_FILES, NATIVE_RUNTIME_FILES, checkManifests, compatibilityFiles, runtimePackageJson } from './manifests.mjs';

export { PLUGIN_NAME };
const CLAUDE_MARKETPLACE = 'claude-codex-local';
const LEGACY_PLUGIN = 'codex-claude-desktop-bridge';
const LEGACY_LOCAL = 'codex-claude-desktop-local';
const LEGACY_MARKETPLACE = 'keeveeg-desktop-bridge';
const LEGACY_PREFIX = `mcp__plugin_${LEGACY_PLUGIN}_${LEGACY_PLUGIN}`;
const TOOL_PREFIX = `mcp__plugin_${PLUGIN_NAME}_${PLUGIN_NAME}`;

function checkEnvironment(env) {
  const warnings = legacyEnvironmentWarnings(env);
  if (warnings.length) throw new Error(warnings.join('\n'));
}
// Claude scopes plugin MCP tools by plugin name and server name. Marketplace
// names and cache versions are not part of this permission identifier.
export const CLAUDE_SEND_PERMISSION = `mcp__plugin_${PLUGIN_NAME}_${PLUGIN_NAME}__send_to_codex`;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeFiles = NATIVE_RUNTIME_FILES;
export { runtimeFiles as RUNTIME_FILES };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const jsonText = value => `${JSON.stringify(value, null, 2)}\n`;
const timestamp = () => new Date().toISOString().replace(/[-:.TZ]/g, '');

// Windows scanners and sync clients can briefly hold handles to freshly copied
// plugin files. Keep each move atomic and retry the same source/destination;
// never restage files or repeat application installation after sharing errors.
function renameDirectoryWithRetry(source, destination) {
  const until = performance.now() + 1000;
  for (;;) {
    try { fs.renameSync(source, destination); return; }
    catch (error) { if (!waitForSharingRetry(error, until)) throw error; }
  }
}

function readRawIfPresent(filename) {
  try { return fs.readFileSync(filename, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
}

function optionalJson(filename) {
  try { return readJson(filename); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read valid JSON from ${filename}: ${error.message}`);
  }
}

function contained(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Recognize installer output before moving it. A name, a plugin manifest, or a backup suffix is not ownership.
const stageMarker = '.bridge-installed';
const markerText = 'bridge-claude-codex installer v1\n';
const stageStamp = /^\d+\.\d+\.\d+\+codex\.\d{17}$/;
const backupSuffix = /^\d{17}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function stageKind(directory) {
  // Permit only the closed runtime layout; preserve even a marked folder if it acquired a checkout, notes or links.
  const allowed = new Set([...runtimeFiles, '.mcp.json', '.claude-plugin/marketplace.json', stageMarker]);
  function regularFiles(dir, prefix = '') {
    return fs.readdirSync(dir, { withFileTypes: true }).every(entry => {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) return [...allowed].some(file => file.startsWith(`${name}/`)) && regularFiles(path.join(dir, entry.name), `${name}/`);
      return entry.isFile() && allowed.has(name);
    });
  }
  try {
    if (!fs.lstatSync(directory).isDirectory() || !regularFiles(directory)) return null;
    const read = name => readJson(path.join(directory, name));
    const manifest = read('config/plugin-source.json'), pkg = read('package.json');
    const claude = read('.claude-plugin/plugin.json'), codex = read('.codex-plugin/plugin.json');
    const catalog = read('.claude-plugin/marketplace.json');
    if (manifest.name !== PLUGIN_NAME || !stageStamp.test(manifest.version) || pkg.name !== 'claude-codex-bridge' ||
        pkg.version !== manifest.version || [claude, codex].some(m => m.name !== PLUGIN_NAME || m.version !== manifest.version) ||
        catalog.name !== CLAUDE_MARKETPLACE || catalog.plugins?.length !== 1 || catalog.plugins[0].name !== PLUGIN_NAME || catalog.plugins[0].source !== './') return null;
    const marker = readRawIfPresent(path.join(directory, stageMarker));
    if (marker !== null) return marker === markerText && !fs.existsSync(path.join(directory, '.mcp.json')) ? 'owned' : null;
    // The released 1.0 installer had no marker. Recognize its generated, stamped adapters and pinned config, not source trees.
    // Preserve this unmarked predecessor intact as a backup; it is never eligible for automatic pruning.
    const launch = read('.mcp.json').mcpServers?.[PLUGIN_NAME], pin = read('config/mcp-source.json').mcpServers?.[PLUGIN_NAME]?.env?.CLAUDE_CODEX_BRIDGE_STATE_DIR;
    return /^1\.0\.\d+\+codex\./.test(manifest.version) && claude.mcpServers === './.mcp.json' && launch?.command === 'node' &&
      launch.args?.[0] === '${CLAUDE_PLUGIN_ROOT}/scripts/mcp.mjs' && typeof pin === 'string' && path.isAbsolute(pin) &&
      launch.env?.CLAUDE_CODEX_BRIDGE_STATE_DIR === pin && codex.mcpServers?.[PLUGIN_NAME]?.env?.CLAUDE_CODEX_BRIDGE_STATE_DIR === pin ? 'legacy' : null;
  } catch { return null; }
}
// Only identical output may be destroyed. Previous software, differently configured stages, and edits
// survive without trusting filesystem timestamps or leaving an inventory of private paths on disk.
function stageComparator(directory, version) {
  const versioned = new Set(['package.json', 'config/plugin-source.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']);
  const expected = [...runtimeFiles, stageMarker, '.claude-plugin/marketplace.json'].map(name => [name, fs.readFileSync(path.join(directory, name))]);
  return candidate => {
    if (stageKind(candidate) !== 'owned') return false;
    try {
      const stamp = readJson(path.join(candidate, 'package.json')).version;
      return expected.every(([name, data]) => {
        const bytes = versioned.has(name) && stamp !== version ? Buffer.from(data.toString().replaceAll(version, stamp)) : data;
        const file = path.join(candidate, name);
        return fs.statSync(file).size === bytes.length && fs.readFileSync(file).equals(bytes);
      });
    } catch { return false; }
  };
}
function pruneInstallationBackups(prepared, homeDir) {
  const directory = path.resolve(homeDir, 'plugins');
  refuseLink(directory);
  const prefix = `.${PLUGIN_NAME}.backup-`;
  const backups = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() &&
    entry.name.startsWith(prefix) && backupSuffix.test(entry.name.slice(prefix.length))).map(entry => path.join(directory, entry.name)).sort().reverse();
  const owned = backups.filter(prepared.unchangedStage);
  const keep = owned.includes(prepared.backupDirectory) ? prepared.backupDirectory : owned[0];
  for (const file of owned) {
    if (file === keep) continue;
    fs.rmSync(file, { recursive: true });
  }
}

function refuseLink(filename) {
  try {
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error(`Refusing to replace a symbolic link: ${filename}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// Backup ownership is explicit. Never glob or remove older sibling backups: their names are not proof.
const backupFolder = '.bridge-claude-codex-backups';
const secureWindowsDirectory = `
$ErrorActionPreference = 'Stop'
$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
$p = $job.dir
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [IO.Directory]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access)
$acl.SetAccessRuleProtection($true,$false)
foreach ($existing in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($existing) }
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($p,$acl)
if ($job.original) {
  # Make the replacement inherit no broader rights than the existing file, even under a shared parent.
  $saved = [IO.File]::GetAccessControl($job.original,[Security.AccessControl.AccessControlSections]::Access)
  $saved.SetAccessRuleProtection($true,$true)
  [IO.File]::Open($job.temporary,[IO.FileMode]::CreateNew).Dispose()
  [IO.File]::SetAccessControl($job.temporary,$saved)
}
`;
function privateBackupFolder(dir, temporary, original) {
  const marker = path.join(dir, stageMarker);
  let created = false;
  try { fs.mkdirSync(dir, { mode: 0o700 }); created = true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  refuseLink(dir); refuseLink(marker);
  if (created) fs.writeFileSync(marker, markerText, { flag: 'wx', mode: 0o600 });
  else if (readRawIfPresent(marker) !== markerText) throw new Error('The backup directory is not installer-owned. Preserve it elsewhere before installing.');
  restrictDirectory(dir, temporary, original);
}
function restrictDirectory(dir, temporary, original) {
  if (process.platform === 'win32') {
    // Newly created files must inherit a private DACL before any settings bytes are written.
    const system = process.env.SystemRoot;
    if (!system || !path.isAbsolute(system)) throw new Error('Cannot secure the installer backup directory.');
    const result = spawnSync(path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', secureWindowsDirectory],
      { input: Buffer.from(JSON.stringify({ dir, temporary, original })).toString('base64'), windowsHide: true, timeout: 15000, stdio: ['pipe', 'ignore', 'ignore'] });
    if (result.status !== 0) throw new Error('Cannot set a private Windows ACL on the installer backup directory. No settings were written.');
  } else fs.chmodSync(dir, 0o700);
}

/** Keep one private previous version per file, then compare and atomically publish the replacement. */
export function writeJsonAtomic(filename, value, options) {
  return writeTextAtomic(filename, jsonText(value), options);
}
function writeTextAtomic(filename, next, { expectedPrevious, label = 'marketplace', saveBackup = true } = {}) {
  refuseLink(filename);
  const previous = readRawIfPresent(filename);
  if (expectedPrevious !== undefined && previous !== expectedPrevious) {
    throw new Error(`The ${label} changed during installation. No replacement was made; retry from the updated file.`);
  }
  if (previous === next) return null;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const dir = path.join(path.dirname(filename), backupFolder);
  const name = path.basename(filename), temporary = path.join(dir, `${name}.tmp-${randomUUID()}`);
  const backup = previous === null || !saveBackup ? null : path.join(dir, `${name}.previous`);
  const temporaryBackup = `${temporary}.prev`;
  try {
    privateBackupFolder(dir, temporary, previous === null ? null : filename);
    const mode = previous === null ? 0o600 : fs.statSync(filename).mode & 0o600;
    fs.writeFileSync(temporary, next, { flag: process.platform === 'win32' && previous !== null ? 'r+' : 'wx', mode });
    if (backup) {
      refuseLink(backup);
      fs.writeFileSync(temporaryBackup, previous, { flag: 'wx', mode });
    }
    if (readRawIfPresent(filename) !== previous) throw new Error(`The ${label} changed before replacement. The newer file was preserved; retry installation.`);
    if (backup) fs.renameSync(temporaryBackup, backup);
    if (previous === null) fs.linkSync(temporary, filename);
    else fs.renameSync(temporary, filename);
  } finally {
    for (const file of [temporary, temporaryBackup]) { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
  return backup;
}

function permissionRuleMatches(rule, toolName) {
  if (typeof rule !== 'string' || rule.includes('(')) return false;
  if (rule === toolName || toolName.startsWith(`${rule}__`)) return true;
  if (!rule.includes('*')) return false;
  const pattern = rule.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${pattern}$`).test(toolName);
}

/** Explicit, narrow user-level grant for Claude's outbound bridge tool. */
export function grantClaudeSendPermission({ homeDir = os.homedir(), env = process.env, preview = false } = {}) {
  const configDir = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'));
  const settingsPath = path.join(configDir, 'settings.json');
  const lockDirectory = path.join(configDir, `.${PLUGIN_NAME}-permissions-lock`);
  const plan = () => {
    const previous = readRawIfPresent(settingsPath);
    let settings;
    try { settings = previous === null ? {} : JSON.parse(previous.replace(/^\uFEFF/, '')); }
    catch { throw new Error('Claude settings.json is not valid JSON. No permission was added.'); }
    if (!object(settings) || (settings.permissions !== undefined && !object(settings.permissions))) {
      throw new Error('Claude settings.json must contain an object with optional object permissions. No permission was added.');
    }
    const permissions = settings.permissions || {};
    for (const field of ['allow', 'ask', 'deny']) {
      if (permissions[field] !== undefined && (!Array.isArray(permissions[field]) ||
          permissions[field].some(rule => typeof rule !== 'string'))) {
        throw new Error(`Claude permissions.${field} must be an array of strings. No permission was added.`);
      }
    }
    for (const field of ['deny', 'ask']) {
      if (permissions[field]?.some(rule => permissionRuleMatches(rule, CLAUDE_SEND_PERMISSION) || permissionRuleMatches(rule, `${LEGACY_PREFIX}__send_to_codex`))) {
        throw new Error(`Claude permissions.${field} already matches the outbound bridge tool. Resolve that rule in Claude before granting access.`);
      }
    }
    if (preview || permissions.allow?.includes(CLAUDE_SEND_PERMISSION)) {
      return { settingsPath, rule: CLAUDE_SEND_PERMISSION, added: false, backup: null };
    }
    settings.permissions = { ...permissions, allow: [...(permissions.allow || []), CLAUDE_SEND_PERMISSION] };
    const backup = writeJsonAtomic(settingsPath, settings, { expectedPrevious: previous, label: 'Claude settings' });
    return { settingsPath, rule: CLAUDE_SEND_PERMISSION, added: true, backup };
  };
  return preview ? plan() : withStateLock(lockDirectory, plan);
}

/** Migrate user choices before applying the normal narrow send grant. */
function migrateClaudeSettings({ homeDir, env, log, retired, keepLegacyRules }) {
  const configDir = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'));
  const filename = path.join(configDir, 'settings.json');
  if (!fs.existsSync(filename)) return;
  withStateLock(path.join(configDir, `.${PLUGIN_NAME}-permissions-lock`), () => {
    const previous = readRawIfPresent(filename);
    const settings = JSON.parse(previous.replace(/^\uFEFF/, ''));
    if (!object(settings)) throw new Error('Claude settings.json must contain an object. No migration was made.');
    let changed = false;
    for (const field of ['allow', 'ask', 'deny']) {
      const rules = settings.permissions?.[field];
      if (!Array.isArray(rules)) continue;
      settings.permissions[field] = rules.flatMap(rule => {
        if (typeof rule !== 'string' || (rule !== LEGACY_PREFIX && !rule.startsWith(`${LEGACY_PREFIX}__`))) return rule;
        const next = TOOL_PREFIX + rule.slice(LEGACY_PREFIX.length);
        if (keepLegacyRules && rules.includes(next)) return [rule];
        changed = true;
        return [...(keepLegacyRules ? [rule] : []), ...(rules.includes(next) ? [] : [next])];
      });
    }
    if (object(settings.enabledPlugins)) {
      for (const id of Object.keys(settings.enabledPlugins)) {
        if (retired.has(id)) {
          delete settings.enabledPlugins[id]; changed = true;
        }
      }
    }
    if (!changed) return;
    const backup = writeJsonAtomic(filename, settings, { expectedPrevious: previous, label: 'Claude settings' });
    log(`Migrated Claude bridge permission rules and enabled-plugin entries in ${filename}`);
    if (backup) log(`Previous Claude settings backup: ${backup}`);
  });
}

const isLegacyPlugin = id => typeof id === 'string' && (id === LEGACY_PLUGIN || id.startsWith(`${LEGACY_PLUGIN}@`));

const codexConfigPath = ({ homeDir, env }) => path.join(codexHome({ env, homeDir }), 'config.toml');

/** The `[plugins.<id>]` or `[marketplaces.<name>]` table a Codex configuration line opens. */
function codexTable(line) {
  const match = line.trim().match(/^\[(plugins|marketplaces)\.(?:"([^"]+)"|'([^']+)'|([\w-]+))\]\s*(?:#.*)?$/);
  return match && { kind: match[1], name: match[2] ?? match[3] ?? match[4] };
}

/** Plugin IDs and marketplace names recorded as tables in Codex's own configuration. */
function codexConfigTables({ homeDir, env }) {
  const tables = { plugins: [], marketplaces: [] };
  for (const line of (readRawIfPresent(codexConfigPath({ homeDir, env })) ?? '').split(/\r?\n/)) {
    const table = codexTable(line);
    if (table) tables[table.kind].push(table.name);
  }
  return tables;
}

/** Set `enabled = false` in one plugin's Codex table, keeping the previous file as a backup. */
function disableCodexPlugin({ homeDir, env, id }) {
  const filename = codexConfigPath({ homeDir, env });
  const previous = readRawIfPresent(filename) ?? '';
  const lines = previous.split(/(?<=\n)/);
  const start = lines.findIndex(line => { const table = codexTable(line); return table?.kind === 'plugins' && table.name === id; });
  if (start < 0) return null;
  // Never synthesize a second enabled key or edit a string literal. Unsupported TOML is left intact.
  if (previous.includes('"'.repeat(3)) || previous.includes("'".repeat(3))) throw new Error('Cannot safely edit this Codex configuration. Disable the old plugin in Codex.');
  let end = lines.findIndex((line, index) => index > start && line.trimStart().startsWith('['));
  if (end < 0) end = lines.length;
  const enabled = /^(\s*(?:enabled|"enabled"|'enabled')\s*=\s*)(true|false)([^\S\r\n]*(?:#[^\r\n]*)?)(\r?\n)?$/;
  const keys = lines.slice(start + 1, end).flatMap((line, index) => enabled.test(line) ? [index + start + 1] : []);
  if (keys.length !== 1) throw new Error('Cannot safely locate the old plugin’s boolean enabled key. Disable it in Codex; the configuration was not changed.');
  lines[keys[0]] = lines[keys[0]].replace(enabled, '$1false$3$4');
  return writeTextAtomic(filename, lines.join(''), { expectedPrevious: previous, label: 'Codex configuration' });
}

const legacyRepository = 'KeeVeeG/codex-claude-desktop-bridge';
function officialGit(source) {
  return typeof source === 'string' && [legacyRepository, `https://github.com/${legacyRepository}`, `https://github.com/${legacyRepository}.git`].includes(source);
}
function legacyLocalStage(homeDir) {
  const dir = path.join(homeDir, 'plugins', LEGACY_PLUGIN);
  try {
    if (!fs.lstatSync(dir).isDirectory() || fs.existsSync(path.join(dir, '.git'))) return null;
    const read = file => readJson(path.join(dir, file));
    const pkg = read('package.json'), market = read('.claude-plugin/marketplace.json');
    if (pkg.name !== LEGACY_PLUGIN || !stageStamp.test(pkg.version) || market.name !== LEGACY_LOCAL ||
        market.plugins?.length !== 1 || market.plugins[0].name !== LEGACY_PLUGIN || market.plugins[0].source !== './') return null;
    return ['config/plugin-source.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'].every(file => {
      const manifest = read(file); return manifest.name === LEGACY_PLUGIN && manifest.version === pkg.version;
    }) ? dir : null;
  } catch { return null; }
}
function releasedPersonalRow(row) {
  return row?.name === LEGACY_PLUGIN && row.source?.source === 'local' && row.source.path === `./plugins/${LEGACY_PLUGIN}`;
}
function officialCodexMarket(config) {
  // Do not infer a source from a marketplace name, partial table or unsupported TOML shape.
  if (config.includes('"'.repeat(3)) || config.includes("'".repeat(3))) return false;
  const lines = config.split(/\r?\n/);
  const starts = lines.flatMap((line, i) => { const table = codexTable(line); return table?.kind === 'marketplaces' && table.name === LEGACY_MARKETPLACE ? [i] : []; });
  if (starts.length !== 1) return false;
  const fields = new Map();
  for (const line of lines.slice(starts[0] + 1)) {
    if (line.trimStart().startsWith('[')) break;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = /^\s*(source|source_type)\s*=\s*(["'])([^"']+)\2\s*(?:#.*)?$/.exec(line);
    if (!m || fields.has(m[1])) return false;
    fields.set(m[1], m[3]);
  }
  return fields.get('source_type') === 'git' && officialGit(fields.get('source'));
}

/** Retire verified user registrations only. An unknown source, scope, or dependent keeps its registration. */
export function migrateLegacyInstallation({ homeDir = os.homedir(), env = process.env,
  execute = run, log = console.log, claude = true, codex = true, onPending = () => {} } = {}) {
  checkEnvironment(env);
  for (const app of ['claude', 'codex']) if (app === 'claude' ? claude : codex) execute(app, ['--version']);
  const removals = [], retired = new Set(), local = legacyLocalStage(homeDir);
  let keepLegacyRules = false, pending = false;
  const marketplace = (app, name) => ({ app, args: ['plugin', 'marketplace', 'remove', name, '--json'], done: `Removed ${app} marketplace ${name}` });
  if (claude) {
    const plugins = readList(execute('claude', ['plugin', 'list', '--json']), 'plugins');
    const markets = readList(execute('claude', ['plugin', 'marketplace', 'list', '--json']), 'marketplaces');
    const verified = new Set();
    for (const market of markets.filter(row => [LEGACY_LOCAL, LEGACY_MARKETPLACE].includes(row.name))) {
      if (markets.filter(row => row.name === market.name).length !== 1 || (market.scope && market.scope !== 'user')) { pending = true; continue; }
      const entry = market.source || registeredPath(market) ? market : optionalJson(path.join(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'), 'plugins', 'known_marketplaces.json'))?.[market.name];
      const location = registeredPath(entry), src = entry?.source;
      if (market.name === LEGACY_LOCAL ? local && location && samePath(location, local) :
          src && (src.source === 'github' && officialGit(src.repo) || src.source === 'git' && officialGit(src.url)) && !src.path) verified.add(market.name);
      else pending = true;
    }
    const retainedMarkets = new Set();
    for (const entry of plugins) {
      const selector = entry.id || entry.pluginId || (entry.name?.includes('@') || !entry.marketplace ? entry.name : `${entry.name}@${entry.marketplace}`);
      const market = selector?.split('@')[1];
      if (isLegacyPlugin(selector) && verified.has(market) && entry.scope === 'user' && !entry.projectPath) {
        retired.add(selector); removals.push({ app: 'claude', args: ['plugin', 'uninstall', selector, '--scope', 'user', '--json'], done: `Removed claude plugin ${selector} (user)` });
      } else {
        retainedMarkets.add(market); if (isLegacyPlugin(selector)) { keepLegacyRules = true; pending = true; }
      }
    }
    for (const market of verified) if (!retainedMarkets.has(market)) removals.push(marketplace('claude', market));
  }
  if (codex) {
    const tables = codexConfigTables({ homeDir, env }), config = readRawIfPresent(codexConfigPath({ homeDir, env })) ?? '';
    const catalog = optionalJson(path.join(homeDir, '.agents', 'plugins', 'marketplace.json'));
    const personal = local && catalog?.plugins?.filter(row => row?.name === LEGACY_PLUGIN).length === 1 && catalog.plugins.some(releasedPersonalRow) ? catalog.name : null;
    const official = officialCodexMarket(config); let retainMarket = false;
    for (const id of tables.plugins) {
      const market = id.split('@')[1];
      if (!isLegacyPlugin(id)) { if (market === LEGACY_MARKETPLACE) retainMarket = true; continue; }
      if (!(personal && market === personal || market === LEGACY_MARKETPLACE && official)) { pending = true; continue; }
      removals.push({ app: 'codex', args: ['plugin', 'remove', id, '--json'], done: `Removed codex plugin ${id}`,
        fallback(error) {
          const backup = disableCodexPlugin({ homeDir, env, id }); pending = true;
          if (market === LEGACY_MARKETPLACE) retainMarket = true;
          log(`Turned off codex plugin ${id}: Codex could not remove it now (${error.message.trim().split('\n').at(-1).trim()}). After restarting Codex, run the installer again to remove it.`);
          if (backup) log(`Previous Codex configuration backup: ${backup}`);
        } });
    }
    if (tables.marketplaces.includes(LEGACY_MARKETPLACE)) {
      if (official) removals.push({ ...marketplace('codex', LEGACY_MARKETPLACE), skip: () => retainMarket });
      else pending = true;
    }
  }
  for (const { app, args, options, done, fallback, skip } of removals) {
    if (skip?.()) continue;
    try { execute(app, args, options); log(done); } catch (error) {
      if (!fallback) throw error;
      fallback(error);
    }
  }
  if (claude) migrateClaudeSettings({ homeDir, env, log, keepLegacyRules: keepLegacyRules || !retired.size, retired });
  if (pending) { onPending(); log('Legacy cleanup is incomplete. Unverified registrations or other scopes were preserved; review them in the owning application.'); }
  // No legacy release marked its directories. Removing registrations does not prove ownership of source or backups.

}

function codexMarketplacePlan(filename, content = readRawIfPresent(filename)) {
  const marketplace = (content === null ? null : JSON.parse(content.replace(/^\uFEFF/, ''))) ?? {
    name: 'personal', interface: { displayName: 'Personal' }, plugins: [],
  };
  if (!object(marketplace) || typeof marketplace.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(marketplace.name) || !Array.isArray(marketplace.plugins)) {
    throw new Error('The existing personal marketplace must have a valid name and plugins array.');
  }
  const matches = marketplace.plugins.filter(entry => entry?.name === PLUGIN_NAME);
  if (matches.length > 1) throw new Error('The personal marketplace contains duplicate entries for this plugin.');
  const source = { source: 'local', path: `./plugins/${PLUGIN_NAME}` };
  if (matches.length) {
    if (matches[0].source?.source !== source.source || matches[0].source?.path !== source.path) {
      throw new Error('The personal marketplace already has this plugin name with a different source. Resolve the conflict before installing.');
    }
    // Preserve existing policy choices, metadata, order, and unrelated entries.
    matches[0].policy = { installation: 'AVAILABLE', authentication: 'ON_INSTALL', ...(matches[0].policy ?? {}) };
    matches[0].category ??= 'Productivity';
  } else {
    marketplace.plugins.push({ name: PLUGIN_NAME, source,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' });
  }
  return marketplace;
}

function checkedSource(root, relative) {
  const filename = path.join(root, relative);
  if (!contained(root, filename) || !contained(root, fs.realpathSync(filename)) || !fs.lstatSync(filename).isFile()) {
    throw new Error(`Runtime file must be a regular file inside the source tree: ${relative}`);
  }
  return filename;
}

/** Prepare local files only. This function never runs an application command. */
export function prepareInstallation({ sourceRoot = projectRoot, homeDir = os.homedir(), env = process.env, codex = true, claude = true, log = console.log } = {}) {
  checkEnvironment(env);
  if (!codex && !claude) throw new Error('Select Claude, Codex, or both.');
  const root = fs.realpathSync(sourceRoot);
  const bundle = checkManifests(root, { checkNative: false, allowConfiguredSource: true });
  const sshAlias = env.CLAUDE_CODEX_BRIDGE_SSH_HOST === undefined ? undefined
    : validateSshHostAlias(env.CLAUDE_CODEX_BRIDGE_SSH_HOST);
  const pluginsDir = path.resolve(homeDir, 'plugins');
  const destination = path.join(pluginsDir, PLUGIN_NAME);
  const supplied = bundle.mcp.mcpServers[PLUGIN_NAME].env;
  // Installer output carries the previous profile's pins. Do not transplant them into a second profile.
  const sourceConfig = bundle.native && supplied?.CLAUDE_CODEX_BRIDGE_INSTALL_ROOT ? {} : supplied ?? {};
  const stateDir = path.resolve(defaultStateDir({ homeDir, env: { ...sourceConfig, ...env }, log }));
  const marketplacePath = path.resolve(homeDir, '.agents', 'plugins', 'marketplace.json');
  let marketplace = codex ? codexMarketplacePlan(marketplacePath) : null;
  const publisherName = bundle.manifest.author?.name;
  if (typeof publisherName !== 'string' || !publisherName.trim()) {
    throw new Error('The Claude plugin manifest must declare the actual publisher name before installation.');
  }
  const portableMcp = structuredClone(bundle.mcp);
  const portableServer = portableMcp.mcpServers[PLUGIN_NAME];
  // Preserve the shared home-profile state despite application-specific MSIX
  // environments. Regenerate both native adapters from this pinned source.
  portableServer.env = { ...sourceConfig, CLAUDE_CODEX_BRIDGE_STATE_DIR: stateDir };
  if (sshAlias !== undefined) portableServer.env.CLAUDE_CODEX_BRIDGE_SSH_HOST = sshAlias;
  portableServer.env.CLAUDE_CODEX_BRIDGE_INSTALL_ROOT = destination;
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODEX_BRIDGE_REGISTRY_DIR', 'CLAUDE_CODEX_BRIDGE_CODEX_BIN']) {
    if (env[key]) portableServer.env[key] = path.resolve(env[key]);
  }
  if (env.CLAUDE_CODEX_BRIDGE_DAEMON === 'off') portableServer.env.CLAUDE_CODEX_BRIDGE_DAEMON = 'off';
  const generated = new Set(['package.json', ...Object.keys(bundle.files)]);
  const sources = COMMON_RUNTIME_FILES.filter(relative => !generated.has(relative)).map(relative => ({ relative, filename: checkedSource(root, relative) }));
  refuseLink(pluginsDir);
  refuseLink(destination);
  fs.mkdirSync(pluginsDir, { recursive: true });
  if (!contained(pluginsDir, destination) || samePath(destination, root) || (fs.existsSync(destination) && contained(fs.realpathSync(destination), root))) {
    throw new Error('The staging destination must be separate from the source repository.');
  }
  if (fs.existsSync(destination)) {
    if (!stageKind(destination)) throw new Error('The staging destination belongs to another directory or is not a verified installer stage. Preserve it elsewhere before installing.');
  }
  const build = timestamp();
  const temporary = path.join(pluginsDir, `.${PLUGIN_NAME}.stage-${build}-${randomUUID()}`);
  let backupDirectory = null, unchangedStage;
  try {
    fs.mkdirSync(temporary, { mode: 0o700 });
    restrictDirectory(temporary);
    fs.writeFileSync(path.join(temporary, stageMarker), markerText, { flag: 'wx', mode: 0o600 });
    for (const { relative, filename } of sources) {
      const target = path.join(temporary, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(filename, target, fs.constants.COPYFILE_EXCL);
    }
    const manifest = { ...bundle.manifest, version: `${bundle.manifest.version.split('+')[0]}+codex.${build}` };
    const stagedFiles = {
      'config/plugin-source.json': manifest,
      'config/mcp-source.json': portableMcp,
      ...compatibilityFiles(manifest, portableMcp),
      'package.json': { ...runtimePackageJson(bundle.packageJson), version: manifest.version },
    };
    for (const [relative, content] of Object.entries(stagedFiles)) {
      const target = path.join(temporary, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, jsonText(content));
    }
    fs.writeFileSync(path.join(temporary, '.claude-plugin', 'marketplace.json'), jsonText({
      name: CLAUDE_MARKETPLACE,
      owner: { name: publisherName },
      plugins: [{ name: PLUGIN_NAME, source: './', description: 'Asynchronous two-way messaging between Claude Code and Codex conversations.' }],
    }));
    unchangedStage = stageComparator(temporary, manifest.version);
    if (fs.existsSync(destination)) {
      if (!stageKind(destination)) throw new Error('The staging destination changed before replacement.');
      backupDirectory = path.join(pluginsDir, `.${PLUGIN_NAME}.backup-${build}-${randomUUID()}`);
      // Both move targets are resolved, fixed children of this installer-owned plugins directory.
      if (!contained(pluginsDir, backupDirectory)) throw new Error('Invalid staging backup path.');
      renameDirectoryWithRetry(destination, backupDirectory);
    }
    try { renameDirectoryWithRetry(temporary, destination); } catch (error) {
      if (backupDirectory && !fs.existsSync(destination)) renameDirectoryWithRetry(backupDirectory, destination);
      throw error;
    }
  } finally {
    if (fs.existsSync(temporary)) {
      const resolved = fs.realpathSync(temporary);
      if (!contained(fs.realpathSync(pluginsDir), resolved) || path.basename(temporary).indexOf(`.${PLUGIN_NAME}.stage-`) !== 0) {
        throw new Error('Refusing cleanup outside the staging directory.');
      }
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  let marketplaceBackup = null, priorCatalog = null;
  const undoStage = () => {
    if (!unchangedStage(destination) || readJson(path.join(destination, 'package.json')).version !== `${bundle.manifest.version.split('+')[0]}+codex.${build}`) throw new Error('The installed stage changed; it was not overwritten during rollback.');
    renameDirectoryWithRetry(destination, temporary);
    try { if (backupDirectory) renameDirectoryWithRetry(backupDirectory, destination); } catch (e) { renameDirectoryWithRetry(temporary, destination); throw e; }
    fs.rmSync(temporary, { recursive: true });
  };
  try { if (codex) {
    const lockDirectory = path.join(path.dirname(marketplacePath), `.${PLUGIN_NAME}-marketplace-lock`);
    withStateLock(lockDirectory, () => {
      // Staging may take time: merge into the latest catalog under a short lock.
      // The final comparison also detects changes from non-cooperating writers
      // before the replacement, rather than reusing the pre-staging snapshot.
      const expectedPrevious = readRawIfPresent(marketplacePath);
      priorCatalog = expectedPrevious;
      marketplace = codexMarketplacePlan(marketplacePath, expectedPrevious);
      marketplaceBackup = writeJsonAtomic(marketplacePath, marketplace, { expectedPrevious });
    });
  } } catch (error) { undoStage(); throw error; }
  const undo = () => {
    undoStage();
    if (!codex || priorCatalog === jsonText(marketplace)) return;
    withStateLock(path.join(path.dirname(marketplacePath), `.${PLUGIN_NAME}-marketplace-lock`), () => {
      const current = readRawIfPresent(marketplacePath);
      if (current === jsonText(marketplace)) {
        if (priorCatalog === null) fs.unlinkSync(marketplacePath);
        else writeTextAtomic(marketplacePath, priorCatalog, { expectedPrevious: current, saveBackup: false });
      } else if (current !== null) {
        const catalog = JSON.parse(current.replace(/^\uFEFF/, ''));
        const rows = catalog.plugins.filter(entry => entry?.name === PLUGIN_NAME);
        const before = priorCatalog && JSON.parse(priorCatalog.replace(/^\uFEFF/, '')).plugins.find(entry => entry?.name === PLUGIN_NAME);
        if (!rows.length && !before) return;
        if (rows.length !== 1 || !isDeepStrictEqual(rows[0], marketplace.plugins.find(entry => entry?.name === PLUGIN_NAME))) throw new Error('The bridge marketplace entry changed externally and was preserved.');
        catalog.plugins = catalog.plugins.flatMap(entry => entry !== rows[0] ? [entry] : before ? [before] : []);
        writeJsonAtomic(marketplacePath, catalog, { expectedPrevious: current, saveBackup: false });
      }
    });
  };
  return { destination, stateDir, marketplacePath: marketplace ? marketplacePath : null,
    marketplaceName: marketplace?.name ?? null, undo,
    build, backupDirectory, marketplaceBackup, codex, claude, unchangedStage };
}

function run(command, args, { cwd, env = process.env } = {}) {
  const executable = process.platform !== 'win32' ? command : command === 'codex' ? resolveCodexExecutable({ env }) : `${command}.exe`;
  if (!executable) throw new Error('Cannot find the native Codex executable. Install Codex or set CLAUDE_CODEX_BRIDGE_CODEX_BIN.');
  const result = spawnSync(executable, args, {
    cwd, env, shell: false, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 6000);
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed (${result.status ?? result.signal}).${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function readList(output, key) {
  const parsed = JSON.parse(output);
  const list = Array.isArray(parsed) ? parsed : parsed?.[key];
  if (!Array.isArray(list)) throw new Error(`The application CLI returned an unsupported ${key} listing.`);
  return list;
}

function registeredPath(entry) {
  const source = entry?.source;
  if (object(source) && !['directory', 'local', undefined].includes(source.source)) return null;
  const candidates = [source?.path, typeof source === 'string' ? source : null,
    entry?.path, entry?.installLocation, entry?.location];
  return candidates.find(value => typeof value === 'string' && path.isAbsolute(value)) ?? null;
}

function samePath(left, right) {
  try {
    const a = fs.statSync(left, { bigint: true }), b = fs.statSync(right, { bigint: true });
    if (a.ino && b.ino) return a.dev === b.dev && a.ino === b.ino;
    return fs.realpathSync.native(left) === fs.realpathSync.native(right);
  } catch { return path.resolve(left) === path.resolve(right); }
}

export function installApplications(prepared, { execute = run, homeDir = os.homedir(), env = process.env,
  log = console.log, grantPermission = grantClaudeSendPermission, undoNew = [], restorePrior = [] } = {}) {
  if (prepared.codex) {
    const selector = `${PLUGIN_NAME}@${prepared.marketplaceName}`;
    const installed = codexConfigTables({ homeDir, env }).plugins.includes(selector);
    const add = () => execute('codex', ['plugin', 'add', selector, '--json']);
    if (installed) restorePrior.push(add);
    try { add(); } catch (e) {
      if (!installed && codexConfigTables({ homeDir, env }).plugins.includes(selector)) undoNew.push(() => execute('codex', ['plugin', 'remove', selector, '--json']));
      throw e;
    }
    if (!installed) undoNew.push(() => execute('codex', ['plugin', 'remove', selector, '--json']));
    log('Codex plugin installed or updated.');
  }
  if (prepared.claude) {
    const marketplaces = readList(execute('claude', ['plugin', 'marketplace', 'list', '--json']), 'marketplaces');
    const registered = marketplaces.filter(entry => entry.name === CLAUDE_MARKETPLACE);
    if (registered.length > 1) throw new Error('Claude reports duplicate local bridge marketplaces.');
    if (registered.length) {
      let location = registeredPath(registered[0]);
      if (!location) {
        const registry = optionalJson(path.join(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'), 'plugins', 'known_marketplaces.json'));
        location = registeredPath(registry?.[CLAUDE_MARKETPLACE]);
      }
      if (!location || !samePath(location, prepared.destination)) {
        throw new Error('Claude already has this marketplace name with a different or unverifiable source. Resolve the conflict before installing.');
      }
    } else {
      const remove = () => execute('claude', ['plugin', 'marketplace', 'remove', CLAUDE_MARKETPLACE, '--json']);
      try { execute('claude', ['plugin', 'marketplace', 'add', prepared.destination, '--scope', 'user']); }
      catch (error) {
        undoNew.push(() => {
          const found = readList(execute('claude', ['plugin', 'marketplace', 'list', '--json']), 'marketplaces').filter(row => row.name === CLAUDE_MARKETPLACE);
          if (!found.length) return;
          const location = found.length === 1 && registeredPath(found[0]);
          if (!location || !samePath(location, prepared.destination)) throw new Error('Marketplace ownership is uncertain.');
          remove();
        });
        throw error;
      }
      undoNew.push(remove);
    }
    const selector = `${PLUGIN_NAME}@${CLAUDE_MARKETPLACE}`;
    const plugins = readList(execute('claude', ['plugin', 'list', '--json']), 'plugins');
    const matches = entry => (entry.id === selector || entry.name === selector ||
      (entry.name === PLUGIN_NAME && entry.marketplace === CLAUDE_MARKETPLACE)) &&
      (entry.scope === undefined || entry.scope === 'user');
    const installed = plugins.some(matches);
    const apply = () => execute('claude', ['plugin', installed ? 'update' : 'install', selector, '--scope', 'user', '--json']);
    if (installed) restorePrior.push(apply);
    const remove = () => execute('claude', ['plugin', 'uninstall', selector, '--scope', 'user', '--json']);
    try { apply(); } catch (error) {
      if (!installed) undoNew.push(() => { if (readList(execute('claude', ['plugin', 'list', '--json']), 'plugins').some(matches)) remove(); });
      throw error;
    }
    if (!installed) undoNew.push(remove);
    log(`Claude plugin ${installed ? 'updated' : 'installed'}.`);
    const granted = grantPermission({ homeDir, env });
    log(granted.added ? `Allowed Claude outbound bridge tool: ${granted.rule}` : `Claude outbound bridge tool was already allowed: ${granted.rule}`);
    if (granted.backup) log(`Previous Claude settings backup: ${granted.backup}`);
  }
}

export async function main(args = process.argv.slice(2), { homeDir = os.homedir(), env = process.env,
  execute = (app, argv, options) => run(app, argv, { ...options, env }), log = console.log } = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    log('Usage: node scripts/install.mjs [--all | --claude | --codex] [--prepare-only]\nDefault: install for both apps. A normal Claude installation grants only its send_to_codex MCP tool in user permissions.allow. --prepare-only stages files and local catalogs without invoking either app CLI or changing tool permissions.');
    return;
  }
  for (const arg of args) if (!['--all', '--codex', '--claude', '--prepare-only'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
  const selected = args.filter(arg => ['--all', '--codex', '--claude'].includes(arg));
  if (selected.length > 1) throw new Error('Choose exactly one of --all, --claude, or --codex.');
  checkEnvironment(env);
  const target = selected[0] ?? '--all';
  const selection = { codex: target !== '--claude', claude: target !== '--codex' };
  const pluginsDir = path.resolve(homeDir, 'plugins'); refuseLink(pluginsDir);
  const prepared = withStateLock(path.join(pluginsDir, `.${PLUGIN_NAME}-install-lock`),
    () => installSelected(args, { homeDir, env, execute, log, selection }));
  if (!args.includes('--prepare-only') && env.CODEX_APP_TOOLS_PIPE_PATH && env.CODEX_THREAD_ID && !env.CLAUDE_CODE_MESSAGING_SOCKET) {
    try {
      const { publishCodexHost } = await import('../lib/codex-host.mjs');
      await publishCodexHost({ stateDir: prepared.stateDir,
      pipePath: env.CODEX_APP_TOOLS_PIPE_PATH, threadId: env.CODEX_THREAD_ID });
      log('Registered this Codex Desktop host for local conversation discovery.');
    } catch { log('Bridge installed; Desktop registration was not refreshed. Run bridge_doctor in the intended Codex Desktop chat.'); }
  }
  return prepared;
}

function finishCleanup(prepared, homeDir, log) {
  try { pruneInstallationBackups(prepared, homeDir); } catch { prepared.cleanupPending = true; log('Bridge installed; an older installer backup could not be pruned. Leave it until the file is no longer in use.'); }
}

function installSelected(args, { homeDir, env, execute, log, selection }) {
  // Refuse an invalid source or route before removing a working legacy install.
  checkManifests(projectRoot, { checkNative: false, allowConfiguredSource: true });
  if (env.CLAUDE_CODEX_BRIDGE_SSH_HOST !== undefined) validateSshHostAlias(env.CLAUDE_CODEX_BRIDGE_SSH_HOST);
  if (!args.includes('--prepare-only')) {
    for (const app of ['claude', 'codex']) if (selection[app]) execute(app, ['--version']);
    if (selection.claude) grantClaudeSendPermission({ homeDir, env, preview: true });
  }
  const prepared = prepareInstallation({ homeDir, env, log, ...selection });
  log(`Prepared ${PLUGIN_NAME} in ${prepared.destination}`);
  if (prepared.backupDirectory) log(`Previous staged files: ${prepared.backupDirectory}`);
  if (prepared.marketplaceBackup) log(`Personal marketplace backup: ${prepared.marketplaceBackup}`);
  if (args.includes('--prepare-only')) {
    finishCleanup(prepared, homeDir, log);
    log('Preparation complete. No application plugin commands were run.');
    return prepared;
  }
  const undoNew = [], restorePrior = [];
  try { installApplications(prepared, { homeDir, env, execute, log, undoNew, restorePrior }); }
  catch (error) {
    const failures = [];
    for (const undo of [...undoNew.reverse(), prepared.undo, ...restorePrior]) {
      try { undo(); } catch (e) { failures.push(e); }
    }
    if (failures.length) throw new Error(`${error.message} Rollback could not finish. Inspect ${prepared.destination}${prepared.backupDirectory ? ` and its preserved predecessor ${prepared.backupDirectory}` : ''} and the selected registrations before retrying.`);
    throw error;
  }
  // Cut over only after the replacement works. A cleanup failure is not a failed installation.
  try {
    migrateLegacyInstallation({ homeDir, env, execute, log, ...selection, onPending: () => { prepared.cleanupPending = true; } });
    if (prepared.codex) withStateLock(path.join(path.dirname(prepared.marketplacePath), `.${PLUGIN_NAME}-marketplace-lock`), () => {
      const previous = readRawIfPresent(prepared.marketplacePath), catalog = JSON.parse(previous.replace(/^\uFEFF/, ''));
      const rows = catalog.plugins.filter(entry => entry?.name === LEGACY_PLUGIN);
      if (!rows.length) return;
      if (rows.length !== 1 || !releasedPersonalRow(rows[0]) || !legacyLocalStage(homeDir) || codexConfigTables({ homeDir, env }).plugins.includes(`${LEGACY_PLUGIN}@${catalog.name}`)) {
        prepared.cleanupPending = true; log('The old personal catalog entry was preserved. Review it in Codex before removing it.'); return;
      }
      const keep = catalog.plugins.filter(entry => entry !== rows[0]);
      if (keep.length === catalog.plugins.length) return;
      catalog.plugins = keep;
      const backup = writeJsonAtomic(prepared.marketplacePath, catalog, { expectedPrevious: previous, saveBackup: !prepared.marketplaceBackup });
      prepared.marketplaceBackup ??= backup;
      log(`Removed old bridge entry from ${prepared.marketplacePath}`);
    });
  } catch (error) { prepared.cleanupPending = true; log(`Bridge installed; legacy cleanup is incomplete. ${error.message}`); }
  if (prepared.claude) log('In Claude CLI, run /reload-plugins and check /mcp. If it warns that the conversation would be re-read, the reload is held: run /reload-plugins --force. In Claude Desktop, fully quit and reopen the app when convenient so its MCP process loads this version.');
  if (prepared.codex) log('Fully quit Codex Desktop, not only its window, and reopen it: until then new tasks still start the old version. Restart terminal Codex sessions when convenient to load updated tools.');
  log(`Apps were not restarted.${prepared.claude ? ' Only the exact Claude send_to_codex tool received a user-level allow rule.' : ' Claude tool permissions were not changed.'}`);
  finishCleanup(prepared, homeDir, log);
  return prepared;
}

// Node resolves the entry module through links (macOS /tmp is /private/tmp), so compare real paths.
if (isMainModule(import.meta.url)) {
  try { await main(); } catch (error) {
    console.error(`Installation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
