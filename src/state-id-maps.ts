// deno-lint-ignore-file no-explicit-any
/**
 * @module
 * Identity-keyed array maps for legacy $arr delta format.
 * @deprecated These maps exist only for backward compatibility with the old
 * $arr wire format. Remove after v1.0.0 stable.
 */

import {
  _BLOCKED_KEYS,
  _preserveArrayRefs,
  _shallowEqual,
} from "./state-array-utils.ts";

// ── Identity-keyed array maps ─────────────────────────────────────────

/** @deprecated Legacy — remove after v1.0.0 stable. Only needed for $arr delta backward compat. */
export const _idMaps: Map<
  string,
  { ids: Map<string, unknown>; order: string[] }
> = new Map();

/** @deprecated Legacy — remove after v1.0.0 stable. Only needed for $arr delta backward compat.
 *  Build _idMaps entries from a full state object. Called on full state receive and reconnect. */
export function _rebuildIdMaps(state: Record<string, unknown>): void {
  _idMaps.clear();
  for (const [fk, fv] of Object.entries(state)) {
    if (!fv || typeof fv !== "object" || Array.isArray(fv)) continue;
    for (const [sk, sv] of Object.entries(fv as Record<string, unknown>)) {
      if (!Array.isArray(sv) || sv.length === 0) continue;
      let allHaveId = true;
      for (const el of sv) {
        if (
          !el || typeof el !== "object" || Array.isArray(el) ||
          typeof (el as Record<string, unknown>).id !== "string"
        ) {
          allHaveId = false;
          break;
        }
      }
      if (!allHaveId) continue;
      const ids = new Map<string, unknown>();
      const order: string[] = [];
      for (const el of sv) {
        const id = (el as Record<string, unknown>).id as string;
        ids.set(id, el);
        order.push(id);
      }
      _idMaps.set(`${fk}.${sk}`, { ids, order });
    }
  }
}

/** @deprecated Legacy — remove after v1.0.0 stable. Server no longer produces $arr format.
 *  Apply a $arr identity-keyed array patch. Returns the reconstructed array. */
export function _applyArrPatch(
  mapKey: string,
  arrPatch: Record<string, unknown>,
): unknown[] {
  let entry = _idMaps.get(mapKey);
  if (!entry) {
    entry = { ids: new Map(), order: [] };
    _idMaps.set(mapKey, entry);
  }

  // Apply updates and additions
  for (const [k, v] of Object.entries(arrPatch)) {
    if (k === "$arr" || k === "$rm") continue;
    if (k.startsWith("$id:")) {
      const id = k.slice(4);
      if (!entry.ids.has(id)) {
        entry.order.push(id);
      }
      entry.ids.set(id, v);
    }
  }

  // Apply removals
  if (Array.isArray(arrPatch.$rm)) {
    for (const id of arrPatch.$rm) {
      if (typeof id === "string") {
        entry.ids.delete(id);
        const idx = entry.order.indexOf(id);
        if (idx !== -1) entry.order.splice(idx, 1);
      }
    }
  }

  // Reconstruct array from order — filter out any desynced entries
  const result: unknown[] = [];
  for (const id of entry.order) {
    const el = entry.ids.get(id);
    if (el !== undefined) {
      result.push(el);
    }
  }
  // Clean up desynced order entries
  entry.order = entry.order.filter((id) => entry!.ids.has(id));
  return result;
}

// ── Delta application ($p + $d) ──────────────────────────────────────

/** @deprecated Legacy — remove after v1.0.0 stable. Server no longer produces $p/$d format.
 *  Apply a delta patch ($p + $d) to previous state. Handles nested cell patches (v0.5).
 *  Preserves object references for unchanged slices. */
export function _applyPatch(
  prev: Record<string, unknown> | null,
  data: { $p: Record<string, unknown>; $d?: string[] },
): Record<string, unknown> {
  const next = prev ? { ...prev } : {} as Record<string, unknown>;
  // Apply patches — shallow merge for nested object patches (cell slices)
  for (const [k, v] of Object.entries(data.$p)) {
    if (_BLOCKED_KEYS.has(k)) {
      continue;
    }
    if (
      v && typeof v === "object" && !Array.isArray(v) && next[k] &&
      typeof next[k] === "object" && !Array.isArray(next[k])
    ) {
      // Nested cell patch — shallow merge sub-keys (filter unsafe keys)
      const sub = v as Record<string, unknown>;
      const prev_slice = next[k] as Record<string, unknown>;
      const merged = { ...prev_slice };
      const arrPatchedKeys = new Set<string>();
      for (const [sk, sv] of Object.entries(sub)) {
        if (_BLOCKED_KEYS.has(sk) || sk === "$d") continue;
        // Identity-keyed array patch ($arr marker)
        if (
          sv && typeof sv === "object" && !Array.isArray(sv) &&
          (sv as Record<string, unknown>).$arr === true
        ) {
          merged[sk] = _applyArrPatch(
            `${k}.${sk}`,
            sv as Record<string, unknown>,
          );
          arrPatchedKeys.add(sk);
        } else if (Array.isArray(sv) && Array.isArray(prev_slice[sk])) {
          // Structural sharing: preserve per-element references for atomic array sub-keys
          merged[sk] = _preserveArrayRefs(
            sv as unknown[],
            prev_slice[sk] as unknown[],
          );
        } else {
          merged[sk] = sv;
        }
      }
      // Handle nested deletions ($d within the sub-patch)
      if (Array.isArray(sub.$d)) {
        for (const sk of sub.$d) {
          if (typeof sk === "string" && !_BLOCKED_KEYS.has(sk)) {
            if (arrPatchedKeys.has(sk)) {
              continue; // $arr patch supersedes deletion
            }
            delete merged[sk];
          }
        }
        delete merged.$d;
      }
      next[k] = merged;
      // Preserve reference if patch didn't actually change anything
      if (prev && _shallowEqual(merged, prev[k])) {
        next[k] = prev[k] as Record<string, unknown>;
      }
    } else {
      // Sanitize new objects — filter unsafe keys even for new top-level entries
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const safe: Record<string, unknown> = {};
        for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
          if (!_BLOCKED_KEYS.has(sk)) safe[sk] = sv;
        }
        next[k] = safe;
        // Preserve reference if new object is shallow-equal to previous
        if (prev && _shallowEqual(safe, prev[k])) {
          next[k] = prev[k] as Record<string, unknown>;
        }
      } else {
        next[k] = v;
      }
    }
  }
  // Top-level deletions
  if (Array.isArray(data.$d)) {
    for (const k of data.$d) {
      if (typeof k === "string" && !_BLOCKED_KEYS.has(k)) delete next[k];
    }
  }
  return next;
}

// ── Deep merge for $f (filtered) responses ───────────────────────────

/** @deprecated Legacy — remove after v1.0.0 stable. Server no longer produces $f format.
 *  Recursive deep merge for `$f` (filtered) responses — preserves sub-keys at every depth. */
export function _deepMergeFiltered(
  prev: Record<string, unknown>,
  incoming: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 32) return prev; // AIO-238: depth limit — prevent stack overflow from malicious payloads
  const result: Record<string, unknown> = { ...prev };
  for (const key of Object.keys(incoming)) {
    if (_BLOCKED_KEYS.has(key)) continue; // AIO-238: prototype pollution guard
    const oldVal = prev[key];
    const newVal = incoming[key];
    if (
      oldVal && typeof oldVal === "object" && !Array.isArray(oldVal) &&
      newVal && typeof newVal === "object" && !Array.isArray(newVal)
    ) {
      result[key] = _deepMergeFiltered(
        oldVal as Record<string, unknown>,
        newVal as Record<string, unknown>,
        depth + 1,
      );
    } else {
      result[key] = newVal;
    }
  }
  return result;
}

// ── Path-based deletion ──────────────────────────────────────────────

/** @deprecated Legacy — remove after v1.0.0 stable. Server no longer produces path-delete format.
 *  Mutate state object for deep path deletions. Signal notifications are handled
 *  by the caller's batch() — this function must NOT fire signals (AIO-101). */
export function _applyPathDelete(
  state: Record<string, any>,
  path: string,
): void {
  const parts = path.split(".");

  // Identity array element deletion: "cell.field.$id:KEY"
  const idIdx = parts.findIndex((p) => p.startsWith("$id:"));
  if (idIdx >= 0) {
    const mapKey = parts.slice(0, idIdx).join(".");
    const id = parts[idIdx]!.slice(4);
    const idMap = _idMaps.get(mapKey);
    if (idMap) {
      idMap.ids.delete(id);
      const orderIdx = idMap.order.indexOf(id);
      if (orderIdx >= 0) idMap.order.splice(orderIdx, 1);
      const arr = idMap.order.map((oid) => idMap.ids.get(oid)).filter(Boolean);
      const cellName = parts[0]!;
      const fieldName = parts.slice(1, idIdx).join(".");
      const cellState = {
        ...(state[cellName] as Record<string, unknown>),
      };
      cellState[fieldName] = arr;
      state[cellName] = cellState;
    }
    return;
  }

  // Simple path deletion
  if (parts.length === 1) {
    delete state[parts[0]!];
  } else {
    const cellName = parts[0]!;
    const cellState = { ...(state[cellName] as Record<string, unknown>) };
    let current: Record<string, unknown> = cellState;
    for (let i = 1; i < parts.length - 1; i++) {
      const val = current[parts[i]!];
      if (!val || typeof val !== "object" || Array.isArray(val)) return;
      current[parts[i]!] = {
        ...(current[parts[i]!] as Record<string, unknown>),
      };
      current = current[parts[i]!] as Record<string, unknown>;
    }
    delete current[parts[parts.length - 1]!];
    state[cellName] = cellState;
  }
}
