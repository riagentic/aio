// Deep merge — restores persisted state while preserving new schema fields
// Shared by aio.ts (Deno KV) and standalone.ts (localStorage)

import { log } from "../diagnostics/logger-api.ts";
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

// Breadth guard. MAX_DEPTH bounds how DEEP the merge goes; nothing bounded how
// WIDE. That did not matter while cycle detection used a visited-set, because a
// visited-set also (accidentally) merged every object at most once. Correct
// cycle detection tracks the ancestor path instead, so a shared subtree is now
// merged once per reference — right for data, but a DAG that shares references
// at every level costs 2^depth. Fixing silent data loss must not buy a hang, so
// the breadth is bounded explicitly and, like every other cap in this file,
// says so instead of quietly returning less than it was given.
// 100k nodes is far past any hand-written state shape.
const MAX_NODES = 100_000;

/** Path segment for diagnostics: `$.a.b` for identifiers, `$["weird key"]`. */
function step(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

type MergeCtx = {
  /** The objects on the CURRENT ancestor path — added on entry, removed on
   *  exit. Not a visited-set: a visited-set cannot tell a cycle from a DAG.
   *  See the cycle check in `merge` for why that distinction is data loss. */
  onPath: Set<object>;
  /** Paths where the depth cap stopped the schema-directed merge. */
  truncated: string[];
  /** Paths where a genuine reference cycle was cut. */
  cycles: string[];
  /** Nodes merged so far — the breadth guard (see MAX_NODES). */
  nodes: number;
  /** Paths where the node budget stopped the merge. */
  overBudget: string[];
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
  // `_seen` is accepted for signature compatibility and deliberately ignored:
  // a caller-supplied visited-set is exactly the bug fixed here (see `merge`).
  void _seen;
  const ctx: MergeCtx = {
    onPath: new Set<object>(),
    truncated: [],
    cycles: [],
    nodes: 0,
    overBudget: [],
  };
  const result = merge(initial, persisted, depth, ctx, "$");
  if (ctx.truncated.length > 0) reportTruncation(ctx.truncated);
  if (ctx.cycles.length > 0) reportCycles(ctx.cycles);
  if (ctx.overBudget.length > 0) reportBudget(ctx.overBudget);
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

/** The merge did more work than any real state shape needs — a shape sharing
 *  references at many levels. Subtrees past the budget are kept VERBATIM from
 *  storage (data first), but they skipped the schema merge. */
function reportBudget(paths: string[]): void {
  const shown = paths.slice(0, 3).join(", ");
  const more = paths.length > 3 ? ` (+${paths.length - 3} more)` : "";
  const msg = `restore hit the ${MAX_NODES}-node merge budget at ${shown}` +
    `${more} — those subtrees were kept VERBATIM from storage and NOT merged ` +
    `against the schema. This means the state shares object references at many ` +
    `levels (the same object reachable by many paths), which multiplies the ` +
    `work; store ids instead of repeated references.`;
  log.warn("restore", msg);
  diagEmit({
    type: "restore-node-budget",
    severity: "warning",
    source: "deep-merge",
    message: msg,
    detail: { paths: paths.slice(0, 20), count: paths.length, max: MAX_NODES },
    hint: "Heavily reference-shared state — store ids, not repeated refs.",
  });
}

/** A real reference cycle was cut. The branch below it cannot be merged, so the
 *  declared default stands in — which is a substitution, and every silent
 *  substitution in this file has cost someone their data. Name the path. */
function reportCycles(paths: string[]): void {
  const shown = paths.slice(0, 3).join(", ");
  const more = paths.length > 3 ? ` (+${paths.length - 3} more)` : "";
  const msg = `restore found a reference CYCLE at ${shown}${more} — that ` +
    `branch cannot be merged, so the declared default stands in and whatever ` +
    `was stored below it is NOT restored. State is meant to be a tree; a ` +
    `cycle usually means a parent reference was stored alongside a child ` +
    `(store an id instead).`;
  log.warn("restore", msg);
  diagEmit({
    type: "restore-cycle",
    severity: "warning",
    source: "deep-merge",
    message: msg,
    detail: { paths: paths.slice(0, 20), count: paths.length },
    hint:
      "Replace the back-reference with an id — cyclic state cannot round-trip.",
  });
}

function merge(
  initial: Record<string, unknown>,
  persisted: Record<string, unknown>,
  depth: number,
  ctx: MergeCtx,
  path: string,
): Record<string, unknown> {
  // Breadth guard — same treatment as the depth cap: keep the DATA, name the
  // path. Reached only by a heavily reference-shared shape (see MAX_NODES).
  if (++ctx.nodes > MAX_NODES) {
    ctx.overBudget.push(path);
    return persisted;
  }
  if (depth >= MAX_DEPTH) {
    // Keep the DATA (the whole persisted subtree) and name the path — the old
    // `return initial` handed back the declared default and dropped everything
    // the user had stored below level 31 without a word.
    ctx.truncated.push(path);
    return persisted;
  }
  // Cycle detection, on the ANCESTOR PATH rather than everything visited.
  //
  // A visited-set answers "have I ever seen this object?", but the question
  // that stops infinite recursion is "am I INSIDE this object right now?".
  // Only the second is a cycle; the first also fires on a DAG — the same object
  // referenced from two places, which `structuredClone` preserves and which any
  // in-memory restore path can therefore hand us. With a visited-set, the
  // SECOND reference merged to the declared default and the user's stored value
  // vanished, silently: `{ a: shared, b: shared }` holding `n: 99` restored
  // `b.n` as `0`. That is data loss dressed as cycle safety.
  //
  // Adding on entry and removing on exit answers the right question, so a DAG
  // merges correctly at every occurrence and a real cycle is still cut.
  if (ctx.onPath.has(persisted)) {
    // FAIL LOUD. Substituting `initial` here is the only honest thing to
    // return — the branch cannot be followed — but it IS a substitution, and
    // one that silently swaps stored data for a default is the failure mode
    // this codebase keeps paying for. Say where.
    ctx.cycles.push(path);
    return initial;
  }
  ctx.onPath.add(persisted);
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
  // Leaving this node: it is no longer an ancestor. Without this the set decays
  // back into a visited-set and the DAG data loss above returns.
  ctx.onPath.delete(persisted);
  return result;
}
