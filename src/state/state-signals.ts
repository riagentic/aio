// deno-lint-ignore-file no-explicit-any
/**
 * @module
 * Core signal management for state-core.
 * Owns: _stateSignal, _connected, _cellSignals, and _applyFullState.
 * Consumed by state-message.ts.
 */

import { batch, type Signal, signal } from "./signal.ts";
import {
  deepFreeze,
  FREEZE_SIZE_LIMIT,
  noteFreezeSkipped,
} from "./immutable.ts";

// ── Dev-only deep freeze for cell signal values ─────────────────────
// AIO-4.4: in dev, deep-freeze the value before installing it in a cell
// signal so component-side mutations throw "Cannot assign to read only
// property" with a clear hint. Skip slices over the shared ceiling to keep dev
// boot snappy — and SAY SO, which the local copy of this ceiling did not.
//
// The freeze itself is `immutable.ts`'s: this file used to carry a third
// hand-written `deepFreeze`, the only one with NO cycle guard at all (a cyclic
// slice recursed until the stack blew).

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
    noteFreezeSkipped("cell slice");
    return value;
  }
  try {
    return deepFreeze(value);
  } catch {
    return value;
  }
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
  delivered?: Set<string>;
};
/** Cells whose signal holds a slice a SERVER full-state frame put there —
 *  the only ones a later frame can withdraw (see `_applyFullState`). A
 *  client-scoped cell's signal is written here too, and never by a server. */
const _delivered: Set<string> = _cache.delivered ??= new Set<string>();

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
    // NOT `signal(initial, name)`. A named signal opts into a different dev
    // diagnostic — `signal "X" update skipped (shallow-equal)` on every no-op
    // `set` — which is a useful thing to ask for on a signal you named for that
    // reason and pure noise on every cell in every app. Naming them here turned
    // it on for all of them, and a test that asserts a plain component handle
    // is silent caught it.
    //
    // The name is still available where it is wanted: `cellSignalName()` reads
    // it back off THIS registry, which is the one place that actually knows it.
    sig = signal(initial);
    _cellSignals.set(name, sig);
  }
  return sig;
}

// ── Cell-signal ownership (sync cells) ───────────────────────────────

/** Who else writes a cell's signal. Set by the browser sync engine at boot. */
let _engineOwnsCell: ((cell: string) => boolean) | null = null;

/** The sync engine claims the cells whose signals it drives.
 *
 *  A sync cell's signal shows the engine's OPTIMISTIC view (confirmed + ops
 *  still waiting for an ack — docs/persistence/crdt.md: "UI always reads
 *  optimistic"). Server state frames (`$patches` and full state) used to set
 *  that same signal to the server's slice, which does not have those ops yet,
 *  so any unrelated write to the cell made the user's pending change vanish
 *  from the screen until its ack. Two writers, one signal: the engine is the
 *  one that knows about pending ops, so it is the only one. (Server-origin
 *  writes still reach it — they are pushed to the engine as ops/patches.)
 *
 *  `null` (no engine: none needed, not booted yet, or its boot failed and the
 *  cell fell back to plain actions) leaves every cell server-driven, so a sync
 *  cell is never stranded without state.
 *  @internal Engine wiring. */
export function _setCellSignalOwner(
  owns: ((cell: string) => boolean) | null,
): void {
  _engineOwnsCell = owns;
}

/** Does a server state frame set this cell's signal? The ONE predicate both
 *  state paths (`$patches` in state-message.ts, full state below) consult.
 *  The global `_stateSignal` is updated either way. */
export function _serverDrivesCellSignal(cell: string): boolean {
  return _engineOwnsCell === null || !_engineOwnsCell(cell);
}

export function _applyFullState(
  state: Record<string, any>,
  /** The frame is a connection's FIRST state — never subscription-filtered
   *  (the server's set starts null on both transports and the frame goes out
   *  before any `subs` is read), so it is this connection's whole view. */
  wholeView = false,
): void {
  batch(() => {
    // Readiness is set BEFORE the state itself, inside the same batch: a
    // component that renders off `ready` must not see it flip while its slices
    // are still the previous frame's.
    _ready.set(true);
    _stateSignal.set(state);
    for (const [key, value] of Object.entries(state)) {
      if (!_serverDrivesCellSignal(key)) continue; // the sync engine's (above)
      // AIO-4.4: freeze the value before installing in the cell signal so
      // component-side mutations throw in dev.
      _getOrCreateCellSignal(key, _maybeFreezeInDev(value)).set(value);
      _delivered.add(key);
    }
    // …except in a connection's whole view. There an absent cell is one the
    // server WITHHELD from this connection — `visible.forUser` failed closed,
    // the documented "your UI sees the cell as absent" — and keeping the
    // signal kept the PREVIOUS connection's slice on screen: alice's admin
    // cell, still answering after bob signed in in the same tab. Reset, not
    // deleted (the instance must stay stable, below); a getter reading
    // `undefined` answers the declared state, as for a cell never sent.
    if (wholeView) {
      for (const key of _delivered) {
        if (Object.hasOwn(state, key) || !_serverDrivesCellSignal(key)) {
          continue;
        }
        _cellSignals.get(key)?.set(undefined);
        _delivered.delete(key);
      }
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

/** Withdraw the cells a full frame COVERS but does not carry — the server
 *  WITHHELD them from this connection (`visible.forUser` failed closed). The
 *  frame says which cells it covers (`s`, see `encState` in
 *  server-broadcast.ts): `null` = the whole view, else the subscription it
 *  was filtered by. Without that word an absent cell may just be unsubscribed,
 *  which keeps its copy. Only cells a server frame delivered; reset, not
 *  deleted, as in `_applyFullState`. @internal */
export function _withdrawWithheld(
  state: Record<string, unknown>,
  covers: readonly string[] | null,
): void {
  batch(() => {
    for (const key of _delivered) {
      if (
        Object.hasOwn(state, key) || !_serverDrivesCellSignal(key) ||
        (covers !== null && !covers.includes(key))
      ) continue;
      _cellSignals.get(key)?.set(undefined);
      _delivered.delete(key);
    }
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
  _delivered.clear();
}

/** The cell a tracked signal belongs to, or null.
 *
 *  A reverse lookup over the cell registry rather than a name stored on the
 *  signal, because a stored `_name` opts the signal into the noisy no-op-set
 *  warning (see `_getOrCreateCellSignal`). Dev-only callers, and the map is one
 *  entry per cell, so the scan is not worth an index.
 *
 *  Used by the untracked-read warning: "a cell/signal value was read inside
 *  afterRender" is a puzzle; "`speech` was read inside afterRender" is an
 *  answer. */
export function cellSignalName(sig: unknown): string | null {
  for (const [name, s] of _cellSignals) if (s === sig) return name;
  return null;
}
