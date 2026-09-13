// React migration compat hooks for AIR.
// Allow React code to compile and run when imported from 'aio/air'.
// Dev-mode hints guide toward AIR-native alternatives.
// Isolated — deletable when no longer needed.

import { effect, type Signal, signal, untrack } from "../state/signal.ts";
import {
  afterRender,
  onCleanup,
  onMount,
  useRef as rendererUseRef,
} from "./aio-renderer.ts";

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

/** Re-export useRef from renderer for compat */
export const useRef = rendererUseRef;

// ── useState ───────────────────────────────────────────────────────

/**
 * React-compatible `useState`, signal-backed. Migration shim — prefer
 * `useLocal()` for object state or `signal()` for module-scoped state.
 */
export function useState<T>(
  initial: T | (() => T),
): [T, (next: T | ((prev: T) => T)) => void] {
  _hint(
    "useState",
    "[aio] useState() is signal-backed in AIR. Recommended: useLocal() for object state, signal() for module-scoped.",
  );

  const ref = rendererUseRef<Signal<T> | null>(null);
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
      sig.update(next as (prev: T) => T);
    } else {
      sig.set(next);
    }
  };

  return [sig.value, setter];
}

// ── useEffect ──────────────────────────────────────────────────────

/**
 * React-compatible `useEffect` mapped to AIR lifecycle primitives; deps are
 * honored (React semantics). Migration shim — prefer `onMount()` / `effect()`.
 */
export function useEffect(
  fn: () => void | (() => void),
  deps?: unknown[],
): void {
  _hint(
    "useEffect",
    "[aio] useEffect() mapped to AIR primitives. Deps are honored (React semantics). Signal-native alternative: effect() auto-tracks reads.",
  );

  if (deps && deps.length > 0) {
    // AIO-7.1: real React semantics — run after mount, re-run only when deps
    // differ by Object.is on a later render, cleanup before re-run. Signal
    // auto-tracking is disabled (untrack): behavior is purely deps-driven.
    const store = useRef<{
      deps: unknown[] | null;
      cleanup: (() => void) | null;
    }>({ deps: null, cleanup: null });
    const fnRef = useRef(fn);
    fnRef.current = fn;

    const prev = store.current.deps;
    const changed = prev === null ||
      deps.length !== prev.length ||
      deps.some((d, i) => !Object.is(d, prev[i]));

    const disposeCleanup = () => {
      if (store.current.cleanup) {
        store.current.cleanup();
        store.current.cleanup = null;
      }
    };

    if (changed) {
      const first = prev === null;
      store.current.deps = deps.slice(); // record at schedule time — no double-fire
      const run = () => {
        disposeCleanup();
        const cleanup = untrack(() => fnRef.current());
        if (typeof cleanup === "function") {
          store.current.cleanup = cleanup;
        }
      };
      if (first) {
        // The unmount cleanup is registered INSIDE onMount, which makes it
        // unmount-only. Registered in the component body it would also fire
        // before every re-render — and a re-render with UNCHANGED deps does
        // not re-run the effect, so the cleanup tore the effect down and
        // nothing put it back: a `useEffect(..., [])` listener was removed by
        // the first unrelated re-render and never re-added.
        onMount(() => {
          onCleanup(disposeCleanup);
          run(); // first run lands after the mount commit
        });
      } else {
        // Re-runs must land AFTER the diff/commit phase so the effect sees the
        // committed DOM (React semantics). queueMicrotask would fire before
        // the diff runs, reading stale layout and racing the impending patch.
        afterRender(run);
      }
    }
    return;
  }

  if (deps && deps.length === 0) {
    // Empty deps → mount/cleanup semantics
    // Capture cleanup ref so onCleanup can dispose it on unmount
    const cleanupRef = useRef<(() => void) | null>(null);
    onMount(() => {
      const cleanup = fn();
      if (typeof cleanup === "function") {
        cleanupRef.current = cleanup;
      }
      // INSIDE onMount, exactly as the deps-form above does and for exactly the
      // reason written there: registered in the component body, `onCleanup`
      // fires before EVERY re-render. With empty deps the effect never re-runs,
      // so the first unrelated re-render tore it down permanently —
      // `useEffect(() => subscribe(), [])` silently unsubscribed and nothing
      // put it back. The deps-form branch was fixed for this; this one was
      // missed, which is what a comment on one of two twins tends to produce.
      onCleanup(() => {
        if (cleanupRef.current) {
          cleanupRef.current();
          cleanupRef.current = null;
        }
      });
    });
  } else {
    // No deps or non-empty deps → effect with fresh closure each render.
    // Store fn in ref so the effect always calls the latest closure,
    // preventing stale captures of non-signal values (props, locals).
    // AIO-182: Re-create effect every render — _effectDisposeAll kills
    // the previous one during re-render cleanup, so we must re-create it.
    const fnRef = useRef(fn);
    fnRef.current = fn;
    const dispose = effect(() => fnRef.current());
    onCleanup(dispose);
  }
}

// ── useCallback ────────────────────────────────────────────────────

/**
 * React-compatible `useCallback` — a STABLE identity across renders, which is
 * the thing it is for.
 *
 * It used to return `fn` unchanged, on the reasoning that AIR auto-optimizes
 * rendering so a memoized callback buys nothing. That is true of RENDERING and
 * false of IDENTITY, and identity is what a deps array compares. `useEffect`
 * on this same surface promises "Deps are honored (React semantics)" and
 * compares with `Object.is`, so a fresh arrow every render was a CHANGED dep
 * every render. Measured:
 *
 *   useEffect(fn, [useCallback(cb, [])])  over 1 mount + 3 re-renders
 *     React: subscribe 1, unsubscribe 0
 *     aio:   subscribe 4, unsubscribe 3
 *
 * …and the canonical fetch-on-mount shape — `useEffect(() => { setN(...) },
 * [load])` with `load` a `useCallback` — became an unbounded render loop
 * instead of running once. The compat layer exists so React code "compiles and
 * runs"; the single most common React idiom silently did neither.
 *
 * It is `useMemo(() => fn, deps)`, which is exactly what React's is.
 *
 * The parameter keeps its `_deps` name: the public surface is FROZEN and
 * `check:api` reads the signature verbatim, so renaming it — even to the same
 * type in the same position — is a refused change. It is read now; the
 * underscore is history, not a claim.
 */
export function useCallback<T>(fn: T, _deps?: unknown[]): T {
  _hint(
    "useCallback",
    "[aio] useCallback() is a migration shim — prefer a plain function, or " +
      "computed() for a cached derivation.",
  );
  return useMemo(() => fn, _deps);
}

// ── useMemo ────────────────────────────────────────────────────────

/**
 * React-compatible `useMemo` with dep comparison. Migration shim — prefer
 * `computed()` for cached derivations.
 */
export function useMemo<T>(fn: () => T, _deps?: unknown[]): T {
  _hint(
    "useMemo",
    "[aio] useMemo() is unnecessary in AIR — use computed() for cached derivations. Safe to remove.",
  );
  const ref = useRef<{ deps: unknown[] | undefined; value: T } | null>(null);
  // LENGTH first. An element-wise compare judges a SHRINKING deps array
  // unchanged whenever its surviving prefix matches, so `useMemo(fn, [...ids])`
  // with one id removed kept the old value: measured, deps `[0,1,2]` → `[0,1]`
  // returned 3 and never recomputed. That is a wrong VALUE rendered to the
  // page, not a missed optimisation. Its twin `useEffect` in this same file
  // already compares lengths — two deciders for one question, and this was the
  // half that had not been done.
  const prev = ref.current?.deps;
  if (
    ref.current === null ||
    !_deps ||
    !prev ||
    prev.length !== _deps.length ||
    !_deps.every((d, i) => d === prev[i])
  ) {
    ref.current = { deps: _deps, value: fn() };
  }
  return ref.current.value;
}
