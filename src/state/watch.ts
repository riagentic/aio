// watch() — observe signal changes with old/new values.
// Thin wrapper over effect() + peek(). Returns a stop function.

import { type Computed, effect, type Signal, untrack } from "./signal.ts";

/**
 * Explicit dependency declaration for effects. The returned function is passed
 * to effect() and only re-runs when `source` changes.
 *
 * ```ts
 * effect(on(count, (next, prev) => { ... }));
 * ```
 */
export function on<T>(
  source: Signal<T> | Computed<T>,
  fn: (next: T, prev: T) => void,
): () => void {
  let prev: T = source.peek();
  let first = true;
  const derived = isDerived(source);

  return () => {
    const next = source.value; // track only this source
    if (first) {
      first = false;
      prev = next;
      return;
    }
    if (derived && Object.is(next, prev)) return; // invalidated, not changed
    const p = prev;
    prev = next;
    // Run callback with all other reads untracked
    untrack(() => fn(next, p));
  };
}

/** Is this source one with NO writer — i.e. a computed?
 *
 *  It decides who answers "did it change". A Signal's writer answers it:
 *  `set` already drops a no-op write, and `set(v, { force: true })`
 *  deliberately notifies with an identical (usually mutated-in-place) value —
 *  comparing values here would silently overrule that, which is the whole
 *  reason `force` exists. A Computed has no writer to ask: its dependency edge
 *  propagates INVALIDATION (recompute is lazy, so nothing can compare values at
 *  propagation time), so `watch(computed(() => list.value.length))` fired
 *  `3 → 3` every time any item's text changed. For a derived value, "changed"
 *  can only mean "the value differs", and this is the one place that holds both
 *  the old and the new one. */
function isDerived<T>(source: Signal<T> | Computed<T>): boolean {
  return typeof (source as Signal<T>).set !== "function";
}

/** Options for watch(). */
export interface WatchOptions {
  /** If true, callback fires immediately with current value (prev = undefined). */
  immediate?: boolean;
}

/**
 * Watch a signal or computed, calling `fn(next, prev)` whenever it changes.
 * Returns a stop function.
 */
export function watch<T>(
  source: Signal<T> | Computed<T>,
  fn: (next: T, prev: T | undefined) => void,
  opts?: WatchOptions,
): () => void {
  let prev: T | undefined = source.peek();
  let first = true;
  const derived = isDerived(source);

  if (opts?.immediate) {
    fn(prev as T, undefined);
  }

  const dispose = effect(() => {
    const next = source.value;
    if (first) {
      first = false;
      return;
    }
    // A computed that was invalidated but recomputed to the same value did not
    // change — see isDerived.
    if (derived && Object.is(next, prev)) return;
    const p = prev;
    prev = next;
    fn(next, p);
  });

  return dispose;
}
