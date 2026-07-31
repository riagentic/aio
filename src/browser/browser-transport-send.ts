// Send action and reset logic for browser transport.

import {
  _diagEmit,
  _saveOfflineAction,
  _vitalsRenderMeter,
  OFFLINE_MAX_QUEUE,
  WS_MAX_QUEUE,
} from "./browser-protocol.ts";
import { T } from "./browser-transport-state.ts";
import { enc } from "../protocol/envelope.ts";
import { _registerAck, _rejectAck } from "../protocol/browser-ack.ts";

/** The per-method budget key ("cell:method") for an action — same derivation
 *  as the server executor's methodBudgetKey: async methods all travel as
 *  `<cell>:__exec` with the real name in the payload. */
function ackMethodKey(action: { type: string; payload?: unknown }): string {
  if (action.type.endsWith(":__exec")) {
    const m = (action.payload as { _method?: unknown } | undefined)?._method;
    if (typeof m === "string") {
      return `${action.type.slice(0, -":__exec".length)}:${m}`;
    }
  }
  return action.type;
}

/** Sends action via IPC or WS — queues to memory during initial connect, persists to IndexedDB when disconnected.
 *  Returns a Promise that resolves when the server has acknowledged the action
 *  (only when `cid` is supplied). Without `cid` the call is fire-and-forget and
 *  the returned promise resolves immediately. */
export function send(
  action: { type: string; payload?: unknown; cid?: string },
): Promise<unknown> {
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
  // A QUEUED action registers with `deferTimer` — its clock starts when the
  // frame is actually written (browser-transport-ws arms it on replay), so a
  // call queued offline for a minute is not told "no response" while it was
  // never sent at all.
  const register = (deferTimer: boolean): Promise<unknown> =>
    action.cid
      ? _registerAck(action.cid, {
        methodKey: ackMethodKey(action),
        deferTimer,
      })
      : Promise.resolve();

  if (T.ipc && T.ipcConnected) {
    const ackPromise = register(false);
    T.ipc.send(enc("action", action));
    return ackPromise;
  }
  if (T.ws && T.ws.readyState === WebSocket.OPEN) {
    const ackPromise = register(false);
    T.ws.send(enc("action", action));
    return ackPromise;
  }
  if (!T.wasConnected && T.queue.length < WS_MAX_QUEUE) {
    T.queue.push(action);
    return register(true);
  }
  if (T.wasConnected) {
    if (T.offlineQueue.length < OFFLINE_MAX_QUEUE) {
      const ackPromise = register(true);
      T.offlineQueue.push(action);
      // The in-memory queue survives the disconnect; only this write makes the
      // action survive a RELOAD. `_saveOfflineAction` reports its own storage
      // failures (offline-storage-error / offline-queue-full); a REJECTION is
      // the case it cannot report from the inside, and losing it silently means
      // the user's edit is gone with no trace anywhere.
      _saveOfflineAction(action).catch((e) =>
        console.error(
          `[aio] offline queue write failed — '${action.type}' is queued in ` +
            `memory but will be lost on reload: ${e}`,
        )
      );
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
  // Action was dropped — reject the awaiting caller (if any) immediately so
  // they don't hang. The "action-dropped" diag already fired above; this
  // surfaces the failure to `await cell.method()` callers.
  const ackPromise = register(true); // never armed — rejected right here
  if (action.cid) {
    _rejectAck(
      action.cid,
      new Error(
        `action '${action.type}' dropped — ${
          T.wasConnected
            ? `offline queue full (${OFFLINE_MAX_QUEUE})`
            : `connect queue full (${WS_MAX_QUEUE})`
        }`,
      ),
    );
  }
  return ackPromise;
}
