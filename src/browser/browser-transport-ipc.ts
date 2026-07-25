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
import {
  type AckPayload,
  dec,
  enc,
  v1PeerReason,
} from "../protocol/envelope.ts";
import { _rejectAck, _resolveAck } from "../protocol/browser-ack.ts";
import { handleControlFrame } from "./browser-shared.ts";
import {
  getStateSnapshot,
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
    for (const a of q) T.ipc!.send(enc("action", a));
    if (!T.ipcPingTimer) {
      T.ipcPingTimer = setInterval(() => {
        if (T.ipc && T.ipcConnected) T.ipc.send(enc("ping"));
      }, IPC_PING_INTERVAL);
    }
  });

  T.ipc.onMessage((line: string) => {
    const frame = dec(line);
    if (!frame) {
      // The one v1 shim: a v1 server's hello/refusal is still readable.
      const v1 = v1PeerReason(line);
      if (v1) console.error(`[aio] protocol version mismatch: ${v1}`);
      else console.warn("[aio] undecodable frame — dropped");
      return;
    }
    if (handleControlFrame(frame, T.bootId)) return;
    switch (frame.t) {
      case "get-state":
        try {
          T.ipc!.send(enc("client-state", getStateSnapshot()));
        } catch (err) {
          T.ipc!.send(enc("client-state", { error: String(err) }));
        }
        return;
      case "tt-state":
        _handleTTMessage(frame.d as object);
        return;
      case "diag":
        try {
          if (_w && typeof _w._aioDiag === "function") {
            _w._aioDiag(frame.d as Record<string, unknown>);
          }
        } catch { /* ignore malformed diag */ }
        return;
      case "ack": {
        // AIO-402: per-action ack over UDS+IPC — settle the awaited method.
        const { cid, ok, value, error } = (frame.d ?? {}) as AckPayload;
        if (typeof cid !== "string") return;
        if (ok) _resolveAck(cid, value);
        else _rejectAck(cid, new Error(error ?? "server rejected action"));
        return;
      }
      case "state":
      case "patches":
        handleStateMessage(frame.t, frame.d, "IPC");
        return;
      default:
        console.warn(`[aio] unexpected "${frame.t}" frame (IPC) — dropped`);
        return;
    }
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
