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
};

export const IPC_PING_INTERVAL = 60_000;

// ── Fiber callbacks (injected from browser-fiber.ts to avoid circular deps) ──

let _getStateSnapshot: () => unknown = () => [];
let _handleClickCmd: (
  cmd: string,
) => { ok: boolean; error?: string; clicked?: string } = () => ({
  ok: false,
  error: "fiber not initialized",
});

export function getStateSnapshot(): unknown {
  return _getStateSnapshot();
}

export function handleClickCmd(
  cmd: string,
): { ok: boolean; error?: string; clicked?: string } {
  return _handleClickCmd(cmd);
}

export function setFiberCallbacks(
  getSnapshot: () => unknown,
  handleClick: (
    cmd: string,
  ) => { ok: boolean; error?: string; clicked?: string },
): void {
  _getStateSnapshot = getSnapshot;
  _handleClickCmd = handleClick;
}
