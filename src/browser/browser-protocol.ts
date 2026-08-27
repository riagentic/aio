// deno-lint-ignore-file
// Browser-protocol: renderer-agnostic protocol layer for aio.
// browser-air.ts (AIR renderer) imports from here.
//
// This file is the thin orchestrator. Logic lives in:
//   ../protocol/protocol-types.ts        — types + constants
//   ../protocol/protocol-diagnostics.ts  — _diagEmit, state integrity
//   ../protocol/protocol-status.ts       — DOM connection status widget
//   ./protocol-devtools.ts               — Redux DevTools integration
//   ./protocol-router.ts                 — client-side router
//   ./protocol-cell.ts                   — cell(), aio stubs
//   ./protocol-subscription.ts           — listeners, vitals state, readiness

import {
  _accessedPaths as _coreAccessedPaths,
  _BLOCKED_KEYS as _coreBLOCKED_KEYS,
  _checkWastedRenders as _coreCheckWastedRenders,
  _getArrayRefStats as _coreGetArrayRefStats,
  _getState as _coreGetState,
  _offlineQueueFullness as _coreOfflineQueueFullness,
  _preserveArrayRefs as _corePreserveArrayRefs,
  _reset as _coreReset,
  _resetArrayRefStats as _coreResetArrayRefStats,
  _resolveWithFallback as _coreResolveWithFallback,
  _shallowEqual as _coreShallowEqual,
  _trackingProxy as _coreTrackingProxy,
  cancelSubsTimer as _coreCancelSubsTimer,
  type CellRef as _CoreCellRef,
  collapsePaths as _coreCollapsePaths,
  createSendProxy as _coreCreateSendProxy,
  getConnectedSignal as _coreGetConnectedSignal,
  handleMessage as _coreHandleMessage,
  type HandleResult as _HandleResult,
  isInitialStateReceived as _coreHasState,
  resendSubscriptions as _coreResendSubs,
  setConnected as _coreSetConnected,
  setTransport as _coreSetTransport,
  trackPath as _coreTrackPath,
  type Transport as _CoreTransport,
} from "../state-core.ts";
import {
  createRenderMeter,
  renderHint,
  type RenderMeterAPI,
} from "../vitals/render-meter.ts";
import { createTransportProbeClient } from "../vitals/transport-probe.ts";
import { resolveSyncCells } from "./sync-cells.ts";
import { _cfgSink } from "./browser-shared.ts";
import {
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_THRESHOLDS,
} from "../vitals/types.ts";
import { formatDiagEvent } from "../vitals/diag-formatter.ts";
import type { DiagEvent } from "../vitals/types.ts";
import { resetTT as _resetTT } from "../air/time-travel-panel.ts";
import { wrapTransport } from "../protocol/transport-shared.ts";

// ── Re-export state-core types/functions needed by browser-air.ts ───
export type { _CoreCellRef, _CoreTransport, _HandleResult };
export {
  _coreCreateSendProxy,
  _coreGetConnectedSignal,
  _coreGetState,
  _coreHandleMessage,
  _coreHasState,
  _coreOfflineQueueFullness,
  _coreResendSubs,
  _coreReset,
  _coreResolveWithFallback,
  _coreSetConnected,
  _coreSetTransport,
  _coreTrackPath,
};

// Re-export vitals/render-meter for browser-air.ts connection code
export {
  createRenderMeter,
  createTransportProbeClient,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_THRESHOLDS,
  type DiagEvent,
  formatDiagEvent,
  renderHint,
  type RenderMeterAPI,
};

// ── Re-exports from sub-modules ─────────────────────────────────────

export type {
  AioIPC,
  AioWindow,
  DevToolsConnection,
  LinkProps,
  RouteProps,
  RouteState,
} from "../protocol/protocol-types.ts";
export { WS_MAX_QUEUE } from "../protocol/protocol-types.ts";

import { _diagEmit } from "../protocol/protocol-diagnostics.ts";
export {
  _checkStateIntegrity,
  _diagEmit,
  _diagLastEmit,
  _resetInitialShapeKeys,
  _w,
} from "../protocol/protocol-diagnostics.ts";

export {
  _hideStatus,
  _resetStatus,
  _showStatus,
} from "../protocol/protocol-status.ts";

export {
  _devtools,
  _devtoolsConnected,
  _resetDevTools,
  _sendDevTools,
  connectDevTools,
  disconnectDevTools,
} from "./protocol-devtools.ts";

export {
  _getRPath,
  _getRSearch,
  _navigateHandler,
  _popstateHandler,
  _rListeners,
  _rSnapshot,
  _rSubscribe,
  _rSync,
  _setNavigateHandler,
  _setPopstateHandler,
  matchPath,
  navigate,
  routePath,
  routeSearch,
} from "./protocol-router.ts";

export { aio, cell } from "./protocol-cell.ts";

export {
  _cleanupTimer,
  _incStateVersion,
  _listenerHighWater,
  _listeners,
  _notify,
  _resetStateReady,
  _resetStateVersion,
  _resolveStateReady,
  _setCleanupTimer,
  _setConnectFn,
  _setListenerHighWater,
  _setSubscribeTriggers,
  _setTeardownFn,
  _setUseAioActiveCount,
  _setVitalsPingTimer,
  _setVitalsRenderMeter,
  _setVitalsTransportProbe,
  _setVitalsUrlLogged,
  _stateVersion,
  _subscribe,
  _useAioActiveCount,
  _useAioSubscribe,
  _useAioWarned,
  _vitalsPingTimer,
  _vitalsRenderMeter,
  _vitalsTransportProbe,
  _vitalsUrlLogged,
  _waitForState,
} from "./protocol-subscription.ts";

// ── Constants (re-export from state-core) ───────────────────────────

/** Prototype pollution guard — re-export from state-core. */
export const _BLOCKED_KEYS: Set<string> = _coreBLOCKED_KEYS;

// ── Array ref stats (AIO-11 wasted render detection) ────────────────
export const _getArrayRefStats = _coreGetArrayRefStats;
export const _resetArrayRefStats = _coreResetArrayRefStats;
export const _checkWastedRenders = _coreCheckWastedRenders;
export const _preserveArrayRefs = _corePreserveArrayRefs;
export const _shallowEqual = _coreShallowEqual;

// ── Subscription tracking re-exports ────────────────────────────────

export const _accessedPaths = _coreAccessedPaths;
export const _collapsePaths = (paths: Set<string>): string[] =>
  _coreCollapsePaths(paths);
export const _trackingProxy = _coreTrackingProxy;

export function _resetTracking(): void {
  _coreAccessedPaths.clear();
  _coreCancelSubsTimer();
}

// No `_getSnapshot` / `_getServerSnapshot` here. They were the other two
// thirds of a `useSyncExternalStore` triple next to `_subscribe`, from before
// AIR existed — and nothing in the framework, the tests or an app ever called
// them (`_getServerSnapshot` returned a bare `null`). AIR subscribes through
// signals, not a store snapshot; a seam that looks like an integration point
// but is wired to nothing is worse than no seam at all.

// ── _projectWithSharing ─────────────────────────────────────────────

export function _projectWithSharing<T>(result: T, prev: T | null): T {
  if (prev === null) return result;
  if (Array.isArray(result) && Array.isArray(prev)) {
    return _preserveArrayRefs(
      result as unknown[],
      prev as unknown[],
    ) as unknown as T;
  }
  if (
    result && typeof result === "object" && !Array.isArray(result) &&
    typeof prev === "object" && _shallowEqual(result, prev)
  ) {
    return prev;
  }
  return result;
}

// ── _memoCompare ────────────────────────────────────────────────────

export function _memoCompare(
  prevProps: Record<string, unknown>,
  nextProps: Record<string, unknown>,
): boolean {
  const prevKeys = Object.keys(prevProps);
  const nextKeys = Object.keys(nextProps);
  if (prevKeys.length !== nextKeys.length) return false;
  for (const key of prevKeys) {
    const pv = prevProps[key];
    const nv = nextProps[key];
    if (pv === nv) continue;
    if (
      pv && nv && typeof pv === "object" && typeof nv === "object" &&
      !Array.isArray(pv) && !Array.isArray(nv)
    ) {
      if (!_shallowEqual(pv, nv)) return false;
      continue;
    }
    return false;
  }
  return true;
}

// ── log ─────────────────────────────────────────────────────────────

export const log: {
  trace(cat: string, msg: string, data?: Record<string, unknown>): void;
  debug(cat: string, msg: string, data?: Record<string, unknown>): void;
  info(cat: string, msg: string, data?: Record<string, unknown>): void;
  warn(cat: string, msg: string, data?: Record<string, unknown>): void;
  error(cat: string, msg: string, data?: Record<string, unknown>): void;
} = {
  trace(_cat: string, _msg: string, _data?: Record<string, unknown>): void {},
  debug(_cat: string, _msg: string, _data?: Record<string, unknown>): void {},
  info(_cat: string, _msg: string, _data?: Record<string, unknown>): void {},
  warn(_cat: string, _msg: string, _data?: Record<string, unknown>): void {},
  error(_cat: string, _msg: string, _data?: Record<string, unknown>): void {},
};

// ── client API ──────────────────────────────────────────────────────
// _send is injected from browser-air.ts to avoid circular dep
let _clientSend:
  | ((
    action: { type: string; payload?: unknown; cid?: string },
  ) => void | Promise<unknown>)
  | null = null;
export function _setClientSend(
  fn: (
    action: { type: string; payload?: unknown; cid?: string },
  ) => void | Promise<unknown>,
): void {
  _clientSend = fn;
}

import {
  _getRPath,
  _getRSearch,
  _rListeners,
  navigate as _navigate,
} from "./protocol-router.ts";
import {
  _callConnectFn,
  _noteDispatch,
  _subscribe,
  _vitalsRenderMeter as _vmRenderMeter,
} from "./protocol-subscription.ts";

export const client: {
  subscribe(fn: (state: unknown) => void): () => void;
  getState(): unknown;
  getCellState(name: string): unknown;
  send(action: { type: string; payload?: unknown }): void;
  route: {
    subscribe(fn: () => void): () => void;
    getPath(): string;
    getSearch(): URLSearchParams;
    navigate: typeof _navigate;
  };
} = {
  subscribe(fn: (state: unknown) => void): () => void {
    return _subscribe(() => fn(_coreHasState() ? _coreGetState() : null));
  },
  getState(): unknown {
    return _coreHasState() ? _coreGetState() : null;
  },
  getCellState(name: string): unknown {
    if (!_coreHasState()) return null;
    const s = _coreGetState();
    return s[name] ?? null;
  },
  send(action: { type: string; payload?: unknown }): void {
    // Note it BEFORE the transport check. An action dispatched while the
    // socket is down is still this client's action — it queues, lands on
    // reconnect, and the state frame it produces belongs to it.
    _noteDispatch(action);
    if (_clientSend) _clientSend(action);
  },
  route: {
    subscribe(fn: () => void): () => void {
      return _rListeners.add(() => fn());
    },
    getPath(): string {
      return _getRPath();
    },
    getSearch(): URLSearchParams {
      return _getRSearch();
    },
    navigate: _navigate,
  },
};

// ── ensureConnected ─────────────────────────────────────────────────

import {
  bindAllCellsReactive,
  getRegisteredCells,
} from "../state/cell-reactive.ts";
import { _installReadOnlyHint } from "../air/dev-readonly-hint.ts";

let _ensured = false;
export function ensureConnected(): void {
  if (_ensured) return;
  _ensured = true;
  // AIO-4.4: install the read-only dev hint on first connect.
  _installReadOnlyHint();
  // Sync cells route method calls through the CRDT engine (HLC op + offline
  // queue) instead of the plain action path; everything else is unchanged.
  // The engine boots lazily (dynamic import) below. A sync-cell method called
  // in that boot window is BUFFERED — never leaked to a plain send, which would
  // skip HLC stamping + the offline queue and silently diverge the op-log.
  const plainSend = _clientSend ?? undefined;
  bindAllCellsReactive(plainSend ? _makeSendWrapper(plainSend) : undefined);
  _initSyncIfNeeded();
  _callConnectFn();
}

/** The send the cell bindings actually get: the client transport, with
 *  sync-cell actions routed through the CRDT engine (and buffered while that
 *  engine boots).
 *
 *  Built through `wrapTransport`, NOT as a bare arrow: the wrapper is what the
 *  binding layer sees, so it has to answer the same capability questions the
 *  transport does. As a bare arrow it answered "I do not arm ack clocks", the
 *  binding armed the 15s clock at dispatch time, and every action dispatched
 *  while offline was rejected at 15s and then delivered on reconnect. Exported
 *  for the guard test that pins exactly that. */
export function _makeSendWrapper(
  plainSend: (action: { type: string; payload?: unknown }) => void,
): (action: { type: string; payload?: unknown }) => void {
  return wrapTransport(
    plainSend,
    (action: { type: string; payload?: unknown }) => {
      // The other half of the pair named in `_noteDispatch`'s doc: every bound
      // cell method reaches the transport through here, including the
      // CRDT-routed and boot-buffered branches below. Both halves live in this
      // file so they cannot drift apart unseen; noting in only one of them
      // attributes the other half's state frames to `@@aio/state`, which is
      // what DevTools showed for every action for the life of the feature.
      _noteDispatch(action);
      if (_syncRoute) {
        if (_syncRoute(action)) return;
        plainSend(action);
        return;
      }
      // Engine not ready yet: hold sync-cell actions until it boots.
      if (_isSyncCellAction(action)) {
        _syncPending.push(action);
        return;
      }
      plainSend(action);
    },
  );
}

// ── Sync engine wiring (lazy — only when a registered cell has sync) ──
let _syncRoute: ((a: { type: string; payload?: unknown }) => boolean) | null =
  null;
/** Cell ids that route through the CRDT engine — known SYNCHRONOUSLY (before
 *  the engine's async import resolves) so the send wrapper can buffer their
 *  actions during the boot window instead of racing the import. */
let _syncCellIds: Set<string> | null = null;
/** Sync-cell actions dispatched before the engine finished booting; replayed
 *  through the engine once ready (or as plain sends if boot fails). */
const _syncPending: Array<{ type: string; payload?: unknown }> = [];

/** True when `action` targets a sync cell's real (non-framework) method — the
 *  exact set `handleSyncLocalAction` will route, so buffering matches routing.
 *  `cell:__method` framework-internal calls stay on the plain path. */
function _isSyncCellAction(action: { type: string }): boolean {
  if (!_syncCellIds) return false;
  const i = action.type.indexOf(":");
  if (i <= 0 || action.type.startsWith("__", i + 1)) return false;
  return _syncCellIds.has(action.type.slice(0, i));
}

/** Drain the boot-window buffer in dispatch order. With a route, real sync
 *  methods become ops; without one (boot failed / no engine) everything falls
 *  back to a plain send so no queued action is ever dropped. */
function _flushSyncPending(
  route: ((a: { type: string; payload?: unknown }) => boolean) | null,
): void {
  const pending = _syncPending.splice(0);
  for (const a of pending) {
    if (route && route(a)) continue;
    _clientSend?.(a);
  }
}

/** The engine loader — the real dynamic import, injectable so a test can hold
 *  the boot open and prove the buffer window deterministically. */
let _syncLoader: () => Promise<typeof import("./browser-sync.ts")> = () =>
  import("./browser-sync.ts");
/** Test seam: override (or reset with null) the sync-engine loader. */
export function _setSyncLoaderForTest(
  fn: (() => Promise<typeof import("./browser-sync.ts")>) | null,
): void {
  _syncLoader = fn ?? (() => import("./browser-sync.ts"));
}

/** Apply a server-sent "cfg" frame (runtime config handshake). Shell-injected
 *  keys win — same values, delivered earlier — so this only FILLS GAPS, which
 *  is exactly the build-time-templated-shell case (electron UDS, android
 *  assets: no `__aioConfig` at all). If sync cells become known here, adoption
 *  runs now; actions dispatched before this frame round-tripped as plain
 *  actions, which the server executes identically — late adoption upgrades
 *  the routing, it never corrects state. */
export function _applyServerConfig(cfg: Record<string, unknown>): void {
  const g = globalThis as unknown as {
    __aioConfig?: Record<string, unknown>;
  };
  g.__aioConfig = { ...cfg, ...(g.__aioConfig ?? {}) };
  _warnCellSetDrift(cfg.bootedCells);
  if (_ensured) _initSyncIfNeeded();
}

/** A cell in the BUNDLE that the running server never booted dispatches into
 *  nothing — the UI renders and its controls do nothing at all.
 *
 *  Field report: a `ui` cell was added to a running dev app and the browser
 *  reloaded. The client bundle is fetched fresh, so the new controls appeared;
 *  the server process was still the old one, so every dispatch went nowhere.
 *  From the UI it looked like three dead buttons, and the only place the truth
 *  appeared was `am dispatch` ("unknown cell \"ui\" — not booted"). A person
 *  who does not think to ask `am` sees a UI that renders and does not work.
 *
 *  Both halves are known here — the server's booted set arrives on the `cfg`
 *  frame, the bundle's set is the local registry — so the drift is stated
 *  where it is felt, with the fix. Reported through the diagnostic sink too,
 *  so it reaches the terminal (client-log) and not just the console. */
function _warnCellSetDrift(booted: unknown): void {
  if (!Array.isArray(booted)) return; // older server — nothing to compare
  const server = new Set(booted.map(String));
  const missing = [...getRegisteredCells().keys()].filter((id) =>
    !server.has(id)
  );
  if (missing.length === 0) return;
  const msg = `the client bundle registers cell(s) [${missing.join(", ")}] ` +
    `that this server process did NOT boot (it has: [${
      [...server].join(", ")
    }]). Their methods dispatch into nothing — the UI renders and does not ` +
    `work. Restart the server to pick them up.`;
  _diagEmit({
    type: "cell-set-drift",
    severity: "error",
    source: "browser",
    message: msg,
    detail: { missing, booted: [...server] },
    hint: "Restart the dev server — a bundle reload cannot add a cell to an " +
      "already-running process.",
  });
}
_cfgSink.apply = _applyServerConfig;

function _initSyncIfNeeded(): void {
  // Re-entrant by design: called at ensureConnected AND when a "cfg" frame
  // lands. Once ids are known (or the engine is up) there is nothing to redo.
  if (_syncCellIds || _syncRoute) return;
  // Same resolver the engine uses — see sync-cells.ts for why this is not two
  // independent walks over the registry.
  const ids = new Set(
    resolveSyncCells(getRegisteredCells().values(), (id) =>
      console.warn(
        `[aio:sync] localFirst adopted '${id}' but this cell cannot replay ops ` +
          `locally — it keeps round-tripping through the server`,
      )).keys(),
  );
  if (ids.size === 0) return;
  // Known synchronously so the send wrapper buffers from the FIRST dispatch —
  // this is what closes the boot-window race.
  _syncCellIds = ids;
  // Dynamic import keeps the engine out of apps that don't use sync.
  _syncLoader().then((mod) => {
    const engine = mod.initBrowserSync((raw) => _sendRawViaTransport(raw));
    if (!engine) {
      // No engine after all — don't strand buffered actions.
      _syncCellIds = null;
      _flushSyncPending(null);
      return;
    }
    _syncRoute = mod.handleSyncLocalAction;
    _setSyncWiring(mod.handleSyncMessage, mod.setSyncOnline);
    _flushSyncPending(_syncRoute);
  }).catch((e) => {
    console.warn(`[aio:sync] engine init failed: ${e}`);
    // Boot failed — flush as plain sends so nothing is lost, then stop buffering.
    _syncCellIds = null;
    _flushSyncPending(null);
  });
}

// Late-bound transport hooks — browser-air-transport registers these so this
// module stays transport-agnostic.
let _sendRawViaTransport: (raw: string) => void = () => {};
let _setSyncWiring: (
  onMsg: (t: string, d: unknown) => void,
  onOnline: (v: boolean) => void,
) => void = () => {};
export function _registerSyncTransport(
  sendRaw: (raw: string) => void,
  setWiring: (
    onMsg: (t: string, d: unknown) => void,
    onOnline: (v: boolean) => void,
  ) => void,
): void {
  _sendRawViaTransport = sendRaw;
  _setSyncWiring = setWiring;
}
export function _resetEnsured(): void {
  _ensured = false;
  _syncRoute = null;
  _syncCellIds = null;
  _syncPending.length = 0;
}

// ── Visibility guard ────────────────────────────────────────────────

// Module-local, and no setter: the handler is installed once at load and
// nothing ever replaced it. (The exported `_setVisibilityHandler` that used to
// sit here was reachable from nowhere in src/ or tests/.)
let _visibilityHandler: (() => void) | null = null;
if (typeof document !== "undefined") {
  _visibilityHandler = () => {
    if (_vmRenderMeter) {
      _vmRenderMeter.setPaused(document.hidden);
    }
  };
  document.addEventListener("visibilitychange", _visibilityHandler);
}
