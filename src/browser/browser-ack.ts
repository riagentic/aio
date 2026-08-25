// Browser-side pending-ack map — used by the AIR transport to
// resolve the Promise returned by an awaited method call.
//
// The MECHANISM lives in ack-registry.ts (one implementation, shared with the
// CLI client, which needs its own instance per connection). This file is the
// browser's singleton over it: one page, one transport, one registry — so the
// module-level functions below keep exactly the names and semantics every
// browser call site already uses.

import { ACK_TIMEOUT_MS, type AioWindow } from "../protocol/protocol-types.ts";
import {
  type AckCeiling,
  type AckRegistry,
  createAckRegistry,
} from "../protocol/ack-registry.ts";
import { _ackSink } from "../state/ack-sink.ts";

export { ackMethodKey } from "../protocol/ack-registry.ts";

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
 *  wait indefinitely), or the legacy constant when no shell config exists.
 *
 *  Read at REGISTRATION time (not captured once) so `_setAckTimeoutMs` and a
 *  late-arriving `cfg` frame both take effect. */
function callCeilingMs(methodKey: string | undefined): AckCeiling {
  const cfg = (globalThis as AioWindow).__aioConfig?.callTimeouts;
  const perMethod = methodKey !== undefined
    ? cfg?.methods?.[methodKey]
    : undefined;
  const withGrace = (ms: number) => ms <= 0 ? 0 : ms + _ackGraceMs;
  if (perMethod === "warn") {
    // The server warns at the DEFAULT ceiling and keeps waiting; so do we.
    return { warnAfterMs: withGrace(cfg?.default ?? _ackTimeoutMs) };
  }
  const resolved = perMethod ?? cfg?.default;
  if (resolved === undefined) return _ackTimeoutMs;
  return withGrace(resolved);
}

const _registry: AckRegistry = createAckRegistry(
  callCeilingMs,
  (m) => console.warn(m),
);

/** Marks a send function that ARMS the ack clock itself when it writes the
 *  frame (and defers it while the action sits in an offline queue). The cell
 *  binding registers the ack before handing the action to a transport, so it
 *  has to know whether that transport will start the clock — a custom or
 *  legacy `sendFn` will not, and its calls must still be able to time out. */
export const ARMS_ACK_TIMER = Symbol.for("aio.armsAckTimer");

/** True when `fn` is a transport that arms ack timers itself. */
// deno-lint-ignore ban-types
export function armsAckTimer(fn: Function | undefined): boolean {
  return !!fn &&
    (fn as unknown as Record<symbol, boolean>)[ARMS_ACK_TIMER] === true;
}

/** Register a pending ack. The returned promise resolves on `_resolveAck`,
 *  rejects on `_rejectAck` (timeout, disconnect, drop), or the timer fires.
 *
 *  `methodKey` ("cell:method") selects the bridged per-method ceiling.
 *  `deferTimer` registers WITHOUT starting the clock — an offline-queued call
 *  must not time out while it waits for a connection; the transport arms it
 *  via `_armAckTimer` when the frame is actually written.
 *
 *  Idempotent per cid (see ack-registry.ts). */
export function _registerAck(
  cid: string,
  opts?: { methodKey?: string; deferTimer?: boolean },
): Promise<unknown> {
  return _registry.register(cid, opts);
}

/** The frame for `cid` is now on the wire: mark the call in flight and start
 *  its clock. Every transport calls this at the moment it writes — on the
 *  direct send AND when draining the offline queue. No-op if the timer already
 *  runs or the ack has settled. */
export function _armAckTimer(cid: string): void {
  _registry.armTimer(cid);
}

/** True when `cid`'s frame has actually been written (as opposed to sitting in
 *  a transport's offline queue). */
export function _isAckWritten(cid: string): boolean {
  return _registry.isWritten(cid);
}

/** Settle a pending ack with the method's transported return value (undefined
 *  for void). Returns true if a pending entry was found. */
export function _resolveAck(cid: string, value?: unknown): boolean {
  return _registry.resolve(cid, value);
}

/** Reject a single pending ack (e.g. on dispatch error or validation failure). */
export function _rejectAck(cid: string, err: Error): boolean {
  return _registry.reject(cid, err);
}

/** Reject all pending acks with the given error — for a teardown that also
 *  DISCARDS the offline queue (page teardown, protocol mismatch). */
export function _rejectAllPending(err: Error): number {
  return _registry.rejectAll(err);
}

/** Reject only the calls already written to the wire — for a disconnect whose
 *  offline queue survives and flushes on reconnect. A queued call keeps its
 *  promise: it has not been sent, so nothing can have applied it, and
 *  rejecting it would be contradicted by the very next flush. */
export function _rejectInFlight(err: Error): number {
  return _registry.rejectInFlight(err);
}

/** Number of currently-pending acks — for tests and diagnostics. */
export function _pendingAckCount(): number {
  return _registry.size();
}

// ── state/ seam ──────────────────────────────────────────────────────
// The cell binding (state/cell-reactive.ts) and the shared offline queue
// (state/offline-queue.ts) settle call promises through this singleton, but
// the boundary matrix forbids state → browser — so this module hands its
// implementation to the late-bound sink instead (see state/ack-sink.ts).
_ackSink.impl = {
  register: _registerAck,
  armTimer: _armAckTimer,
  reject: _rejectAck,
  armsAckTimer,
};
