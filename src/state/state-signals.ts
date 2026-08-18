// deno-lint-ignore-file no-explicit-any
/**
 * @module
 * Core signal management for state-core.
 * Owns: _stateSignal, _connected, _cellSignals, and _applyFullState.
 * Consumed by state-message.ts.
 */

import { batch, type Signal, signal } from "./signal.ts";
import { log } from "../diagnostics/logger-api.ts";

// ── Dev-only deep freeze for cell signal values ─────────────────────
// AIO-4.4: in dev, deep-freeze the value before installing it in a cell
// signal so component-side mutations throw "Cannot assign to read only
// property" with a clear hint. Skip slices >100KB to keep dev boot snappy.
const FREEZE_SIZE_LIMIT = 100_000;

function _maybeFreezeInDev<T>(value: T): T {
  if ((globalThis as Record<string, unknown>).__aioDev !== true) return value;
  if (value === null || typeof value !== "object") return value;
  // Cheap size estimate: stringify once, bail if over limit.
  let size: number;
  try {
    size = JSON.stringify(value).length;
  } catch {
    return value; // circular — skip
  }
  if (size > FREEZE_SIZE_LIMIT) {
    if (!(globalThis as Record<string, unknown>).__aioFreezeSkipped) {
      (globalThis as Record<string, unknown>).__aioFreezeSkipped = true;
      // One-time warn to keep dev boot snappy.
      log.info(
        `[aio] dev freeze skipped: cell slice > ${FREEZE_SIZE_LIMIT}B`,
      );
    }
    return value;
  }
  try {
    return deepFreeze(value);
  } catch {
    return value;
  }
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  }
  return obj;
}

// ── HMR-safe singleton cache ─────────────────────────────────────────
// Module re-evaluation (dev mode HMR) must not replace the canonical
// signal instances — otherwise old subscribers point to leaked signals.
const _global = globalThis as Record<string, any>;
if (!_global.__aioSignals) {
  _global.__aioSignals = {
    state: signal<Record<string, any>>({}),
    connected: signal<boolean>(false),
    ready: signal<boolean>(false),
    cells: new Map<string, Signal<any>>(),
  };
}
const _cache = _global.__aioSignals as {
  state: Signal<Record<string, any>>;
  connected: Signal<boolean>;
  ready: Signal<boolean>;
  cells: Map<string, Signal<any>>;
};

// ── Module state ─────────────────────────────────────────────────────

// Stable instances — reset mutates their VALUES in place (see _resetSignals),
// never reassigns, so reactive getters that close over them see every reset.
export const _stateSignal: Signal<Record<string, any>> = _cache.state;
export const _connected: Signal<boolean> = _cache.connected;
/** True once a FULL state frame has landed — see {@linkcode getReadySignal}. */
export const _ready: Signal<boolean> = _cache.ready;
export const _cellSignals = _cache.cells;

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
    // Readiness is set BEFORE the state itself, inside the same batch: a
    // component that renders off `ready` must not see it flip while its slices
    // are still the previous frame's.
    _ready.set(true);
    _stateSignal.set(state);
    for (const [key, value] of Object.entries(state)) {
      // AIO-4.4: freeze the value before installing in the cell signal so
      // component-side mutations throw in dev.
      _getOrCreateCellSignal(key, _maybeFreezeInDev(value)).set(value);
    }
    // NB: do NOT delete cell signals for keys absent from `state`. With
    // subscription filtering, an incoming full-state message is FILTERED to the
    // client's subscribed cells — an absent cell is merely unsubscribed, not
    // gone. Cells are a static, bounded set, and the direct-access getter and
    // component renders capture a cell's signal instance at bind time
    // (cell-reactive.ts). Deleting it here orphaned that instance: on
    // re-subscribe a NEW signal was created, so the getter/render stayed bound
    // to the stale (deleted) one, frozen at the connect-time value — the a field report
    // 2026-07-18 "read only after navigation never updates" bug. Signal
    // instances must stay stable for the session (same invariant _resetSignals
    // relies on: mutate values in place, never reassign).
  });
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

/** Has the client received a full state frame yet?
 *
 *  Distinct from CONNECTED: a socket can be up while the first frame is still
 *  in flight, and in that window every cell slice reads `undefined`. Every app
 *  hand-rolls the same guard against it — a field report's is
 *  `if (!state.core) return <Loading/>` at the top of its root component,
 *  picking one arbitrary slice to stand in for "has anything arrived at all".
 *  That is a fact the runtime knows and the app was made to guess.
 *  @internal Engine wiring — apps read it through `useAio().ready`. */
export function getReadySignal(): Signal<boolean> {
  return _ready;
}

/** Returns the connection status signal — `true` when transport is connected.
 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export function getConnectedSignal(): Signal<boolean> {
  return _connected;
}

/** Update connection status signal.
 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export function setConnected(v: boolean): void {
  _connected.set(v);
}

/**
 * Reset all signal state (for test isolation).
 *
 * Resets VALUES in place — it must NOT swap signal instances or clear the
 * cell-signal map. Reactive getters installed on cell defs close over a
 * specific Signal instance; swapping the instance (the old bug) orphaned those
 * closures with stale state, so a value added in one test leaked into the next
 * even after "reset". Keeping instance identity stable means every closure sees
 * the reset. Cell signals reset to `undefined` so their getters fall back to
 * the cell's pristine declared initial (see immutable.ts).
 */
export function _resetSignals(): void {
  _stateSignal.set({});
  _connected.set(false);
  _ready.set(false);
  for (const sig of _cellSignals.values()) sig.set(undefined);
}
