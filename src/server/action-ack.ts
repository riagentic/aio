// action-ack.ts — ONE decider for "did this action actually DO anything?",
// shared by every transport that acks a client call (server-ws.ts, uds.ts).
//
// The ack was taken from the dispatch PROMISE alone, and dispatch resolves
// whether or not anything ran. A cell method that no longer exists, a cell the
// server never booted, a cell disabled by its breaker, a `validate` hook that
// refused the change — all four resolve, so `await todos.rename(id, "x")` in
// the browser returned `ok: true` while the reduce had logged "does NOTHING"
// and changed no state. A stale client after a rename is the everyday version
// of it: the UI reports success forever and the data never moves.
//
// The refusal was already recorded — `recordRejection` keys it to the very
// action object that was refused (see state/rejection-tracker.ts) — but only
// the sync handler ever read it. This is the same read on the ack path.

import { takeRejectionFor } from "../state/rejection-tracker.ts";
import { type AioError, createAioError } from "../diagnostics/error.ts";

/** Why this action was refused, or `null` when it really ran.
 *
 *  Read-and-clear, keyed to the action OBJECT: the caller passes the same
 *  object it handed to `dispatch()`, so two concurrent calls can never take
 *  each other's answer. The cell is the action's own prefix (`cell:method`) —
 *  the cell that owns the method, and the one that records a refusal for it.
 *
 *  Returns an `AioError`, not a bare string. The ack path's job is to tell the
 *  caller apart three failures — refused by the gate, refused by the reduce,
 *  thrown by the app — and a string can only carry the first two as WORDING,
 *  which `docs/basics/semver-policy.md` refuses to freeze. `ACTION_REFUSED` is
 *  the classification; `errorFields()` puts it on the wire; `errorCode(err)`
 *  reads it back on the caller. One shape, one decider, both transports. */
export function _dispatchRefusal(action: unknown): AioError | null {
  if (!action || typeof action !== "object") return null;
  const type = (action as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  const ci = type.indexOf(":");
  if (ci <= 0) return null;
  const cellName = type.slice(0, ci);
  const hit = takeRejectionFor(action, cellName);
  if (!hit) return null;
  return createAioError("ACTION_REFUSED", hit.reason, {
    cellName,
    actionType: type,
  });
}
