// Send action and reset logic for browser transport.

import {
  _diagEmit,
  _saveOfflineAction,
  _vitalsRenderMeter,
  OFFLINE_MAX_QUEUE,
  WS_MAX_QUEUE,
} from "./browser-protocol.ts";
import { T } from "./browser-transport-state.ts";

/** Sends action via IPC or WS — queues to memory during initial connect, persists to IndexedDB when disconnected. */
export function send(action: { type: string; payload?: unknown }): void {
  T.lastAction = action;
  if (_vitalsRenderMeter) {
    const actionType = typeof action === "object" && action !== null
      ? (action as Record<string, unknown>).type as string ?? ""
      : "";
    const cellPart = actionType.split("/")[0] ?? actionType.split(":")[0] ?? "";
    _vitalsRenderMeter.recordAction(actionType, cellPart);
  }
  if (T.ipc && T.ipcConnected) {
    T.ipc.send(JSON.stringify(action));
    return;
  }
  if (T.ws && T.ws.readyState === WebSocket.OPEN) {
    T.ws.send(JSON.stringify(action));
  } else if (!T.wasConnected && T.queue.length < WS_MAX_QUEUE) {
    T.queue.push(action);
  } else if (T.wasConnected) {
    if (T.offlineQueue.length < OFFLINE_MAX_QUEUE) {
      T.offlineQueue.push(action);
      _saveOfflineAction(action).catch(() => {});
    } else {
      _diagEmit({
        type: "action-dropped",
        severity: "warning",
        source: "browser",
        message: "Action '" + action.type + "' dropped — offline queue full (" +
          OFFLINE_MAX_QUEUE + ")",
        detail: { actionType: action.type, queueSize: T.offlineQueue.length },
        hint:
          "Check network connection. Actions are queued when disconnected but the queue has a limit.",
      });
    }
  } else {
    _diagEmit({
      type: "action-dropped",
      severity: "warning",
      source: "browser",
      message: "Action '" + action.type + "' dropped — connect queue full (" +
        WS_MAX_QUEUE + ")",
      detail: { actionType: action.type, queueSize: T.queue.length },
      hint: "Server may be slow to respond. Check terminal for errors.",
    });
  }
}
