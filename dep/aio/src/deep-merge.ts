// Deep merge — restores persisted state while preserving new schema fields
// Shared by aio.ts (Deno KV) and standalone.ts (localStorage)

/** Returns true if v is a plain object (not null, not array) */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// Uses `initial` as the structural template: any key in initial is guaranteed to exist
// in the result. Persisted values override leaf values but can't remove keys or change
// object→primitive. Arrays are replaced wholesale (not merged element-by-element).
const MAX_DEPTH = 32

/** Merges persisted state into initial, using initial as the structural template */
export function deepMerge(initial: Record<string, unknown>, persisted: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth >= MAX_DEPTH) return initial  // prevent stack overflow on deeply nested payloads
  const result: Record<string, unknown> = { ...initial }
  for (const key of Object.keys(persisted)) {
    if (BANNED_KEYS.has(key)) continue  // prevent prototype pollution
    if (!(key in initial)) continue  // drop keys removed from schema
    const iv = initial[key]
    const pv = persisted[key]
    if (isPlainObject(iv) && isPlainObject(pv)) {
      result[key] = deepMerge(iv, pv, depth + 1)
    } else if (pv === null && isPlainObject(iv)) {
      // persisted null can't wipe schema object → keep initial
    } else if (typeof iv === typeof pv || iv === null || pv === null) {
      result[key] = pv  // same type → use persisted
    }
    // type mismatch → keep initial (schema wins)
  }
  return result
}
