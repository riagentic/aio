/**
 * @module
 * React adapter — bridges state-core signals to React via `useSyncExternalStore`.
 *
 * Provides the same `useCell`/`useAio`/`useLocal`/`useConnected` API as the
 * AIR adapter but using React's reactivity mechanism.
 *
 * @example
 * ```ts
 * import { useCell } from "aio/adapters/react";
 * const { state, send } = useCell(myCell);
 * ```
 */

import { useCallback, useState, useSyncExternalStore } from "react";
import {
  _resolveWithFallback,
  _trackingProxy,
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

// ── Cell send cache ──────────────────────────────────────────────

const _cellSendCache = new WeakMap<
  CellRef,
  Record<string, (...args: unknown[]) => void>
>();

function _getCachedSend(
  ref: CellRef,
): Record<string, (...args: unknown[]) => void> {
  let obj = _cellSendCache.get(ref);
  if (!obj) {
    obj = createSendProxy(ref.__aio.id, ref);
    _cellSendCache.set(ref, obj);
  }
  return obj;
}

// ── Hooks ───────────────────────────────────────────────────────────

/**
 * Subscribe to a cell's server state via React.
 * Same { state, send } contract as AIR adapter.
 */
// Typed overload — when passing a cell def with DirectCalling methods
export function useCell<
  // deno-lint-ignore no-explicit-any
  F extends CellDef<any, any, any, any> & DirectCalling<any, any>,
>(
  ref: F,
  options?: { fallback?: ExtractState<F> },
): { state: ExtractState<F>; send: SendOf<F>; status?: string };
// Untyped overload — for dynamic CellRef usage
export function useCell<S = unknown>(
  ref: CellRef,
  options?: { fallback?: S },
): {
  state: S;
  send: Record<string, (...args: unknown[]) => void>;
  status?: string;
};
// Implementation
// deno-lint-ignore no-explicit-any
export function useCell(ref: any, options?: any): any {
  const name = ref.__aio.id;
  trackPath(name);

  const sig = getCellSignal(name, ref.__aio.state);

  const subscribe = useCallback(
    (cb: () => void) => sig.subscribe(cb),
    [name],
  );
  const getSnapshot = useCallback(
    () => sig.peek(),
    [name],
  );

  const cellState = useSyncExternalStore(subscribe, getSnapshot, () => null);

  // AIO-29 defense: merge with fallback/defaults
  const defaults = options?.fallback ?? ref.__aio.state;
  const resolved = _resolveWithFallback(cellState, defaults);

  const status = resolved
    ? (resolved as Record<string, unknown>).__aio_status as string | undefined
    : undefined;
  return {
    state: _trackingProxy(resolved, name),
    send: _getCachedSend(ref),
    status,
  };
}

/**
 * Subscribe to the entire app state via React.
 * Re-renders on every state change — prefer useCell for scoped updates.
 */
export function useAio<S = unknown>(): {
  state: S;
  send: (action: { type: string; payload?: unknown }) => void;
} {
  trackPath("*");
  const sig = getStateSignal();

  const subscribe = useCallback(
    (cb: () => void) => sig.subscribe(cb),
    [],
  );
  const getSnapshot = useCallback(
    () => sig.peek(),
    [],
  );

  const state = useSyncExternalStore(subscribe, getSnapshot, () => null);
  return { state: _trackingProxy(state) as S, send };
}

/**
 * Local component state via React's useState.
 * Same API as AIR adapter's useLocal for adapter contract compatibility (AIO-158).
 */
export function useLocal<T>(
  initial: T,
): {
  readonly local: T;
  set: (next: T | ((prev: T) => T)) => void;
  patch: T extends Record<string, unknown> ? (partial: Partial<T>) => void
    : never;
} {
  const [value, setValue] = useState(initial);
  return {
    get local() {
      return value;
    },
    set: setValue as (next: T | ((prev: T) => T)) => void,
    patch: ((partial: Partial<T>) => {
      setValue((prev) => {
        if (prev && typeof prev === "object" && !Array.isArray(prev)) {
          return { ...prev, ...partial };
        }
        return prev;
      });
    }) as T extends Record<string, unknown> ? (partial: Partial<T>) => void
      : never,
  };
}

/**
 * Subscribe to connection status via React.
 */
export function useConnected(): boolean {
  const sig = getConnectedSignal();
  const subscribe = useCallback(
    (cb: () => void) => sig.subscribe(cb),
    [],
  );
  const getSnapshot = useCallback(() => sig.peek(), []);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
