// cell-reactive.ts — browser-side reactive cell binding
//
// Installs signal-backed getters on cell defs so that reading
// counter.count in a component auto-tracks and re-renders.
// Called from ensureConnected() for all registered cells.

import type { CellDef } from "./cell-types.ts";
import { getCellSignal } from "./state-signals.ts";

// ── Cell registry ────────────────────────────────────────────────────
// Every cell() call registers here. Browser binding iterates this set.

const _cellRegistry = new Set<CellDef>();

/** Register a cell for reactive binding. Called by cell() at creation time. */
export function registerCell(def: CellDef): void {
  _cellRegistry.add(def);
}

/** Get all registered cells. */
export function getRegisteredCells(): ReadonlySet<CellDef> {
  return _cellRegistry;
}

/** Clear registry (test isolation). */
export function _resetCellRegistry(): void {
  _cellRegistry.clear();
}

// ── Reactive binding ─────────────────────────────────────────────────

const _reactivelyBound = new WeakSet<CellDef>();

/** Install signal-backed getters on a cell for each state key, and wrap
 *  action creators with dispatch so `counter.increment()` sends to server.
 *  After this, `counter.count` reads from the cell signal (auto-tracked). */
export function bindCellReactive(
  def: CellDef,
  sendFn?: (action: { type: string; payload?: unknown }) => void,
): void {
  if (_reactivelyBound.has(def)) return;
  _reactivelyBound.add(def);

  const cellName = def.__aio.id;
  const initialState = def.__aio.state;
  const sig = getCellSignal(cellName, initialState);

  // Install signal-backed state getters
  for (const key of Object.keys(initialState)) {
    if (key in def && key !== "__aio") continue;

    Object.defineProperty(def, key, {
      get() {
        const s = sig.value; // tracked read — auto-tracked by AIR renderer
        if (s == null) return initialState[key];
        return (s as Record<string, unknown>)[key];
      },
      enumerable: false,
      configurable: true,
    });
  }

  // Wrap action creators with dispatch so methods send to server
  if (sendFn) {
    for (const key of def.__aio.actionKeys) {
      const creator = (def as Record<string, unknown>)[key];
      if (typeof creator !== "function") continue;

      const fn = (...args: unknown[]) => {
        const action = (creator as (...a: unknown[]) => {
          type: string;
          payload?: unknown;
        })(...args);
        sendFn(action);
      };
      (fn as unknown as Record<string, unknown>).type =
        (creator as unknown as { type: string }).type;
      (def as Record<string, unknown>)[key] = fn;
    }
  }
}

/** Bind all registered cells reactively. Called once from ensureConnected(). */
export function bindAllCellsReactive(
  sendFn?: (action: { type: string; payload?: unknown }) => void,
): void {
  for (const def of _cellRegistry) {
    bindCellReactive(def, sendFn);
  }
}
