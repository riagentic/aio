// React migration compat hooks for AIR.
// Allow React code to compile and run when imported from 'aio/air'.
// Dev-mode hints guide toward AIR-native alternatives.
// Isolated — deletable when no longer needed.

import { effect, type Signal, signal } from "./signal.ts";
import { onCleanup, onMount, useRef } from "./aio-renderer.ts";

// ── Dev hints (once per function name per session) ─────────────────

const _hinted = new Set<string>();

function _hint(name: string, msg: string): void {
  if (!(globalThis as Record<string, unknown>).__aioDev) return;
  if (_hinted.has(name)) return;
  _hinted.add(name);
  console.info(msg);
}

/** Reset hint tracking (for testing). */
export function _resetHints(): void {
  _hinted.clear();
}

// ── useState ───────────────────────────────────────────────────────

export function useState<T>(
  initial: T | (() => T),
): [T, (next: T | ((prev: T) => T)) => void] {
  _hint(
    "useState",
    "[aio] useState() is signal-backed in AIR. Recommended: useLocal() for object state, signal() for module-scoped.",
  );

  const ref = useRef<Signal<T> | null>(null);
  if (ref.current === null) {
    // Matches React behavior: functions are always treated as lazy initializers.
    // If T is itself a function type, wrap it: useState(() => myFn)
    const val = typeof initial === "function"
      ? (initial as () => T)()
      : initial;
    ref.current = signal(val);
  }
  const sig = ref.current;

  const setter = (next: T | ((prev: T) => T)): void => {
    if (typeof next === "function") {
      sig.set((next as (prev: T) => T)(sig.peek()));
    } else {
      sig.set(next);
    }
  };

  return [sig.value, setter];
}

// ── useEffect ──────────────────────────────────────────────────────

export function useEffect(
  fn: () => void | (() => void),
  deps?: unknown[],
): void {
  _hint(
    "useEffect",
    "[aio] useEffect() mapped to AIR primitives. Deps ignored (auto-tracked). Recommended: onMount() for setup, effect() for reactive.",
  );

  if (deps && deps.length === 0) {
    // Empty deps → mount/cleanup semantics
    // Capture cleanup ref so onCleanup can dispose it on unmount
    const cleanupRef = useRef<(() => void) | null>(null);
    onMount(() => {
      const cleanup = fn();
      if (typeof cleanup === "function") {
        cleanupRef.current = cleanup;
      }
    });
    onCleanup(() => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    });
  } else {
    // No deps or non-empty deps → effect (created once via useRef)
    const created = useRef(false);
    if (!created.current) {
      created.current = true;
      const dispose = effect(fn);
      onCleanup(dispose);
    }
  }
}

// ── useCallback ────────────────────────────────────────────────────

export function useCallback<T>(fn: T, _deps?: unknown[]): T {
  _hint(
    "useCallback",
    "[aio] useCallback() is unnecessary in AIR — components are auto-optimized. Safe to remove.",
  );
  return fn;
}

// ── useMemo ────────────────────────────────────────────────────────

export function useMemo<T>(fn: () => T, _deps?: unknown[]): T {
  _hint(
    "useMemo",
    "[aio] useMemo() is unnecessary in AIR — use computed() for cached derivations. Safe to remove.",
  );
  return fn();
}
