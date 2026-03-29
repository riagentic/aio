// deno-lint-ignore-file
// Browser-protocol: renderer-agnostic protocol layer for aio.
// Extracted from browser.ts — no React imports.
// browser.ts (React) and browser-air.ts (AIR) import from here.

import { Listeners } from "./listeners.ts";
import { resetTT as _resetTT } from "./time-travel-panel.ts";
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
  collapsePaths as _coreCollapsePaths,
  createSendProxy as _coreCreateSendProxy,
  type FeatureRef as _CoreFeatureRef,
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
import { type Signal, signal } from "./signal.ts";

// ── Re-export state-core types/functions needed by browser.ts ───────
export type { _CoreFeatureRef, _CoreTransport, _HandleResult };
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

// ── Types ───────────────────────────────────────────────────────────

/** Window properties used by AIO diagnostics (avoids `declare global` for JSR compat). */
export interface AioWindow {
  _aioDiag?: (ev: Record<string, unknown>) => void;
  __aioConfig?: {
    renderBudget?: { staleness?: number; pendingPatches?: number };
  };
}

/** IPC transport (UDS mode via Electron) */
export type AioIPC = {
  send: (json: string) => void;
  ready: () => void;
  onMessage: (fn: (line: string) => void) => void;
  onOpen: (fn: () => void) => void;
  onClose: (fn: () => void) => void;
};

// ── Constants ───────────────────────────────────────────────────────

export const _w = typeof window !== "undefined"
  ? window as unknown as AioWindow & typeof globalThis
  : undefined;

export const WS_MAX_QUEUE = 100;
export const OFFLINE_MAX_QUEUE = 100;
export const OFFLINE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
/** Prototype pollution guard — re-export from state-core. */
export const _BLOCKED_KEYS: Set<string> = _coreBLOCKED_KEYS;

// ── Diagnostics ─────────────────────────────────────────────────────

export const _diagLastEmit = new Map<string, number>();
export function _diagEmit(ev: {
  type: string;
  severity: "error" | "warning" | "info";
  source: string;
  message: string;
  detail?: unknown;
  hint?: string;
}): void {
  if (!_w || typeof _w._aioDiag !== "function") {
    return;
  }
  const now = Date.now();
  const last = _diagLastEmit.get(ev.type);
  if (last && now - last < 5000) return;
  _diagLastEmit.set(ev.type, now);
  _w._aioDiag({ ...ev, ts: now });
}

// ── Array ref stats (AIO-11 wasted render detection) ────────────────
export const _getArrayRefStats = _coreGetArrayRefStats;
export const _resetArrayRefStats = _coreResetArrayRefStats;
export const _checkWastedRenders = _coreCheckWastedRenders;
export const _preserveArrayRefs = _corePreserveArrayRefs;
export const _shallowEqual = _coreShallowEqual;
export const _rebuildIdMaps = _coreRebuildIdMaps;
export const _applyPatch = _coreApplyPatch;
export const _deepMergeFiltered = _coreDeepMergeFiltered;

// ── State integrity ─────────────────────────────────────────────────

let _initialShapeKeys: Set<string> | null = null;

export function _checkStateIntegrity(state: unknown): void {
  if (!state || typeof state !== "object" || Array.isArray(state)) return;
  const obj = state as Record<string, unknown>;
  if (_initialShapeKeys === null) {
    _initialShapeKeys = new Set(Object.keys(obj));
    return;
  }
  for (const k of _initialShapeKeys) {
    if (!(k in obj)) {
      _diagEmit({
        type: "state-shape-drift",
        severity: "warning",
        source: "browser",
        message: `State key "${k}" from initial shape is now missing`,
        detail: { missingKey: k, currentKeys: Object.keys(obj) },
        hint:
          "A key from the initial full state has disappeared. This may indicate a delta patch or merge bug.",
      });
    }
  }
}

/** Reset _initialShapeKeys — for _reset() */
export function _resetInitialShapeKeys(): void {
  _initialShapeKeys = null;
}

// ── Offline queue persistence (IndexedDB) ─────────────────────────────

const _offlineDB = "__aio_offline";
const _offlineStore = "queue";
const _offlineVersion = 1;
interface _QueuedAction {
  id?: number;
  action: { type: string; payload?: unknown };
  ts: number;
}
let _idb: IDBDatabase | null = null;
let _idbPromise: Promise<IDBDatabase | null> | null = null;

function _openIDB(): Promise<IDBDatabase | null> {
  if (_idb) return Promise.resolve(_idb);
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(_offlineDB, _offlineVersion);
      req.onerror = () => {
        _idbPromise = null;
        resolve(null);
      };
      req.onsuccess = () => {
        _idb = req.result;
        resolve(req.result);
      };
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(_offlineStore)) {
          db.createObjectStore(_offlineStore, {
            keyPath: "id",
            autoIncrement: true,
          });
        }
      };
    } catch {
      _idbPromise = null;
      resolve(null);
    }
  });
  return _idbPromise;
}

export async function _loadOfflineQueue(): Promise<_QueuedAction[]> {
  const db = await _openIDB();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(_offlineStore, "readonly");
      const store = tx.objectStore(_offlineStore);
      const req = store.getAll();
      req.onerror = () => resolve([]);
      req.onsuccess = () => {
        const actions = req.result as _QueuedAction[];
        const cutoff = Date.now() - OFFLINE_MAX_AGE;
        resolve(actions.filter((a) => a.ts >= cutoff));
      };
    } catch (e) {
      _diagEmit({
        type: "offline-storage-error",
        severity: "info",
        source: "browser",
        message: "IndexedDB operation failed — offline persistence unavailable",
        detail: { error: String(e) },
        hint:
          "Offline action queue will use memory only. Check browser storage quota.",
      });
      resolve([]);
    }
  });
}

export const MAX_OFFLINE_ACTIONS = 1000;
export async function _saveOfflineAction(
  action: { type: string; payload?: unknown },
): Promise<void> {
  const db = await _openIDB();
  if (!db) return;
  try {
    const tx = db.transaction(_offlineStore, "readwrite");
    const store = tx.objectStore(_offlineStore);
    const countReq = store.count();
    countReq.onsuccess = () => {
      if (countReq.result >= MAX_OFFLINE_ACTIONS) return;
      const addReq = store.add({ action, ts: Date.now() });
      addReq.onerror = () => {
        _diagEmit({
          type: "offline-storage-error",
          severity: "info",
          source: "browser",
          message: "IndexedDB add() failed — offline action lost",
          detail: { error: String(addReq.error) },
          hint:
            "Offline action queue will use memory only. Check browser storage quota.",
        });
      };
    };
    countReq.onerror = () => {
      _diagEmit({
        type: "offline-storage-error",
        severity: "info",
        source: "browser",
        message: "IndexedDB count() failed — offline action lost",
        detail: { error: String(countReq.error) },
        hint:
          "Offline action queue will use memory only. Check browser storage quota.",
      });
    };
  } catch (e) {
    _diagEmit({
      type: "offline-storage-error",
      severity: "info",
      source: "browser",
      message: "IndexedDB operation failed — offline persistence unavailable",
      detail: { error: String(e) },
      hint:
        "Offline action queue will use memory only. Check browser storage quota.",
    });
  }
}

export async function _clearOfflineQueue(): Promise<void> {
  const db = await _openIDB();
  if (!db) return;
  try {
    const tx = db.transaction(_offlineStore, "readwrite");
    const store = tx.objectStore(_offlineStore);
    store.clear();
  } catch (e) {
    _diagEmit({
      type: "offline-storage-error",
      severity: "info",
      source: "browser",
      message: "IndexedDB operation failed — offline persistence unavailable",
      detail: { error: String(e) },
      hint:
        "Offline action queue will use memory only. Check browser storage quota.",
    });
  }
}

/** Reset IDB state — for _reset() */
export function _resetIDB(): void {
  _idb = null;
  _idbPromise = null;
}

// ── Subscription tracking re-exports ────────────────────────────────

export const _accessedPaths = _coreAccessedPaths;
export const _collapsePaths = (paths: Set<string>): string[] =>
  _coreCollapsePaths(paths);
export const _trackingProxy = _coreTrackingProxy;

export function _resetTracking(): void {
  _coreAccessedPaths.clear();
  _coreCancelSubsTimer();
}

// ── Vitals / render meter state ─────────────────────────────────────

export let _vitalsRenderMeter: RenderMeterAPI | null = null;
export function _setVitalsRenderMeter(v: RenderMeterAPI | null): void {
  _vitalsRenderMeter = v;
}
export let _vitalsUrlLogged = false;
export function _setVitalsUrlLogged(v: boolean): void {
  _vitalsUrlLogged = v;
}
export let _vitalsTransportProbe:
  | ReturnType<typeof createTransportProbeClient>
  | null = null;
export function _setVitalsTransportProbe(
  v: typeof _vitalsTransportProbe,
): void {
  _vitalsTransportProbe = v;
}
export let _vitalsPingTimer: ReturnType<typeof setInterval> | null = null;
export function _setVitalsPingTimer(v: typeof _vitalsPingTimer): void {
  _vitalsPingTimer = v;
}
export const _useAioWarned = new Set<string>();
export let _useAioActiveCount = 0;
export function _setUseAioActiveCount(n: number): void {
  _useAioActiveCount = n;
}
export let _cleanupTimer: ReturnType<typeof setTimeout> | null = null;
export function _setCleanupTimer(v: typeof _cleanupTimer): void {
  _cleanupTimer = v;
}
export let _listenerHighWater = 0;
export function _setListenerHighWater(n: number): void {
  _listenerHighWater = n;
}

// ── Connection status indicator (pure DOM) ──────────────────────────

let _statusEl: HTMLElement | null = null;
let _statusTimer: ReturnType<typeof setTimeout> | null = null;
let _statusStyleInjected = false;

function _injectStatusStyle(): void {
  if (_statusStyleInjected) return;
  _statusStyleInjected = true;
  const style = document.createElement("style");
  style.textContent =
    "@keyframes __aio-pulse{0%,100%{opacity:1}50%{opacity:.5}}";
  document.head.appendChild(style);
}

export function _showStatus(
  text: string,
  color: string,
  autohide?: number,
): void {
  if (
    (window as unknown as Record<string, unknown>).__aioShowStatus === false
  ) return;
  _injectStatusStyle();
  if (_statusTimer) {
    clearTimeout(_statusTimer);
    _statusTimer = null;
  }
  if (!_statusEl) {
    _statusEl = document.createElement("div");
    _statusEl.style.cssText =
      "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:99999;" +
      "font:12px/1 monospace;padding:6px 14px;border-radius:20px;" +
      "background:rgba(240,240,245,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);" +
      "border:1px solid rgba(0,0,0,.12);box-shadow:0 4px 16px rgba(0,0,0,.12);" +
      "transition:opacity .3s;pointer-events:none;";
    document.body.appendChild(_statusEl);
  }
  _statusEl.textContent = text;
  _statusEl.style.color = color;
  _statusEl.style.opacity = "1";
  _statusEl.style.animation = autohide
    ? "none"
    : "__aio-pulse 2s ease-in-out infinite";
  if (autohide) {
    _statusTimer = setTimeout(() => {
      if (_statusEl) _statusEl.style.opacity = "0";
    }, autohide);
  }
}

export function _hideStatus(): void {
  if (_statusEl) _statusEl.style.opacity = "0";
  if (_statusTimer) {
    clearTimeout(_statusTimer);
    _statusTimer = null;
  }
}

/** Reset status UI state — for _reset() */
export function _resetStatus(): void {
  _statusEl?.remove();
  _statusEl = null;
  if (_statusTimer) {
    clearTimeout(_statusTimer);
    _statusTimer = null;
  }
}

// ── State notification ──────────────────────────────────────────────

export const _listeners = new Listeners<unknown>();

export function _notify() {
  _listeners.notify(_coreHasState() ? _coreGetState() : null);
}

// ── State version & readiness ───────────────────────────────────────

export let _stateVersion = 0;
export function _incStateVersion(): void {
  _stateVersion++;
}
export function _resetStateVersion(): void {
  _stateVersion = 0;
}

let _stateReadyResolve: (() => void) | null = null;
let _stateReadyPromise: Promise<void> | null = null;

/** Called from _notify() when state first arrives — resolves the readiness promise. */
export function _resolveStateReady(): void {
  if (_stateReadyResolve) {
    _stateReadyResolve();
    _stateReadyResolve = null;
    _stateReadyPromise = null;
  }
}

export function _resetStateReady(): void {
  _stateReadyPromise = null;
  _stateReadyResolve = null;
}

// _waitForState needs _connect — injected from browser.ts
let _connectFn: (() => void) | null = null;
export function _setConnectFn(fn: () => void): void {
  _connectFn = fn;
}

export function _waitForState(): Promise<void> {
  if (_coreHasState()) return Promise.resolve();
  if (!_stateReadyPromise) {
    _stateReadyPromise = new Promise<void>((resolve) => {
      _stateReadyResolve = resolve;
    });
  }
  if (_connectFn) _connectFn();
  return _stateReadyPromise;
}

// ── Subscription management ─────────────────────────────────────────

export const _useAioSubscribe = (onStoreChange: () => void): () => void => {
  _useAioActiveCount++;
  const unsub = _subscribe(onStoreChange);
  return () => {
    _useAioActiveCount--;
    unsub();
  };
};

// _subscribe needs _connect, _rSync, _popstateHandler — injected
let _subscribeTriggerConnect: (() => void) | null = null;
let _subscribeTriggerPopstate: (() => void) | null = null;
export function _setSubscribeTriggers(
  connect: () => void,
  popstate: () => void,
): void {
  _subscribeTriggerConnect = connect;
  _subscribeTriggerPopstate = popstate;
}

export function _subscribe(onStoreChange: () => void): () => void {
  const unsub = _listeners.add(() => {
    onStoreChange();
  });
  if (_listeners.size > _listenerHighWater) {
    _listenerHighWater = _listeners.size;
  }
  if (_subscribeTriggerConnect) {
    _subscribeTriggerConnect();
  }
  return () => {
    unsub();
    if (_listeners.size === 0) {
      if (_cleanupTimer) clearTimeout(_cleanupTimer);
      const peakCount = _listenerHighWater;
      _cleanupTimer = setTimeout(() => {
        _cleanupTimer = null;
        if (_listeners.size === 0) {
          console.warn(
            `[aio] teardown — no listeners for 300ms (peak was ${peakCount}). Closing connection, clearing state.`,
          );
          _diagEmit({
            type: "teardown",
            severity: "warning",
            source: "browser",
            message: "Full teardown — no listeners remained after grace period",
            detail: { graceMs: 300, peakListenerCount: peakCount },
          });
          // Trigger full teardown via browser.ts callback
          if (_teardownFn) _teardownFn();
        } else {
          console.warn(
            `[aio] teardown averted — listeners dropped to 0 but recovered to ${_listeners.size} within 300ms`,
          );
          _diagEmit({
            type: "teardown-averted",
            severity: "info",
            source: "browser",
            message: "Transient listener gap — teardown cancelled",
            detail: { recoveredCount: _listeners.size },
          });
        }
      }, 300);
    }
  };
}

let _teardownFn: (() => void) | null = null;
export function _setTeardownFn(fn: () => void): void {
  _teardownFn = fn;
}

export function _getSnapshot(): unknown {
  return _coreHasState() ? _coreGetState() : null;
}
export function _getServerSnapshot(): unknown {
  return null;
}

// ── DevTools ────────────────────────────────────────────────────────

interface DevToolsConnection {
  init: (state: unknown) => void;
  send: (action: { type: string; payload?: unknown }, state: unknown) => void;
  subscribe: (
    listener: (
      message: { type: string; payload?: unknown; state?: string },
    ) => void,
  ) => () => void;
  disconnect: () => void;
}

export let _devtools: DevToolsConnection | null = null;
export let _devtoolsConnected = false;

function _initDevTools(): void {
  if (_devtoolsConnected) return;
  const ext =
    (window as unknown as Record<string, unknown>).__REDUX_DEVTOOLS_EXTENSION__;
  if (!ext) return;

  try {
    _devtools = (ext as { connect: () => DevToolsConnection }).connect();
    if (_devtools) {
      _devtoolsConnected = true;
      _devtools.subscribe((msg) => {
        if (msg.type === "DISPATCH") {
          const payload = msg.payload as { type?: string } | undefined;
          if (
            payload?.type === "JUMP_TO_STATE" ||
            payload?.type === "JUMP_TO_ACTION"
          ) {
            console.log(
              "[aio] DevTools time-travel: use Ctrl+. panel for client-side state navigation",
            );
          }
        }
      });
      if (_coreHasState()) {
        _devtools.init(_coreGetState());
      }
    }
  } catch {
    // DevTools not available or failed to connect
  }
}

export function _sendDevTools(
  action: { type: string; payload?: unknown },
  state: unknown,
): void {
  if (_devtools && _devtoolsConnected) {
    try {
      _devtools.send(action, state);
    } catch {
      _devtoolsConnected = false;
    }
  }
}

export function connectDevTools(): void {
  _initDevTools();
  if (_devtools && _coreHasState()) {
    try {
      _devtools.init(_coreGetState());
    } catch { /* ignore */ }
  }
}

export function disconnectDevTools(): void {
  if (_devtools) {
    try {
      _devtools.disconnect();
    } catch { /* ignore */ }
    _devtools = null;
    _devtoolsConnected = false;
  }
}

export function _resetDevTools(): void {
  _devtools = null;
  _devtoolsConnected = false;
}

// ── feature + bridge + aio stub ─────────────────────────────────────

// deno-lint-ignore no-explicit-any
type _Creators = Record<string, (...args: any[]) => any>;

// deno-lint-ignore no-explicit-any
export function feature(
  name: string,
  config: {
    state?: any;
    actions?: _Creators;
    methods?: Record<string, unknown>;
    generators?: Record<string, unknown>;
    effects?: _Creators;
    machine?: any;
    reduce?: any;
    execute?: any;
    selectors?: any;
  },
): Record<string, unknown> {
  const prefix = name;
  // deno-lint-ignore no-explicit-any
  const buildCat = (creators: _Creators): Record<string, any> => {
    const cat: Record<string, unknown> = {};
    for (const key of Object.keys(creators)) {
      const label = `${prefix}:${key}`;
      cat[key] = Object.assign(
        (...args: unknown[]) => ({
          type: label,
          payload: creators[key]!(...args) ?? {},
        }),
        { type: label },
      );
    }
    return cat;
  };
  if (config.methods) {
    const allKeys = [
      ...Object.keys(config.methods),
      ...Object.keys(config.generators ?? {}),
    ];
    const cat: Record<string, unknown> = {};
    for (const key of allKeys) {
      const label = `${prefix}:${key}`;
      cat[key] = Object.assign(
        (...args: unknown[]) => ({ type: label, payload: { args } }),
        { type: label },
      );
    }
    // deno-lint-ignore no-explicit-any
    const eCat = buildCat((config.effects ?? {}) as any);
    const def: Record<string, unknown> = {
      __aio: {
        state: config.state ?? {},
        machine: config.machine ?? false,
        selectors: config.selectors ?? {},
        actionKeys: allKeys,
        effectKeys: Object.keys(config.effects ?? {}),
        id: prefix,
        actions: cat,
        effects: eCat,
        bound: false,
      },
    };
    for (const [key, value] of Object.entries(cat)) {
      def[key] = value;
    }
    return def;
  }
  const aCat = buildCat(config.actions ?? {});
  const def: Record<string, unknown> = {
    __aio: {
      state: config.state ?? {},
      machine: config.machine ?? false,
      selectors: config.selectors ?? {},
      actionKeys: Object.keys(config.actions ?? {}),
      effectKeys: Object.keys(config.effects ?? {}),
      id: prefix,
      actions: aCat,
      effects: buildCat(config.effects ?? {}),
      bound: false,
    },
  };
  for (const [key, value] of Object.entries(aCat)) {
    def[key] = value;
  }
  return def;
}

// deno-lint-ignore no-explicit-any
export function bridge(name: string, config: any): Record<string, unknown> {
  const channels = Object.keys(config.channels ?? {});
  // deno-lint-ignore no-explicit-any
  const actions: Record<string, (...args: any[]) => Record<string, unknown>> =
    {};
  for (const ch of channels) {
    actions[`${ch}Request`] = (...args: unknown[]) => ({
      ...(config.channels[ch]?.request?.(...args) ?? {}),
      _channel: ch,
    });
    actions[`${ch}Response`] = (...args: unknown[]) => ({
      ...(config.channels[ch]?.response?.(...args) ?? {}),
      _channel: ch,
    });
    actions[`${ch}Timeout`] = () => ({ _channel: ch });
  }
  return feature(name, { actions, machine: false, reduce: () => {} });
}

// deno-lint-ignore no-explicit-any
export const aio: Record<string, any> = {
  run() {
    return Promise.resolve();
  },
  middleware: {
    logger: () => () => null,
    devtools: () => () => null,
    perfBudget: () => () => null,
    validate: () => () => null,
    metrics: () => () => null,
    freeze: () => () => null,
    create: () => () => null,
  },
};

// ── Send cache ──────────────────────────────────────────────────────

export const _featureSendCache = new WeakMap<
  _CoreFeatureRef,
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

export const client: {
  subscribe(fn: (state: unknown) => void): () => void;
  getState(): unknown;
  getFeatureState(name: string): unknown;
  send(action: { type: string; payload?: unknown }): void;
  route: {
    subscribe(fn: () => void): () => void;
    getPath(): string;
    getSearch(): URLSearchParams;
    navigate: typeof navigate;
  };
} = {
  subscribe(fn: (state: unknown) => void): () => void {
    const unsub = _subscribe(() =>
      fn(_coreHasState() ? _coreGetState() : null)
    );
    return unsub;
  },
  getState(): unknown {
    return _coreHasState() ? _coreGetState() : null;
  },
  getFeatureState(name: string): unknown {
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
      return _rPath;
    },
    getSearch(): URLSearchParams {
      return _rSearch;
    },
    navigate,
  },
};

// ── Router infrastructure ───────────────────────────────────────────

let _rPath = typeof location !== "undefined" ? location.pathname : "/";
let _rSearch: URLSearchParams = typeof location !== "undefined"
  ? new URLSearchParams(location.search)
  : new URLSearchParams();
export const _rListeners = new Listeners<void>();

export const routePath: Signal<string> = signal(_rPath);
export const routeSearch: Signal<URLSearchParams> = signal(_rSearch);

export function _rSync(): void {
  _rPath = location.pathname;
  _rSearch = new URLSearchParams(location.search);
  routePath.set(_rPath);
  routeSearch.set(_rSearch);
  _rListeners.notify(undefined);
}

export let _popstateHandler: (() => void) | null = null;
export function _setPopstateHandler(h: (() => void) | null): void {
  _popstateHandler = h;
}
if (typeof window !== "undefined") {
  _popstateHandler = _rSync;
  addEventListener("popstate", _popstateHandler);
  // AIO-54: Electron swallows <a> clicks before DOM dispatch. The main process
  // intercepts via will-navigate, prevents navigation, and relays the URL back
  // to the renderer as CustomEvent('aio:navigate'). We handle it here so both
  // browser.ts (React) and browser-air.ts (AIR) get navigation support.
  addEventListener(
    "aio:navigate",
    ((e: CustomEvent<{ url: string }>) => {
      try {
        const url = new URL(e.detail.url);
        navigate(url.pathname + url.search + url.hash);
      } catch { /* invalid URL — ignore */ }
    }) as EventListener,
  );
}

export function _rSubscribe(fn: () => void): () => void {
  return _rListeners.add(() => fn());
}

export function _rSnapshot(): string {
  return typeof location !== "undefined"
    ? location.pathname + location.search
    : "/";
}

export function matchPath(
  pattern: string,
  path: string,
  exact = true,
): Record<string, string> | null {
  const keys: string[] = [];
  const segments = pattern.replace(/\/+$/, "").split("/");
  const regParts = segments.map((seg) => {
    if (seg.startsWith(":")) {
      keys.push(seg.slice(1));
      return "([^/]+)";
    }
    if (seg === "*") {
      keys.push("*");
      return "(.*)";
    }
    return seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  });
  const suffix = exact ? "\\/?$" : "(\\/|$)";
  const re = new RegExp("^" + regParts.join("\\/") + suffix);
  const m = re.exec(path);
  if (!m) return null;
  const params: Record<string, string> = {};
  keys.forEach((k, i) => {
    let v = decodeURIComponent(m[i + 1] ?? "");
    if (k === "*") v = v.replace(/\/$/, "");
    params[k] = v;
  });
  return params;
}

export function navigate(
  to: string | number,
  opts?: { replace?: boolean },
): void {
  if (typeof to === "number") {
    history.go(to);
    return;
  }
  const url = new URL(to, location.href);
  if (opts?.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  _rSync();
}

// ── Types (exported) ────────────────────────────────────────────────

export type RouteState = {
  path: string;
  params: Record<string, string>;
  search: URLSearchParams;
  matched: boolean;
};

export type RouteProps = {
  path?: string;
  index?: boolean;
  element?: unknown;
  children?: unknown;
};

export type LinkProps = {
  to: string;
  replace?: boolean;
  exact?: boolean;
  activeClass?: string;
  activeStyle?: Record<string, unknown>;
  children?: unknown;
  className?: string;
  style?: Record<string, unknown>;
  [k: string]: unknown;
};

// ── Routing state accessors ─────────────────────────────────────────

export function _getRPath(): string {
  return _rPath;
}
export function _getRSearch(): URLSearchParams {
  return _rSearch;
}

// ── ensureConnected ─────────────────────────────────────────────────

let _ensured = false;
export function ensureConnected(): void {
  if (_ensured) return;
  _ensured = true;
  if (_connectFn) _connectFn();
}
export function _resetEnsured(): void {
  _ensured = false;
}

// ── Visibility guard ────────────────────────────────────────────────

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (_vitalsRenderMeter) {
      _vitalsRenderMeter.setPaused(document.hidden);
    }
  });
}
