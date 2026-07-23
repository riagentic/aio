// deno-lint-ignore-file
// browser-air-transport: WS/IPC transport layer for AIR renderer.
// Minimal WS transport (no React, no vitals) — just WS <-> state-core bridge.

import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
import { _registerSfnTransport, handleSfnResult } from "./server-fns-client.ts";
import { installConsoleIntercept } from "./console-intercept.ts";
import { routeCommand } from "./browser-air-commands.ts";
import { protoHello, stampedVersion } from "../protocol/protocol-version.ts";
import {
  _checkStateIntegrity,
  _coreGetState,
  _coreHandleMessage,
  _coreHasState,
  _coreResendSubs,
  _coreSetConnected,
  _coreSetTransport,
  type _HandleResult,
  _incStateVersion,
  _resolveStateReady,
  _setClientSend,
  _setConnectFn,
  _setSubscribeTriggers,
  _setTeardownFn,
} from "./browser-protocol.ts";
import { _registerSyncTransport } from "./browser-protocol.ts";
import {
  type AioIPCBridge,
  buildWsUrl,
  detectIPC,
  handleControlFrame,
} from "./browser-shared.ts";
import { dec, enc, v1PeerReason } from "../protocol/envelope.ts";

let _ws: WebSocket | null = null;
let _closed = false;
let _connecting = false;
let _wasConnected = false;
let _retry = 0;
let _queue: Array<{ type: string; payload?: unknown }> = [];
const QUEUE_MAX = 1000;
let _connectionDegraded = false;

function _updateDegraded(): void {
  const degraded = _queue.length > QUEUE_MAX * 0.8;
  if (_connectionDegraded !== degraded) _connectionDegraded = degraded;
}

/** Returns true when the offline action queue is >80% full — UI can use this
 *  to show a "reconnecting / slow connection" indicator. */
export function isConnectionDegraded(): boolean {
  return _connectionDegraded;
}
let _onSyncMessage: ((t: string, d: unknown) => void) | null = null;

/** Register a handler for sync frames (op / sync-ack / sync-res / …). */
export function setSyncMessageHandler(
  handler: ((t: string, d: unknown) => void) | null,
): void {
  _onSyncMessage = handler;
}

const _bootId: { current: string | null } = { current: null };
const _ipc: AioIPCBridge | null = detectIPC();
let _ipcConnected = false;
/** The IPC bridge's onOpen/onMessage/onClose are registered once per page —
 *  the bridge has no unbind, so re-registering on reconnect duplicates frames. */
let _ipcBound = false;
let _ipcPingTimer: ReturnType<typeof setInterval> | null = null;

function _status(text: string) {
  console.debug("[aio:air]", text);
}

function _handleState(data: Record<string, unknown>) {
  const r: _HandleResult = _coreHandleMessage(data);
  if (r === "dropped" || r === "noop") return;
  _checkStateIntegrity(_coreGetState());
  _incStateVersion();
  if (_coreHasState()) _resolveStateReady();
}

// Register with the sync-engine seam: raw sends for op/sync-req envelopes,
// and the wiring setter that plugs the engine into message + online events.
_registerSyncTransport(
  (raw) => _sendRaw(raw),
  (onMsg, onOnline) => {
    setSyncMessageHandler(onMsg);
    _syncOnline = onOnline;
  },
);
// serverFn client (B3): raw sends for sfn calls.
_registerSfnTransport((raw) => _sendRaw(raw));
let _syncOnline: ((v: boolean) => void) | null = null;

function _sendRaw(msg: string): void {
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    try {
      _ws.send(msg);
    } catch { /* buffer full */ }
  } else if (_ipc && _ipcConnected) _ipc.send(msg);
}

/** One demux for both AIR transports (WS + IPC): decode once, route. */
function _route(line: string): void {
  const f = dec(line);
  if (!f) {
    // The one v1 shim: a v1 server's hello/refusal is still readable.
    const v1 = v1PeerReason(line);
    if (v1) console.error(`[aio:air] protocol version mismatch: ${v1}`);
    else console.warn("[aio:air] undecodable frame — dropped");
    return;
  }
  if (handleControlFrame(f, _bootId)) return;
  if (routeCommand(f, _sendRaw)) return;
  switch (f.t) {
    case "sfnr":
      handleSfnResult(f.d);
      return;
    case "op":
    case "op-rejected":
    case "sync-ack":
    case "sync-res":
    case "sync-err":
      if (typeof _onSyncMessage === "function") {
        _onSyncMessage(f.t, f.d);
      } else {
        console.warn(
          `[aio:air] sync frame "${f.t}" but no handler — discarding`,
        );
      }
      return;
    case "state":
      _handleState(f.d as Record<string, unknown>);
      return;
    case "patches":
      _handleState({ $patches: f.d });
      return;
    default:
      console.warn(`[aio:air] unexpected "${f.t}" frame — dropped`);
      return;
  }
}

function _flushQueue(send: (d: string) => void) {
  const q = _queue;
  _queue = [];
  _connectionDegraded = false;
  for (const a of q) send(enc("action", a));
}

function _scheduleReconnect() {
  const delay = Math.min(1000 * 2 ** _retry, 30000);
  _retry++;
  setTimeout(() => _connect(), delay);
}

function _connectIPC() {
  if (!_ipc || _ipcConnected) {
    _connecting = false;
    return;
  }
  _ipcConnected = true;
  // Bind the bridge callbacks EXACTLY once. The preload bridge registers with
  // `ipcRenderer.on` (additive, and it exposes no `off`), while _connectIPC
  // runs again on every reconnect — so each server restart added another
  // handler and every later frame was routed N+1 times. Patch frames are not
  // idempotent (an Immer array `add` applied twice inserts twice), so a single
  // reconnect was enough to duplicate items in the UI. Reconnection only needs
  // to flip the flag and re-arm the bridge.
  if (_ipcBound) {
    _ipc.ready();
    return;
  }
  _ipcBound = true;
  _ipc.onOpen(() => {
    _connecting = false;
    _retry = 0;
    if (_wasConnected) _status("Connected");
    _wasConnected = true;
    _coreSetTransport({ send: (d: string) => _ipc!.send(d), close: () => {} });
    _coreSetConnected(true);
    _syncOnline?.(true);
    _coreResendSubs();
    _flushQueue((d) => _ipc!.send(d));
    if (!_ipcPingTimer) {
      _ipcPingTimer = setInterval(() => {
        if (_ipc && _ipcConnected) _ipc.send(enc("ping"));
      }, 60_000);
    }
  });
  _ipc.onMessage(_route);
  _ipc.onClose(() => {
    _ipcConnected = false;
    _connecting = false;
    _coreSetTransport(null);
    _coreSetConnected(false);
    _syncOnline?.(false);
    if (_ipcPingTimer) {
      clearInterval(_ipcPingTimer);
      _ipcPingTimer = null;
    }
    if (_closed) return;
    if (_wasConnected) _status("Reconnecting\u2026");
    _scheduleReconnect();
  });
  _ipc.ready();
}

function _connect() {
  if (_closed) return;
  if (_ipc && !_ws) {
    _connectIPC();
    return;
  }
  if (_ws) return;
  const ws = new WebSocket(buildWsUrl());
  ws.onopen = () => {
    _connecting = false;
    _retry = 0;
    _coreSetTransport({ send: (d) => ws.send(d), close: () => ws.close() });
    _coreSetConnected(true);
    _syncOnline?.(true);
    // Announce our wire-protocol version before anything else — without this
    // hello the server's version gate never applies to AIR clients.
    ws.send(enc("proto", protoHello(stampedVersion())));
    const ua = typeof navigator !== "undefined" &&
      /electron/i.test(navigator.userAgent);
    ws.send(enc("type", { kind: ua ? "electron" : "browser" }));
    if (_wasConnected) _status("Connected");
    _wasConnected = true;
    _coreResendSubs();
    _flushQueue((d) => ws.send(d));
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    _route(e.data);
  };
  ws.onclose = () => {
    _ws = null;
    _coreSetTransport(null);
    _coreSetConnected(false);
    _syncOnline?.(false);
    if (_closed) return;
    _connecting = true;
    if (_wasConnected) _status("Reconnecting\u2026");
    _scheduleReconnect();
  };
  ws.onerror = () => ws.close();
  _ws = ws;
}

function _send(action: { type: string; payload?: unknown }) {
  const tagged = { ...action, _source: "UI" };
  const json = enc("action", tagged);
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    try {
      _ws.send(json);
    } catch {
      _queue.push(tagged);
      _updateDegraded();
    }
  } else if (_ipc && _ipcConnected) _ipc.send(json);
  else {
    if (_queue.length >= QUEUE_MAX) {
      _queue.shift();
      diagEmit({
        type: "browser-air-transport:queue-drop",
        severity: "warning",
        source: "browser-air-transport",
        message: "Queued action dropped (queue full)",
        detail: { max: QUEUE_MAX },
        hint: "Check network connectivity or reduce mutation rate",
      });
    }
    _queue.push(tagged);
    _updateDegraded();
  }
}

// ── Wire transport into protocol layer ──────────────────────────────

function _tryConnect() {
  if (!_ws && !_ipcConnected && !_connecting) {
    _closed = false;
    _connecting = true;
    _connect();
  }
}

_setConnectFn(_tryConnect);
_setSubscribeTriggers(_tryConnect, () => {});

_setTeardownFn(() => {
  _closed = true;
  _ws?.close();
  _ws = null;
  _ipcConnected = false;
  _connecting = false;
  if (_ipcPingTimer) {
    clearInterval(_ipcPingTimer);
    _ipcPingTimer = null;
  }
  _queue = [];
  _retry = 0;
});

_setClientSend(_send);
installConsoleIntercept(_sendRaw);
