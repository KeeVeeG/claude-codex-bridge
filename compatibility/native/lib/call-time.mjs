// Time policy for one bridge tool call (D02): a single deadline on the monotonic clock,
// one retry helper for read-only inquiries, and a gate that every transport write passes.
import { performance } from 'node:perf_hooks';

/** One deadline per tool call, measured from MCP receipt, queue time included. Codex's default tool
 * timeout is 60 s and its clock starts before ours; the margin keeps every write and its reply inside it. */
export const CALL_DEADLINE_MS = 55_000;
/** No new transport write starts with less time left than this, so its reply can still arrive in time. */
export const WRITE_RESERVE_MS = 5_000;
/** Read-only inquiries (identity probes, route probes): up to 3 attempts of 15 s, within the deadline. */
export const INQUIRY_ATTEMPTS = 3;
export const INQUIRY_ATTEMPT_MS = 15_000;

const now = () => performance.now();
// Deadline (monotonic ms) of each call signal and of the attempt signals derived from it.
const deadlines = new WeakMap();

export class CallDeadlineError extends Error {
  constructor() {
    super(`The bridge call reached its ${CALL_DEADLINE_MS / 1000} s time limit.`);
    this.name = 'TimeoutError';
    this.code = 'BRIDGE_DEADLINE';
    this.reason = 'deadline';
  }
}

/** One attempt of an inquiry ran out of its own time; another attempt may still succeed. */
class AttemptTimeoutError extends Error {
  constructor() {
    super('The check did not finish in time.');
    this.name = 'TimeoutError';
    this.code = 'ATTEMPT_TIMEOUT';
    this.transient = true;
  }
}

export function cancelledError(message = 'Bridge request was cancelled.') {
  return Object.assign(new Error(message), { name: 'AbortError', code: 'ABORT_ERR' });
}

export const isCancelledError = error => error?.code === 'ABORT_ERR' || error?.name === 'AbortError';

// Some transport checks deliberately recognize only a raw abort, not a call deadline or its reason.
export function throwIfAborted(signal, message) {
  if (signal?.aborted) throw cancelledError(message);
}

/** The error that explains why a signal stopped: the call deadline, an attempt timeout, or cancellation. */
export function stopError(signal) {
  const reason = signal?.reason;
  if (reason?.code === 'BRIDGE_OUTPUT_BUSY') return reason;
  if (reason?.code === 'BRIDGE_DEADLINE') return new CallDeadlineError();
  if (reason?.code === 'ATTEMPT_TIMEOUT') return new AttemptTimeoutError();
  return cancelledError();
}

export function deadlineOf(signal) {
  return signal ? deadlines.get(signal) : undefined;
}

/** Milliseconds left before the call deadline; Infinity for a signal without one. */
export function remainingMs(signal) {
  const deadline = deadlineOf(signal);
  return deadline === undefined ? Infinity : deadline - now();
}

/** Throw when the call was cancelled or its deadline passed, even if the deadline timer has not run yet. */
export function throwIfStopped(signal) {
  if (signal?.aborted) throw stopError(signal);
  const deadline = deadlineOf(signal);
  if (deadline !== undefined && now() >= deadline) throw new CallDeadlineError();
}

/** Start the clock of one tool call. `cancelSignal` carries the client's cancellation. */
export function startCall({ cancelSignal, deadlineMs = CALL_DEADLINE_MS, startedAt = now() } = {}) {
  const controller = new AbortController();
  const deadline = startedAt + deadlineMs;
  deadlines.set(controller.signal, deadline);
  const timer = setTimeout(() => controller.abort(new CallDeadlineError()), Math.max(0, deadline - now()));
  timer.unref?.();
  const onCancel = () => controller.abort(cancelSignal.reason ?? cancelledError());
  cancelSignal?.addEventListener('abort', onCancel, { once: true });
  if (cancelSignal?.aborted) onCancel();
  return {
    signal: controller.signal,
    deadline,
    cancel(reason) { controller.abort(reason ?? cancelledError()); },
    dispose() { clearTimeout(timer); cancelSignal?.removeEventListener('abort', onCancel); },
  };
}

/** A signal with a deadline unchanged, or a new call clock for callers (library use, tests) that bring none. */
export function ensureCall(signal) {
  if (deadlineOf(signal) !== undefined) return { signal, dispose() {} };
  return startCall({ cancelSignal: signal });
}

/** Called immediately before every transport write: a cancelled call, or one without time left for
 * the write and its reply, never writes. */
export function beforeWrite(signal) {
  throwIfStopped(signal);
  if (remainingMs(signal) < WRITE_RESERVE_MS) {
    throw Object.assign(new CallDeadlineError(), { message: 'The bridge call ran out of time before the message was written.' });
  }
}

function abortPromise(signal) {
  let onAbort;
  const promise = new Promise((_, reject) => {
    onAbort = () => reject(stopError(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, dispose: () => signal.removeEventListener('abort', onAbort) };
}

/**
 * Run a read-only, repeatable step (class (a)) with bounded attempts. Each attempt gets its own
 * signal, aborted at min(attempt limit, call deadline, optional budget); the helper returns at that
 * moment even if the step ignores it. Only a timed-out attempt or an error marked `transient` is
 * retried. When the attempts or the time run out, the last error is thrown with `inconclusive`.
 * Cancellation and the call deadline always win over a step's own result.
 */
export async function inquire(step, { signal, attempts = INQUIRY_ATTEMPTS, attemptMs = INQUIRY_ATTEMPT_MS, until } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    throwIfStopped(signal);
    const cap = Array.isArray(attemptMs) ? attemptMs[Math.min(attempt, attemptMs.length) - 1] : attemptMs;
    const limit = Math.min(cap, remainingMs(signal), until === undefined ? Infinity : until - now());
    if (!(limit >= 1)) {
      // No time left for another attempt: that is the call's deadline unless a smaller budget ran out.
      if (remainingMs(signal) < 1) throw new CallDeadlineError();
      break;
    }
    const controller = new AbortController();
    deadlines.set(controller.signal, Math.min(now() + limit, deadlineOf(signal) ?? Infinity));
    const onParent = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onParent, { once: true });
    if (signal?.aborted) onParent();
    const timer = setTimeout(() => controller.abort(new AttemptTimeoutError()), limit);
    const stopped = abortPromise(controller.signal);
    try {
      return await Promise.race([step({ signal: controller.signal, attempt, timeoutMs: limit }), stopped.promise]);
    } catch (error) {
      throwIfStopped(signal);
      last = controller.signal.reason?.code === 'ATTEMPT_TIMEOUT' ? stopError(controller.signal) : error;
      if (last?.transient !== true) throw last;
    } finally {
      clearTimeout(timer);
      stopped.dispose();
      signal?.removeEventListener('abort', onParent);
    }
  }
  throwIfStopped(signal);
  const error = last ?? new AttemptTimeoutError();
  error.inconclusive = true;
  throw error;
}

export const monotonicNow = now;
