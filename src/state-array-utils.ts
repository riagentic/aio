/**
 * @module
 * Array reference preservation, shallow equality, and wasted-render detection.
 * Zero dependencies — pure utility functions used by state-core internals.
 */

/**
 * Prototype pollution guard — keys blocked from proxy/patch traversal.
 * @internal Cross-module wiring — not public API, stripped from the snapshot.
 */
export const _BLOCKED_KEYS: Set<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

// ── Shallow equality ────────────────────────────────────────────────

/**
 * Shallow-equal comparison for one level of properties. Uses Object.is for NaN correctness.
 * @internal Cross-module wiring — not public API, stripped from the snapshot.
 */
export function _shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" || typeof b !== "object" || a === null || b === null
  ) return false;
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  for (const k of ka) {
    if (!Object.hasOwn(objB, k) || !Object.is(objA[k], objB[k])) return false; // AIO-237: key-existence check
  }
  return true;
}

// ── Array ref stats (AIO-11 wasted render detection) ────────────────

/** Stats from `_preserveArrayRefs` — tracks how many references were preserved vs changed. */
export interface ArrayRefStats {
  preserved: number;
  changed: number;
  total: number;
  cycles: number;
}

let _arrayRefStats: ArrayRefStats = {
  preserved: 0,
  changed: 0,
  total: 0,
  cycles: 0,
};

/**
 * Returns a snapshot of current array reference preservation stats.
 * @internal Cross-module wiring — not public API, stripped from the snapshot.
 */
export function _getArrayRefStats(): ArrayRefStats {
  return { ..._arrayRefStats };
}

/** @internal Cross-module wiring — not public API, stripped from the snapshot. */
export function _resetArrayRefStats(): void {
  _arrayRefStats = { preserved: 0, changed: 0, total: 0, cycles: 0 };
}

/** Check if wasted renders are likely based on arrayRefStats + render status.
 * @internal Cross-module wiring — not public API, stripped from the snapshot.
 *  Returns a warning string or null. Resets stats after check. */
export function _checkWastedRenders(status: string): string | null {
  const stats = _getArrayRefStats();
  _resetArrayRefStats();
  if (
    stats.total === 0 || stats.cycles < 3 ||
    status === "healthy" || status === "recovered"
  ) {
    return null;
  }
  const ratio = stats.preserved / stats.total;
  if (ratio <= 0.5) return null;
  return `[aio] WASTED RENDERS: _preserveArrayRefs preserved ${stats.preserved}/${stats.total} element refs (${
    Math.round(ratio * 100)
  }%), but render is ${status}. Your memo() comparators may be checking container references instead of element values. Use useProjection() for derived state and import { memo } from "aio" (not React). See docs/ui.md#derived-state--memo`;
}

// ── Structural sharing for arrays ───────────────────────────────────

/** Preserve element references for unchanged items.
 * @internal Cross-module wiring — not public API, stripped from the snapshot.
 *  Returns the previous array reference if ALL elements are unchanged. */
export function _preserveArrayRefs(
  newArr: unknown[],
  oldArr: unknown[],
): unknown[] {
  if (newArr.length !== oldArr.length) {
    _arrayRefStats.total += newArr.length;
    _arrayRefStats.changed += newArr.length;
    _arrayRefStats.cycles++;
    return newArr;
  }
  let allSame = true;
  let result: unknown[] | null = null; // AIO-257: lazy copy — never mutate input
  for (let i = 0; i < newArr.length; i++) {
    _arrayRefStats.total++;
    if (newArr[i] === oldArr[i]) {
      _arrayRefStats.preserved++;
      continue;
    }
    if (
      newArr[i] && typeof newArr[i] === "object" && !Array.isArray(newArr[i]) &&
      oldArr[i] && typeof oldArr[i] === "object" && !Array.isArray(oldArr[i])
    ) {
      if (_shallowEqual(newArr[i], oldArr[i])) {
        if (!result) result = newArr.slice();
        result[i] = oldArr[i]; // restore reference — element unchanged
        _arrayRefStats.preserved++;
        continue;
      }
    }
    _arrayRefStats.changed++;
    allSame = false;
  }
  _arrayRefStats.cycles++;
  return allSame ? oldArr : (result ?? newArr);
}
