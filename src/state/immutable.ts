// immutable.ts — the single authority for aio's state-immutability invariant.
//
// One root cause underlies aio's recurring "state leak" / Immer-alias bugs: a
// live state object gets mutated in place where an immutable/fresh one was
// assumed. The defense is structural, not per-bug:
//
//   1. cloneState  — every place that SEEDS live state hands out a fresh deep
//                    clone, so live state never aliases the declared initial.
//   2. freezeInitial — the declared `state:` is frozen (dev), so any in-place
//                    mutation throws AT THE SITE instead of corrupting silently.
//
// Together: aliasing is impossible (clone) and illegal mutation is loud and
// local (freeze). Immer's autoFreeze already covers produced/committed state;
// this closes the one remaining open seam — the declared initial.

const FREEZE_SIZE_LIMIT = 100_000; // keep dev boot snappy on large slices

/** Deep clone that never throws — structuredClone, then JSON, then identity. */
export function cloneState<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return value; // circular / non-serializable — best effort
    }
  }
}

/** Recursively freeze an object graph (idempotent, cycle-safe). */
export function deepFreeze<T>(obj: T, seen: WeakSet<object> = new WeakSet()): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (seen.has(obj as object)) return obj;
  seen.add(obj as object);
  Object.freeze(obj);
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
      deepFreeze(v, seen);
    }
  }
  return obj;
}

/** True in dev — set on globalThis by the dev runtime. */
function isDev(): boolean {
  return (globalThis as Record<string, unknown>).__aioDev === true;
}

/**
 * Produce the canonical form of a cell's DECLARED initial state: always a deep
 * clone (so it never aliases the caller's object or live state), deep-frozen in
 * dev (so mutating it throws at the site). This is the pristine source of truth
 * every reset/seed/fallback reads — it must never change after creation.
 */
export function freezeInitial<T>(value: T): T {
  const clone = cloneState(value);
  if (!isDev() || clone === null || typeof clone !== "object") return clone;
  try {
    if (JSON.stringify(clone).length > FREEZE_SIZE_LIMIT) return clone;
  } catch {
    return clone; // circular — skip freeze
  }
  try {
    return deepFreeze(clone);
  } catch {
    return clone;
  }
}
