import assert from 'node:assert/strict';
import { getSession, readSession } from '../lib/store.mjs';

export function storedDelivery(stateDir, delivery) {
  const threadId = delivery.from.app === 'claude' ? `claude:${delivery.from.id}` : delivery.from.id;
  const session = getSession({ stateDir, threadId });
  const record = Object.values(readSession(session).messages).find(record => record.id === delivery.message_id &&
    record.route.to.id === delivery.to.id && record.route.to.host_id === delivery.to.host_id);
  assert.ok(record, 'The public delivery must have an unchanged durable record');
  return record;
}
