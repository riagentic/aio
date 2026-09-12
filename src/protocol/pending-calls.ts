/**
 * @module
 * How many calls to `cell:method` are in flight, right now, in THIS runtime.
 *
 * A field report counted ten hand-rolled booleans across five cells, each set
 * at the top of a method and reset in a `finally` — ten chances to forget —
 * and then replicated, persisted and migrated like real domain state, which
 * they are not (report 8 §14, report 9 §9.5). A fourth one was wrong: a BOOLEAN
 * where two readings overlap, so the first to finish declared silence while
 * the speakers were still going.
 *
 * So it is a COUNT, not a flag, and the framework owns it. aio already
 * brackets every async call — `trackCall` on the server, the ack registry in a
 * client — and the count was sitting in both of them unexposed.
 *
 * DEPENDENCY-FREE ON PURPOSE. This lives in `protocol/` because both sides
 * feed it and `protocol` is the folder both can import; the reactive wrapper
 * that makes it re-render a component lives in `state/pending.ts`, which may
 * import this. A signal here would invert that edge.
 */

const _counts = new Map<string, number>();
const _listeners = new Set<(key: string, n: number) => void>();

/** Adjust the in-flight count for `cell:method`. Returns the new count. */
export function bumpPending(key: string, delta: number): number {
  const next = Math.max(0, (_counts.get(key) ?? 0) + delta);
  if (next === 0) _counts.delete(key);
  else _counts.set(key, next);
  for (const l of _listeners) l(key, next);
  return next;
}

/** How many calls to `cell:method` are in flight. */
export function pendingCount(key: string): number {
  return _counts.get(key) ?? 0;
}

/** Every in-flight count for one cell, summed — `cell.$pending()` with no
 *  method name. */
export function pendingForCell(prefix: string): number {
  let n = 0;
  const head = `${prefix}:`;
  for (const [k, v] of _counts) if (k.startsWith(head)) n += v;
  return n;
}

/** Subscribe to changes. Returns an unsubscribe. */
export function onPendingChange(
  fn: (key: string, n: number) => void,
): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Clear everything — teardown, and between tests. */
export function resetPendingCalls(): void {
  _counts.clear();
  _listeners.clear();
}
