// deno-lint-ignore-file
// Browser-side aio module — bundled into dist/app.js for prod builds
// DOM types provided via compilerOptions.lib in deno.json
// Dev mode uses the AIO_UI_JS string in server.ts instead (served at /__aio/ui.js)
import {
  type ComponentType,
  createContext,
  createElement,
  memo as _reactMemo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  handleTTMessage as _handleTTMessage,
  resetTT as _resetTT,
  setSendFn as _ttSetSendFn,
} from "./time-travel-panel.ts";
import { useTimeTravel } from "./time-travel-react.ts";

// ── Protocol imports ────────────────────────────────────────────────
import {
  _accessedPaths,
  _applyPatch,
  _BLOCKED_KEYS,
  // Functions used locally AND re-exported
  _checkStateIntegrity,
  _checkWastedRenders,
  _cleanupTimer,
  _clearOfflineQueue,
  _collapsePaths,
  _coreCreateSendProxy,
  type _CoreFeatureRef,
  // State-core pass-throughs
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
  _deepMergeFiltered,
  // DevTools
  _devtoolsConnected,
  _diagEmit,
  // Diagnostics
  _diagLastEmit,
  // Send cache
  _featureSendCache,
  _getArrayRefStats,
  _getRPath,
  _getRSearch,
  _getServerSnapshot,
  _getSnapshot,
  type _HandleResult,
  _hideStatus,
  _incStateVersion,
  _listenerHighWater,
  // Listeners/notify
  _listeners,
  // Offline
  _loadOfflineQueue,
  _memoCompare,
  _notify,
  _popstateHandler,
  _preserveArrayRefs,
  _projectWithSharing,
  _rebuildIdMaps,
  _resetArrayRefStats,
  _resetDevTools,
  // ensureConnected
  _resetEnsured,
  _resetIDB,
  _resetInitialShapeKeys,
  _resetStateReady,
  _resetStateVersion,
  _resetStatus,
  _resetTracking,
  _resolveStateReady,
  _rListeners,
  _rSnapshot,
  _rSubscribe,
  // Router
  _rSync,
  _saveOfflineAction,
  _sendDevTools,
  _setCleanupTimer,
  // Setter for client send
  _setClientSend,
  _setConnectFn,
  _setListenerHighWater,
  _setPopstateHandler,
  // Subscription management
  _setSubscribeTriggers,
  _setTeardownFn,
  _setUseAioActiveCount,
  _setVitalsPingTimer,
  _setVitalsRenderMeter,
  _setVitalsTransportProbe,
  _setVitalsUrlLogged,
  _shallowEqual,
  // Status UI
  _showStatus,
  // State version/readiness
  _stateVersion,
  _subscribe,
  _trackingProxy,
  _useAioActiveCount,
  _useAioSubscribe,
  _vitalsPingTimer,
  // Vitals state
  _vitalsRenderMeter,
  _vitalsTransportProbe,
  _vitalsUrlLogged,
  _w,
  _waitForState,
  aio,
  // Window/constants
  type AioWindow,
  bridge,
  client,
  connectDevTools,
  // Vitals/render
  createRenderMeter,
  createTransportProbeClient,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_THRESHOLDS,
  type DiagEvent,
  disconnectDevTools,
  ensureConnected,
  feature,
  formatDiagEvent,
  type LinkProps,
  log,
  matchPath,
  navigate,
  OFFLINE_MAX_AGE,
  OFFLINE_MAX_QUEUE,
  renderHint,
  type RenderMeterAPI,
  type RouteProps,
  type RouteState,
  WS_MAX_QUEUE,
} from "./browser-protocol.ts";

// ── Public re-exports from protocol (backward-compatible API surface) ────
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
} from "./browser-protocol.ts";
export type { LinkProps, RouteProps, RouteState } from "./browser-protocol.ts";

// useTimeTravel — re-exported from time-travel-panel.ts for backward compat
export { useTimeTravel };

// ── Transport state ────────────────────────────────────────────────
import {
  type AioIPCBridge,
  buildWsUrl,
  detectIPC,
  handleControlMessage,
} from "./browser-shared.ts";

const _ipc: AioIPCBridge | null = detectIPC();
let _ws: WebSocket | null = null;
let _queue: Array<{ type: string; payload?: unknown }> = [];
let _retry = 0;
let _closed = false;
let _connecting = false;
let _wasConnected = false;
let _offlineReady = false;
let _offlineQueue: Array<{ type: string; payload?: unknown }> = [];
let _lastAction: { type: string; payload?: unknown } | null = null;
const _bootId: { current: string | null } = { current: null };
let _ipcConnected = false;
let _ipcPingTimer: ReturnType<typeof setInterval> | null = null;
const _IPC_PING_INTERVAL = 60_000;

// Wire protocol's _waitForState to our _connect
_setConnectFn(() => {
  if (!_ws && !_ipcConnected && !_connecting) {
    _closed = false;
    _connecting = true;
    _connect();
  }
});

// Wire _subscribe triggers
_setSubscribeTriggers(
  () => {
    if (!_ws && !_ipcConnected && !_connecting) {
      _closed = false;
      _connecting = true;
      _connect();
      // Re-register popstate listener if it was cleaned up
      if (!_popstateHandler && typeof window !== "undefined") {
        _setPopstateHandler(_rSync);
        addEventListener("popstate", _rSync);
      }
    }
  },
  () => {
    if (!_popstateHandler && typeof window !== "undefined") {
      _setPopstateHandler(_rSync);
      addEventListener("popstate", _rSync);
    }
  },
);

// Wire teardown callback
_setTeardownFn(() => {
  _closed = true;
  _ws?.close();
  _ws = null;
  _ipcConnected = false;
  _connecting = false;
  _coreReset();
  _resetInitialShapeKeys();
  _resetStateReady();
  _queue = [];
  _retry = 0;
  _setListenerHighWater(0);
  if (_vitalsRenderMeter) {
    _vitalsRenderMeter.destroy();
    _setVitalsRenderMeter(null);
  }
  // Clean up global listeners to prevent leaks
  _resetTT();
  if (_popstateHandler) {
    removeEventListener("popstate", _popstateHandler);
    _setPopstateHandler(null);
  }
});

// Wire client.send
_setClientSend(_send);

/** Connects via Electron IPC bridge (UDS mode) — messages are NDJSON lines */
function _connectIPC() {
  if (!_ipc || _ipcConnected) return;
  _ipcConnected = true;

  _ipc.onOpen(() => {
    _retry = 0;
    if (_wasConnected) _showStatus("Connected", "#2a2", 2000);
    _wasConnected = true;
    // Register IPC as state-core transport
    _coreSetTransport({ send: (d: string) => _ipc!.send(d), close: () => {} });
    _coreSetConnected(true);
    _ttSetSendFn((cmd: string) => _ipc!.send(cmd));
    // Drain memory queue
    const q = _queue;
    _queue = [];
    for (const a of q) _ipc!.send(JSON.stringify(a));
    // IPC keepalive — prevents stale connection detection in edge cases
    if (!_ipcPingTimer) {
      _ipcPingTimer = setInterval(() => {
        if (_ipc && _ipcConnected) _ipc.send("__ping");
      }, _IPC_PING_INTERVAL);
    }
  });

  _ipc.onMessage((line: string) => {
    if (handleControlMessage(line, _bootId)) return;
    if (line === "__getState") {
      try {
        _ipc!.send("__clientState:" + JSON.stringify(_walkReactTree()));
      } catch (err) {
        _ipc!.send('__clientState:{"error":"' + String(err) + '"}');
      }
      return;
    }
    if (line.startsWith("__click:")) {
      const result = _handleClick(line.slice(8));
      _ipc!.send("__clientState:" + JSON.stringify(result));
      return;
    }
    if (line.startsWith("__tt:")) {
      _handleTTMessage(line.slice(5));
      return;
    }
    if (line.startsWith("__diag:")) {
      try {
        const ev = JSON.parse(line.slice(7));
        if (_w && typeof _w._aioDiag === "function") _w._aioDiag(ev);
      } catch { /* ignore malformed diag */ }
      return;
    }
    try {
      const data = JSON.parse(line);
      if (data === null || typeof data !== "object") return;
      const result: _HandleResult = _coreHandleMessage(data);
      if (result === "dropped") {
        _diagEmit({
          type: "delta-before-state",
          severity: "warning",
          source: "browser",
          message: "Delta patch received before full state (IPC) — dropped",
          hint:
            "This usually means a reconnect race. The next full state sync will correct this.",
        });
        return;
      }
      if (result === "noop") return;

      const next = _coreGetState();
      _checkStateIntegrity(next);
      _incStateVersion();
      if (_coreHasState()) _resolveStateReady();

      // Deferred React notification via RenderMeter
      if (_vitalsRenderMeter) {
        _vitalsRenderMeter.recordPatch();
        _vitalsRenderMeter.markDirty();
      } else {
        _listeners.notify(next);
      }

      // DevTools
      if (_devtoolsConnected && _lastAction) {
        _sendDevTools(_lastAction, next);
        _lastAction = null;
      }
    } catch (err) {
      console.warn("[aio] bad state message:", err);
      _diagEmit({
        type: "state-sync-error",
        severity: "error",
        source: "browser",
        message: "Failed to parse state message from server (IPC)",
        detail: { error: String(err) },
        hint:
          "Server sent malformed state. Check for serialization bugs on the server side.",
      });
    }
  });

  _ipc.onClose(() => {
    _ipcConnected = false;
    _coreSetTransport(null);
    _coreSetConnected(false);
    _ttSetSendFn(null);
    if (_ipcPingTimer) {
      clearInterval(_ipcPingTimer);
      _ipcPingTimer = null;
    }
    if (_closed || _listeners.size === 0) return;
    if (_wasConnected) _showStatus("Reconnecting\u2026", "#e25");
  });

  // Signal to Electron main that listeners are ready — triggers replay of buffered state
  _ipc.ready();
}

/** Opens connection to server — UDS+IPC when available, WebSocket otherwise */
function _connect() {
  if (_closed) return;

  // UDS mode: Electron IPC bridge — no WebSocket needed
  if (_ipc && !_ws) {
    _connectIPC();
    return;
  }

  if (_ws) return;
  const ws = new WebSocket(buildWsUrl());
  ws.onopen = async () => {
    _connecting = false;
    _retry = 0;
    // Register WS as state-core transport
    _coreSetTransport({
      send: (d: string) => ws.send(d),
      close: () => ws.close(),
    });
    _coreSetConnected(true);
    _ttSetSendFn((cmd: string) => ws.send(cmd));
    ws.send(
      "__type:" +
        (typeof navigator !== "undefined" &&
            /electron/i.test(navigator.userAgent)
          ? "electron"
          : "browser"),
    );
    if (_wasConnected) _showStatus("Connected", "#2a2", 2000);
    _wasConnected = true;

    // Re-send tracked subscriptions on reconnect
    // Re-send tracked subscriptions on reconnect (state-core owns the path set)
    _coreResendSubs();

    // Flush memory queue (initial connect race)
    const q = _queue;
    _queue = [];
    for (const a of q) ws.send(JSON.stringify(a));

    // Load and replay offline queue (persisted during disconnect)
    if (!_offlineReady) {
      const persisted = await _loadOfflineQueue();
      _offlineQueue = persisted.map((p) => p.action);
      _offlineReady = true;
    }
    // Guard: socket may have closed during async _loadOfflineQueue
    if (ws.readyState !== WebSocket.OPEN) return;
    if (_offlineQueue.length) {
      console.log(`[aio] replaying ${_offlineQueue.length} offline actions`);
      for (const a of _offlineQueue) ws.send(JSON.stringify(a));
      _offlineQueue = [];
      _clearOfflineQueue().catch(() => {});
    }

    // Initialize vitals render meter
    if (!_vitalsRenderMeter) {
      const _rb = _w?.__aioConfig?.renderBudget;
      _setVitalsRenderMeter(createRenderMeter({
        thresholds: _rb
          ? { staleness: _rb.staleness, pendingPatches: _rb.pendingPatches }
          : undefined,
        onNotify: _notify,
        onStatusChange: (status, gauges) => {
          if (status !== "healthy" && !_vitalsUrlLogged) {
            _setVitalsUrlLogged(true);
            console.warn(
              `[aio:vitals] dashboard at ${location.origin}/__aio/vitals`,
            );
          }
          if (status === "frozen" || status === "recovered") {
            const kind = status === "frozen"
              ? "freeze" as const
              : "recovered" as const;
            const event: DiagEvent = {
              kind,
              severity: kind === "freeze" ? "likely" : "speculative",
              summary: kind === "freeze"
                ? `RENDER FROZEN — staleness ${
                  Math.round(gauges.staleness.current)
                }ms`
                : "render recovered",
              detail: {
                trigger: _vitalsRenderMeter?.getLastAction() ?? undefined,
              },
              timestamp: Date.now(),
            };
            const lines = formatDiagEvent(event);
            if (lines.length === 1) console.warn(lines[0]);
            else {
              console.group(lines[0]);
              for (let i = 1; i < lines.length; i++) console.warn(lines[i]);
              console.groupEnd();
            }
          } else if (status === "degraded" || status === "warning") {
            // AIO-11: Check for wasted renders (high preservation but still degraded)
            const wastedWarning = _checkWastedRenders(status);
            if (wastedWarning) {
              console.warn(wastedWarning);
            }
            const event: DiagEvent = {
              kind: "pressure",
              severity: status === "degraded" ? "speculative" : "possible",
              summary: `STALENESS ${status.toUpperCase()} — ${
                Math.round(gauges.staleness.current)
              }ms behind`,
              detail: {
                hint: renderHint(gauges) ??
                  "check component complexity and update frequency",
              },
              timestamp: Date.now(),
            };
            const lines = formatDiagEvent(event);
            if (lines.length === 1) console.warn(lines[0]);
            else {
              console.group(lines[0]);
              for (let i = 1; i < lines.length; i++) console.warn(lines[i]);
              console.groupEnd();
            }
          }
        },
      }));
    }
    if (!_vitalsTransportProbe) {
      _setVitalsTransportProbe(createTransportProbeClient({
        thresholds: DEFAULT_THRESHOLDS,
        interval: DEFAULT_HEARTBEAT_INTERVAL,
      }));
    }
    if (!_vitalsPingTimer) {
      _setVitalsPingTimer(setInterval(() => {
        if (_ws && _ws.readyState === WebSocket.OPEN && _vitalsTransportProbe) {
          const ping = _vitalsTransportProbe.createPing();
          const ms = _vitalsRenderMeter
            ? Math.round(_vitalsRenderMeter.getStaleness())
            : 0;
          _ws.send("__vitals:ping:" + JSON.stringify({ t1: ping.t1, ms }));
        }
      }, DEFAULT_HEARTBEAT_INTERVAL));
    }
  };
  ws.onmessage = (e) => {
    // WS reload: close socket before reloading (prevent reconnect race)
    if (e.data === "__reload") {
      _closed = true;
      ws.close();
      location.reload();
      return;
    }
    if (typeof e.data === "string" && handleControlMessage(e.data, _bootId)) {
      return;
    }
    // Client UI request (dev mode) — respond with React component tree
    if (e.data === "__getState") {
      try {
        ws.send("__clientState:" + JSON.stringify(_walkReactTree()));
      } catch (err) {
        ws.send('__clientState:{"error":"' + String(err) + '"}');
      }
      return;
    }
    // Client click command (dev mode) — click a component's DOM node
    if (typeof e.data === "string" && e.data.startsWith("__click:")) {
      const result = _handleClick(e.data.slice(8));
      ws.send("__clientState:" + JSON.stringify(result));
      return;
    }
    // Time-travel metadata from server
    if (typeof e.data === "string" && e.data.startsWith("__tt:")) {
      _handleTTMessage(e.data.slice(5));
      return;
    }
    // Vitals pong from server
    if (typeof e.data === "string" && e.data.startsWith("__vitals:pong:")) {
      try {
        const pong = JSON.parse(e.data.slice(14));
        if (_vitalsTransportProbe) {
          _vitalsTransportProbe.processPong(pong);
        }
      } catch (err) {
        console.warn("[aio:vitals] bad pong:", err);
      }
      return;
    }
    // Diagnostic bus event from server (dev mode)
    if (typeof e.data === "string" && e.data.startsWith("__diag:")) {
      try {
        const ev = JSON.parse(e.data.slice(7));
        if (_w && typeof _w._aioDiag === "function") _w._aioDiag(ev);
      } catch { /* ignore malformed diag */ }
      return;
    }
    try {
      const data = JSON.parse(e.data);
      if (data === null || typeof data !== "object") {
        console.warn("[aio] unexpected state type:", typeof data);
        return;
      }
      const result: _HandleResult = _coreHandleMessage(data);
      if (result === "dropped") {
        _diagEmit({
          type: "delta-before-state",
          severity: "warning",
          source: "browser",
          message: "Delta patch received before full state (WS) — dropped",
          hint:
            "This usually means a reconnect race. The next full state sync will correct this.",
        });
        return;
      }
      if (result === "noop") return;

      const next = _coreGetState();
      _checkStateIntegrity(next);
      _incStateVersion();
      if (_coreHasState()) _resolveStateReady();

      // Deferred React notification via RenderMeter
      if (_vitalsRenderMeter) {
        _vitalsRenderMeter.recordPatch();
        _vitalsRenderMeter.markDirty();
      } else {
        _listeners.notify(next);
      }

      // DevTools
      if (_devtoolsConnected && _lastAction) {
        _sendDevTools(_lastAction, next);
        _lastAction = null;
      }
    } catch (err) {
      console.warn("[aio] bad state message:", err);
      _diagEmit({
        type: "state-sync-error",
        severity: "error",
        source: "browser",
        message: "Failed to parse state message from server (WS)",
        detail: { error: String(err) },
        hint:
          "Server sent malformed state. Check for serialization bugs on the server side.",
      });
    }
  };
  ws.onerror = () => {
    _connecting = false;
    console.warn("[aio] connection error");
  };
  ws.onclose = () => {
    _ws = null;
    _connecting = false;
    _coreSetTransport(null);
    _coreSetConnected(false);
    _ttSetSendFn(null);
    if (_vitalsPingTimer) {
      clearInterval(_vitalsPingTimer);
      _setVitalsPingTimer(null);
    }
    if (_closed || _listeners.size === 0) return;
    if (_wasConnected) _showStatus("Reconnecting\u2026", "#e25");
    // exponential backoff: 1s → 2s → 4s → 8s max, with ±20% jitter
    const base = Math.min(1000 * Math.pow(2, _retry), 8000);
    _retry++;
    console.warn(
      `[aio] disconnected, retrying in ${(base / 1000).toFixed(1)}s...`,
    );
    setTimeout(_connect, base * (0.8 + Math.random() * 0.4));
  };
  _ws = ws;
}

/** Sends action via IPC or WS — queues to memory during initial connect, persists to IndexedDB when disconnected */
function _send(action: { type: string; payload?: unknown }) {
  _lastAction = action; // track for DevTools
  if (_vitalsRenderMeter) {
    const actionType = typeof action === "object" && action !== null
      ? (action as Record<string, unknown>).type as string ?? ""
      : "";
    const feature = actionType.split("/")[0] ?? actionType.split(":")[0] ?? "";
    _vitalsRenderMeter.recordAction(actionType, feature);
  }
  // UDS+IPC mode — send via Electron IPC bridge
  if (_ipc && _ipcConnected) {
    _ipc.send(JSON.stringify(action));
    return;
  }
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(action));
  } else if (!_wasConnected && _queue.length < WS_MAX_QUEUE) {
    // Initial connect race — WS not ready yet
    _queue.push(action);
  } else if (_wasConnected) {
    // Disconnected after initial connection started — persist offline (capped to prevent OOM)
    if (_offlineQueue.length < OFFLINE_MAX_QUEUE) {
      _offlineQueue.push(action);
      _saveOfflineAction(action).catch(() => {}); // best-effort
    } else {
      _diagEmit({
        type: "action-dropped",
        severity: "warning",
        source: "browser",
        message: "Action '" + action.type + "' dropped — offline queue full (" +
          OFFLINE_MAX_QUEUE + ")",
        detail: { actionType: action.type, queueSize: _offlineQueue.length },
        hint:
          "Check network connection. Actions are queued when disconnected but the queue has a limit.",
      });
    }
  } else {
    _diagEmit({
      type: "action-dropped",
      severity: "warning",
      source: "browser",
      message: "Action '" + action.type + "' dropped — connect queue full (" +
        WS_MAX_QUEUE + ")",
      detail: { actionType: action.type, queueSize: _queue.length },
      hint: "Server may be slow to respond. Check terminal for errors.",
    });
  }
}

/** React hook — full app state + untyped send. Deep-proxy-tracked: only accessed paths
 *  are sent by the server. Use `useFeature(f)` for scoped re-renders (this hook
 *  re-renders on every state change; useFeature re-renders only when its feature changes). */
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

// ── msg, actions, effects, schedule — shared with browser-air.ts (AIO-47) ──
export { actions, effects, msg, schedule } from "./browser-shared.ts";

function _getCachedSend(
  ref: _CoreFeatureRef,
): Record<string, (...args: unknown[]) => void> {
  let obj = _featureSendCache.get(ref);
  if (!obj) {
    obj = _coreCreateSendProxy(ref.__aio.id, ref, _send);
    _featureSendCache.set(ref, obj);
  }
  return obj;
}

/** v0.5 hook — connects UI to a specific feature with scoped state, typed send, and machine status.
 *  Uses selector-based subscription: only re-renders when this feature's slice changes (not on every WS message).
 *
 *  Pass `fallback` to skip the `state: S | null` guard — useful for Electron/local apps where
 *  connection is near-instant and you want components to render immediately with initial state:
 *
 *  ```tsx
 *  const { state, send } = useFeature(counter, { fallback: counter.__aio.state as CounterState })
 *  // state is CounterState, never null
 *  ```
 */
export function useFeature<S>(
  ref: _CoreFeatureRef,
  options: { fallback: S },
): {
  state: S;
  send: Record<string, (...args: unknown[]) => void>;
  status: string | undefined;
};
export function useFeature<S = unknown>(
  ref: _CoreFeatureRef,
  options?: { fallback?: never },
): {
  state: S | null;
  send: Record<string, (...args: unknown[]) => void>;
  status: string | undefined;
};
export function useFeature<S = unknown>(
  ref: _CoreFeatureRef,
  options?: { fallback?: S },
): {
  state: S;
  send: Record<string, (...args: unknown[]) => void>;
  status: string | undefined;
} {
  const name = ref.__aio.id;

  // Register feature path for proxy-tracked subscriptions.
  _coreTrackPath(name);

  // Selector: extract just this feature's slice from global state
  const getSliceSnapshot = useCallback((): S | null => {
    if (!_coreHasState()) return null;
    return (_coreGetState() as Record<string, unknown>)[name] as S | null;
  }, [name]);

  const featureState = useSyncExternalStore(
    _subscribe,
    getSliceSnapshot,
    _getServerSnapshot as () => S | null,
  );

  // AIO-29 defense: deep-merge with feature's initial state or explicit fallback
  const defaults = options?.fallback ?? (ref.__aio.state as S | undefined);
  const resolved = _coreResolveWithFallback(featureState, defaults);

  const status = resolved
    ? (resolved as Record<string, unknown>)._status as string | undefined
    : undefined;

  return {
    state: _trackingProxy(resolved, name) as S,
    send: _getCachedSend(ref),
    status,
  };
}

/** Client-only state — not synced to server, not persisted. For UI-local concerns (editing flags, form inputs, etc.) */
export function useLocal<T>(
  initial: T,
): { local: T; set: (next: T | ((prev: T) => T)) => void } {
  const [local, setLocal] = useState<T>(initial);
  return { local, set: setLocal };
}

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

/** Derives state from a transformation, preserving element-level references.
 *
 *  Like `useMemo`, but when the transform re-runs and returns an array,
 *  `_preserveArrayRefs` is applied to the output — unchanged elements keep
 *  their previous object reference, enabling `memo()` to skip re-renders.
 *
 *  ```tsx
 *  const groups = useProjection(() => buildGroups(state.members), [state.members]);
 *  ```
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

/** Per-prop comparison: uses _shallowEqual for object props, === for primitives/arrays.
 *  Exported for testing. */
// Re-export _memoCompare is already done from protocol; here we use it

/** Drop-in replacement for React.memo with smarter default comparison.
 *
 *  Uses `_shallowEqual` on each prop (one level deeper than React.memo's default `===`).
 *  This catches the case where a parent creates new container objects that are
 *  structurally identical to the previous props — e.g. `{ ...member, extra: val }`.
 *
 *  ```tsx
 *  import { memo } from "aio";  // instead of React.memo
 *  export default memo(MemberCard);  // _shallowEqual per prop, not ===
 *  ```
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

/** Renders the component matching the current page key. Usage: page(state.page, { home: Home, settings: Settings }) */
export function page<K extends string>(
  current: K,
  routes: Record<K, ComponentType>,
): ReturnType<typeof createElement> | null {
  const Component = routes[current];
  return Component ? createElement(Component) : null;
}

// ── React fiber tree walker (dev mode) ──────────────────────────────
// Walks the React fiber tree from the root and extracts component names,
// useState hooks state, and props for each mounted component.

type _ComponentInfo = {
  component: string;
  state?: unknown;
  props?: Record<string, unknown>;
  children?: _ComponentInfo[];
};

/** Find React fiber root from the DOM */
function _findFiberRoot(): Record<string, unknown> | null {
  const root = document.getElementById("root") ??
    document.getElementById("app");
  if (!root) return null;
  const fiberKey = Object.getOwnPropertyNames(root).find((k) =>
    k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$") ||
    k.startsWith("__reactInternalInstance$")
  );
  if (!fiberKey) return null;
  let fiber = (root as unknown as Record<string, unknown>)[fiberKey] as
    | Record<string, unknown>
    | null;
  if (!fiber) return null;
  if (fiberKey.startsWith("__reactContainer$") && fiber.current) {
    fiber = fiber.current as Record<string, unknown>;
  }
  return fiber;
}

/** Walk React fiber tree and return component info list */
function _walkReactTree(): _ComponentInfo[] {
  const fiber = _findFiberRoot();
  if (!fiber) return [];
  const result: _ComponentInfo[] = [];
  _walkFiber(fiber, result);
  return result;
}

/** Find a component's fiber by name + index or name + prop match */
function _findComponentFiber(
  fiber: Record<string, unknown>,
  name: string,
  match: { index: number } | { prop: string; value: string },
  counter = { n: 0 },
): Record<string, unknown> | null {
  const tag = fiber.tag as number;
  const type = fiber.type as unknown;
  if (type && (tag === 0 || tag === 1 || tag === 11 || tag === 15)) {
    const cName = typeof type === "function"
      ? (type as { displayName?: string; name?: string }).displayName ??
        (type as { name?: string }).name
      : null;
    if (cName === name) {
      if ("index" in match) {
        if (counter.n === match.index) return fiber;
        counter.n++;
      } else {
        const props = fiber.memoizedProps as Record<string, unknown> | null;
        if (props && String(props[match.prop]) === match.value) return fiber;
      }
    }
  }
  let child = fiber.child as Record<string, unknown> | null;
  while (child) {
    const found = _findComponentFiber(child, name, match, counter);
    if (found) return found;
    child = child.sibling as Record<string, unknown> | null;
  }
  return null;
}

/** Find the nearest DOM node from a fiber (walk down to first HostComponent) */
function _fiberToDOM(fiber: Record<string, unknown>): HTMLElement | null {
  // stateNode on HostComponent (tag 5) is the DOM node
  if (fiber.tag === 5 && fiber.stateNode instanceof HTMLElement) {
    return fiber.stateNode;
  }
  // For function components, walk down to first child HostComponent
  let child = fiber.child as Record<string, unknown> | null;
  while (child) {
    if (child.tag === 5 && child.stateNode instanceof HTMLElement) {
      return child.stateNode as HTMLElement;
    }
    const found = _fiberToDOM(child);
    if (found) return found;
    child = child.sibling as Record<string, unknown> | null;
  }
  return null;
}

/** Handle __click: command — find component and click its DOM node */
function _handleClick(
  cmd: string,
): { ok: boolean; error?: string; clicked?: string } {
  const root = _findFiberRoot();
  if (!root) return { ok: false, error: "no React root found" };

  // Parse: "ComponentName:index" or "ComponentName:prop:value"
  const parts = cmd.split(":");
  const name = parts[0];
  if (!name) return { ok: false, error: "no component name" };

  let match: { index: number } | { prop: string; value: string };
  if (parts.length === 2 && /^\d+$/.test(parts[1]!)) {
    match = { index: Number(parts[1]) };
  } else if (parts.length === 3) {
    match = { prop: parts[1]!, value: parts[2]! };
  } else {
    match = { index: 0 }; // default: first instance
  }

  const fiber = _findComponentFiber(root, name, match);
  if (!fiber) return { ok: false, error: `component '${name}' not found` };

  const el = _fiberToDOM(fiber);
  if (!el) return { ok: false, error: `component '${name}' has no DOM node` };

  el.click();
  return { ok: true, clicked: `${name} → <${el.tagName.toLowerCase()}>` };
}

function _walkFiber(
  fiber: Record<string, unknown>,
  out: _ComponentInfo[],
): void {
  // tag 0 = FunctionComponent, 1 = ClassComponent, 11 = ForwardRef, 15 = SimpleMemoComponent
  const tag = fiber.tag as number;
  const type = fiber.type as ((...args: unknown[]) => unknown) | {
    displayName?: string;
    name?: string;
  } | null;

  if (type && (tag === 0 || tag === 1 || tag === 11 || tag === 15)) {
    const name = typeof type === "function"
      ? (type as { displayName?: string; name?: string }).displayName ??
        (type as { name?: string }).name ?? "Anonymous"
      : (type as { displayName?: string }).displayName ?? "Unknown";

    // Skip React internals
    if (name && !name.startsWith("__") && name !== "Fragment") {
      const info: _ComponentInfo = { component: name };

      // Extract useState hook state from memoizedState chain
      const hookState = _extractHookState(
        fiber.memoizedState as Record<string, unknown> | null,
      );
      if (hookState.length) {
        info.state = hookState.length === 1 ? hookState[0] : hookState;
      }

      // Extract props (skip children and internal keys)
      const props = fiber.memoizedProps as Record<string, unknown> | null;
      if (props) {
        const cleaned: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if (k === "children" || typeof v === "function") continue;
          try {
            JSON.stringify(v);
            cleaned[k] = v;
          } catch { /* non-serializable, skip */ }
        }
        if (Object.keys(cleaned).length) info.props = cleaned;
      }

      out.push(info);
    }
  }

  // Walk children
  let child = fiber.child as Record<string, unknown> | null;
  while (child) {
    _walkFiber(child, out);
    child = child.sibling as Record<string, unknown> | null;
  }
}

function _extractHookState(
  memoizedState: Record<string, unknown> | null,
): unknown[] {
  const states: unknown[] = [];
  let hook = memoizedState;
  while (hook) {
    // useState hooks have a queue with a lastRenderedState
    const queue = hook.queue as Record<string, unknown> | null;
    if (queue && "lastRenderedState" in queue) {
      const val = queue.lastRenderedState;
      // Only include serializable values
      try {
        JSON.stringify(val);
        states.push(val);
      } catch { /* skip */ }
    }
    hook = hook.next as Record<string, unknown> | null;
  }
  return states;
}

/** Resets module state — for testing only */
export function _reset(): void {
  _closed = true;
  _ws?.close();
  _ws = null;
  _resetInitialShapeKeys();
  _queue = [];
  _retry = 0;
  _closed = false;
  _listeners.clear();
  _resetTT();
  _resetStatus();
  _wasConnected = false;
  _bootId.current = null;
  _offlineReady = false;
  _offlineQueue = [];
  _resetIDB();
  _lastAction = null;
  _resetDevTools();
  _ipcConnected = false;
  if (_ipcPingTimer) {
    clearInterval(_ipcPingTimer);
    _ipcPingTimer = null;
  }
  _connecting = false;
  _resetStateReady();
  if (_cleanupTimer) {
    clearTimeout(_cleanupTimer);
    _setCleanupTimer(null);
  }
  _setListenerHighWater(0);
  _resetStateVersion();
  _setUseAioActiveCount(0);
  _diagLastEmit.clear();
  _resetArrayRefStats();
  _setVitalsUrlLogged(false);
  if (_vitalsPingTimer) {
    clearInterval(_vitalsPingTimer);
    _setVitalsPingTimer(null);
  }
  _setVitalsTransportProbe(null);
  if (_popstateHandler) {
    removeEventListener("popstate", _popstateHandler);
    _setPopstateHandler(null);
  }
  _resetTracking();
  _coreReset(); // reset state-core signals
  _resetEnsured();
}

// ── Framework-agnostic client ─────────────────────────────────────────────
// Public API for non-React frameworks. Same singleton — shared with useAio/useFeature.
// (client object is defined in protocol — re-exported above)

// ── Router ────────────────────────────────────────────────────────────────
// Client-side routing — history API, nested routes, URL params, search params
// (matchPath, navigate, _rPath, _rSearch, _rListeners, popstate defined in protocol)

/** Current route state — path, params, search, and match status */
/** Current route. With pattern ('/users/:id') extracts params. */
export function useRoute(pattern?: string): RouteState {
  useSyncExternalStore(_rSubscribe, _rSnapshot, () => "/");
  const path = _getRPath();
  const search = _getRSearch();
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

// ── Route context (nested routes + Outlet) ───────────────────────────────

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
  useSyncExternalStore(_rSubscribe, _rSnapshot, () => "/"); // re-render on URL changes
  const { basePath, params: parentParams } = useContext(_RouteCtx);
  const currentPath = _getRPath();

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
  return createElement(
    _RouteCtx.Provider as ComponentType<{ value: _RouteCtxType }>,
    {
      value: {
        basePath: full,
        params: allParams,
        outlet: hasChildren ? children : null,
      },
    },
    (hasChildren
      ? (element ?? createElement(Outlet as () => null))
      : element ?? null) as ReactNode,
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
  useSyncExternalStore(_rSubscribe, _rSnapshot, () => "/");
  const path = _getRPath();
  const isActive = (exact || to === "/")
    ? path === to
    : path === to || path.startsWith(to + "/");
  function handleClick(e: MouseEvent) {
    if (
      (e as MouseEvent & { button: number }).button !== 0 || e.metaKey ||
      e.ctrlKey || e.shiftKey || e.altKey
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
  return createElement("a", {
    ...rest,
    href: to,
    onClick: handleClick,
    className: cls,
    style: sty,
  }, children as ReactNode);
}

/** Link with automatic 'active' class. Prefix match by default, exact for '/' and when exact=true. */
export function NavLink(
  { activeClass = "active", ...rest }: Omit<LinkProps, "activeClass"> & {
    activeClass?: string;
  },
): unknown {
  return createElement(
    Link as ComponentType<LinkProps>,
    { activeClass, ...rest } as LinkProps,
  );
}

/** Navigates to `to` on mount — use for auth redirects. Replace=true by default (no history entry). */
export function Redirect(
  { to, replace: rep = true }: { to: string; replace?: boolean },
): null {
  useLayoutEffect(() => {
    navigate(to, { replace: rep });
  }, [to]);
  return null;
}
