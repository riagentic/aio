// renderer-lifecycle.ts — component lifecycle hooks and persistent state hooks.
// Provides: onMount, onCleanup, useRef, useSignal, useId, _resetSsrIdCounter, useOptimistic.

import { type Signal, signal } from "./signal.ts";
import type { ComponentInstance } from "./renderer-types.ts";
import {
  _activeRoot,
  _currentCollector,
  _insideMount,
  _setCurrentCollector,
} from "./renderer-state.ts";

let _devMode = false;
export function _setLifecycleDevMode(v: boolean): void {
  _devMode = v;
}

// ── onMount / onCleanup ───────────────────────────────────────────────

/**
 * Register a callback to run after the component's first render.
 * Must be called inside a component function body during render.
 */
export function onMount(fn: () => void): void {
  if (!_currentCollector) return;
  _currentCollector.mountCallbacks.push(fn);
}

/**
 * Register a cleanup callback.
 * - Called in component body: runs on unmount AND before each re-render.
 * - Called inside onMount(): runs ONLY on unmount (AIO-76 fix).
 */
export function onCleanup(fn: () => void): void {
  if (!_currentCollector) return;
  if (_insideMount && "mountCleanupCallbacks" in _currentCollector) {
    (_currentCollector as ComponentInstance).mountCleanupCallbacks.push(fn);
  } else {
    _currentCollector.cleanupCallbacks.push(fn);
  }
}

// ── useRef ────────────────────────────────────────────────────────────

/**
 * Persist a mutable ref across renders. Does not trigger re-render on mutation.
 * Must be called inside a component function body during render.
 */
export function useRef<T>(initial: T): { current: T } {
  if (!_currentCollector) {
    if (_devMode) {
      console.warn(
        "[aio-dev] useRef() called outside a component render. The ref will not persist across re-renders.",
      );
    }
    return { current: initial };
  }
  const collector = _currentCollector;
  if (!collector.refs) collector.refs = [];
  if (collector.refIndex === undefined) collector.refIndex = 0;
  const idx = collector.refIndex++;
  if (idx >= collector.refs.length) {
    const ref = { current: initial };
    collector.refs.push(ref);
    return ref;
  }
  return collector.refs[idx] as { current: T };
}

// ── useSignal ─────────────────────────────────────────────────────────

/**
 * Creates a component-scoped signal. Auto-GC'd on unmount.
 * For state that survives remounts, use a module-level `signal()`.
 *
 * @example
 * ```tsx
 * // Module-level UI state (survives unmount)
 * const ui = signal({ collapsed: [] as string[] }, 'sidebar')
 *
 * function Sidebar() {
 *   void ui.value // subscribe parent
 *   return <TreeRow collapsed={ui.value.collapsed} />
 * }
 * ```
 */
export function useSignal<T>(initial: T): Signal<T> {
  if (!_currentCollector) {
    if (_devMode) {
      console.warn(
        "[aio-dev] useSignal() called outside a component render. The signal will not persist across re-renders.",
      );
    }
    return signal(initial);
  }
  const collector = _currentCollector;
  if (!collector.refs) collector.refs = [];
  if (collector.refIndex === undefined) collector.refIndex = 0;
  const idx = collector.refIndex++;
  if (idx >= collector.refs.length) {
    const sig = signal(initial);
    collector.refs.push(sig as unknown as { current: unknown });
    return sig;
  }
  return collector.refs[idx] as unknown as Signal<T>;
}

// ── useId — SSR-safe unique ID ────────────────────────────────────────

let _ssrIdCounter = 0;

/** Reset SSR ID counter. Called at the start of each renderToString. */
export function _resetSsrIdCounter(): void {
  _ssrIdCounter = 0;
}

/**
 * Generate a unique, SSR-stable ID. Persists across re-renders.
 * Format: `:r{N}:` — deterministic per render tree traversal order.
 * Must be called inside a component function body during render.
 */
export function useId(): string {
  if (!_currentCollector) {
    return `:r${_ssrIdCounter++}:`;
  }
  const collector = _currentCollector;
  if (!collector.refs) collector.refs = [];
  if (collector.refIndex === undefined) collector.refIndex = 0;
  const idx = collector.refIndex++;
  if (idx >= collector.refs.length) {
    const root = _activeRoot;
    const n = root ? root._idCounter++ : _ssrIdCounter++;
    const ref = { current: `:r${n}:` };
    collector.refs.push(ref);
    return ref.current;
  }
  return (collector.refs[idx] as { current: string }).current;
}

// ── useOptimistic — optimistic UI during async operations ─────────────

/**
 * Optimistic UI hook. Shows an immediate update while an async action runs,
 * then reverts to the real state when it completes (success or failure).
 */
export function useOptimistic<T, A = T>(
  passthrough: T,
  updateFn: (current: T, optimistic: A) => T,
): [T, (action: A) => void] {
  const pendingRef = useRef<A[]>([]);
  const version = useSignal(0);

  const prevRef = useRef<T>(passthrough);
  if (passthrough !== prevRef.current) {
    prevRef.current = passthrough;
    pendingRef.current = [];
  }

  void version.value;

  let display = passthrough;
  for (const action of pendingRef.current) {
    display = updateFn(display, action);
  }

  function addOptimistic(action: A): void {
    pendingRef.current = [...pendingRef.current, action];
    version.set(version.peek() + 1);
  }

  return [display, addOptimistic];
}

// Re-export so aio-renderer.ts can use _setCurrentCollector via lifecycle module
export { _setCurrentCollector };
