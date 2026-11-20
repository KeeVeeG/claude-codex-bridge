// Windows release-only gate. In a disposable profile, a real 1.0.6 installation of both clients is upgraded with
// the packaged native ZIP's installer. A fresh server started as each client starts it, from the folder that
// client loads, must report the packaged version and serve the packaged panel: registration and cache names
// alone do not show which server and panel a host runs.
// Usage: node test/packaged-upgrade.mjs <claude-codex-bridge-X.Y.Z.zip> <v1.0.6 git archive export>
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseToml } from '../scripts/install.mjs';

const PLUGIN = 'bridge-claude-codex', PLACEHOLDER = '__BRIDGE_CALL_WAIT_MS__';
const [zipArgument, exportArgument] = process.argv.slice(2);
if (process.platform !== 'win32' || !zipArgument || !exportArgument) throw new Error('Run on Windows with the packaged native ZIP and the path to a disposable v1.0.6 git archive export.');
const released = fs.realpathSync(exportArgument), archive = fs.readFileSync(zipArgument);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
assert.equal(readJson(path.join(released, 'package.json')).version, '1.0.6');

// Release archives hold stored entries followed by the central directory.
function unzipStored(buffer, target) {
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0, 'release ZIP entries use stored data');
    const size = buffer.readUInt32LE(offset + 18), nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), file = path.resolve(target, name);
    assert.ok(!path.isAbsolute(name) && file.startsWith(target + path.sep), `unsafe ZIP entry ${name}`);
    const start = offset + 30 + nameLength + extraLength;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer.subarray(start, start + size), { flag: 'wx' });
    offset = start + size;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'local entries must be followed by a central directory');
}

// One MCP session as a host opens it after a restart: initialize, then list and read the panel resource.
function startServer(server, root, env) {
  const expand = value => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', root).replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name, fallback = '') => env[name] ?? fallback);
  const childEnv = { ...Object.fromEntries((server.env_vars ?? []).filter(name => env[name] !== undefined).map(name => [name, env[name]])),
    ...Object.fromEntries(Object.entries(server.env ?? {}).map(([name, value]) => [name, expand(value)])) };
  for (const name of ['SystemRoot', 'PATH', 'PATHEXT']) childEnv[name] ??= env[name];
  const child = spawn(server.command, server.args.map(expand), { cwd: path.resolve(root, server.cwd ?? '.'), env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  return new Promise((resolve, reject) => {
    const replies = new Map(); let buffer = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`The MCP server in ${root} did not answer: ${stderr}`)); }, 30_000);
    const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.setEncoding('utf8').on('data', chunk => {
      buffer += chunk;
      for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line); replies.set(message.id, message);
        if (message.id === 1) { send({ method: 'notifications/initialized', params: {} }); send({ id: 2, method: 'resources/list', params: {} }); }
        else if (message.id === 2) send({ id: 3, method: 'resources/read', params: { uri: message.result?.resources?.[0]?.uri } });
        else if (message.id === 3) child.stdin.end();
      }
    });
    child.once('close', () => { clearTimeout(timer); replies.size === 3 ? resolve(replies) : reject(new Error(`The MCP server in ${root} stopped early: ${stderr}`)); });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'packaged-upgrade-check', version: '1.0.0' } } });
  });
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-packaged-upgrade-'));
try {
  const env = { CLAUDE_CODEX_BRIDGE_DAEMON: 'off', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'COMPUTERNAME', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS']) if (process.env[key]) env[key] = process.env[key];
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_DATA_HOME']) {
    env[key] = ['HOME', 'USERPROFILE'].includes(key) ? home : path.join(home, key.toLowerCase()); fs.mkdirSync(env[key], { recursive: true });
  }
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH}`;
  const run = (command, args, label) => {
    const result = spawnSync(command, args, { env, cwd: home, windowsHide: true, encoding: 'utf8', timeout: 600_000 });
    if (result.error || result.status !== 0) throw new Error(`${label} failed: ${result.error?.message ?? ''}${result.stderr}${result.stdout}`);
    return result.stdout;
  };
  const packaged = path.join(home, 'package');
  unzipStored(archive, packaged);
  const version = readJson(path.join(packaged, 'package.json')).version, stage = path.join(home, 'plugins', PLUGIN);
  run(process.execPath, [path.join(released, 'scripts', 'install.mjs')], 'The 1.0.6 installer');
  const before = readJson(path.join(stage, 'package.json')).version;
  assert.match(before, /^1\.0\.6\+codex\./);
  run(process.execPath, [path.join(packaged, 'scripts', 'install.mjs')], 'The packaged installer');
  const after = readJson(path.join(stage, 'package.json')).version;
  assert.ok(after.startsWith(`${version}+codex.`) && after !== before, `the stage holds ${after}`);

  // What each client starts: Claude loads a local-path marketplace plugin in place (readFromFolder, folderVersion),
  // otherwise its cached copy, and lists the server it resolved; Codex loads its single cached copy. Both must be on.
  const own = JSON.parse(run('claude.exe', ['plugin', 'list', '--json'], 'claude plugin list')).filter(entry => (entry.id ?? entry.name) === `${PLUGIN}@claude-codex-local`);
  assert.equal(own.length, 1, 'Claude lists one installer registration');
  assert.equal(own[0].enabled, true, 'Claude has the bridge turned on');
  const inPlace = typeof own[0].readFromFolder === 'string', claudeRoot = inPlace ? own[0].readFromFolder : own[0].installPath;
  assert.equal(inPlace ? own[0].folderVersion : own[0].version, after, 'Claude loads the upgraded version');
  assert.ok(own[0].mcpServers?.[PLUGIN], 'Claude lists the server it resolved');
  const market = readJson(path.join(home, '.agents', 'plugins', 'marketplace.json')).name;
  assert.equal(parseToml(fs.readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8')).plugins?.[`${PLUGIN}@${market}`]?.enabled, true, 'Codex has the bridge turned on');
  const codexCache = path.join(env.CODEX_HOME, 'plugins', 'cache', market, PLUGIN), codexRoot = path.join(codexCache, after);
  assert.deepEqual(fs.readdirSync(codexCache), [after], 'Codex keeps one copy of the upgraded version');

  const panel = fs.readFileSync(path.join(packaged, 'ui', 'bridge.html'), 'utf8');
  // The server fills its call deadline into the shipped panel; everything else must be the packaged bytes.
  const servesPackagedPanel = text => {
    let at = 0;
    for (const [n, part] of panel.split(PLACEHOLDER).entries()) {
      const digits = n ? /^\d+/.exec(text.slice(at))?.[0] : '';
      if (digits === undefined || !text.startsWith(part, at += digits.length)) return false;
      at += part.length;
    }
    return at === text.length;
  };
  assert.equal(servesPackagedPanel(fs.readFileSync(path.join(released, 'ui', 'bridge.html'), 'utf8')), false, 'the 1.0.6 panel differs from the packaged one');
  for (const [client, root, server] of [['Claude', claudeRoot, own[0].mcpServers[PLUGIN]],
    ['Codex', codexRoot, readJson(path.join(codexRoot, '.codex-plugin', 'plugin.json')).mcpServers[PLUGIN]]]) {
    const replies = await startServer(server, root, env);
    for (const reply of replies.values()) assert.equal(reply.error, undefined, `${client}: ${JSON.stringify(reply.error)}`);
    assert.equal(replies.get(1).result.serverInfo.version, after, `${client} starts the packaged server`);
    const [content] = replies.get(3).result.contents;
    assert.ok(servesPackagedPanel(content.text), `${client} serves the packaged panel`);
    console.log(`${client}: ${root}${client === 'Claude' ? (inPlace ? ' (in place)' : ' (cached copy)') : ''} starts ${after} and serves the packaged ${content.uri}`);
  }
  console.log(`Packaged upgrade from ${before} to ${after} passed.`);
} finally { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); }
