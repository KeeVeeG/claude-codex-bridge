// Windows release-only gate. A skipped, renamed or missing real-writer test is not a pass.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = process.argv[2];
if (process.platform !== 'win32' || !dir) throw new Error('Run on Windows with the path to a disposable v1.0.6 git archive export.');
const root = fs.realpathSync(dir);
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '1.0.6');
const file = fileURLToPath(new URL('./manual.test.mjs', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-released-writer-'));
let result;
try {
  const env = { BRIDGE_TEST_106_ROOT: root, CLAUDE_CODEX_BRIDGE_DAEMON: 'off' };
  for (const key of ['SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT','COMPUTERNAME']) if (process.env[key]) env[key] = process.env[key];
  for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','CLAUDE_CONFIG_DIR','CODEX_HOME','XDG_DATA_HOME']) {
    env[key] = ['HOME','USERPROFILE'].includes(key) ? home : path.join(home, key.toLowerCase()); fs.mkdirSync(env[key], { recursive: true });
  }
  result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^real v1\\.0\\.6 sees', file],
    { env, cwd: home, windowsHide: true, encoding: 'utf8' });
} finally { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 }); }
if (result.error) throw result.error;
process.stdout.write(result.stdout); process.stderr.write(result.stderr);
assert.equal(result.status, 0);
const selected = result.stdout.split(/\r?\n/).filter(line => /^ok \d+ - real v1\.0\.6 sees/.test(line));
assert.equal(selected.length, 1, 'the release must exercise the live 1.0.6 writer');
assert.doesNotMatch(selected[0], /#\s*(?:SKIP|TODO)/i);
assert.match(result.stdout, /^# pass 1$/m);
