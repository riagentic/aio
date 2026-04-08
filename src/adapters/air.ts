/**
 * @module
 * AIR adapter — signal-based hooks for AIO native renderer.
 *
 * `useCell`/`useAio` read from state-core signals directly.
 * Signal reads auto-track in AIR's per-component scope.
 *
 * @example
 * ```ts
 * import { useCell } from "aio/adapters/air";
 * const { state, send } = useCell(myCell);
 * ```
 */

import { signal } from "../signal.ts";
import { useRef } from "../aio-renderer.ts";
import {
  type CellRef,
  createSendProxy,
  getCellSignal,
  getConnectedSignal,
  getStateSignal,
  send,
  trackPath,
} from "../state-core.ts";
import type {
  CellDef,
  DirectCalling,
  ExtractState,
  SendOf,
} from "../cell-types.ts";

// Typed overload — when passing a cell def with DirectCalling methods
export function useCell<
  // deno-lint-ignore no-explicit-any
  F extends CellDef<any, any, any, any> & DirectCalling<any, any>,
>(
  ref: F,
): { state: ExtractState<F>; send: SendOf<F> };
// Untyped overload — for dynamic CellRef usage
export function useCell<
  S extends Record<string, unknown> = Record<string, unknown>,
>(
  ref: CellRef,
): { state: S; send: Record<string, (...args: unknown[]) => void> };
// Implementation
// deno-lint-ignore no-explicit-any
export function useCell(ref: any): any {
  const name = ref.__aio.id;
  const sig = getCellSignal(name, ref.__aio.state);
  trackPath(name);

  // deno-lint-ignore no-explicit-any
  const state = new Proxy({} as any, {
    get(_target, prop: string | symbol): unknown {
      if (typeof prop === "symbol") return undefined;
      const s = sig.value; // tracked read — auto-tracked by AIR renderer
      if (s == null) {
        const fallback = ref.__aio.state as Record<string, unknown> | undefined;
        return fallback ? fallback[prop] : undefined;
      }
      return (s as Record<string, unknown>)[prop];
    },
    ownKeys(): string[] {
      const s = sig.value;
      return s ? Object.keys(s as Record<string, unknown>) : [];
    },
    has(_target, prop: string | symbol): boolean {
      if (typeof prop === "symbol") return false;
      const s = sig.value;
      return s ? prop in (s as Record<string, unknown>) : false;
    },
    getOwnPropertyDescriptor(
      _target,
      prop: string | symbol,
    ): PropertyDescriptor | undefined {
      if (typeof prop === "symbol") return undefined;
      const s = sig.value;
      if (!s || !(prop in (s as Record<string, unknown>))) return undefined;
      return {
        configurable: true,
        enumerable: true,
        value: (s as Record<string, unknown>)[prop as string],
      };
    },
  });

  return { state, send: createSendProxy(name, ref) };
}

/** Subscribe to the full app state. Prefer `useCell` for scoped access. */
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
export function useLocal<T>(
  initial: T,
): {
  readonly local: T;
  set: (next: T | ((prev: T) => T)) => void;
  patch: T extends Record<string, unknown> ? (partial: Partial<T>) => void
    : never;
} {
  const ref = useRef<ReturnType<typeof signal<T>> | null>(null);
  if (!ref.current) ref.current = signal(initial);
  const sig = ref.current;
  return {
    get local(): T {
      return sig.value;
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
}

/** Returns `true` when the WebSocket/IPC transport is connected to the server. */
export function useConnected(): boolean {
  return getConnectedSignal().value;
}
