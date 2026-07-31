// Browser-side pending-ack map — used by browser-transport-send to
// resolve the Promise returned by an awaited method call.

import { ACK_TIMEOUT_MS, type AioWindow } from "./protocol-types.ts";

/** Single pending ack: the shared promise, its resolve/reject + a timeout. The
 *  promise resolves with the method's transported RETURN value (undefined for
 *  void methods / older servers) — `await cell.method()` yields it. */
type PendingEntry = {
  promise: Promise<unknown>;
  resolve: (value?: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Ceiling for this call (ms; 0 = wait indefinitely) — kept so a deferred
   *  arm (offline queue → replay) uses the call's own budget. */
  ceilingMs: number;
  methodKey: string | undefined;
};

const _pending = new Map<string, PendingEntry>();

/** Test/dev override for the NO-CONFIG fallback ceiling. Pass `0` to disable
 *  the timer. */
let _ackTimeoutMs = ACK_TIMEOUT_MS;
export function _setAckTimeoutMs(ms: number): void {
  _ackTimeoutMs = ms;
}

/** The server acks a call only after the method has finished, so the browser
 *  wait must OUTLAST the server's own ceiling — the server's honest timeout
 *  error then arrives on the ack frame instead of this timer firing first and
 *  blaming the transport for a method that was simply still running. The
 *  grace covers the ack's trip back. */
const ACK_GRACE_MS = 5_000;
let _ackGraceMs = ACK_GRACE_MS;
/** Test override for the ack grace window. */
export function _setAckGraceMs(ms: number): void {
  _ackGraceMs = ms;
}

/** The ceiling for one call: the server-resolved budget bridged through the
 *  page shell (`perfBudget.methods[key].timeout ?? effectTimeoutMs`, `0` =
 *  wait indefinitely), or the legacy constant when no shell config exists. */
function callCeilingMs(methodKey: string | undefined): number {
  const cfg = (globalThis as AioWindow).__aioConfig?.callTimeouts;
  const resolved =
    (methodKey !== undefined ? cfg?.methods?.[methodKey] : undefined) ??
      cfg?.default;
  if (resolved === undefined) return _ackTimeoutMs;
  return resolved <= 0 ? 0 : resolved + _ackGraceMs;
}

function armTimer(cid: string, entry: PendingEntry): void {
  if (entry.timer !== undefined || entry.ceilingMs <= 0) return;
  entry.timer = setTimeout(() => {
    _pending.delete(cid);
    const what = entry.methodKey ? `'${entry.methodKey}'` : "the method";
    entry.reject(
      new Error(
        `no response for ${what} after ${entry.ceilingMs}ms — the server ` +
          `never confirmed the call: it may still be running (its writes can ` +
          `commit later) or the connection dropped. The server bounds methods ` +
          `via effectTimeoutMs / perfBudget.methods["${
            entry.methodKey ?? "cell:method"
          }"].timeout (0 = wait indefinitely).`,
      ),
    );
  }, entry.ceilingMs);
}

/** Register a pending ack. The returned promise resolves on `_resolveAck`,
 *  rejects on `_rejectAck` (timeout, disconnect, drop), or the timer fires.
 *
 *  `methodKey` ("cell:method") selects the bridged per-method ceiling.
 *  `deferTimer` registers WITHOUT starting the clock — an offline-queued call
 *  must not time out while it waits for a connection; the transport arms it
 *  via `_armAckTimer` when the frame is actually written.
 *
 *  Idempotent per cid: an action passes through several layers that each
 *  register (cell binding, transport send) — re-registering the same cid
 *  MUST return the same shared promise instead of overwriting the pending
 *  entry, otherwise the first caller's promise is orphaned and times out
 *  even though the server acked (AIO-2.2 regression). */
export function _registerAck(
  cid: string,
  opts?: { methodKey?: string; deferTimer?: boolean },
): Promise<unknown> {
  const existing = _pending.get(cid);
  if (existing) return existing.promise;

  let resolve!: (value?: unknown) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const entry: PendingEntry = {
    promise,
    resolve,
    reject,
    timer: undefined,
    ceilingMs: callCeilingMs(opts?.methodKey),
    methodKey: opts?.methodKey,
  };
  _pending.set(cid, entry);
  if (!opts?.deferTimer) armTimer(cid, entry);
  return promise;
}

/** Start the clock for a deferred registration — called when a queued action
 *  is actually sent. No-op if the timer already runs or the ack has settled. */
export function _armAckTimer(cid: string): void {
  const entry = _pending.get(cid);
  if (entry) armTimer(cid, entry);
}

/** Settle a pending ack with the method's transported return value (undefined
 *  for void). Returns true if a pending entry was found. */
export function _resolveAck(cid: string, value?: unknown): boolean {
  const entry = _pending.get(cid);
  if (!entry) return false;
  _pending.delete(cid);
  if (entry.timer) clearTimeout(entry.timer);
  entry.resolve(value);
  return true;
}

/** Reject a single pending ack (e.g. on dispatch error or validation failure). */
export function _rejectAck(cid: string, err: Error): boolean {
  const entry = _pending.get(cid);
  if (!entry) return false;
  _pending.delete(cid);
  if (entry.timer) clearTimeout(entry.timer);
  entry.reject(err);
  return true;
}

/** Reject all pending acks with the given error. Used on WS close / shutdown. */
export function _rejectAllPending(err: Error): number {
  const count = _pending.size;
  for (const [cid, entry] of _pending) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.reject(err);
    _pending.delete(cid);
  }
  return count;
}

/** Number of currently-pending acks — for tests and diagnostics. */
export function _pendingAckCount(): number {
  return _pending.size;
}
