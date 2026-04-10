// browser-air-hooks: AIR signal-based hooks (useCell, useAio, useLocal, useConnected, useProjection, memo)

import {
  useAio as _airUseAio,
  useCell as _airUseCell,
  useConnected as _airUseConnected,
  useLocal as _airUseLocal,
} from "./adapters/air.ts";
import { useRef } from "./aio-renderer.ts";
import { _projectWithSharing, ensureConnected } from "./browser-protocol.ts";
import type { _CoreCellRef as CellRef } from "./browser-protocol.ts";
import type {
  CellDef,
  DirectCalling,
  ExtractState,
  SendOf,
} from "./cell-types.ts";

// AIO-67 + AIO-75: Typed overloads -- infer State and Send from CellDef
/** Subscribe to a cell — use direct cell access instead for new code. */
export function useCell<
  // deno-lint-ignore no-explicit-any
  F extends CellDef<any, any, any, any> & DirectCalling<any, any>,
>(
  ref: F,
): {
  state: ExtractState<F>;
  send: SendOf<F>;
  status: string | undefined;
};
/** Subscribe to a cell — use direct cell access instead for new code. */
export function useCell<
  S extends Record<string, unknown> = Record<string, unknown>,
>(
  ref: CellRef,
): {
  state: S;
  send: Record<string, (...args: unknown[]) => void>;
  status: string | undefined;
};
/** Subscribe to a cell — use direct cell access instead for new code. */
// deno-lint-ignore no-explicit-any
export function useCell(ref: any): any {
  ensureConnected();
  const result = _airUseCell(ref);
  const status = result.state
    ? (result.state as Record<string, unknown>).__aio_status as
      | string
      | undefined
    : undefined;
  return { state: result.state, send: result.send, status };
}

/** AIR useAio -- full global state, signal-based. Calls ensureConnected(). */
export function useAio<
  S extends Record<string, unknown> = Record<string, unknown>,
>(): {
  state: S;
  send: (action: { type: string; payload?: unknown }) => void;
} {
  ensureConnected();
  return _airUseAio<S>();
}

/** AIR useLocal -- signal-backed local state. No server connection needed.
 *  set() accepts value or updater function. patch() merges partial object updates. */
export function useLocal<T>(
  initial: T,
): {
  readonly local: T;
  set: (next: T | ((prev: T) => T)) => void;
  patch: T extends Record<string, unknown> ? (partial: Partial<T>) => void
    : never;
} {
  return _airUseLocal(initial);
}

/** AIR useConnected -- signal-based connection status. Calls ensureConnected(). */
export function useConnected(): boolean {
  ensureConnected();
  return _airUseConnected();
}

/** Derives state from a transformation, preserving element-level references.
 *  Signal-based -- reads auto-track in AIR renderer scope.
 */
export function useProjection<T>(fn: () => T, _deps?: unknown[]): T {
  // In AIR, fn() reads signals which auto-track (deps ignored).
  // useRef persists prev across renders for reference-stable memo.
  const prevRef = useRef<T | null>(null);
  const raw = fn();
  const projected = _projectWithSharing(raw, prevRef.current);
  prevRef.current = projected;
  return projected;
}

/** No-op in AIR -- the renderer has built-in auto-memo via shallow prop comparison. */
export function memo<P extends Record<string, unknown>>(
  Component: (props: P) => unknown,
  _compare?: (prev: P, next: P) => boolean,
): (props: P) => unknown {
  return Component;
}
