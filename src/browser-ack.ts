// Browser-side pending-ack map — used by browser-transport-send to
// resolve the Promise returned by an awaited method call.

import { ACK_TIMEOUT_MS } from "./protocol-types.ts";

/** Single pending ack: the shared promise, its resolve/reject + a timeout. */
type PendingEntry = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const _pending = new Map<string, PendingEntry>();

/** Test/dev override for ACK_TIMEOUT_MS. Pass `0` to disable the timer. */
let _ackTimeoutMs = ACK_TIMEOUT_MS;
export function _setAckTimeoutMs(ms: number): void {
  _ackTimeoutMs = ms;
}

/** Register a pending ack. The returned promise resolves on `_resolveAck`,
 *  rejects on `_rejectAck` (timeout, disconnect, drop), or the timer fires.
 *
 *  Idempotent per cid: an action passes through several layers that each
 *  register (cell binding, transport send) — re-registering the same cid
 *  MUST return the same shared promise instead of overwriting the pending
 *  entry, otherwise the first caller's promise is orphaned and times out
 *  even though the server acked (AIO-2.2 regression). */
export function _registerAck(cid: string): Promise<void> {
  const existing = _pending.get(cid);
  if (existing) return existing.promise;

  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = _ackTimeoutMs > 0
    ? setTimeout(() => {
      _pending.delete(cid);
      reject(
        new Error(
          `method not acknowledged in ${_ackTimeoutMs}ms — server overloaded or disconnected`,
        ),
      );
    }, _ackTimeoutMs)
    : undefined;
  _pending.set(cid, { promise, resolve, reject, timer });
  return promise;
}

/** Settle a pending ack. Returns true if a pending entry was found. */
export function _resolveAck(cid: string): boolean {
  const entry = _pending.get(cid);
  if (!entry) return false;
  _pending.delete(cid);
  if (entry.timer) clearTimeout(entry.timer);
  entry.resolve();
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
