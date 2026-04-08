// deno-lint-ignore-file no-explicit-any
/**
 * @module
 * Legacy delta signal application — wires old $p/$d/$f wire formats into signals.
 * @deprecated Scheduled for removal after v1.0.0 stable (all clients on v1.0.0+).
 */

import { batch } from "./signal.ts";
import { _BLOCKED_KEYS } from "./state-array-utils.ts";
import {
  _applyPatch,
  _applyPathDelete,
  _deepMergeFiltered,
  _rebuildIdMaps,
} from "./state-id-maps.ts";
import {
  _cellSignals,
  _getOrCreateCellSignal,
  _stateSignal,
} from "./state-signals.ts";

// ── Legacy delta (warn once) ──────────────────────────────────────────

let _warnedLegacyDelta = false;

export function _resetLegacyDeltaWarning(): void {
  _warnedLegacyDelta = false;
}

// ── @deprecated Legacy delta application (signal-wired) ──────────────

export function _applyDeltaToSignals(
  data: { $p?: Record<string, any>; $d?: string[]; $f?: number },
): void {
  if (!_warnedLegacyDelta) {
    _warnedLegacyDelta = true;
    console.warn(
      "[aio DEPRECATED] received $p/$d delta format — server/client mismatch. Upgrade to v1.0.0+",
    );
  }
  const prev = _stateSignal.peek();

  // $f (filtered) — deep merge into existing state
  if (data.$f === 1 && data.$p) {
    batch(() => {
      const next = { ...prev };
      for (const [cellName, patch] of Object.entries(data.$p!)) {
        const cellPrev = (prev[cellName] ?? {}) as Record<string, unknown>;
        const cellNext = _deepMergeFiltered(
          cellPrev,
          patch as Record<string, unknown>,
        );
        next[cellName] = cellNext;
        _getOrCreateCellSignal(cellName, cellNext).set(cellNext);
      }
      _stateSignal.set(next);
    });
    return;
  }

  // Standard delta: use _applyPatch for $p, then _applyPathDelete for deep $d
  if (data.$p || data.$d) {
    // Separate simple top-level deletions (handled by _applyPatch) from
    // deep path deletions including $id: (handled by _applyPathDelete)
    const simpleDeletions: string[] = [];
    const deepDeletions: string[] = [];
    if (data.$d) {
      for (const path of data.$d) {
        if (typeof path === "string") {
          if (path.includes(".")) {
            deepDeletions.push(path);
          } else {
            simpleDeletions.push(path);
          }
        }
      }
    }

    const patchData = {
      $p: data.$p ?? {},
      $d: simpleDeletions.length > 0 ? simpleDeletions : undefined,
    };
    const next = _applyPatch(
      prev,
      patchData as { $p: Record<string, unknown>; $d?: string[] },
    );

    // Apply deep path deletions (including $id: identity array element removal)
    for (const path of deepDeletions) {
      _applyPathDelete(next, path);
    }

    batch(() => {
      _stateSignal.set(next);
      // Update per-cell signals for changed cells
      if (data.$p) {
        for (const cellName of Object.keys(data.$p)) {
          if (_BLOCKED_KEYS.has(cellName)) continue;
          const cellState = next[cellName];
          _getOrCreateCellSignal(cellName, cellState).set(cellState);
        }
      }
      // Handle deletions — update affected cell signals
      if (data.$d) {
        for (const path of data.$d) {
          if (typeof path === "string") {
            const cellName = path.split(".")[0]!;
            if (!_BLOCKED_KEYS.has(cellName)) {
              const sig = _cellSignals.get(cellName);
              if (sig) sig.set(next[cellName]);
            }
          }
        }
      }
    });
  }
}

// ── @deprecated Filtered state application (wire format: { $f:1, feat1:{...}, ... }) ──

export function _applyFilteredToSignals(data: Record<string, any>): void {
  const prev = _stateSignal.peek();
  const next = _deepMergeFiltered(prev, data);
  batch(() => {
    _stateSignal.set(next);
    for (const cellName of Object.keys(data)) {
      if (_BLOCKED_KEYS.has(cellName)) continue;
      _getOrCreateCellSignal(cellName, next[cellName]).set(next[cellName]);
    }
  });
  _rebuildIdMaps(next); // needed for legacy $arr delta backward compat
}
