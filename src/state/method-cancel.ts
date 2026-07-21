// method-cancel.ts — cancellation for async methods (perfect-aio D1: the
// method-native replacement for generator cancelOn).
//
//   cell("checkout", {
//     cancelOn: { place: [cart.clear] },   // cart.clear aborts a running place()
//     methods: {
//       async place(s, item) {
//         s.status = "placing";
//         const r = await fetch(url, { signal: s.$signal }); // signal-aware IO
//         if (s.$signal.aborted) return;                     // or check manually
//         s.status = "placed";
//       },
//     },
//   })
//
// The framework aborts the in-flight call's AbortController when a trigger
// action dispatches; the method observes it via `s.$signal` (and until()
// accepts it). Registry is per (cellPrefix, method) — module-scoped like the
// other runtime registries, reset via _resetMethodCancel for test isolation.

type Key = string; // `${cellPrefix}:${method}`

/** trigger action type → set of method keys it cancels */
const _triggers = new Map<string, Set<Key>>();
/** method key → in-flight AbortControllers */
const _inflight = new Map<Key, Set<AbortController>>();

/** Register cancel triggers for a method (called at cell creation). */
export function registerCancelOn(
  cellPrefix: string,
  method: string,
  triggers: (string | { type: string })[],
): void {
  const key = `${cellPrefix}:${method}`;
  for (const t of triggers) {
    const type = typeof t === "string" ? t : t.type;
    let set = _triggers.get(type);
    if (!set) _triggers.set(type, set = new Set());
    set.add(key);
  }
}

/** Track an in-flight async method call. Returns an untrack fn. */
export function trackCall(
  cellPrefix: string,
  method: string,
  controller: AbortController,
): () => void {
  const key = `${cellPrefix}:${method}`;
  let set = _inflight.get(key);
  if (!set) _inflight.set(key, set = new Set());
  set.add(controller);
  return () => {
    set!.delete(controller);
    if (set!.size === 0) _inflight.delete(key);
  };
}

/** Abort every in-flight call whose method lists this action as a trigger.
 *  Called from the composed reduce for every dispatched action. */
export function notifyMethodCancel(actionType: string): void {
  const keys = _triggers.get(actionType);
  if (!keys) return;
  for (const key of keys) {
    const set = _inflight.get(key);
    if (!set) continue;
    for (const c of set) c.abort();
    _inflight.delete(key);
  }
}

/** Test isolation: forget all triggers and abort nothing. */
export function _resetMethodCancel(): void {
  _triggers.clear();
  _inflight.clear();
}
