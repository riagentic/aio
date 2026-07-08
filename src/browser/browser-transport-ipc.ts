// IPC (Electron UDS) connection logic for browser transport.

import {
  handleTTMessage as _handleTTMessage,
  setSendFn as _ttSetSendFn,
} from "../air/time-travel-panel.ts";
import {
  _coreSetConnected,
  _coreSetTransport,
  _listeners,
  _showStatus,
  _w,
} from "./browser-protocol.ts";
import { handleControlMessage } from "./browser-shared.ts";
import {
  getStateSnapshot,
  handleClickCmd,
  IPC_PING_INTERVAL,
  T,
} from "./browser-transport-state.ts";
import { handleStateMessage } from "./browser-transport-handler.ts";

/** Connects via Electron IPC bridge (UDS mode) — messages are NDJSON lines. */
export function connectIPC(reconnect: () => void): void {
  if (!T.ipc || T.ipcConnected) {
    T.connecting = false; // AIO-218: reset flag when bailing out
    return;
  }
  T.ipcConnected = true;

  T.ipc.onOpen(() => {
    T.connecting = false; // AIO-218: clear connecting flag on success
    T.retry = 0;
    if (T.wasConnected) _showStatus("Connected", "#2a2", 2000);
    T.wasConnected = true;
    _coreSetTransport({
      send: (d: string) => T.ipc!.send(d),
      close: () => {},
    });
    _coreSetConnected(true);
    _ttSetSendFn((cmd: string) => T.ipc!.send(cmd));
    const q = T.queue;
    T.queue = [];
    for (const a of q) T.ipc!.send(JSON.stringify(a));
    if (!T.ipcPingTimer) {
      T.ipcPingTimer = setInterval(() => {
        if (T.ipc && T.ipcConnected) T.ipc.send("__ping");
      }, IPC_PING_INTERVAL);
    }
  });

  T.ipc.onMessage((line: string) => {
    if (handleControlMessage(line, T.bootId)) return;
    if (line === "__getState") {
      try {
        T.ipc!.send(
          "__clientState:" + JSON.stringify(getStateSnapshot()),
        );
      } catch (err) {
        T.ipc!.send('__clientState:{"error":"' + String(err) + '"}');
      }
      return;
    }
    if (line.startsWith("__click:")) {
      const result = handleClickCmd(line.slice(8));
      T.ipc!.send("__clientState:" + JSON.stringify(result));
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
    handleStateMessage(line, "IPC");
  });

  T.ipc.onClose(() => {
    T.ipcConnected = false;
    T.connecting = false; // AIO-218: allow reconnection triggers after close
    _coreSetTransport(null);
    _coreSetConnected(false);
    _ttSetSendFn(null);
    if (T.ipcPingTimer) {
      clearInterval(T.ipcPingTimer);
      T.ipcPingTimer = null;
    }
    if (T.closed || _listeners.size === 0) return;
    if (T.wasConnected) _showStatus("Reconnecting\u2026", "#e25");
    const base = Math.min(1000 * Math.pow(2, T.retry), 8000);
    T.retry++;
    setTimeout(reconnect, base * (0.8 + Math.random() * 0.4));
  });

  T.ipc.ready();
}
