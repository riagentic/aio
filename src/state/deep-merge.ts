// Deep merge — restores persisted state while preserving new schema fields
// Shared by aio.ts (Deno KV) and standalone.ts (localStorage)

/** Returns true if v is a plain object (not null, not array, not Map/Set/Date) */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) &&
    !(v instanceof Map) && !(v instanceof Set) && !(v instanceof Date);
}

const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Uses `initial` as the structural template: any key in initial is guaranteed to exist
// in the result. Persisted values override leaf values but can't remove keys or change
// object→primitive. Arrays are replaced wholesale (not merged element-by-element).
//
// EXCEPTION (AIO-415): an empty plain object `{}` as initial is a DICTIONARY schema
// (`Record<K,V>`), not a fixed-shape template — there are no "schema keys" to protect,
// so ALL persisted entries are kept. Without this, a `{} `-initial dictionary lost
// every persisted entry on restore, silently (the TBD `pins: Record<number,string>`
// data-loss bug).
const MAX_DEPTH = 32;

/** Merges persisted state into initial, using initial as the structural template */
export function deepMerge(
  initial: Record<string, unknown>,
  persisted: Record<string, unknown>,
  depth = 0,
  _seen?: WeakSet<object>,
): Record<string, unknown> {
  if (depth >= MAX_DEPTH) return initial; // prevent stack overflow on deeply nested payloads
  // AIO-185: cycle detection for circular references
  const seen = _seen ?? new WeakSet<object>();
  if (seen.has(persisted)) return initial;
  seen.add(persisted);
  const result: Record<string, unknown> = { ...initial };
  // AIO-415: empty-object initial = dictionary schema → accept all persisted keys.
  const initialIsEmptyDict = Object.keys(initial).length === 0;
  for (const key of Object.keys(persisted)) {
    if (BANNED_KEYS.has(key)) continue; // prevent prototype pollution
    if (!(key in initial)) {
      if (initialIsEmptyDict) {
        const pv = persisted[key];
        // recurse into nested dicts so they restore too; leaves pass through
        result[key] = isPlainObject(pv) ? deepMerge({}, pv, depth + 1, seen) : pv;
      }
      continue; // (non-empty initial) drop keys removed from schema
    }
    const iv = initial[key];
    const pv = persisted[key];
    if (isPlainObject(iv) && isPlainObject(pv)) {
      result[key] = deepMerge(iv, pv, depth + 1, seen);
    } else if (pv === null && isPlainObject(iv)) {
      // persisted null can't wipe schema object → keep initial
    } else if (isPlainObject(iv) && Array.isArray(pv)) {
      // persisted array can't replace schema object → keep initial
    } else if (Array.isArray(iv) && isPlainObject(pv)) {
      // persisted object can't replace schema array → keep initial (AIO-144)
    } else if (typeof iv === typeof pv || iv === null || pv === null) {
      result[key] = pv; // same type → use persisted
    }
    // type mismatch → keep initial (schema wins)
  }
  return result;
}
