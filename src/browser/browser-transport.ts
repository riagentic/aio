// deno-lint-ignore-file
// Transport layer for aio browser client — IPC (Electron) and WebSocket connections.
// Barrel re-export: all implementation lives in browser-transport-*.ts modules.

// ── Side-effect: wire protocol callbacks register on import ────────
import { _wireInitialized } from "./browser-transport-wire.ts";
void _wireInitialized;

// ── Shared state (re-exported with original names) ─────────────────
import {
  IPC_PING_INTERVAL,
  setFiberCallbacks,
  T,
} from "./browser-transport-state.ts";
import type { AioIPCBridge } from "./browser-shared.ts";

export const _ipc: AioIPCBridge | null = T.ipc;
export { T };

// Getters for mutable state — consumers that imported `let` bindings
// previously got live values; now they read through the T object.
export function get_ws() {
  return T.ws;
}
export function get_queue() {
  return T.queue;
}
export function get_retry() {
  return T.retry;
}
export function get_closed() {
  return T.closed;
}
export function get_connecting() {
  return T.connecting;
}
export function get_wasConnected() {
  return T.wasConnected;
}
export function get_offlineReady() {
  return T.offlineReady;
}
export function get_offlineQueue() {
  return T.offlineQueue;
}
export function get_lastAction() {
  return T.lastAction;
}
export function get_ipcConnected() {
  return T.ipcConnected;
}
export function get_ipcPingTimer() {
  return T.ipcPingTimer;
}

export const _bootId = T.bootId;
export const _IPC_PING_INTERVAL = IPC_PING_INTERVAL;

// ── Public API (unchanged) ─────────────────────────────────────────
export { connect as _connect } from "./browser-transport-ws.ts";
export { send as _send } from "./browser-transport-send.ts";
export { resetTransport as _resetTransport } from "./browser-transport-reset.ts";
export { setFiberCallbacks as _setFiberCallbacks } from "./browser-transport-state.ts";
