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

  return () => {
    const next = source.value; // track only this source
    if (first) {
      first = false;
      prev = next;
      return;
    }
    const p = prev;
    prev = next;
    // Run callback with all other reads untracked
    untrack(() => fn(next, p));
  };
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

  if (opts?.immediate) {
    fn(prev as T, undefined);
  }

  const dispose = effect(() => {
    const next = source.value;
    if (first) {
      first = false;
      return;
    }
    const p = prev;
    prev = next;
    fn(next, p);
  });

  return dispose;
}
