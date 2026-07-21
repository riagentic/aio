// State message handler shared by WS and IPC transports.

import {
  _checkStateIntegrity,
  _coreGetState,
  _coreHandleMessage,
  _coreHasState,
  _devtoolsConnected,
  _diagEmit,
  type _HandleResult,
  _incStateVersion,
  _listeners,
  _resolveStateReady,
  _sendDevTools,
  _vitalsRenderMeter,
} from "./browser-protocol.ts";
import { T } from "./browser-transport-state.ts";

/** Dispatches a decoded state/patches frame from the server (shared WS/IPC
 *  path). v2 (B4b): the transport already knows the kind — "patches" is
 *  re-shaped to the `{$patches}` form the core message handler speaks. */
export function handleStateMessage(
  kind: "state" | "patches",
  payload: unknown,
  transport: "WS" | "IPC",
): void {
  try {
    const parsed = kind === "patches"
      ? { $patches: payload }
      : payload as Record<string, unknown>;
    if (parsed === null || typeof parsed !== "object") {
      if (transport === "WS") {
        console.warn("[aio] unexpected state type:", typeof parsed);
      }
      return;
    }
    const result: _HandleResult = _coreHandleMessage(parsed);
    if (result === "dropped") {
      _diagEmit({
        type: "delta-before-state",
        severity: "warning",
        source: "browser",
        message:
          `Delta patch received before full state (${transport}) — dropped`,
        hint:
          "This usually means a reconnect race. The next full state sync will correct this.",
      });
      return;
    }
    if (result === "noop") return;

    const next = _coreGetState();
    _checkStateIntegrity(next);
    _incStateVersion();
    if (_coreHasState()) _resolveStateReady();

    if (_vitalsRenderMeter) {
      _vitalsRenderMeter.recordPatch();
      _vitalsRenderMeter.markDirty();
    } else {
      _listeners.notify(next);
    }

    if (_devtoolsConnected && T.lastAction) {
      _sendDevTools(T.lastAction, next);
      T.lastAction = null;
    }
  } catch (err) {
    console.warn("[aio] bad state message:", err);
    _diagEmit({
      type: "state-sync-error",
      severity: "error",
      source: "browser",
      message: `Failed to parse state message from server (${transport})`,
      detail: { error: String(err) },
      hint:
        "Server sent malformed state. Check for serialization bugs on the server side.",
    });
  }
}
