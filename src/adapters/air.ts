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
} {
  trackPath("*");
  const sig = getStateSignal();

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

  return { state, send };
}

/** Client-only reactive state — not synced to server. Returns `{ local, set, patch }`. */
/** Result of {@linkcode useLocal} — object form (`{ local, set, patch }`)
 *  AND tuple form (`const [value, set] = useLocal(init)`); pick either.
 *  The tuple side is destructuring-only (backed by an iterator) — don't
 *  index it (`result[0]`); use `.local` for direct reads. */
export type UseLocalResult<T> =
  & {
    readonly local: T;
    set: (next: T | ((prev: T) => T)) => void;
    patch: T extends Record<string, unknown> ? (partial: Partial<T>) => void
      : never;
  }
  & readonly [T, (next: T | ((prev: T) => T)) => void];

/** Component-local reactive state — the signal you would otherwise create by
 *  hand, scoped to this instance and disposed with it. Returns the tuple form
 *  `[value, set]` and the object form (`.value`/`.set`/`.patch`) from one call. */
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
      }
    }) as T extends Record<string, unknown> ? (partial: Partial<T>) => void
      : never,
  };
  return result as unknown as UseLocalResult<T>;
}

/** Returns `true` when the WebSocket/IPC transport is connected to the server. */
export function useConnected(): boolean {
  return getConnectedSignal().value;
}
