// VDOM lazy component loader — deferred module loading with Suspense integration.
// Zero dependency on vdom.ts — imports only from vdom-types.ts.

import type { ComponentFn } from "./vdom-types.ts";
import { _LAZY_PENDING } from "./vdom-types.ts";

/**
 * Lazy-load a component. Use with Suspense for fallback UI.
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
  /** Listeners notified when lazy resolves — Suspense boundaries register here. */
  const _listeners = new Set<() => void>();

  const LazyWrapper: ComponentFn = (props: P) => {
    if (resolved) return resolved({ ...props });
    if (error) {
      // Allow retry: clear state so next render re-attempts the import (AIO-129)
      const cached = error;
      error = null;
      loading = false;
      throw cached;
    }
    if (!loading) {
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
        error = e;
        loading = false;
        for (const fn of _listeners) fn();
        _listeners.clear();
      });
    }
    // Signal to Suspense that we're still loading
    throw _LAZY_PENDING;
  };

  // Attach listener registry for Suspense boundaries
  (LazyWrapper as unknown as { _lazyListeners: Set<() => void> })
    ._lazyListeners = _listeners;

  return LazyWrapper;
}

/** Check if a ComponentFn is a lazy wrapper with listener support. */
export function _getLazyListeners(fn: ComponentFn): Set<() => void> | null {
  return (fn as unknown as { _lazyListeners?: Set<() => void> })
    ._lazyListeners ?? null;
}
