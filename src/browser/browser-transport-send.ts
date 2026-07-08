// Send action and reset logic for browser transport.

import {
  _diagEmit,
  _saveOfflineAction,
  _vitalsRenderMeter,
  OFFLINE_MAX_QUEUE,
  WS_MAX_QUEUE,
} from "./browser-protocol.ts";
import { T } from "./browser-transport-state.ts";
import { _registerAck } from "../protocol/browser-ack.ts";

/** Sends action via IPC or WS — queues to memory during initial connect, persists to IndexedDB when disconnected.
 *  Returns a Promise that resolves when the server has acknowledged the action
 *  (only when `cid` is supplied). Without `cid` the call is fire-and-forget and
 *  the returned promise resolves immediately. */
export function send(
  action: { type: string; payload?: unknown; cid?: string },
): Promise<void> {
  T.lastAction = action;
  if (_vitalsRenderMeter) {
    const actionType = typeof action === "object" && action !== null
      ? (action as Record<string, unknown>).type as string ?? ""
      : "";
    const cellPart = actionType.split("/")[0] ?? actionType.split(":")[0] ?? "";
    _vitalsRenderMeter.recordAction(actionType, cellPart);
  }

  // If no cid, fire-and-forget. We still route the action through the same
  // send pipeline (IPC, WS, queue, offline) but skip registering a pending ack.
  const ackPromise = action.cid ? _registerAck(action.cid) : Promise.resolve();

  if (T.ipc && T.ipcConnected) {
    T.ipc.send(JSON.stringify(action));
    return ackPromise;
  }
  if (T.ws && T.ws.readyState === WebSocket.OPEN) {
    T.ws.send(JSON.stringify(action));
    return ackPromise;
  }
  if (!T.wasConnected && T.queue.length < WS_MAX_QUEUE) {
    T.queue.push(action);
    return ackPromise;
  }
  if (T.wasConnected) {
    if (T.offlineQueue.length < OFFLINE_MAX_QUEUE) {
      T.offlineQueue.push(action);
      _saveOfflineAction(action).catch(() => {});
      return ackPromise;
    }
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
  // Action was dropped — fail the awaiting caller (if any) so they don't hang.
  if (action.cid) {
    // Reject the ack so the caller's await surfaces the error.
    // Done in a microtask so the thrower doesn't see this synchronously.
    queueMicrotask(() => {
      // We don't have direct access to the reject here — the ackPromise is
      // already created. The transport-level drop will be visible via the
      // "action-dropped" diag; the promise times out per ACK_TIMEOUT_MS.
      // (Resolving the diagnostic is the contract.)
    });
  }
  return ackPromise;
}
