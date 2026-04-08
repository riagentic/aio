// deno-lint-ignore-file
// React hooks for aio — useAio, useCell, useLocal, useConnected, useProjection, memo, page.

import {
  type ComponentType,
  createElement,
  memo as _reactMemo,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  _cellSendCache,
  type _CoreCellRef,
  _coreCreateSendProxy,
  _coreGetConnectedSignal,
  _coreGetState,
  _coreHasState,
  _coreResolveWithFallback,
  _coreTrackPath,
  _getServerSnapshot,
  _getSnapshot,
  _memoCompare,
  _projectWithSharing,
  _subscribe,
  _trackingProxy,
  _useAioSubscribe,
} from "./browser-protocol.ts";
import { _send } from "./browser-transport.ts";

// ── useAio ────────────────────────────────────────────────────────

/** React hook — full app state + untyped send. Deep-proxy-tracked: only accessed paths
 *  are sent by the server. Use `useCell(f)` for scoped re-renders (this hook
 *  re-renders on every state change; useCell re-renders only when its cell changes). */
export function useAio<S = unknown>(): {
  state: S;
  send: (action: { type: string; payload?: unknown }) => void;
} {
  const state = useSyncExternalStore(
    _useAioSubscribe,
    _getSnapshot,
    _getServerSnapshot,
  ) as S | null;
  return { state: _trackingProxy(state) as S, send: _send };
}

// ── useCell ───────────────────────────────────────────────────────

function _getCachedSend(
  ref: _CoreCellRef,
): Record<string, (...args: unknown[]) => void> {
  let obj = _cellSendCache.get(ref);
  if (!obj) {
    obj = _coreCreateSendProxy(ref.__aio.id, ref, _send);
    _cellSendCache.set(ref, obj);
  }
  return obj;
}

/** v0.5 hook — connects UI to a specific cell with scoped state, typed send, and machine status.
 *  Uses selector-based subscription: only re-renders when this cell's slice changes.
 *
 *  Pass `fallback` to skip the `state: S | null` guard — useful for Electron/local apps where
 *  connection is near-instant and you want components to render immediately with initial state.
 */
export function useCell<S>(
  ref: _CoreCellRef,
  options: { fallback: S },
): {
  state: S;
  send: Record<string, (...args: unknown[]) => void>;
  status: string | undefined;
};
export function useCell<S = unknown>(
  ref: _CoreCellRef,
  options?: { fallback?: never },
): {
  state: S | null;
  send: Record<string, (...args: unknown[]) => void>;
  status: string | undefined;
};
export function useCell<S = unknown>(
  ref: _CoreCellRef,
  options?: { fallback?: S },
): {
  state: S;
  send: Record<string, (...args: unknown[]) => void>;
  status: string | undefined;
} {
  const name = ref.__aio.id;

  _coreTrackPath(name);

  const getSliceSnapshot = useCallback((): S | null => {
    if (!_coreHasState()) return null;
    return (_coreGetState() as Record<string, unknown>)[name] as S | null;
  }, [name]);

  const cellState = useSyncExternalStore(
    _subscribe,
    getSliceSnapshot,
    _getServerSnapshot as () => S | null,
  );

  // AIO-29 defense: deep-merge with cell's initial state or explicit fallback
  const defaults = options?.fallback ?? (ref.__aio.state as S | undefined);
  const resolved = _coreResolveWithFallback(cellState, defaults);

  const status = resolved
    ? (resolved as Record<string, unknown>).__aio_status as string | undefined
    : undefined;

  return {
    state: _trackingProxy(resolved, name) as S,
    send: _getCachedSend(ref),
    status,
  };
}

// ── useLocal ──────────────────────────────────────────────────────

/** Client-only state — not synced to server, not persisted. For UI-local concerns. */
export function useLocal<T>(
  initial: T,
): { local: T; set: (next: T | ((prev: T) => T)) => void } {
  const [local, setLocal] = useState<T>(initial);
  return { local, set: setLocal };
}

// ── useConnected ──────────────────────────────────────────────────

/** Subscribe to connection status (connected to server or not). */
export function useConnected(): boolean {
  const sig = _coreGetConnectedSignal();
  const subscribe = useCallback(
    (cb: () => void) => sig.subscribe(cb),
    [],
  );
  const getSnapshot = useCallback(() => sig.peek(), []);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

// ── useProjection ─────────────────────────────────────────────────

/** Derives state from a transformation, preserving element-level references.
 *
 *  Like `useMemo`, but when the transform re-runs and returns an array,
 *  `_preserveArrayRefs` is applied — unchanged elements keep their previous
 *  object reference, enabling `memo()` to skip re-renders.
 */
export function useProjection<T>(fn: () => T, deps: unknown[]): T {
  const prevRef = useRef<T | null>(null);
  const result = useMemo(() => {
    const raw = fn();
    const projected = _projectWithSharing(raw, prevRef.current);
    prevRef.current = projected;
    return projected;
  }, deps);
  return result;
}

// ── memo ──────────────────────────────────────────────────────────

/** Drop-in replacement for React.memo with smarter default comparison.
 *
 *  Uses `_shallowEqual` on each prop (one level deeper than React.memo's default `===`).
 *  Catches the case where a parent creates new container objects that are
 *  structurally identical to previous props.
 */
export function memo<P extends Record<string, any>>(
  Component: ComponentType<P>,
  compare?: (prev: P, next: P) => boolean,
): ComponentType<P> {
  return _reactMemo(
    Component,
    compare ?? _memoCompare as (prev: P, next: P) => boolean,
  ) as unknown as ComponentType<P>;
}

// ── page ──────────────────────────────────────────────────────────

/** Renders the component matching the current page key.
 *  Usage: `page(state.page, { home: Home, settings: Settings })` */
export function page<K extends string>(
  current: K,
  routes: Record<K, ComponentType>,
): ReturnType<typeof createElement> | null {
  const Component = routes[current];
  return Component ? createElement(Component) : null;
}
