// VDOM lazy component loader — deferred module loading with Suspense integration.
// Zero dependency on vdom.ts — imports only from vdom-types.ts.

import type { ComponentFn } from "./vdom-types.ts";
import { _LAZY_PENDING } from "./vdom-types.ts";

/** The listener set of the lazy component that threw `_LAZY_PENDING` most
 *  recently — read (and cleared) by the catching Suspense boundary. Render is
 *  synchronous and single-threaded, so the throw and the catch are adjacent:
 *  whatever is here when a boundary catches IS the lazy that stopped it. */
let _pendingListeners: Set<() => void> | null = null;

/** Take the pending lazy's listener set, clearing it. @internal */
export function _takePendingLazyListeners(): Set<() => void> | null {
  const p = _pendingListeners;
  _pendingListeners = null;
  return p;
}

/** First retry delay after a failed import; doubles per attempt, capped. */
const _RETRY_BASE_MS = 1000;
const _RETRY_MAX_MS = 30_000;

/**
 * Lazy-load a component. Use with Suspense for fallback UI.
 *
 * (These two retry consts used to sit BETWEEN this comment and the function,
 * which orphaned the doc: `deno doc` attributed it to `_RETRY_BASE_MS` and
 * `lazy` shipped as an undocumented public symbol. `check:doc-coverage` found
 * it; the comment belongs against what it documents.)
 * ```ts
 * const LazyComp = lazy(() => import("../HeavyComponent.ts"));
 * // h(Suspense, { fallback: h("span", null, "Loading...") }, h(LazyComp, null))
 * ```
 */
export function lazy<P extends Record<string, unknown>>(
  loader: () => Promise<{ default: ComponentFn }>,
): ComponentFn {
  let resolved: ComponentFn | null = null;
  let loading = false;
  let error: Error | null = null;
  /** Failed attempts so far, and the earliest moment another one is allowed. */
  let attempts = 0;
  let nextRetryAt = 0;
  /** Listeners notified when lazy resolves — Suspense boundaries register here. */
  const _listeners = new Set<() => void>();

  /** Start the import, at most once at a time. Hoisted so a Suspense boundary
   *  can START a sibling lazy it has not rendered yet (see `_preloadLazy`). */
  function startLoad(): void {
    if (resolved || loading || error) return;
    loading = true;
    loader().then((mod) => {
      resolved = mod.default;
      // Surface the real component name (semantic UI surface / devtools
      // address lazy components by it, not by "LazyWrapper").
      (LazyWrapper as unknown as { _lazyName?: string })._lazyName =
        mod.default.name || undefined;
      // Notify all registered Suspense boundaries to re-render
      for (const fn of _listeners) fn();
      _listeners.clear();
    }).catch((e) => {
      error = e instanceof Error ? e : new Error(String(e));
      loading = false;
      attempts++;
      const wait = Math.min(
        _RETRY_MAX_MS,
        _RETRY_BASE_MS * 2 ** (attempts - 1),
      );
      nextRetryAt = Date.now() + wait;
      // Loud, always. Without this a failed chunk left the Suspense fallback
      // spinning on screen forever with NOTHING in the console — the exact
      // silent failure this project forbids. It is the only report the app
      // gets when there is no <ErrorBoundary> above the boundary.
      console.error(
        `[aio:lazy] dynamic import failed (attempt ${attempts}) — the ` +
          `<Suspense> fallback stays on screen; next attempt allowed in ` +
          `${wait}ms:`,
        error,
      );
      for (const fn of _listeners) fn();
      _listeners.clear();
    });
  }

  const LazyWrapper: ComponentFn = (props: P) => {
    if (resolved) return resolved({ ...props });
    if (error) {
      const cached = error;
      // Retry is allowed (AIO-129) — but on a BACKOFF, not on every render.
      // Clearing the state unconditionally meant an unrelated re-render fired
      // another request: measured 6 requests over 5 renders that had nothing
      // to do with this component, against an import already known to fail.
      // The throw still happens every render, so an <ErrorBoundary> above
      // still sees the error each time.
      if (Date.now() >= nextRetryAt) {
        error = null;
        loading = false;
      }
      throw cached;
    }
    startLoad();
    // Signal to Suspense that we're still loading. Record WHICH lazy is
    // pending first: the boundary used to identify it by scanning its own
    // immediate children, so a lazy one component deeper
    // (`<Suspense><Wrapper/></Suspense>` where Wrapper renders the lazy) got no
    // listener at all — the loader resolved and nothing ever re-rendered, so
    // the fallback stayed on screen forever. The thrower knows its own
    // identity; the boundary should not have to guess.
    _pendingListeners = _listeners;
    throw _LAZY_PENDING;
  };

  // Attach listener registry for Suspense boundaries
  (LazyWrapper as unknown as { _lazyListeners: Set<() => void> })
    ._lazyListeners = _listeners;
  // ...and the way to START it without rendering it. A Suspense boundary
  // aborts its child loop at the FIRST lazy that throws, so the siblings after
  // it were never rendered, never started, and only began loading once the
  // first one had finished: N round trips end to end where the network could
  // have done them at once.
  (LazyWrapper as unknown as { _lazyPreload: () => void })._lazyPreload =
    startLoad;

  return LazyWrapper;
}

/** Start a lazy component's import without rendering it. @internal */
export function _preloadLazy(fn: ComponentFn): void {
  (fn as unknown as { _lazyPreload?: () => void })._lazyPreload?.();
}

/** Check if a ComponentFn is a lazy wrapper with listener support. */
export function _getLazyListeners(fn: ComponentFn): Set<() => void> | null {
  return (fn as unknown as { _lazyListeners?: Set<() => void> })
    ._lazyListeners ?? null;
}
