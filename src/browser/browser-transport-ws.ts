// WebSocket connection logic for browser transport.

import { backoffDelay } from "../protocol/transport-shared.ts";
import {
  type AckPayload,
  dec,
  enc,
  v1PeerReason,
} from "../protocol/envelope.ts";
import {
  handleTTMessage as _handleTTMessage,
  setSendFn as _ttSetSendFn,
} from "../air/time-travel-panel.ts";
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
import { buildWsUrl, handleControlFrame } from "./browser-shared.ts";
import { getStateSnapshot, T } from "./browser-transport-state.ts";
import {
  _rejectAck,
  _rejectAllPending,
  _resolveAck,
} from "../protocol/browser-ack.ts";
import { handleStateMessage } from "./browser-transport-handler.ts";
import { initVitals } from "./browser-transport-vitals.ts";
import { connectIPC } from "./browser-transport-ipc.ts";
import {
  negotiateProtocol,
  parseProtoHello,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  protoHello,
  stampedVersion,
} from "../protocol/protocol-version.ts";

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
    ws.send(enc("proto", protoHello(stampedVersion())));
    ws.send(enc("type", {
      kind: typeof navigator !== "undefined" &&
          /electron/i.test(navigator.userAgent)
        ? "electron"
        : "browser",
    }));
    if (T.wasConnected) {
      _showStatus("Connected", "#2a2", 2000);
      console.info("[aio] reconnected"); // recovery is logged once, matching the one-shot disconnect log
    }
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
    for (const a of q) ws.send(enc("action", a));

    if (T.offlineQueue.length) {
      console.debug(
        `[aio] replaying ${T.offlineQueue.length} offline actions`,
      );
      for (const a of T.offlineQueue) ws.send(enc("action", a));
      T.offlineQueue = [];
      _clearOfflineQueue().catch(() => {});
    }

    initVitals(ws);
  };

  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    const _protoMismatch = (reason: string) => {
      // Loud + terminal: retrying can't fix a version gap.
      console.error(`[aio] protocol version mismatch: ${reason}`);
      _showStatus("Protocol mismatch — reload/update the app", "#e25");
      T.closed = true; // stop the reconnect loop
      ws.close(PROTOCOL_MISMATCH_CLOSE_CODE, "protocol mismatch");
    };
    const frame = dec(e.data);
    if (!frame) {
      // The one v1 shim: a v1 server's hello/refusal is still readable.
      const v1 = v1PeerReason(e.data);
      if (v1) _protoMismatch(v1);
      else console.warn("[aio] undecodable frame — dropped");
      return;
    }
    switch (frame.t) {
      case "reload":
        T.closed = true;
        ws.close();
        location.reload();
        return;
      // A3: wire-protocol version handshake (server speaks first).
      case "proto": {
        const theirs = parseProtoHello(frame.d);
        if (!theirs) return; // malformed — ignore, server will still enforce
        const result = negotiateProtocol(protoHello(stampedVersion()), theirs);
        if (!result.ok) {
          _protoMismatch(result.reason);
          return;
        }
        T.protocolVersion = result.effective;
        return;
      }
      // A3: server rejected our hello — terminal, do not reconnect-storm.
      case "proto-err":
        _protoMismatch(
          (frame.d as { reason?: string } | undefined)?.reason ?? "?",
        );
        return;
      case "get-state":
        try {
          ws.send(enc("client-state", getStateSnapshot()));
        } catch (err) {
          ws.send(enc("client-state", { error: String(err) }));
        }
        return;
      case "tt-state":
        _handleTTMessage(frame.d as object);
        return;
      case "vitals-pong":
        try {
          if (_vitalsTransportProbe) {
            _vitalsTransportProbe.processPong(
              frame.d as import("../vitals/transport-probe.ts").VitalsPong,
            );
          }
        } catch (err) {
          console.warn("[aio:vitals] bad pong:", err);
        }
        return;
      case "ack": {
        // AIO-2.2: settle the pending ack for this cid.
        const { cid, ok, value, error } = (frame.d ?? {}) as AckPayload;
        if (typeof cid !== "string") return;
        if (ok) _resolveAck(cid, value);
        else _rejectAck(cid, new Error(error ?? "server rejected action"));
        return;
      }
      case "diag":
        try {
          if (_w && typeof _w._aioDiag === "function") {
            _w._aioDiag(frame.d as Record<string, unknown>);
          }
        } catch { /* ignore malformed diag */ }
        return;
      case "state":
      case "patches":
        handleStateMessage(frame.t, frame.d, "WS");
        return;
      default:
        if (handleControlFrame(frame, T.bootId)) return;
        console.warn(`[aio] unexpected "${frame.t}" frame — dropped`);
        return;
    }
  };

  ws.onerror = () => {
    // No log here — an error is always followed by onclose, which reports the
    // outage exactly once. Logging both flooded the console on every retry.
    T.connecting = false;
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
    const delay = backoffDelay(T.retry);
    // Log the outage ONCE (first retry of this outage), not every attempt — the
    // on-screen "Reconnecting…" status above is the live per-attempt indicator.
    if (T.retry === 0) {
      console.warn("[aio] disconnected — reconnecting (backoff up to 8s)…");
    }
    T.retry++;
    setTimeout(() => {
      T.connecting = false;
      connect();
    }, delay);
  };

  T.ws = ws;
}
