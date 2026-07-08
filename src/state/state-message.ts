// deno-lint-ignore-file no-explicit-any
/**
 * @module
 * Message handling and lifecycle — processes server messages (full state, Immer patches).
 * Owns: handleMessage, ready(), isInitialStateReceived(), ready promise management.
 */

import { batch } from "./signal.ts";
import { applyPatches, type Patch } from "immer";
import { _BLOCKED_KEYS } from "./state-array-utils.ts";
import {
  _applyFullState,
  _getOrCreateCellSignal,
  _stateSignal,
} from "./state-signals.ts";
import { _accessedPaths, cancelSubsTimer } from "./state-subs.ts";
import { _getTransport } from "./state-transport.ts";

// ── Module state ─────────────────────────────────────────────────────

let _initialStateReceived = false;
let _readyResolve: ((state: any) => void) | null = null;
let _readyPromise = new Promise<any>((resolve) => {
  _readyResolve = resolve;
});
let _readyTimeout: ReturnType<typeof setTimeout> | null = null;

// ── Types ────────────────────────────────────────────────────────────

/** Result of handleMessage — tells caller what happened. */
export type HandleResult = "full" | "delta" | "noop" | "dropped";

// ── Message handling ─────────────────────────────────────────────────

/** Process a message from the server (full state, delta, or filtered).
 *  CALLER is responsible for filtering browser signals (__reload, __css, __boot, etc.)
 *  before calling this — state-core has no browser-specific protocol knowledge.
 *  Returns what happened so caller can react (notify listeners, devtools, etc). */
export function handleMessage(data: any): HandleResult {
  // AIO-272: validate input — null/undefined messages crash transport
  if (!data || typeof data !== "object") return "noop";
  if (!_initialStateReceived) {
    // Delta before first state — drop (reconnect race)
    if (data.$patches) return "dropped";
    _initialStateReceived = true;
    _applyFullState(data);
    _accessedPaths.clear();
    cancelSubsTimer();
    if (_readyResolve) {
      if (_readyTimeout !== null) {
        clearTimeout(_readyTimeout);
        _readyTimeout = null;
      }
      _readyResolve(data);
      _readyResolve = null;
    }
    return "full";
  }

  // Immer patches: { $patches: [{op, path, value}, ...] }
  if (data.$patches) {
    if (!Array.isArray(data.$patches)) {
      // Safety: a message carrying $patches as a non-array is malformed wire
      // protocol — never fall through to full-state replacement with it.
      console.warn("[aio] malformed $patches (not an array) — dropped");
      return "dropped";
    }
    const prev = _stateSignal.peek();
    const patches: Patch[] = data.$patches;
    if (patches.length === 0) return "noop";

    try {
      const next = applyPatches(prev, patches);
      if (next === prev) return "noop";

      // Determine which cells were affected
      const changedCells = new Set<string>();
      for (const p of patches) {
        if (p.path.length > 0 && typeof p.path[0] === "string") {
          changedCells.add(p.path[0]);
        }
      }

      batch(() => {
        _stateSignal.set(next);
        for (const cellName of changedCells) {
          if (_BLOCKED_KEYS.has(cellName)) continue;
          const cellState = (next as Record<string, unknown>)[cellName];
          _getOrCreateCellSignal(cellName, cellState).set(cellState);
        }
      });
      return "delta";
    } catch (e) {
      // applyPatches failed — client state desynced, request full state from server
      console.warn("[aio] applyPatches failed, requesting resync:", e);
      const transport = _getTransport();
      if (transport) transport.send("__resync");
      return "noop";
    }
  }

  // Full state replacement (reconnect / subscription response)
  // Do NOT clear _accessedPaths here — that nukes "*" from useAio() and causes
  // subsequent __subs messages to exclude cells not read by useCell() (AIO-170)
  _applyFullState(data);
  return "full";
}

// ── Lifecycle ────────────────────────────────────────────────────────

/** Promise resolving on first state, or rejecting after 30s timeout. */
export function ready(): Promise<unknown> {
  if (_readyTimeout === null) {
    _readyTimeout = setTimeout(() => {
      if (_readyResolve) {
        _readyResolve(null); // resolve with null rather than hang
        _readyResolve = null;
      }
    }, 30_000);
  }
  return _readyPromise;
}

/** Whether initial state has been received. */
export function isInitialStateReceived(): boolean {
  return _initialStateReceived;
}

/** Reset message handler state (for test isolation). */
export function _resetMessageState(): void {
  _initialStateReceived = false;
  if (_readyTimeout !== null) {
    clearTimeout(_readyTimeout);
    _readyTimeout = null;
  }
  _readyResolve = null;
  _readyPromise = new Promise<any>((resolve) => {
    _readyResolve = resolve;
  });
}

/** Mark initial state as received (called by _injectState in testing). */
export function _markInitialStateReceived(): void {
  _initialStateReceived = true;
}

/** Reset only the initial-state-received flag (for reconnect — AIO-183).
 *  Does NOT reset the ready promise — that stays resolved once fired. */
export function _resetInitialStateFlag(): void {
  _initialStateReceived = false;
}
