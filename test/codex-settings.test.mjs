import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import * as settings from '../lib/codex-settings.mjs';

test('the Codex home follows CODEX_HOME and the bridge reads no composer setting from config.toml (K03)', () => {
  assert.equal(settings.codexHome({ homeDir: path.resolve('home'), env: {} }), path.resolve('home', '.codex'));
  assert.equal(settings.codexHome({ homeDir: path.resolve('home'), env: { CODEX_HOME: path.resolve('custom') } }), path.resolve('custom'));
  assert.deepEqual(Object.keys(settings), ['codexHome']);
});
