// Shared mutable transport state — single source of truth for browser-transport-*.ts modules.
// Primitive `let` exports can't be reassigned from other modules, so we wrap them in an object.

import { type AioIPCBridge, detectIPC } from "./browser-shared.ts";

/** All mutable transport state lives here so split modules can share it. */
export const T = {
  ipc: detectIPC() as AioIPCBridge | null,
  ws: null as WebSocket | null,
  queue: [] as Array<{ type: string; payload?: unknown }>,
  retry: 0,
  closed: false,
  connecting: false,
  wasConnected: false,
  offlineReady: false,
  offlineQueue: [] as Array<{ type: string; payload?: unknown }>,
  lastAction: null as { type: string; payload?: unknown } | null,
  bootId: { current: null as string | null },
  ipcConnected: false,
  ipcPingTimer: null as ReturnType<typeof setInterval> | null,
  /** Negotiated wire-protocol version (A3); null until the server's hello. */
  protocolVersion: null as number | null,
};

export const IPC_PING_INTERVAL = 60_000;

// ── Fiber callbacks (injected from browser-fiber.ts to avoid circular deps) ──

let _getStateSnapshot: () => unknown = () => [];

export function getStateSnapshot(): unknown {
  return _getStateSnapshot();
}

export function setFiberCallbacks(getSnapshot: () => unknown): void {
  _getStateSnapshot = getSnapshot;
}
