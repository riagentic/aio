// deno-lint-ignore-file
// Browser-air: AIR renderer entry point for aio.
// ZERO React imports — uses signal-based hooks from adapters/air.ts
// and AIR renderer primitives (createContext, useContext, onMount, h).

import {
  useAio as _airUseAio,
  useConnected as _airUseConnected,
  useFeature as _airUseFeature,
  useLocal as _airUseLocal,
} from "./adapters/air.ts";
import { createContext, onMount, useContext, useRef } from "./aio-renderer.ts";
import { type ComponentFn, h, type VChild } from "./vdom.ts";
import { useTimeTravel } from "./time-travel-air.ts";

// ── Protocol imports (renderer-agnostic) ───────────────────────────
import {
  _accessedPaths,
  _applyPatch,
  _BLOCKED_KEYS,
  _checkStateIntegrity,
  _checkWastedRenders,
  _collapsePaths,
  // State-core pass-throughs (routed through protocol layer)
  _coreGetState,
  _coreHandleMessage,
  _coreHasState,
  _coreResendSubs,
  _coreSetConnected,
  _coreSetTransport,
  _deepMergeFiltered,
  // Public re-exports
  _getArrayRefStats,
  type _HandleResult,
  _incStateVersion,
  _memoCompare,
  _preserveArrayRefs,
  _projectWithSharing,
  _rebuildIdMaps,
  _resetArrayRefStats,
  _resetTracking,
  _resolveStateReady,
  _setClientSend,
  // Transport wiring
  _setConnectFn,
  _setSubscribeTriggers,
  _setTeardownFn,
  _shallowEqual,
  _subscribe,
  _trackingProxy,
  _useAioSubscribe,
  _waitForState,
  aio,
  bridge,
  client,
  connectDevTools,
  disconnectDevTools,
  ensureConnected,
  feature,
  type LinkProps,
  log,
  matchPath,
  navigate,
  routePath,
  type RouteProps,
  routeSearch,
  type RouteState,
} from "./browser-protocol.ts";

// ── Minimal WS transport (AIR — no React, no vitals) ───────────────
// browser.ts has the full transport with React-specific vitals, render meter,
// tree walking, etc. AIR only needs the WS ↔ state-core bridge.

let _ws: WebSocket | null = null;
let _closed = false;
let _connecting = false;
let _wasConnected = false;
let _retry = 0;
let _queue: Array<{ type: string; payload?: unknown }> = [];
const _bootId: { current: string | null } = { current: null };

const _ipc: AioIPCBridge | null = detectIPC();
let _ipcConnected = false;
let _ipcPingTimer: ReturnType<typeof setInterval> | null = null;

function _showStatus(text: string, _color: string, _ms?: number) {
  console.debug("[aio:air]", text);
}

function _handleState(data: Record<string, unknown>) {
  const result: _HandleResult = _coreHandleMessage(data);
  if (result === "dropped") return;
  if (result === "noop") return;
  _checkStateIntegrity(_coreGetState());
  _incStateVersion();
  if (_coreHasState()) _resolveStateReady();
}

function _connectIPC() {
  if (!_ipc || _ipcConnected) return;
  _ipcConnected = true;

  _ipc.onOpen(() => {
    _connecting = false;
    _retry = 0;
    if (_wasConnected) _showStatus("Connected", "#2a2");
    _wasConnected = true;
    _coreSetTransport({ send: (d: string) => _ipc!.send(d), close: () => {} });
    _coreSetConnected(true);
    _coreResendSubs();
    const q = _queue;
    _queue = [];
    for (const a of q) _ipc!.send(JSON.stringify(a));
    if (!_ipcPingTimer) {
      _ipcPingTimer = setInterval(() => {
        if (_ipc && _ipcConnected) _ipc.send("__ping");
      }, 60_000);
    }
  });

  _ipc.onMessage((line: string) => {
    if (handleControlMessage(line, _bootId)) return;
    // Skip React-only commands (__getState, __click, __tt, __diag)
    if (line.startsWith("__")) return;
    try {
      const data = JSON.parse(line);
      if (data === null || typeof data !== "object") return;
      _handleState(data);
    } catch (err) {
      console.warn("[aio:air] bad state message:", err);
    }
  });

  _ipc.onClose(() => {
    _ipcConnected = false;
    _coreSetTransport(null);
    _coreSetConnected(false);
    if (_ipcPingTimer) {
      clearInterval(_ipcPingTimer);
      _ipcPingTimer = null;
    }
    if (_closed) return;
    if (_wasConnected) _showStatus("Reconnecting\u2026", "#e25");
  });

  _ipc.ready();
}

function _connect() {
  if (_closed) return;

  // UDS mode: Electron IPC bridge
  if (_ipc && !_ws) {
    _connectIPC();
    return;
  }

  if (_ws) return;
  const ws = new WebSocket(buildWsUrl());
  ws.onopen = () => {
    _connecting = false;
    _retry = 0;
    _coreSetTransport({
      send: (d: string) => ws.send(d),
      close: () => ws.close(),
    });
    _coreSetConnected(true);
    ws.send(
      "__type:" +
        (typeof navigator !== "undefined" &&
            /electron/i.test(navigator.userAgent)
          ? "electron"
          : "browser"),
    );
    if (_wasConnected) _showStatus("Connected", "#2a2");
    _wasConnected = true;
    _coreResendSubs();
    const q = _queue;
    _queue = [];
    for (const a of q) ws.send(JSON.stringify(a));
  };
  ws.onmessage = (e) => {
    if (typeof e.data === "string" && handleControlMessage(e.data, _bootId)) {
      return;
    }
    // Skip React-only WS commands
    if (typeof e.data === "string" && e.data.startsWith("__")) return;
    try {
      const data = JSON.parse(e.data);
      if (data === null || typeof data !== "object") return;
      _handleState(data);
    } catch (err) {
      console.warn("[aio:air] bad state message:", err);
    }
  };
  ws.onclose = () => {
    _ws = null;
    _coreSetTransport(null);
    _coreSetConnected(false);
    if (_closed) return;
    if (_wasConnected) _showStatus("Reconnecting\u2026", "#e25");
    const delay = Math.min(1000 * 2 ** _retry, 30000);
    _retry++;
    setTimeout(() => {
      _connecting = true;
      _connect();
    }, delay);
  };
  ws.onerror = () => ws.close();
  _ws = ws;
}

function _send(action: { type: string; payload?: unknown }) {
  const tagged = { ...action, _source: "UI" };
  const json = JSON.stringify(tagged);
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(json);
  } else if (_ipc && _ipcConnected) {
    _ipc.send(json);
  } else {
    _queue.push(tagged);
  }
}

// Wire transport into protocol layer
_setConnectFn(() => {
  if (!_ws && !_ipcConnected && !_connecting) {
    _closed = false;
    _connecting = true;
    _connect();
  }
});

_setSubscribeTriggers(
  () => {
    if (!_ws && !_ipcConnected && !_connecting) {
      _closed = false;
      _connecting = true;
      _connect();
    }
  },
  () => {},
);

_setTeardownFn(() => {
  _closed = true;
  _ws?.close();
  _ws = null;
  _ipcConnected = false;
  _connecting = false;
  if (_ipcPingTimer) {
    clearInterval(_ipcPingTimer);
    _ipcPingTimer = null;
  }
  _queue = [];
  _retry = 0;
});

_setClientSend(_send);

// ── Public re-exports (same surface as browser.ts) ─────────────────
export {
  _accessedPaths,
  _applyPatch,
  _BLOCKED_KEYS,
  _checkStateIntegrity,
  _checkWastedRenders,
  _collapsePaths,
  _deepMergeFiltered,
  _getArrayRefStats,
  _memoCompare,
  _preserveArrayRefs,
  _projectWithSharing,
  _rebuildIdMaps,
  _resetArrayRefStats,
  _resetTracking,
  _shallowEqual,
  _subscribe,
  _trackingProxy,
  _useAioSubscribe,
  _waitForState,
  aio,
  bridge,
  client,
  connectDevTools,
  disconnectDevTools,
  ensureConnected,
  feature,
  log,
  matchPath,
  navigate,
  routePath,
  routeSearch,
};
export type { LinkProps, RouteProps, RouteState };

// useTimeTravel — signal-based AIR version
export { useTimeTravel };

// ── AIR renderer primitives (AIO-70) ─────────────────────────────────
export {
  type Context,
  createContext,
  hydrate,
  mount,
  type MountHandle,
  onCleanup,
  onMount,
  useContext,
  useRef,
} from "./aio-renderer.ts";
export { type ComponentFn, h, type VChild, type VNode } from "./vdom.ts";
export {
  batch,
  type Computed,
  computed,
  effect,
  type Signal,
  signal,
} from "./signal.ts";

// ── Shared utilities (AIO-47) ──
export { actions, effects, msg, schedule } from "./browser-shared.ts";
import {
  type AioIPCBridge,
  buildWsUrl,
  detectIPC,
  handleControlMessage,
  refreshCSS,
} from "./browser-shared.ts";

// ── AIR hooks (signal-based, with ensureConnected) ─────────────────

import type { _CoreFeatureRef as FeatureRef } from "./browser-protocol.ts";

// AIO-67: Typed overload — infer State from FeatureDef generic
/** AIR useFeature — signal-based, auto-tracked. Calls ensureConnected().
 *  Pass a feature definition to get full type inference on state and send. */
export function useFeature<
  S extends Record<string, unknown> = Record<string, unknown>,
>(
  ref: FeatureRef & { __aio: { state?: S } },
): {
  state: S;
  send: Record<string, (...args: unknown[]) => void>;
  status: string | undefined;
} {
  ensureConnected();
  const result = _airUseFeature<S>(ref);
  const status = result.state
    ? (result.state as Record<string, unknown>)._status as string | undefined
    : undefined;
  return { state: result.state, send: result.send, status };
}

/** AIR useAio — full global state, signal-based. Calls ensureConnected(). */
export function useAio<
  S extends Record<string, unknown> = Record<string, unknown>,
>(): {
  state: S;
  send: (action: { type: string; payload?: unknown }) => void;
} {
  ensureConnected();
  return _airUseAio<S>();
}

/** AIR useLocal — signal-backed local state. No server connection needed.
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

/** AIR useConnected — signal-based connection status. Calls ensureConnected(). */
export function useConnected(): boolean {
  ensureConnected();
  return _airUseConnected();
}

// ── useProjection (signal-based) ───────────────────────────────────

import { signal as _signal } from "./signal.ts";

/** Derives state from a transformation, preserving element-level references.
 *  Signal-based — reads auto-track in AIR renderer scope.
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

// ── memo (no-op in AIR — auto-memo built into renderer) ────────────

/** No-op in AIR — the renderer has built-in auto-memo via shallow prop comparison. */
export function memo<P extends Record<string, unknown>>(
  Component: (props: P) => unknown,
  _compare?: (prev: P, next: P) => boolean,
): (props: P) => unknown {
  return Component;
}

// ── page (using h()) ───────────────────────────────────────────────

/** Renders the component matching the current page key. */
export function page<K extends string>(
  current: K,
  routes: Record<K, (props: Record<string, never>) => unknown>,
): unknown {
  const Component = routes[current];
  return Component ? h(Component as ComponentFn, null) : null;
}

// ── Router (AIR signal-based) ──────────────────────────────────────

/** Current route state — reads routePath/routeSearch signals (auto-tracked by AIR). */
export function useRoute(pattern?: string): RouteState {
  ensureConnected();
  const path = routePath.value; // auto-tracked signal read
  const search = routeSearch.value;
  if (!pattern) return { path, params: {}, search, matched: true };
  const params = matchPath(pattern, path);
  return { path, params: params ?? {}, search, matched: params !== null };
}

/** Returns the navigate function. */
export function useNavigate(): (
  to: string | number,
  opts?: { replace?: boolean },
) => void {
  return navigate;
}

// ── Route context (nested routes + Outlet) ─────────────────────────

type _RouteCtxType = {
  basePath: string;
  params: Record<string, string>;
  outlet: unknown;
};
const _RouteCtx = createContext<_RouteCtxType>({
  basePath: "",
  params: {},
  outlet: null,
});

/** Renders element when path matches. Nest inside other Routes for layouts with Outlet. */
export function Route({ path, index, element, children }: RouteProps): unknown {
  ensureConnected();
  const currentPath = routePath.value; // auto-tracked signal read
  const { basePath, params: parentParams } = useContext(_RouteCtx);

  if (index) {
    const base = basePath || "/";
    const match = currentPath === base ||
      currentPath === base.replace(/\/$/, "") ||
      base === "/" && currentPath === "/";
    if (!match) return null;
    return element ?? null;
  }

  if (!path) return null;
  const full =
    (basePath + "/" + path.replace(/^\//, "")).replace(/\/+/g, "/").replace(
      /(.)\/$/,
      "$1",
    ) || "/";
  const hasChildren = !!children;
  const params = matchPath(full, currentPath, !hasChildren);
  if (!params) return null;

  const allParams = { ...parentParams, ...params };
  return h(
    _RouteCtx.Provider,
    {
      value: {
        basePath: full,
        params: allParams,
        outlet: hasChildren ? children : null,
      },
    },
    (hasChildren
      ? (element ?? h(Outlet as ComponentFn, {}))
      : element ?? null) as VChild,
  );
}

/** Renders the matching child route inside a parent Route's element. */
export function Outlet(): unknown {
  const { outlet } = useContext(_RouteCtx);
  return outlet ?? null;
}

/** Anchor that navigates without page reload. Adds activeClass when path matches. */
export function Link(
  { to, replace: rep, exact, activeClass, activeStyle, children, ...rest }:
    LinkProps,
): unknown {
  const path = routePath.value; // auto-tracked signal read
  const isActive = (exact || to === "/")
    ? path === to
    : path === to || path.startsWith(to + "/");
  function handleClick(e: Event) {
    const me = e as MouseEvent;
    if (
      me.button !== 0 || me.metaKey || me.ctrlKey || me.shiftKey || me.altKey
    ) return;
    e.preventDefault();
    navigate(to, { replace: rep });
  }
  const cls = isActive && activeClass
    ? [rest.className, activeClass].filter(Boolean).join(" ")
    : rest.className;
  const sty = isActive && activeStyle
    ? { ...rest.style, ...activeStyle }
    : rest.style;
  return h("a", {
    ...rest,
    href: to,
    onClick: handleClick,
    className: cls,
    style: sty,
  }, children as VChild);
}

/** Link with automatic 'active' class. */
export function NavLink(
  { activeClass = "active", ...rest }: Omit<LinkProps, "activeClass"> & {
    activeClass?: string;
  },
): unknown {
  return Link({ activeClass, ...rest } as LinkProps);
}

/** Navigates to `to` on mount. Replace=true by default (no history entry). */
export function Redirect(
  { to, replace: rep = true }: { to: string; replace?: boolean },
): null {
  onMount(() => {
    navigate(to, { replace: rep });
  });
  return null;
}
