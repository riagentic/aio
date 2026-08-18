/**
 * @module
 * Framework-agnostic canonical state store.
 *
 * Owns: Immer patch application, subscription tracking, send logic,
 * transport abstraction. Delta generation uses Immer's produceWithPatches
 * in cell-compose.ts; patch application uses Immer's applyPatches here.
 * Both the React and AIR adapters consume this module. The `aio/state-core`
 * entry is for custom-transport / custom-client authors.
 *
 * @example
 * ```ts
 * import { getCellSignal, send, setTransport } from "aio/state-core";
 * ```
 */
// ZERO framework dependencies (no React, no DOM).
//
// Extracted from browser.ts's battle-tested delta pipeline (34 resolved issues)
// combined with aio-hooks.ts's signal-based state management.

import { enablePatches } from "immer";
import {
  _applyFullState,
  _resetSignals,
  _stateSignal,
} from "./state/state-signals.ts";
import {
  _resetTransport,
  flushOfflineQueue,
  setTransport as _setTransport,
} from "./state/state-transport.ts";
import { _resetSubs } from "./state/state-subs.ts";
import {
  _markInitialStateReceived,
  _resetInitialStateFlag,
  _resetMessageState,
} from "./state/state-message.ts";

enablePatches();

// ── Re-exports (public API) ──────────────────────────────────────────

// Types
export type { Transport } from "./state/state-transport.ts";
/** @internal Adapter plumbing — not public API, stripped from the snapshot. */
export type { AioIPC, CellRef } from "./state/state-transport.ts";
/** @internal Adapter plumbing — not public API, stripped from the snapshot. */
export type { HandleResult } from "./state/state-message.ts";
/** @internal Adapter plumbing — not public API, stripped from the snapshot. */
export type { ArrayRefStats } from "./state/state-array-utils.ts";

// Array utilities
/** @internal Cross-module wiring — not public API, stripped from the snapshot. */
export {
  _BLOCKED_KEYS,
  _checkWastedRenders,
  _getArrayRefStats,
  _preserveArrayRefs,
  _resetArrayRefStats,
  _shallowEqual,
} from "./state/state-array-utils.ts";

// Signals
export { getCellSignal, getStateSignal } from "./state/state-signals.ts";
/** @internal Framework wiring (alpha52 sweep) — not public API, stripped from
 *  the snapshot. The public custom-transport set is: getStateSignal,
 *  getCellSignal, send, setTransport, Transport, ready, handleMessage. */
export {
  getConnectedSignal,
  getReadySignal,
  setConnected,
} from "./state/state-signals.ts";

// Subscriptions
/** @internal Framework wiring (alpha52 sweep) — not public API, stripped from the snapshot. */
export {
  cancelSubsTimer,
  collapsePaths,
  resendSubscriptions,
  trackPath,
} from "./state/state-subs.ts";
/** @internal Cross-module wiring — not public API, stripped from the snapshot. */
export { _accessedPaths } from "./state/state-subs.ts";

// Transport & dispatch
export { send } from "./state/state-transport.ts";
/** @internal Framework wiring (alpha52 sweep) — not public API, stripped from the snapshot. */
export {
  createSendProxy,
  flushOfflineQueue,
  setSyncHandler,
} from "./state/state-transport.ts";
/** @internal Cross-module wiring — not public API, stripped from the snapshot. */
export {
  _offlineQueueFullness,
  _resolveWithFallback,
  _trackingProxy,
} from "./state/state-transport.ts";

// Message handling & lifecycle
export { handleMessage, ready } from "./state/state-message.ts";
/** @internal Framework wiring (alpha52 sweep) — not public API, stripped from the snapshot. */
export { isInitialStateReceived } from "./state/state-message.ts";

// ── setTransport (orchestrates initialStateReceived reset + queue flush) ──

/**
 * Set the abstract transport (WS adapter, IPC adapter, etc).
 * Resets initial-state flag on reconnect so next message is treated as full state.
 */
export function setTransport(
  transport: import("./state/state-transport.ts").Transport | null,
): void {
  _setTransport(
    transport,
    transport
      ? () => {
        _resetInitialStateFlag(); // AIO-183: treat first post-reconnect message as full state
        flushOfflineQueue();
      }
      : undefined,
  );
}

// ── Testing helpers ──────────────────────────────────────────────────

/**
 * Inject state directly (for testing without transport).
 * @internal Test helper — not public API, stripped from the snapshot.
 */
// deno-lint-ignore no-explicit-any
export function _injectState(state: Record<string, any>): void {
  _applyFullState(state);
  _markInitialStateReceived();
}

/**
 * Get the current internal state (for testing).
 * @internal Test helper — not public API, stripped from the snapshot.
 */
// deno-lint-ignore no-explicit-any
export function _getState(): Record<string, any> {
  return _stateSignal.peek();
}

/**
 * Reset all internal state (for test isolation).
 * @internal Test helper — not public API, stripped from the snapshot.
 */
export function _reset(): void {
  _resetTransport();
  _resetSignals();
  _resetSubs();
  _resetMessageState();
}
