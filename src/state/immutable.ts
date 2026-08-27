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

import { log } from "../diagnostics/logger-api.ts";

/** THE dev-freeze size ceiling — one decider for every freeze site (declared
 *  initial state here, cell signal slices in state-signals.ts). It used to be
 *  written twice, and the two copies disagreed about whether skipping is
 *  announced: one warned, one returned in silence. A skipped freeze means "an
 *  illegal mutation will NOT throw here", which is never a silent fact.
 *  Callers report the skip through {@linkcode noteFreezeSkipped}. */
export const FREEZE_SIZE_LIMIT = 100_000; // keep dev boot snappy on large slices

/** One-time-per-process notice that something could not be cloned faithfully. */
let _warnedUncloneable = false;

/** A structural clone for the values `structuredClone` refuses.
 *
 *  This replaces a `JSON.parse(JSON.stringify(...))` rung that CHANGED the data
 *  it was asked to copy, silently: a `Date` came back a string, `undefined` and
 *  function-valued keys vanished, a `Map`/`Set` became `{}`, `NaN`/`Infinity`
 *  became `null`. It ran precisely when `structuredClone` had failed — i.e. on
 *  the states that already contain something unusual — and `freezeInitial`
 *  feeds its result to every reset/seed/fallback in the app. So the app's
 *  DECLARED initial state was quietly not the state it declared. "Clone
 *  faithfully or say so" — this does the first, and says so for the leaves it
 *  cannot copy (a function, a class instance, a DOM node), which are passed
 *  through BY REFERENCE rather than dropped or emptied.
 *
 *  Cycle-safe via `seen`. */
function faithfulClone<T>(value: T, seen: Map<object, unknown>): T {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function") _noteUncloneable("a function");
    return value;
  }
  const hit = seen.get(value as object);
  if (hit !== undefined) return hit as T;
  const rec = <V>(v: V): V => faithfulClone(v, seen);

  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags) as T;
  }
  if (value instanceof ArrayBuffer) return value.slice(0) as T;
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      return new DataView(
        value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength,
        ),
      ) as T;
    }
    // Every TypedArray has a copy constructor taking another TypedArray.
    const Ctor = (value as object).constructor as new (
      v: ArrayBufferView,
    ) => unknown;
    return new Ctor(value) as T;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value as object, out);
    for (const v of value) out.push(rec(v));
    return out as T;
  }
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value as object, out);
    for (const [k, v] of value) out.set(rec(k), rec(v));
    return out as T;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value as object, out);
    for (const v of value) out.add(rec(v));
    return out as T;
  }
  // A class instance / DOM node / anything with behaviour in its prototype:
  // copying its own keys onto a bare object would produce a LOOKALIKE that has
  // lost every method — worse than not copying it. Hand back the original and
  // say so; `freezeInitial` still freezes it, so an in-place mutation is loud.
  const proto = Object.getPrototypeOf(value);
  const ctor = (proto as { constructor?: { name?: string } } | null)
    ?.constructor;
  if (proto !== null && ctor?.name !== "Object") {
    _noteUncloneable(`a ${ctor?.name ?? "non-plain"} instance`);
    return value;
  }
  const out: Record<string, unknown> = {};
  seen.set(value as object, out);
  for (const k of Object.keys(value as Record<string, unknown>)) {
    out[k] = rec((value as Record<string, unknown>)[k]);
  }
  return out as T;
}

function _noteUncloneable(what: string): void {
  if (_warnedUncloneable) return;
  _warnedUncloneable = true;
  log.warn(
    `[aio] cell state contains ${what}, which cannot be copied — it is shared ` +
      `by REFERENCE between the declared initial state and live state instead ` +
      `of cloned. Keep cell state to plain JSON-shaped data (objects, arrays, ` +
      `numbers, strings, booleans, null, Date, Map, Set); move behaviour to ` +
      `methods and non-serializable handles to \`own\` (logged once).`,
  );
}

/** Deep clone that never throws — `structuredClone`, then a faithful
 *  structural clone for what it refuses. `onUncloneable` decides only the ROOT
 *  case where even that must hand back a reference (a class instance / function
 *  AT the root): seeding wants `"identity"` (aliasing the declared initial is
 *  survivable and freeze catches mutation); read-snapshots want `"shallow"`
 *  (returning the live ref would let a `.map()` over the "snapshot" silently
 *  mutate real state — the exact Immer-alias class this module exists to
 *  kill). */
export function cloneState<T>(
  value: T,
  onUncloneable: "identity" | "shallow" = "identity",
): T {
  try {
    return structuredClone(value);
  } catch {
    const cloned = faithfulClone(value, new Map());
    if (
      onUncloneable === "shallow" && cloned === value && value !== null &&
      typeof value === "object"
    ) {
      return (Array.isArray(value)
        ? [...(value as unknown[])]
        : { ...(value as Record<string, unknown>) }) as T;
    }
    return cloned;
  }
}

/** One-time-per-process notice that a Map/Set in state cannot be frozen. */
let _warnedUnfreezable = false;

/** THE deep freeze — one implementation for the three sites that had their own
 *  (declared initial state, the dispatch loop's `freezeState`, cell signal
 *  slices). They had drifted: one had no cycle guard at all, none of them knew
 *  that `Object.freeze` THROWS on a non-empty typed array, and all three
 *  reported success on a `Map`/`Set` while giving it zero protection.
 *
 *  Idempotent and cycle-safe. Returns `obj`. */
export function deepFreeze<T>(
  obj: T,
  seen: WeakSet<object> = new WeakSet(),
): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (seen.has(obj as object)) return obj;
  seen.add(obj as object);
  // A typed array / DataView cannot be frozen while it has elements —
  // `Object.freeze` throws "Cannot freeze array buffer views with elements".
  // Immer's own freeze skips non-draftables, so PROD was fine and DEV died:
  // one `Uint8Array` in cell state took the whole dispatch loop down (and the
  // action's write with it). Skipping is what Immer already does, so this is
  // dev matching prod, not dev going soft — the buffer's CONTENTS were never
  // protected by freezing the view either way.
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return obj;
  // A frozen Map/Set is a lie: `Object.freeze` seals the object's PROPERTIES
  // and leaves `set`/`add`/`delete`/`clear` fully working, so "it's frozen"
  // meant "mutation is silent" here — the opposite of what freezing is for.
  // Say so once, freeze what is reachable, and move on. (Immer's MapSet plugin
  // is not enabled either, so a Map/Set that reaches a producer already
  // throws — this is the other half of the same missing support.)
  if (obj instanceof Map || obj instanceof Set) {
    if (!_warnedUnfreezable) {
      _warnedUnfreezable = true;
      log.warn(
        `[aio] a ${
          obj instanceof Map ? "Map" : "Set"
        } in state cannot be frozen — JS freezing does not cover ` +
          `set/add/delete/clear, so an in-place mutation of it will NOT throw ` +
          `in dev the way every other illegal mutation does. Immer's MapSet ` +
          `plugin is not enabled either. Use a plain object or array in cell ` +
          `state (logged once).`,
      );
    }
    for (const v of obj.values()) {
      if (v !== null && typeof v === "object") deepFreeze(v, seen);
    }
    return obj;
  }
  Object.freeze(obj);
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
      deepFreeze(v, seen);
    }
  }
  return obj;
}

/** Announce, once, that a dev freeze was skipped for size. Both freeze sites
 *  call it, so "we did not protect this slice" is never a silent fact. */
export function noteFreezeSkipped(what: string): void {
  const g = globalThis as Record<string, unknown>;
  if (g.__aioFreezeSkipped) return;
  g.__aioFreezeSkipped = true;
  log.info(
    `[aio] dev freeze skipped: ${what} > ${FREEZE_SIZE_LIMIT}B — an illegal ` +
      `in-place mutation of it will NOT throw at the site. Split the slice, ` +
      `or keep large blobs out of cell state (logged once).`,
  );
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
    if (JSON.stringify(clone).length > FREEZE_SIZE_LIMIT) {
      noteFreezeSkipped("declared initial state");
      return clone;
    }
  } catch {
    return clone; // circular — skip freeze
  }
  try {
    return deepFreeze(clone);
  } catch {
    return clone;
  }
}

// ── what a frozen-state write MEANS ─────────────────────────────────────────
//
// This module is the authority for the invariant, so it is also the authority
// for the sentence a user reads when they break it. Before this, the two
// places that recognised the shape carried their own regex and their own
// wording (`state/cell-compose-reduce.ts` for a mutation inside a method,
// `air/dev-readonly-hint.ts` for one from a component), and a write from
// anywhere ELSE — a test, an effect, a callback holding a read value — got the
// raw engine text and nothing more:
//
//     TypeError: Cannot add property 1, object is not extensible
//
// which names neither the cell, nor the rule, nor the fix.

/** Does this engine message mean "you wrote to frozen state"?
 *
 *  Every engine phrases it differently and none of them mention freezing:
 *  V8 says "object is not extensible" for a grow, "Cannot assign to read only
 *  property" for an overwrite, "Cannot delete property" for a delete. */
export function isFrozenWriteError(message: string): boolean {
  return /not extensible|read only|read-only|already been frozen|Cannot delete property|preventExtensions/i
    .test(message);
}

/** THE explanation for a frozen-state write. `raw` is the engine's own text
 *  (kept — it says WHICH property), `cellName` names the state that was
 *  frozen when it is known.
 *
 *  Committed state is frozen in dev AND prod (`autoFreeze` is never disabled),
 *  so this is not a dev-only curiosity: the same line fails the same way in
 *  production, which is exactly why it has to teach. */
export function frozenWriteMessage(raw: string, cellName?: string): string {
  const whose = cellName ? `cell '${cellName}'` : "cell state";
  return `${raw} — this is a write to ${whose}, which is frozen. ` +
    `State changes only inside a METHOD, through its own \`s\` draft: ` +
    `${cellName ? `\`${cellName}.add(…)\`` : "`myCell.add(…)`"}, never \`${
      cellName ? cellName : "myCell"
    }.items.push(…)\` from outside one. ` +
    `If you meant to read: copy first (\`[...${
      cellName ? cellName : "myCell"
    }.items]\`) — a value read out of state is the frozen object itself, ` +
    `not a snapshot.`;
}
