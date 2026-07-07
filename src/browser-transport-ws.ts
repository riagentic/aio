// WebSocket connection logic for browser transport.

import {
  handleTTMessage as _handleTTMessage,
  setSendFn as _ttSetSendFn,
} from "./time-travel-panel.ts";
import {
  _clearOfflineQueue,
  _coreResendSubs,
  _coreSetConnected,
  _coreSetTransport,
  _listeners,
  _loadOfflineQueue,
  _setVitalsPingTimer,
  _showStatus,
  _vitalsPingTimer,
  _vitalsTransportProbe,
  _w,
} from "./browser-protocol.ts";
import { buildWsUrl, handleControlMessage } from "./browser-shared.ts";
import {
  getStateSnapshot,
  handleClickCmd,
  T,
} from "./browser-transport-state.ts";
import { _rejectAck, _rejectAllPending, _resolveAck } from "./browser-ack.ts";
import { handleStateMessage } from "./browser-transport-handler.ts";
import { initVitals } from "./browser-transport-vitals.ts";
import { connectIPC } from "./browser-transport-ipc.ts";
import {
  negotiateProtocol,
  parseProtoHello,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  protoHello,
} from "./protocol-version.ts";

/** Opens connection to server — UDS+IPC when available, WebSocket otherwise. */
export function connect(): void {
  if (T.closed) return;

  if (T.ipc && !T.ws) {
    connectIPC(connect);
    return;
  }

  if (T.ws) return;
  const ws = new WebSocket(buildWsUrl());
  ws.onopen = async () => {
    T.connecting = false;
    T.retry = 0;
    _coreSetTransport({
      send: (d: string) => ws.send(d),
      close: () => ws.close(),
    });
    _ttSetSendFn((cmd: string) => ws.send(cmd));
    // A3: announce our wire-protocol version before anything else.
    ws.send("__proto:" + JSON.stringify(protoHello()));
    ws.send(
      "__type:" +
        (typeof navigator !== "undefined" &&
            /electron/i.test(navigator.userAgent)
          ? "electron"
          : "browser"),
    );
    if (T.wasConnected) _showStatus("Connected", "#2a2", 2000);
    T.wasConnected = true;

    // Load offline queue FIRST — before subscriptions trigger server broadcasts
    if (!T.offlineReady) {
      const persisted = await _loadOfflineQueue();
      T.offlineQueue = persisted.map((p) => p.action);
      T.offlineReady = true;
    }
    if (ws.readyState !== WebSocket.OPEN) return;

    _coreSetConnected(true);
    _coreResendSubs();

    const q = T.queue;
    T.queue = [];
    for (const a of q) ws.send(JSON.stringify(a));

    if (T.offlineQueue.length) {
      console.debug(
        `[aio] replaying ${T.offlineQueue.length} offline actions`,
      );
      for (const a of T.offlineQueue) ws.send(JSON.stringify(a));
      T.offlineQueue = [];
      _clearOfflineQueue().catch(() => {});
    }

    initVitals(ws);
  };

  ws.onmessage = (e) => {
    if (e.data === "__reload") {
      T.closed = true;
      ws.close();
      location.reload();
      return;
    }
    // A3: wire-protocol version handshake (server speaks first).
    if (typeof e.data === "string" && e.data.startsWith("__proto:")) {
      const theirs = parseProtoHello(e.data.slice(8));
      if (!theirs) return; // malformed — ignore, server will still enforce
      const result = negotiateProtocol(protoHello(), theirs);
      if (!result.ok) {
        // Loud + terminal: retrying can't fix a version gap.
        console.error(`[aio] protocol version mismatch: ${result.reason}`);
        _showStatus("Protocol mismatch — reload/update the app", "#e25");
        T.closed = true; // stop the reconnect loop
        ws.close(PROTOCOL_MISMATCH_CLOSE_CODE, "protocol mismatch");
        return;
      }
      T.protocolVersion = result.effective;
      return;
    }
    // A3: server rejected our hello — terminal, do not reconnect-storm.
    if (typeof e.data === "string" && e.data.startsWith("__proto-err:")) {
      console.error(
        `[aio] server rejected protocol version: ${e.data.slice(12)}`,
      );
      _showStatus("Protocol mismatch — reload/update the app", "#e25");
      T.closed = true;
      return;
    }
    if (typeof e.data === "string" && handleControlMessage(e.data, T.bootId)) {
      return;
    }
    if (e.data === "__getState") {
      try {
        ws.send("__clientState:" + JSON.stringify(getStateSnapshot()));
      } catch (err) {
        ws.send('__clientState:{"error":"' + String(err) + '"}');
      }
      return;
    }
    if (typeof e.data === "string" && e.data.startsWith("__click:")) {
      const result = handleClickCmd(e.data.slice(8));
      ws.send("__clientState:" + JSON.stringify(result));
      return;
    }
    if (typeof e.data === "string" && e.data.startsWith("__tt:")) {
      _handleTTMessage(e.data.slice(5));
      return;
    }
    if (typeof e.data === "string" && e.data.startsWith("__vitals:pong:")) {
      try {
        const pong = JSON.parse(e.data.slice(14));
        if (_vitalsTransportProbe) _vitalsTransportProbe.processPong(pong);
      } catch (err) {
        console.warn("[aio:vitals] bad pong:", err);
      }
      return;
    }
    if (typeof e.data === "string" && e.data.startsWith("__ack:")) {
      // AIO-2.2: settle the pending ack for this cid.
      // Format: __ack:<cid>:<ok>  (ok is "1" or "0")
      const rest = e.data.slice(6);
      const sep = rest.indexOf(":");
      if (sep > 0) {
        const cid = rest.slice(0, sep);
        const ok = rest.slice(sep + 1) === "1";
        if (ok) {
          _resolveAck(cid);
        } else {
          _rejectAck(cid, new Error("server rejected action"));
        }
      }
      return;
    }
    if (typeof e.data === "string" && e.data.startsWith("__diag:")) {
      try {
        const ev = JSON.parse(e.data.slice(7));
        if (_w && typeof _w._aioDiag === "function") _w._aioDiag(ev);
      } catch { /* ignore malformed diag */ }
      return;
    }
    handleStateMessage(e.data, "WS");
  };

  ws.onerror = () => {
    T.connecting = false;
    console.warn("[aio] connection error");
  };

  ws.onclose = () => {
    T.ws = null;
    _coreSetTransport(null);
    _coreSetConnected(false);
    _ttSetSendFn(null);
    // AIO-2.2: reject any pending acks — the connection is gone.
    _rejectAllPending(new Error("connection lost"));
    if (_vitalsPingTimer) {
      clearInterval(_vitalsPingTimer);
      _setVitalsPingTimer(null);
    }
    if (T.closed || _listeners.size === 0) {
      T.connecting = false;
      return;
    }
    // AIO-246: keep _connecting=true during backoff to prevent connection storms
    T.connecting = true;
    if (T.wasConnected) _showStatus("Reconnecting\u2026", "#e25");
    const base = Math.min(1000 * Math.pow(2, T.retry), 8000);
    T.retry++;
    console.warn(
      `[aio] disconnected, retrying in ${(base / 1000).toFixed(1)}s...`,
    );
    setTimeout(() => {
      T.connecting = false;
      connect();
    }, base * (0.8 + Math.random() * 0.4));
  };

  T.ws = ws;
}
