// Browser-side pending-ack map — used by browser-transport-send to
// resolve the Promise returned by an awaited method call.

import { ACK_TIMEOUT_MS } from "./protocol-types.ts";

/** Single pending ack: the promise's resolve/reject + a timeout handle. */
type PendingEntry = {
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
 *  rejects on `_rejectAck` (timeout, disconnect, drop), or the timer fires. */
export function _registerAck(cid: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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
    _pending.set(cid, { resolve, reject, timer });
  });
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
