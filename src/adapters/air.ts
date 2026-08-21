/**
 * @module
 * AIR adapter — signal-based hooks for AIO native renderer.
 *
 * Preferred: use cells directly — `counter.count` (reactive),
 * `counter.increment()` (dispatches). No hooks needed.
 *
 * `useAio` still available for backward compat. (`useCell` was REMOVED in
 * alpha52 — its `.state` was a LIVE proxy, so the natural stash-and-diff
 * idiom silently compared state to itself. Read `cell.field` directly;
 * `aiol --safe-fix` rewrites the mechanical `useCell(c).state.x` form.)
 *
 * @example
 * ```ts
 * import { counter } from "./app.ts";
 * // counter.count — reactive state read
 * // counter.increment() — dispatches action
 * ```
 */

import { signal } from "../state/signal.ts";
import { useRef } from "../air/aio-renderer.ts";
import {
  getConnectedSignal,
  getReadySignal,
  getStateSignal,
  send,
  trackPath,
} from "../state-core.ts";

/** Subscribe to the full app state. Prefer direct cell access
 *  (`counter.count` — reactive, scoped) over the full-state proxy. */
export function useAio<
  S extends Record<string, unknown> = Record<string, unknown>,
>(): {
  state: S;
  send: (action: { type: string; payload?: unknown }) => void;
  /** Has a full state frame arrived yet?
   *
   *  Before it does, every slice of `state` reads `undefined` — a socket can
   *  be open while the first frame is still in flight. Every app wrote the
   *  same guard against that window, each picking one arbitrary slice to
   *  stand in for "has anything arrived" (`if (!state.core) return
   *  <Loading/>`), which breaks the day that slice legitimately empties.
   *
   *  ```tsx
   *  const { state, ready } = useAio<AppState>()
   *  if (!ready) return <Spinner/>
   *  ```
   *  Reading it subscribes, so the component re-renders when the frame lands. */
  ready: boolean;
} {
  trackPath("*");
  const sig = getStateSignal();
  const readySig = getReadySignal();

  const state = new Proxy({} as S, {
    get(_target, prop: string | symbol): unknown {
      if (typeof prop === "symbol") return undefined;
      return (sig.value as Record<string, unknown>)[prop as string];
    },
    ownKeys(): string[] {
      return Object.keys(sig.value);
    },
    has(_target, prop: string | symbol): boolean {
      if (typeof prop === "symbol") return false;
      return prop in sig.value;
    },
    getOwnPropertyDescriptor(
      _target,
      prop: string | symbol,
    ): PropertyDescriptor | undefined {
      if (typeof prop === "symbol") return undefined;
      const s = sig.value;
      if (!(prop in s)) return undefined;
      return { configurable: true, enumerable: true, value: s[prop as string] };
    },
  });

  return {
    state,
    send,
    // A getter, not a snapshot: reading it inside the render subscribes, so a
    // component that gates on it re-renders when the first frame lands.
    get ready(): boolean {
      return readySig.value;
    },
  };
}

/** Result of {@linkcode useLocal} — object form (`{ local, set, patch }`)
 *  AND tuple form (`const [value, set] = useLocal(init)`).
 *
 *  Neither is "preferred", and saying otherwise was itself the bug: the docs
 *  called the tuple preferred while every worked example (and
 *  `examples/contacts/App.tsx`) used the object form, so a reader following
 *  the code reached for the shape the reference told them not to. The honest
 *  rule is what each is FOR — the tuple for a scalar
 *  (`const [text, setText] = useLocal("")`), the object when you want `patch`
 *  (`draft.patch({ email })` on a form), which the tuple cannot express.
 *
 *  The tuple side is destructuring-only (backed by an iterator) — don't index
 *  it (`result[0]`); use `.local` for direct reads. */
export type UseLocalResult<T> =
  & {
    readonly local: T;
    set: (next: T | ((prev: T) => T)) => void;
    patch: T extends Record<string, unknown> ? (partial: Partial<T>) => void
      : never;
  }
  & readonly [T, (next: T | ((prev: T) => T)) => void];

/** Component-local reactive state — the signal you would otherwise create by
 *  hand, scoped to this instance and disposed with it. One call returns both
 *  the tuple form `[value, set]` and the object form (`.local`/`.set`/
 *  `.patch`); see {@linkcode UseLocalResult} for which to reach for. */
export function useLocal<T>(
  initial: T,
): UseLocalResult<T> {
  const ref = useRef<ReturnType<typeof signal<T>> | null>(null);
  if (!ref.current) ref.current = signal(initial);
  const sig = ref.current;
  const result = {
    get local(): T {
      return sig.value;
    },
    // Tuple form: const [text, setText] = useLocal("") — reads the signal at
    // destructure time (same reactivity as reading .local during render).
    *[Symbol.iterator](): Iterator<unknown> {
      yield sig.value;
      yield (next: T | ((prev: T) => T)) => {
        if (typeof next === "function") sig.update(next as (prev: T) => T);
        else sig.set(next);
      };
    },
    set: (next: T | ((prev: T) => T)) => {
      // AIO-66: Accept updater function like React's useState
      if (typeof next === "function") {
        sig.update(next as (prev: T) => T);
      } else {
        sig.set(next);
      }
    },
    // AIO-66: Partial updates for object state — merge with current
    patch: ((partial: Partial<T>) => {
      const current = sig.peek();
      if (current && typeof current === "object" && !Array.isArray(current)) {
        sig.set({ ...current, ...partial });
        return;
      }
      // There is nothing to merge INTO, and pretending otherwise means a UI
      // that simply never updates. The type already says `never` for non-object
      // state, so reaching this is a cast or untyped call — the two cases where
      // a silent no-op is least likely to be noticed and most likely to be
      // blamed on the framework.
      throw new Error(
        `[aio] useLocal().patch() needs object state to merge into, but this ` +
          `local holds ${
            Array.isArray(current) ? "an array" : typeof current
          }. Use .set(next) — or .set(prev => …) — for arrays and primitives.`,
      );
    }) as T extends Record<string, unknown> ? (partial: Partial<T>) => void
      : never,
  };
  return result as unknown as UseLocalResult<T>;
}

/** Returns `true` when the WebSocket/IPC transport is connected to the server. */
export function useConnected(): boolean {
  return getConnectedSignal().value;
}
