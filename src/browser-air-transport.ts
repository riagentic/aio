// deno-lint-ignore-file
// browser-air-transport: WS/IPC transport layer for AIR renderer.
// Minimal WS transport (no React, no vitals) — just WS <-> state-core bridge.

import { installConsoleIntercept } from "./console-intercept.ts";
import { routeCommand } from "./browser-air-commands.ts";
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
import {
  type AioIPCBridge,
  buildWsUrl,
  detectIPC,
  handleControlMessage,
} from "./browser-shared.ts";

let _ws: WebSocket | null = null;
let _closed = false;
let _connecting = false;
let _wasConnected = false;
let _retry = 0;
let _queue: Array<{ type: string; payload?: unknown }> = [];
let _onSyncMessage: ((msg: Record<string, unknown>) => void) | null = null;

/** Register a sync message handler for __ack/__op/__sync messages from server */
export function setSyncMessageHandler(
  handler: ((msg: Record<string, unknown>) => void) | null,
): void {
  _onSyncMessage = handler;
}

const _bootId: { current: string | null } = { current: null };
const _ipc: AioIPCBridge | null = detectIPC();
let _ipcConnected = false;
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

function _sendRaw(msg: string): void {
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    try {
      _ws.send(msg);
    } catch { /* buffer full */ }
  } else if (_ipc && _ipcConnected) _ipc.send(msg);
}

function _routeCmd(line: string): boolean {
  return routeCommand(line, _sendRaw);
}

function _parseAndRoute(line: string): void {
  try {
    const data = JSON.parse(line);
    if (data === null || typeof data !== "object") return;
    if (data.__ack || data.__op || data.__sync) {
      if (typeof _onSyncMessage === "function") _onSyncMessage(data);
      return;
    }
    _handleState(data);
  } catch (err) {
    console.warn("[aio:air] bad state message:", err);
  }
}

function _flushQueue(send: (d: string) => void) {
  const q = _queue;
  _queue = [];
  for (const a of q) send(JSON.stringify(a));
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
  _ipc.onOpen(() => {
    _connecting = false;
    _retry = 0;
    if (_wasConnected) _status("Connected");
    _wasConnected = true;
    _coreSetTransport({ send: (d: string) => _ipc!.send(d), close: () => {} });
    _coreSetConnected(true);
    _coreResendSubs();
    _flushQueue((d) => _ipc!.send(d));
    if (!_ipcPingTimer) {
      _ipcPingTimer = setInterval(() => {
        if (_ipc && _ipcConnected) _ipc.send("__ping");
      }, 60_000);
    }
  });
  _ipc.onMessage((line: string) => {
    if (handleControlMessage(line, _bootId)) return;
    if (_routeCmd(line)) return;
    _parseAndRoute(line);
  });
  _ipc.onClose(() => {
    _ipcConnected = false;
    _connecting = false;
    _coreSetTransport(null);
    _coreSetConnected(false);
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
    const ua = typeof navigator !== "undefined" &&
      /electron/i.test(navigator.userAgent);
    ws.send("__type:" + (ua ? "electron" : "browser"));
    if (_wasConnected) _status("Connected");
    _wasConnected = true;
    _coreResendSubs();
    _flushQueue((d) => ws.send(d));
  };
  ws.onmessage = (e) => {
    if (typeof e.data === "string" && handleControlMessage(e.data, _bootId)) {
      return;
    }
    if (typeof e.data === "string" && _routeCmd(e.data)) return;
    _parseAndRoute(e.data);
  };
  ws.onclose = () => {
    _ws = null;
    _coreSetTransport(null);
    _coreSetConnected(false);
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
  const json = JSON.stringify(tagged);
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    try {
      _ws.send(json);
    } catch {
      _queue.push(tagged);
    }
  } else if (_ipc && _ipcConnected) _ipc.send(json);
  else _queue.push(tagged);
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
