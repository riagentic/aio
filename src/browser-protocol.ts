// deno-lint-ignore-file
// Browser-protocol: renderer-agnostic protocol layer for aio.
// Extracted from browser.ts — no React imports.
// browser.ts (React) and browser-air.ts (AIR) import from here.
//
// This file is the thin orchestrator. Logic lives in:
//   protocol-types.ts         — types + constants
//   protocol-diagnostics.ts   — _diagEmit, state integrity
//   protocol-offline.ts       — IndexedDB offline queue
//   protocol-status.ts        — DOM connection status widget
//   protocol-devtools.ts      — Redux DevTools integration
//   protocol-router.ts        — client-side router
//   protocol-cell.ts          — cell(), bridge(), aio stubs
//   protocol-subscription.ts  — listeners, vitals state, state readiness

import {
  _accessedPaths as _coreAccessedPaths,
  _applyPatch as _coreApplyPatch,
  _BLOCKED_KEYS as _coreBLOCKED_KEYS,
  _checkWastedRenders as _coreCheckWastedRenders,
  _deepMergeFiltered as _coreDeepMergeFiltered,
  _getArrayRefStats as _coreGetArrayRefStats,
  _getState as _coreGetState,
  _preserveArrayRefs as _corePreserveArrayRefs,
  _rebuildIdMaps as _coreRebuildIdMaps,
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
} from "./state-core.ts";
import {
  createRenderMeter,
  renderHint,
  type RenderMeterAPI,
} from "./vitals/render-meter.ts";
import { createTransportProbeClient } from "./vitals/transport-probe.ts";
import {
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_THRESHOLDS,
} from "./vitals/types.ts";
import { formatDiagEvent } from "./vitals/diag-formatter.ts";
import type { DiagEvent } from "./vitals/types.ts";
import { resetTT as _resetTT } from "./time-travel-panel.ts";

// ── Re-export state-core types/functions needed by browser.ts ───────
export type { _CoreCellRef, _CoreTransport, _HandleResult };
export {
  _coreCreateSendProxy,
  _coreGetConnectedSignal,
  _coreGetState,
  _coreHandleMessage,
  _coreHasState,
  _coreResendSubs,
  _coreReset,
  _coreResolveWithFallback,
  _coreSetConnected,
  _coreSetTransport,
  _coreTrackPath,
};

// Re-export vitals/render-meter for browser.ts connection code
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
} from "./protocol-types.ts";
export {
  OFFLINE_MAX_AGE,
  OFFLINE_MAX_QUEUE,
  WS_MAX_QUEUE,
} from "./protocol-types.ts";

export {
  _checkStateIntegrity,
  _diagEmit,
  _diagLastEmit,
  _resetInitialShapeKeys,
  _w,
} from "./protocol-diagnostics.ts";

export {
  _clearOfflineQueue,
  _loadOfflineQueue,
  _resetIDB,
  _saveOfflineAction,
  MAX_OFFLINE_ACTIONS,
} from "./protocol-offline.ts";

export { _hideStatus, _resetStatus, _showStatus } from "./protocol-status.ts";

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

export { aio, bridge, cell } from "./protocol-cell.ts";

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
export const _rebuildIdMaps = _coreRebuildIdMaps;
export const _applyPatch = _coreApplyPatch;
export const _deepMergeFiltered = _coreDeepMergeFiltered;

// ── Subscription tracking re-exports ────────────────────────────────

export const _accessedPaths = _coreAccessedPaths;
export const _collapsePaths = (paths: Set<string>): string[] =>
  _coreCollapsePaths(paths);
export const _trackingProxy = _coreTrackingProxy;

export function _resetTracking(): void {
  _coreAccessedPaths.clear();
  _coreCancelSubsTimer();
}

// ── Snapshot helpers ─────────────────────────────────────────────────

export function _getSnapshot(): unknown {
  return _coreHasState() ? _coreGetState() : null;
}
export function _getServerSnapshot(): unknown {
  return null;
}

// ── Send cache ──────────────────────────────────────────────────────

export const _cellSendCache = new WeakMap<
  _CoreCellRef,
  Record<string, (...args: unknown[]) => void>
>();

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
// _send is injected from browser.ts to avoid circular dep
let _clientSend:
  | ((action: { type: string; payload?: unknown }) => void)
  | null = null;
export function _setClientSend(
  fn: (action: { type: string; payload?: unknown }) => void,
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

let _ensured = false;
export function ensureConnected(): void {
  if (_ensured) return;
  _ensured = true;
  _callConnectFn();
}
export function _resetEnsured(): void {
  _ensured = false;
}

// ── Visibility guard ────────────────────────────────────────────────

export let _visibilityHandler: (() => void) | null = null;
export function _setVisibilityHandler(h: (() => void) | null): void {
  _visibilityHandler = h;
}
if (typeof document !== "undefined") {
  _visibilityHandler = () => {
    if (_vmRenderMeter) {
      _vmRenderMeter.setPaused(document.hidden);
    }
  };
  document.addEventListener("visibilitychange", _visibilityHandler);
}
