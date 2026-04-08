// Transport reset logic — teardown all state for testing.

import { resetTT as _resetTT } from "./time-travel-panel.ts";
import {
  _cleanupTimer,
  _coreReset,
  _diagLastEmit,
  _listeners,
  _navigateHandler,
  _popstateHandler,
  _resetArrayRefStats,
  _resetDevTools,
  _resetEnsured,
  _resetIDB,
  _resetInitialShapeKeys,
  _resetStateReady,
  _resetStateVersion,
  _resetStatus,
  _resetTracking,
  _setCleanupTimer,
  _setListenerHighWater,
  _setNavigateHandler,
  _setPopstateHandler,
  _setUseAioActiveCount,
  _setVisibilityHandler,
  _setVitalsPingTimer,
  _setVitalsTransportProbe,
  _setVitalsUrlLogged,
  _visibilityHandler,
  _vitalsPingTimer,
} from "./browser-protocol.ts";
import { T } from "./browser-transport-state.ts";

/** Tears down all transport state — for testing only. */
export function resetTransport(): void {
  T.closed = true;
  T.ws?.close();
  T.ws = null;
  _resetInitialShapeKeys();
  T.queue = [];
  T.retry = 0;
  T.closed = false;
  _listeners.clear();
  _resetTT();
  _resetStatus();
  T.wasConnected = false;
  T.bootId.current = null;
  T.offlineReady = false;
  T.offlineQueue = [];
  _resetIDB();
  T.lastAction = null;
  _resetDevTools();
  T.ipcConnected = false;
  if (T.ipcPingTimer) {
    clearInterval(T.ipcPingTimer);
    T.ipcPingTimer = null;
  }
  T.connecting = false;
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
  if (_navigateHandler) {
    removeEventListener("aio:navigate", _navigateHandler);
    _setNavigateHandler(null);
  }
  if (_visibilityHandler && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", _visibilityHandler);
    _setVisibilityHandler(null);
  }
  _resetTracking();
  _coreReset();
  _resetEnsured();
}
