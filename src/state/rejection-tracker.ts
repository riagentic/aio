// rejection-tracker.ts — D11 (perfect-aio): every rejected change is
// explainable. The composed reduce records WHY a dispatch was refused
// (validate hook failure, method throw); the sync server handler reads it
// right after dispatching an op and tells the op's origin client instead of
// leaving its optimistic view to silently snap back.
//
// The rejection is keyed to the ACTION OBJECT that was refused — never to a
// process-wide "last" slot. The reader sits on the far side of an `await`
// (`await dispatch(op)` → "was it refused?"), and the event loop is free in
// between: another op's chain resumes and runs its own reduce. With one
// cell-keyed slot cleared at the start of every reduce, that neighbour both
// ERASED a rejection that belonged to someone else (a refused op was acked,
// broadcast to every peer and left in the log — applied everywhere except the
// machine that refused it) and PLANTED one that did not (a healthy op deleted
// from the log and rolled back on its origin while the server kept it).
// Keying by action makes "which dispatch does this rejection belong to" a
// question with exactly one decider.

export interface DispatchRejection {
  cell: string;
  reason: string;
}

// WeakMap: an action nobody asks about is collected with the action itself —
// no clearing step, and therefore no window in which clearing is wrong.
const _byAction = new WeakMap<object, DispatchRejection[]>();

/** Record why THIS action was refused (called by the reducer, which holds the
 *  action object the dispatcher passed in). One action can collect more than
 *  one rejection: the owning cell's, plus any foreign-action listener's. */
export function recordRejection(action: unknown, r: DispatchRejection): void {
  if (!action || typeof action !== "object") return;
  const list = _byAction.get(action as object);
  if (list) list.push(r);
  else _byAction.set(action as object, [r]);
}

/** Read-and-clear the rejection `cell` recorded for THIS action, if any.
 *  Callers pass the very object they handed to `dispatch()`; matching the cell
 *  here (rather than at every call site) keeps "is this rejection mine?" a
 *  one-decider question. */
export function takeRejectionFor(
  action: unknown,
  cell: string,
): DispatchRejection | null {
  if (!action || typeof action !== "object") return null;
  const list = _byAction.get(action as object);
  if (!list) return null;
  const idx = list.findIndex((r) => r.cell === cell);
  if (idx === -1) return null;
  const [hit] = list.splice(idx, 1);
  if (list.length === 0) _byAction.delete(action as object);
  return hit ?? null;
}
