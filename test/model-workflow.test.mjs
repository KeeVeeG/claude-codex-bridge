import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, recordMessage, finishMessage, updateSession } from '../lib/store.mjs';
import { executeBridgeTool } from '../lib/bridge-service.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = 'task-a', session = createSession({ stateDir: root, threadId: owner, cwd: root });
  const context = { env: {}, stateDir: root, registryDir: path.join(root, 'empty-registry'), metadata: { 'openai/threadId': owner } };
  const put = (id, target, from = owner, message = target) => {
    const route = { from: { kind: 'codex', id: from }, to: { kind: 'claude', id: target } };
    recordMessage(session, { id, route, direction: 'to_claude', message });
    finishMessage(session, id, { status: 'submitted', route });
  };
  return { owner, session, context, put };
}
for (const large of [false, true]) test(`exact outgoing ID is scoped to the verified sender and matched before limit (${large ? 'worker' : 'inline'})`, async t => {
  const { session, context, put } = fixture(t);
  put('shared', 'first'); put('shared', 'second'); put('shared', 'private', 'other-owner'); put('different', 'latest');
  if (large) updateSession(session, state => { state.padding = 'x'.repeat(530000); });
  const lookup = args => executeBridgeTool('list_deliveries', args, context);
  assert.deepEqual((await lookup({ message_id: 'shared' })).deliveries.map(d => [d.to.id, d.message]), [['second','second'],['first','first']]);
  assert.deepEqual((await lookup({ message_id: 'shared', limit: 1 })).deliveries.map(d => d.to.id), ['second']);
  assert.deepEqual((await lookup({ limit: 1 })).deliveries.map(d => d.to.id), ['latest']);
  assert.deepEqual((await lookup({ message_id: 'absent' })).deliveries, []);
  const sibling = await executeBridgeTool('list_deliveries', { message_id: 'shared' }, { ...context, metadata: { 'openai/threadId': 'other-owner' } });
  assert.deepEqual(sibling.deliveries, []);
});

test('compact replay drops only the current sender echo; default, explicit true and ledger retain it', async t => {
  const { context, put } = fixture(t); const args = { session_id: 'recipient', message_id: 'checked', message: 'Exact body' };
  put(args.message_id, args.session_id, undefined, args.message);
  const send = extra => executeBridgeTool('send_to_claude', { ...args, ...extra }, context);
  const normal = await send({}), explicit = await send({ include_message: true }), compact = await send({ include_message: false });
  assert.deepEqual(explicit, normal); assert.equal(normal.delivery.message, args.message);
  assert.deepEqual(normal.outcome.record, { message_id: 'checked', status: 'submitted' });
  const expected = structuredClone(normal); delete expected.delivery.message;
  assert.deepEqual(compact, expected); assert.equal(compact.outcome.retry, 'no');
  const ledger = await executeBridgeTool('list_deliveries', { message_id: 'checked' }, context);
  assert.equal(ledger.deliveries[0].message, args.message);
});
