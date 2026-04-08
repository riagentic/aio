// deno-lint-ignore-file no-explicit-any
/**
 * @module
 * Core signal management for state-core.
 * Owns: _stateSignal, _connected, _cellSignals, and _applyFullState.
 * Consumed by state-message.ts and state-legacy-delta.ts.
 */

import { batch, type Signal, signal } from "./signal.ts";
import { _rebuildIdMaps } from "./state-id-maps.ts";

// ── Module state ─────────────────────────────────────────────────────

export let _stateSignal: Signal<Record<string, any>> = signal({});
export let _connected: Signal<boolean> = signal<boolean>(false);
export const _cellSignals = new Map<string, Signal<any>>();

// ── Internal helpers ─────────────────────────────────────────────────

export function _getOrCreateCellSignal(
  name: string,
  initial?: any,
): Signal<any> {
  let sig = _cellSignals.get(name);
  if (!sig) {
    sig = signal(initial);
    _cellSignals.set(name, sig);
  }
  return sig;
}

export function _applyFullState(state: Record<string, any>): void {
  batch(() => {
    _stateSignal.set(state);
    for (const [key, value] of Object.entries(state)) {
      _getOrCreateCellSignal(key, value).set(value);
    }
    // AIO-189: remove cell signals for cells no longer in state
    for (const key of _cellSignals.keys()) {
      if (!(key in state)) {
        _cellSignals.delete(key);
      }
    }
  });
  _rebuildIdMaps(state); // needed for legacy $arr delta backward compat
}

// ── Public API ───────────────────────────────────────────────────────

/** Returns the root state signal — the canonical reactive state container. */
export function getStateSignal(): Signal<Record<string, any>> {
  return _stateSignal;
}

/** Returns a signal scoped to a specific cell's state slice. Creates one if it doesn't exist. */
export function getCellSignal(name: string, fallback?: any): Signal<any> {
  return _getOrCreateCellSignal(name, fallback);
}

/** Returns the connection status signal — `true` when transport is connected. */
export function getConnectedSignal(): Signal<boolean> {
  return _connected;
}

/** Update connection status signal. */
export function setConnected(v: boolean): void {
  _connected.set(v);
}

/** Reset all signal state (for test isolation). */
export function _resetSignals(): void {
  _stateSignal = signal({});
  _connected = signal(false);
  _cellSignals.clear();
}
