// Deep merge — restores persisted state while preserving new schema fields
// Shared by aio.ts (Deno KV) and standalone.ts (localStorage)

import { log } from "../diagnostics/logger.ts";
import { diagEmit } from "../diagnostics/diagnostic-bus.ts";

/** Returns true if v is a plain object (not null, not array, not Map/Set/Date) */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) &&
    !(v instanceof Map) && !(v instanceof Set) && !(v instanceof Date);
}

/**
 * Write an OWN data property — the ONLY way a persisted key enters the result.
 *
 * `target[key] = value` is not safe for every key a dictionary may legitimately
 * hold: `__proto__` hits `Object.prototype`'s accessor and RE-PARENTS the
 * object instead of storing data. That accessor is the whole prototype-
 * pollution vector, and it is the only one — `Object.prototype.__proto__` is
 * the sole accessor property on `Object.prototype`, so every other key is a
 * plain create-data-property on a fresh object literal. `defineProperty`
 * always creates an own data property, so `__proto__` restores as the data it
 * is and no prototype, anywhere, is touched.
 *
 * (This replaces the old BANNED_KEYS drop-list: `constructor`/`prototype` are
 * inert as OWN properties, and dropping them silently lost user data — see the
 * dictionary note on `deepMerge`.)
 */
function setOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  target[key] = value;
}

// Recursion guard, not a policy: restore runs at boot on data the process did
// not produce this run (disk, localStorage, a migrated profile). A corrupt or
// hostile payload nested thousands of levels deep would blow the JS stack
// before the app ever serves, and a stack overflow is unrecoverable and
// undiagnosable. 32 levels is far past any hand-written state shape.
const MAX_DEPTH = 32;

/** Path segment for diagnostics: `$.a.b` for identifiers, `$["weird key"]`. */
function step(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

type MergeCtx = {
  seen: WeakSet<object>;
  /** Paths where the depth cap stopped the schema-directed merge. */
  truncated: string[];
};

// Uses `initial` as the structural template: any key in initial is guaranteed to exist
// in the result. Persisted values override leaf values but can't remove keys or change
// object→primitive. Arrays are replaced wholesale (not merged element-by-element).
//
// EXCEPTION (AIO-415): an empty plain object `{}` as initial is a DICTIONARY schema
// (`Record<K,V>`), not a fixed-shape template — there are no "schema keys" to protect,
// so ALL persisted entries are kept. Without this, a `{} `-initial dictionary lost
// every persisted entry on restore, silently (a `pins: Record<number,string>`
// data-loss bug).
//
// "Declared" is tested with `Object.hasOwn`, never `key in initial`: `in` walks the
// PROTOTYPE CHAIN, so a dictionary entry whose key happens to name an
// `Object.prototype` member (`toString`, `valueOf`, `hasOwnProperty`,
// `constructor`, …) read as "declared" in a fixed-shape template and as
// "undeclared" nowhere — while the drop-list below removed the rest. Either way
// a tag count named `toString` or a per-username record for a user called
// `constructor` vanished on restart, silently. Keys are DATA; only the write
// itself has to be safe (see `setOwn`).

/** Merges persisted state into initial, using initial as the structural template */
export function deepMerge(
  initial: Record<string, unknown>,
  persisted: Record<string, unknown>,
  depth = 0,
  _seen?: WeakSet<object>,
): Record<string, unknown> {
  const ctx: MergeCtx = { seen: _seen ?? new WeakSet<object>(), truncated: [] };
  const result = merge(initial, persisted, depth, ctx, "$");
  if (ctx.truncated.length > 0) reportTruncation(ctx.truncated);
  return result;
}

/** The depth cap is a stack guard, so it may not be silent: the subtrees below
 *  it are restored verbatim (never replaced by defaults — that was silent data
 *  loss), but they skipped the schema merge entirely, so this says WHERE. */
function reportTruncation(paths: string[]): void {
  const shown = paths.slice(0, 3).join(", ");
  const more = paths.length > 3 ? ` (+${paths.length - 3} more)` : "";
  const msg = `restore hit the ${MAX_DEPTH}-level nesting cap at ${shown}` +
    `${more} — those subtrees were kept VERBATIM from storage and NOT merged ` +
    `against the schema below that point: new defaults are not filled in, ` +
    `type mismatches are not corrected, removed keys are not pruned. The cap ` +
    `is a stack guard against unbounded nesting; flatten the structure (e.g. ` +
    `an id-keyed map of nodes instead of literal nesting) to restore fully.`;
  log.warn("restore", msg);
  diagEmit({
    type: "restore-depth-cap",
    severity: "warning",
    source: "deep-merge",
    message: msg,
    detail: {
      paths: paths.slice(0, 20),
      count: paths.length,
      maxDepth: MAX_DEPTH,
    },
    hint:
      "State nested deeper than 32 levels restores unmerged. Flatten the shape.",
  });
}

function merge(
  initial: Record<string, unknown>,
  persisted: Record<string, unknown>,
  depth: number,
  ctx: MergeCtx,
  path: string,
): Record<string, unknown> {
  if (depth >= MAX_DEPTH) {
    // Keep the DATA (the whole persisted subtree) and name the path — the old
    // `return initial` handed back the declared default and dropped everything
    // the user had stored below level 31 without a word.
    ctx.truncated.push(path);
    return persisted;
  }
  // AIO-185: cycle detection for circular references
  if (ctx.seen.has(persisted)) return initial;
  ctx.seen.add(persisted);
  const result: Record<string, unknown> = { ...initial };
  // AIO-415: empty-object initial = dictionary schema → accept all persisted keys.
  const initialIsEmptyDict = Object.keys(initial).length === 0;
  for (const key of Object.keys(persisted)) {
    if (!Object.hasOwn(initial, key)) {
      if (initialIsEmptyDict) {
        const pv = persisted[key];
        // recurse into nested dicts so they restore too; leaves pass through
        setOwn(
          result,
          key,
          isPlainObject(pv)
            ? merge({}, pv, depth + 1, ctx, step(path, key))
            : pv,
        );
      }
      continue; // (non-empty initial) drop keys removed from schema
    }
    const iv = initial[key];
    const pv = persisted[key];
    if (isPlainObject(iv) && isPlainObject(pv)) {
      setOwn(result, key, merge(iv, pv, depth + 1, ctx, step(path, key)));
    } else if (pv === null && isPlainObject(iv)) {
      // persisted null can't wipe schema object → keep initial
    } else if (isPlainObject(iv) && Array.isArray(pv)) {
      // persisted array can't replace schema object → keep initial
    } else if (Array.isArray(iv) && isPlainObject(pv)) {
      // persisted object can't replace schema array → keep initial (AIO-144)
    } else if (typeof iv === typeof pv || iv === null || pv === null) {
      setOwn(result, key, pv); // same type → use persisted
    }
    // type mismatch → keep initial (schema wins)
  }
  return result;
}
