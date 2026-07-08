// Wire protocol callback registration — side effects that run on module load.
// Registers connectFn, subscribeTriggers, teardownFn, and clientSend on the protocol layer.

import { resetTT as _resetTT } from "../air/time-travel-panel.ts";
import {
  _coreReset,
  _navigateHandler,
  _popstateHandler,
  _resetInitialShapeKeys,
  _resetStateReady,
  _rSync,
  _setClientSend,
  _setConnectFn,
  _setListenerHighWater,
  _setNavigateHandler,
  _setPopstateHandler,
  _setSubscribeTriggers,
  _setTeardownFn,
  _setVisibilityHandler,
  _setVitalsRenderMeter,
  _visibilityHandler,
  _vitalsRenderMeter,
} from "./browser-protocol.ts";
import { T } from "./browser-transport-state.ts";
import { connect } from "./browser-transport-ws.ts";
import { send } from "./browser-transport-send.ts";

_setConnectFn(() => {
  if (!T.ws && !T.ipcConnected && !T.connecting) {
    T.closed = false;
    T.connecting = true;
    connect();
  }
});

_setSubscribeTriggers(
  () => {
    if (!T.ws && !T.ipcConnected && !T.connecting) {
      T.closed = false;
      T.connecting = true;
      connect();
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

_setTeardownFn(() => {
  T.closed = true;
  T.ws?.close();
  T.ws = null;
  T.ipcConnected = false;
  T.connecting = false;
  if (T.ipcPingTimer) {
    clearInterval(T.ipcPingTimer);
    T.ipcPingTimer = null;
  }
  _coreReset();
  _resetInitialShapeKeys();
  _resetStateReady();
  T.queue = [];
  T.retry = 0;
  _setListenerHighWater(0);
  if (_vitalsRenderMeter) {
    _vitalsRenderMeter.destroy();
    _setVitalsRenderMeter(null);
  }
  _resetTT();
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
});

_setClientSend(send);

// Force side-effect evaluation — this module must be imported for wiring to occur.
export const _wireInitialized = true;
