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

/** One-time-per-process-per-KIND notice that a value in state cannot be
 *  protected by freezing. One shared boolean used to cover Map/Set only, so
 *  the FIRST unfreezable kind seen silenced every other kind for the rest of
 *  the process. @internal — the test that proves the de-duplication resets it. */
export const _unfreezableWarned = new Set<string>();

/** Announce, once per kind, that freezing cannot protect this value — and what
 *  that costs.
 *
 *  This is not a freeze detail, it is the reason a whole class of method is
 *  silently broken: Immer does not draft a `Date`, a typed array or a class
 *  instance, so `s.when.setTime(0)` / `s.bytes[0] = 1` / `s.acct.deposit(5)`
 *  inside a SYNC method mutates the object in place, produces NO patch, and
 *  therefore commits in this process while reaching no client and no
 *  `state.db`. In-process `testCell`/`testUI` assertions still pass, which is
 *  green-test-broken-prod by construction. Freezing is what normally makes
 *  such a write throw at the site — and freezing is exactly what does not work
 *  on these values (a Date's time and a typed array's bytes live in internal
 *  slots and a typed array cannot be frozen at all), so the silence has to be
 *  broken by saying so. */
export function noteUnfreezable(
  kind: string,
  what: string,
  fix: string,
): void {
  if (_unfreezableWarned.has(kind)) return;
  _unfreezableWarned.add(kind);
  log.warn(
    `[aio] a ${what} in cell state cannot be frozen — an in-place mutation ` +
      `of it will NOT throw the way every other illegal write does, will ` +
      `commit NO patch, and so will reach no client and no state.db while ` +
      `looking correct in this process. Assign a NEW value instead of ` +
      `mutating in place (${fix}) (logged once per kind).`,
  );
}

/** Report the shapes a value LOSES on the way into async-method state.
 *
 *  The async write path clones what it installs (`ownedValue`), and cloning
 *  flattens exactly the two shapes `deepFreeze` warns about on the sync path:
 *  a class instance becomes a plain object (`s.obj.inst instanceof A` differs
 *  by the `async` keyword), and an accessor collapses to the value it happened
 *  to return. Sync warned and async said nothing at all, so the quieter half
 *  of a divergence was also the invisible one. Same notice, both paths. */
export function noteMaterialized(v: unknown): void {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return;
  const proto = Object.getPrototypeOf(v);
  if (proto !== null && proto !== Object.prototype) {
    const name =
      (proto as { constructor?: { name?: string } } | null)?.constructor
        ?.name ?? "non-plain";
    noteUnfreezable(
      name,
      `${name} instance`,
      `s.acct = { ...plain fields } — keep behaviour in methods`,
    );
    return;
  }
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
    if (d.get || d.set) {
      noteUnfreezable(
        `accessor:${k}`,
        `a get/set accessor ("${k}") — it is flattened to whatever it ` +
          `returned at write time here, and KEPT LIVE by a sync method`,
        `s.x = { ...s.x, ${k}: <the value> } — compute it in a method, not on read`,
      );
    }
  }
}

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
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
    noteUnfreezable(
      "bytes",
      "typed array / ArrayBuffer",
      "s.bytes = new Uint8Array(next)",
    );
    return obj;
  }
  // A Date freezes without complaint and is not protected by it: `setTime`,
  // `setHours` and friends write an internal slot, which `Object.freeze` does
  // not cover. Immer does not draft one either, so the mutation is invisible
  // to the patch stream as well.
  if (obj instanceof Date) {
    noteUnfreezable("Date", "Date", "s.when = new Date(next)");
    return Object.freeze(obj);
  }
  // A frozen Map/Set is a lie: `Object.freeze` seals the object's PROPERTIES
  // and leaves `set`/`add`/`delete`/`clear` fully working, so "it's frozen"
  // meant "mutation is silent" here — the opposite of what freezing is for.
  // Say so once, freeze what is reachable, and move on. (Immer's MapSet plugin
  // is not enabled either, so a Map/Set that reaches a producer already
  // throws — this is the other half of the same missing support.)
  if (obj instanceof Map || obj instanceof Set) {
    const kind = obj instanceof Map ? "Map" : "Set";
    noteUnfreezable(
      kind,
      `${kind} (JS freezing does not cover set/add/delete/clear, and Immer's ` +
        `MapSet plugin is not enabled)`,
      kind === "Map"
        ? "s.byId = { ...s.byId, [k]: v } on a plain object"
        : "s.tags = [...s.tags, t] on a plain array",
    );
    for (const v of obj.values()) {
      if (v !== null && typeof v === "object") deepFreeze(v, seen);
    }
    return obj;
  }
  // A class instance DOES freeze, and freezing protects only what it can see:
  // its own enumerable properties. Private fields (`#balance`) and internal
  // slots stay writable, its methods keep mutating them, and Immer never
  // drafted the instance — so `s.acct.deposit(5)` is a committed, patch-less,
  // client-invisible change that a frozen plain object would have refused.
  // Arrays and null-prototype bags are the only other prototypes state
  // legitimately carries.
  if (!Array.isArray(obj)) {
    const proto = Object.getPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype) {
      const name =
        (proto as { constructor?: { name?: string } } | null)?.constructor
          ?.name ?? "non-plain";
      noteUnfreezable(
        name,
        `${name} instance`,
        `s.acct = { ...plain fields } — keep behaviour in methods`,
      );
    }
  }
  // An ACCESSOR is the one shape here that survives freezing AND keeps
  // changing. `Object.freeze` makes the property non-configurable and leaves
  // the getter in place, so `Object.isFrozen(state)` is true while every read
  // returns a different value — committed state that changes with no write, no
  // patch and no broadcast, so what a client receives depends on when
  // serialization happened. Measured: `JSON.stringify` of the same committed
  // slice, twice, gave `{"live":11}` then `{"live":12}`.
  //
  // It is also the one shape `deepFreeze` did not name, while enumerating
  // typed arrays, Dates, Maps/Sets and class instances by name directly above
  // — a checker silent about exactly the case it cannot handle. (The async
  // path materializes accessors away via `cloneState`, so the same method body
  // commits a different KIND of state depending on the `async` keyword; making
  // the two agree is a compat break and is deliberately NOT done here.)
  //
  // Reading through `getOwnPropertyDescriptors` rather than `Object.values`:
  // asking for the VALUE would invoke the getter, which is the side effect
  // being reported.
  for (
    const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(obj))
  ) {
    if (d.get || d.set) {
      noteUnfreezable(
        `accessor:${k}`,
        `a get/set accessor ("${k}") — freezing keeps it, so committed state ` +
          `changes with no write, no patch and no broadcast`,
        `s.x = { ...s.x, ${k}: <the value> } — compute it in a method, not on read`,
      );
    }
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
