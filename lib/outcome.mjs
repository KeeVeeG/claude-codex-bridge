// Machine-readable outcomes (D03). Every send result and every error reply carries
// { delivered, retry, reason } and, when a delivery record exists, { record: { message_id, status } }.
// This module owns the one closed list of reasons; producers tag errors, never the MCP layer by text.
//
// delivered: true = the destination transport took the message; false = this call sent nothing;
//   "unknown" = a write may have happened.
// retry: same_id = the identical call is safe to repeat now; after_fix = fix the stated cause, then
//   repeat the call (same message_id is fine); new_id = this message_id cannot carry the message
//   again, a new one may; inspect = check the receiving conversation and list_deliveries before any
//   further send, and do not reuse this message_id for different text; no = nothing to retry.
import { isCancelledError } from './call-time.mjs';

const entry = (delivered, retry) => Object.freeze({ delivered, retry });

export const REASONS = Object.freeze({
  submitted: entry(true, 'no'),
  already_submitted: entry(true, 'no'),
  // The transport took the message but its record could not be saved.
  settlement_failed: entry(true, 'no'),
  // The first attempt with this message_id is still running.
  in_flight: entry('unknown', 'inspect'),
  // An earlier attempt with this message_id may have arrived.
  prior_uncertain: entry('unknown', 'inspect'),
  // This attempt wrote, but the destination did not confirm it.
  delivery_unconfirmed: entry('unknown', 'inspect'),
  // A record written by an earlier bridge version says failed without saying why.
  prior_failed: entry('unknown', 'inspect'),
  // The message_id already belongs to other text, another recipient or another sending origin.
  id_conflict: entry(false, 'inspect'),
  invalid_argument: entry(false, 'after_fix'),
  wrong_tool: entry(false, 'after_fix'),
  caller_unverified: entry(false, 'same_id'),
  caller_invalid: entry(false, 'after_fix'),
  caller_changed: entry(false, 'after_fix'),
  target_unavailable: entry(false, 'after_fix'),
  target_unverified: entry(false, 'same_id'),
  target_changed: entry(false, 'after_fix'),
  target_busy: entry(false, 'same_id'),
  identity_check_unavailable: entry(false, 'after_fix'),
  route_unavailable: entry(false, 'after_fix'),
  route_unverified: entry(false, 'same_id'),
  protocol_incompatible: entry(false, 'after_fix'),
  request_rejected: entry(false, 'after_fix'),
  deadline: entry(false, 'same_id'),
  cancelled: entry(false, 'same_id'),
  state_busy: entry(false, 'same_id'),
  // The bridge server has too many calls outstanding; nothing of this call ran.
  server_busy: entry(false, 'same_id'),
  state_unavailable: entry(false, 'after_fix'),
  // Doctor findings: a setting, platform or installation step needs attention; versions differ.
  setup_incomplete: entry(false, 'after_fix'),
  version_mismatch: entry(false, 'after_fix'),
  internal_error: entry(false, 'after_fix'),
});

export const RETRIES = Object.freeze(['same_id', 'after_fix', 'new_id', 'inspect', 'no']);

/** JSON Schema of the outcome object, shared by every tool output schema that carries one. */
export const OUTCOME_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['delivered', 'retry', 'reason'],
  properties: {
    delivered: { enum: [true, false, 'unknown'] },
    retry: { enum: RETRIES },
    reason: { enum: Object.keys(REASONS) },
    record: {
      type: 'object', additionalProperties: false, required: ['message_id', 'status'],
      properties: { message_id: { type: 'string' }, status: { enum: ['sending', 'submitted', 'failed', 'uncertain'] } },
    },
  },
});

/** Build an outcome; `retry` and `delivered` override the reason's defaults only where a caller knows more. */
export function outcome(reason, { record, retry, delivered } = {}) {
  const known = REASONS[reason];
  if (!known) throw new Error(`Unknown outcome reason ${reason}`);
  return {
    delivered: delivered ?? known.delivered,
    retry: retry ?? known.retry,
    reason,
    ...(record ? { record: { message_id: record.id ?? record.message_id, status: record.status } } : {}),
  };
}

/** Tag an error with its reason at the place that knows the cause. */
export function tagged(error, reason, extra = {}) {
  if (!REASONS[reason]) throw new Error(`Unknown outcome reason ${reason}`);
  return Object.assign(error, { reason }, extra);
}

export function failure(message, reason, extra) {
  return tagged(new Error(message), reason, extra);
}

/** The reason an error carries, or the one its standard code implies. */
export function reasonOf(error) {
  if (REASONS[error?.reason]) return error.reason;
  if (error?.code === 'BRIDGE_DEADLINE') return 'deadline';
  if (isCancelledError(error)) return 'cancelled';
  return 'internal_error';
}

/** The outcome of an error reply. A send error that may have written is never reported as not delivered. */
export function errorOutcome(error) {
  if (error?.outcome) return error.outcome;
  const record = error?.record;
  if (error?.deliveryUnknown === true) return outcome('delivery_unconfirmed', { record });
  return outcome(reasonOf(error), { record });
}

const NOT_SENT = /\b(?:message not sent|no message was sent|nothing was sent|no new send was made)\b/i;
const INSPECT_ADVICE = /\blist_deliveries\b/;

/** Make a send error's text agree with its outcome: say plainly whether the message went out. */
export function sendErrorText(message, result) {
  const text = String(message ?? '').trim();
  if (result.delivered === false && !NOT_SENT.test(text)) return `Message not sent. ${text}`;
  if (result.delivered === 'unknown' && !INSPECT_ADVICE.test(text)) {
    return `${text} The message may have arrived; check the receiving conversation and list_deliveries before sending again.`;
  }
  return text;
}
