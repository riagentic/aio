// Pure state filtering — cell field filters + patch strategy filtering
import type { CellFieldFilter } from "./cell-types.ts";
import type { WirePatch as Patch } from "../protocol/patch-ops.ts";

/** Per-cell patch delivery strategy */
export type CellPatchStrategy = "raw" | "skip" | "filter" | "full";

/** Field-level filter config for "filter" strategy cells */
export type PatchFilterFields = {
  mode: "include" | "exclude";
  fields: Set<string>;
  /** Parsed dot-path excludes (`"accounts.encSecKey"` → ["accounts",
   *  "encSecKey"]) — removed everywhere under the head field, traversing
   *  arrays element-wise. Exclude mode only. */
  deepExcludes?: string[][];
  /** Parsed dot-path INCLUDES (`"profile.name"` → ["profile", "name"]).
   *  Include mode only, and the mirror of `deepExcludes`.
   *
   *  Without it, `fields` held the literal string `"profile.name"` while the
   *  patch filter compared it against the first path SEGMENT (`"profile"`) —
   *  never equal, so every patch for that cell was dropped. It failed closed
   *  (nothing leaked) and it failed SILENTLY: the field arrived once in the
   *  full-state frame and then never moved again, so an included field looked
   *  like a broken one. `applyCellFieldFilter` had already learned dot paths
   *  on both sides; this is the patch path learning the same spelling. */
  deepIncludes?: string[][];
};

// ── The ONE deep-exclude rule ──────────────────────────────────────────────
//
// `visible: { exclude: ["accounts.encSecKey"] }` has FOUR deciders — the wire
// filter, the patch path, the client read seam (cell-reactive), the `am
// surface` view — plus `restoreExcluded` on the persistence read-back. Four
// hand-written copies of one traversal is how a leak survives: each was
// individually plausible and they disagreed. They all call this walker now,
// and the two seam-specific bits (a refusing tripwire, a memo) are hooks.
//
// THE RULE, at one object node, for one path whose head is `h`:
//   1. If the node HAS `h` as an OWN property, the literal reading applies —
//      drop it (last segment) or descend into it with the tail.
//   2. AND the container reading applies to every REMAINING key: a
//      records-by-id map is the most ordinary state shape there is, so
//      `accounts.encSecKey` must also mean "`encSecKey` under each record".
//
// Both, always — that is the deliberate part. Doing (2) only when `h` was
// ABSENT (the rule until this fix) made the filter switchable from the
// OUTSIDE: record ids are user-controlled (usernames, slugs), so registering
// an account literally named `encSecKey` made `head in obj` true, took the
// literal branch, and broadcast every OTHER account's key — on the full frame,
// the patch path, the client read seam and the restore. When a name is
// ambiguous the only safe answer is to remove BOTH readings.
//
// `Object.hasOwn`, never `in`: `in` walks the PROTOTYPE CHAIN, so
// `"constructor" in obj` / `"__proto__" in obj` / `"toString"` / `"valueOf"`
// are true for every plain object — excluding `a.constructor` took the literal
// branch on an object that has no such own field and removed nothing anywhere.

/** Where one exclude path has got to at the current node. */
type Cursor = { readonly path: readonly string[]; readonly d: number };
/** A cursor set plus its memo key (computed once, reused down the walk). */
type Active = { readonly cur: readonly Cursor[]; readonly key: string };

/** Install a refusing stand-in for the dropped leaf. Called only on objects
 *  this walk BUILT (never on frozen app state), and only when the node
 *  actually changed — see `deepExcludePaths`. */
export type ExcludeTripwire = (
  obj: Record<string, unknown>,
  head: string,
  path: readonly string[],
) => void;

export type DeepExcludeOptions = {
  tripwire?: ExcludeTripwire;
  /** Per-cursor-set memo, source value → filtered view. State is immutable
   *  (Immer autoFreeze), so same source ⇒ same view is exact. Pass a shared
   *  Map to keep view identity stable across reads (the client seam). */
  memos?: Map<string, WeakMap<object, unknown>>;
};

/** `obj[k] = v` — except for `__proto__`, where plain assignment would hit
 *  `Object.prototype`'s setter and set the PROTOTYPE instead of creating the
 *  own property, silently dropping the key from the rebuilt object. */
function setKey(
  obj: Record<string, unknown>,
  k: string,
  v: unknown,
): void {
  if (k === "__proto__") {
    Object.defineProperty(obj, k, {
      value: v,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else obj[k] = v;
}

const cursorKey = (cur: readonly Cursor[]): string =>
  cur.map((c) => `${c.d}:${c.path.join(".")}`).sort().join("|");

/** Deep-remove every field named by `paths` under `value`, in ONE pass.
 *
 *  One pass and not one call per path on purpose: each pass rebuilds objects
 *  with a spread, which copies own ENUMERABLE properties only — so a second
 *  pass silently dropped the first pass's non-enumerable tripwire and
 *  `["a.b", "a.c"]` left `a.b` reading as a clean `undefined` while `a.c`
 *  refused. "undefined as data" is the exact trap this seam exists to close.
 *
 *  Arrays are traversed element-wise (an index never consumes a segment).
 *  Clones only along changed branches; an untouched branch — including a
 *  Date/Map/Set/TypedArray, which has no own enumerable keys to walk — keeps
 *  its identity and its value. */
export function deepExcludePaths(
  value: unknown,
  paths: readonly (readonly string[])[],
  opts: DeepExcludeOptions = {},
): unknown {
  const live = paths.filter((p) => p.length > 0);
  if (live.length === 0) return value;
  const { tripwire, memos } = opts;
  const cur = live.map((path) => ({ path, d: 0 }));

  const walk = (v: unknown, act: Active): unknown => {
    if (v === null || typeof v !== "object") return v;
    const memo = memos
      ? memos.get(act.key) ??
        (() => {
          const m = new WeakMap<object, unknown>();
          memos.set(act.key, m);
          return m;
        })()
      : undefined;
    // `build` never answers `undefined` (an object, or the source itself), so
    // a miss and a memoized `undefined` cannot be confused.
    const hit = memo?.get(v as object);
    if (hit !== undefined) return hit;
    const out = build(v as object, act);
    memo?.set(v as object, out);
    return out;
  };

  const build = (v: object, act: Active): unknown => {
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((el) => {
        const next = walk(el, act);
        if (next !== el) changed = true;
        return next;
      });
      return changed ? out : v;
    }
    const obj = v as Record<string, unknown>;
    let changed = false;
    const out: Record<string, unknown> = {};
    // One derived cursor set per MATCHING key; every other key is a plain
    // record and reuses the parent's set (and its memo key) untouched.
    let derived: Map<string, Active> | undefined;
    for (const k of Object.keys(obj)) {
      let matched = false;
      let drop = false;
      for (const c of act.cur) {
        if (c.path[c.d] !== k) continue;
        matched = true;
        // The literal path ends here: the field goes, whatever else any other
        // path would have done under it.
        if (c.d === c.path.length - 1) drop = true;
      }
      if (drop) {
        changed = true;
        continue;
      }
      let next: unknown;
      if (!matched) {
        next = walk(obj[k], act);
      } else {
        derived ??= new Map();
        let child = derived.get(k);
        if (!child) {
          const cc = act.cur.map((c) =>
            c.path[c.d] === k ? { path: c.path, d: c.d + 1 } : c
          );
          child = { cur: cc, key: memos ? cursorKey(cc) : "" };
          derived.set(k, child);
        }
        next = walk(obj[k], child);
      }
      if (next !== obj[k]) changed = true;
      setKey(out, k, next);
    }
    const leaves = tripwire
      ? act.cur.filter((c) => c.d === c.path.length - 1)
      : [];
    if (!changed) {
      // Nothing under here was excluded. Hand back the SOURCE — a rebuilt `{}`
      // would turn a Date/Map/Set/TypedArray (no own enumerable keys to walk)
      // into an empty object on this seam while the wire kept the value.
      //
      // The one exception is a PLAIN object on a seam that reports: the
      // refusing getter has to go somewhere, and committed state is frozen
      // (Immer autoFreeze), so it goes on a copy. The copy is value-identical
      // — the wire's frame and this view still serialize the same — and the
      // wire filter itself never takes this branch (no tripwire, no copy).
      // Without it the field the WIRE already removed reads back as a clean
      // `undefined` here, which is the trap this seam exists to close.
      const proto = leaves.length > 0 ? Object.getPrototypeOf(obj) : false;
      if (proto !== Object.prototype && proto !== null) return v;
    }
    for (const c of leaves) tripwire!(out, c.path[c.d]!, c.path);
    return out;
  };

  return walk(value, { cur, key: memos ? cursorKey(cur) : "" });
}

/** One cell slice with what a dot-path exclude keeps OUT of the store put back
 *  to its boot value (or removed, where boot had none) — the mirror of
 *  {@linkcode deepExcludePaths}, walking the same shape by the same rule:
 *  the own head is restored literally AND every remaining key is walked as a
 *  record. A head boot HAS but the replay does not means a replayed action
 *  deleted the field, and a clean restart would fill boot's value back in
 *  (restore merges over the declared shape), so this does too. Clones only
 *  along the changed path. */
export function restoreExcluded(
  now: unknown,
  was: unknown,
  segs: readonly string[],
): unknown {
  if (segs.length === 0 || now === null || typeof now !== "object") return now;
  if (Array.isArray(now)) {
    let changed = false;
    const out = now.map((el, i) => {
      const next = restoreExcluded(
        el,
        Array.isArray(was) ? was[i] : undefined,
        segs,
      );
      if (next !== el) changed = true;
      return next;
    });
    return changed ? out : now;
  }
  const obj = now as Record<string, unknown>;
  const base = was !== null && typeof was === "object" && !Array.isArray(was)
    ? was as Record<string, unknown>
    : undefined;
  const head = segs[0]!;
  const leaf = segs.length === 1;
  const keys = new Set(Object.keys(obj));
  // Boot has the field and the replay dropped it — put it back where it was.
  if (leaf && base && Object.hasOwn(base, head)) keys.add(head);
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k === head) {
      if (leaf) {
        if (base && Object.hasOwn(base, head)) {
          if (!Object.hasOwn(obj, head) || obj[head] !== base[head]) {
            changed = true;
          }
          setKey(out, head, base[head]);
        } else changed = true; // boot had none → the field goes
        continue;
      }
      if (!Object.hasOwn(obj, head)) continue; // no branch to restore under
      const child = restoreExcluded(obj[head], base?.[head], segs.slice(1));
      if (child !== obj[head]) changed = true;
      setKey(out, head, child);
      continue;
    }
    const next = restoreExcluded(obj[k], base?.[k], segs);
    if (next !== obj[k]) changed = true;
    setKey(out, k, next);
  }
  return changed ? out : now;
}

const MISSING: unique symbol = Symbol("missing");

/** The value at ONE dotted path, or MISSING. The mirror of
 *  {@linkcode deepExcludePaths}, including its array rule: a path through an array
 *  applies to EVERY element (`rows.name` keeps `name` from each row), so
 *  `include` and `exclude` read the same spelling the same way. An element
 *  without the path becomes `{}` — the array keeps its shape and indices. */
function pickPath(src: unknown, segs: string[]): unknown {
  if (segs.length === 0) return src;
  if (src === null || typeof src !== "object") return MISSING;
  if (Array.isArray(src)) {
    // AN ARRAY ALWAYS PROJECTS TO AN ARRAY OF THE SAME LENGTH — including an
    // empty one, and including one whose elements all lack the path.
    //
    // Returning MISSING there dropped the key entirely, and the array's
    // LENGTH is load-bearing twice over: a component reads `state.rows.map`
    // (undefined, not `[]`, on a cell whose list starts empty), and the delta
    // path keeps sending index ops for it — so the first `add rows[0]` after
    // an empty start could not resolve against a projection with no `rows`,
    // and the client had to fall back to a full resync to recover. The mixed
    // case already produced `{}` per element for exactly this reason; this is
    // the all-or-nothing case reading the same way.
    //
    // Found by `scripts/audit-round.ts 28`, which patches the projected
    // previous state and compares it with the projected next state.
    const out = src.map((el) => pickPath(el, segs));
    return out.map((v) => (v === MISSING ? {} : v));
  }
  const [head, ...rest] = segs;
  const from = src as Record<string, unknown>;
  if (head === undefined || !(head in from)) return MISSING;
  const picked = pickPath(from[head], rest);
  return picked === MISSING ? MISSING : { [head]: picked };
}

/** Merge one picked branch into the projection so `["profile.name",
 *  "profile.email"]` yields one `profile` with both, and `["rows.a", "rows.b"]`
 *  one array whose elements carry both. */
function mergePicked(dst: unknown, add: unknown): unknown {
  if (Array.isArray(dst) && Array.isArray(add) && dst.length === add.length) {
    return dst.map((d, i) => mergePicked(d, add[i]));
  }
  const obj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (obj(dst) && obj(add)) {
    const out: Record<string, unknown> = { ...dst };
    for (const k of Object.keys(add)) out[k] = mergePicked(out[k], add[k]);
    return out;
  }
  return add;
}

/** Apply a CellFieldFilter to a cell's state slice — returns filtered object or undefined if "none" */
export function applyCellFieldFilter(
  filter: CellFieldFilter | undefined,
  cellState: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!filter || filter === "none") return undefined;
  if (filter === "all") return cellState;
  if ("include" in filter) {
    const result: Record<string, unknown> = {};
    for (const key of filter.include) {
      // Dot paths work on BOTH sides. They used to work only on `exclude`, so
      // `include: ["profile.name"]` silently produced nothing at all — the
      // field was hidden, which fails closed (good) and says nothing (not
      // good). Same spelling, same meaning, either way round.
      if (key.includes(".")) {
        const picked = pickPath(cellState, key.split("."));
        if (picked === MISSING) continue; // not there — invent nothing
        for (
          const [k, v] of Object.entries(picked as Record<string, unknown>)
        ) {
          result[k] = mergePicked(result[k], v);
        }
      } else if (key in cellState) {
        result[key] = cellState[key];
      }
    }
    return result;
  }
  if ("exclude" in filter) {
    const result: Record<string, unknown> = { ...cellState };
    const deep: string[][] = [];
    for (const key of filter.exclude) {
      // BOTH READINGS of a dotted entry, exactly as `deepExcludePaths` takes
      // both readings of an ambiguous name: the path a → b, AND a top-level
      // key literally CALLED "a.b". The literal one is not hypothetical — the
      // client read seam (`uiKeyVisibility`), the `am surface` view and the
      // trojan `fields` badge all matched the key string and answered
      // "hidden", while this frame and the delta path read only the path and
      // broadcast the value: the field sat in the client's own state and
      // refused to be read by the component that owns it.
      delete result[key];
      if (key.includes(".")) deep.push(key.split("."));
    }
    // ONE pass over all dot paths — the same call the client seam makes, so
    // the two cannot drift.
    return deepExcludePaths(result, deep) as Record<string, unknown>;
  }
  return undefined;
}

/** What a cell's filter leaves of a value known to live at `segs` INSIDE the
 *  cell's slice — `["seeds", "0", "encSeed"]` for a timeline diff leaf, say.
 *
 *  `{ hidden: true }` ⇒ the filter removes the value itself (nothing of it may
 *  be shown); otherwise `value` is what survives, with anything the filter
 *  excludes BELOW that point removed — a whole row keeps its label and loses
 *  its ciphertext.
 *
 *  It is the same reading as the full frame, and provably so: the path is
 *  re-nested into a slice-shaped object and run through
 *  {@linkcode applyCellFieldFilter}, so there is no second traversal to drift.
 *
 *  A path segment says nothing about the CONTAINER it indexes — `"0"` is an
 *  array index in `{ rows: [ … ] }` and an ordinary key in a records-by-id map
 *  keyed `"0"`, and a timeline path (`DiffEntry.segments`, built with
 *  `Object.keys`) spells both the same way. The two readings do not agree:
 *  the full frame projects an ARRAY element-wise, so `include: ["rows.0"]`
 *  leaves `[{}, {}]` there, while the object reading hands back row 0 whole —
 *  a value the client never receives. Ambiguous ⇒ BOTH readings apply, the
 *  same answer `deepExcludePaths` gives a key that is both a literal field and
 *  a record id: the value is screened through each in turn, so what comes out
 *  is never more than either would have shown. */
export function visibleValueAt(
  filter: CellFieldFilter | undefined,
  segs: readonly string[],
  value: unknown,
): { hidden: true } | { hidden: false; value: unknown } {
  if (!filter || filter === "all") return { hidden: false, value };
  if (filter === "none") return { hidden: true };
  // An index-like segment is the ambiguous case; anything else nests one way.
  const ambiguous = segs.some((s) => /^(0|[1-9][0-9]*)$/.test(s));
  let cur = value;
  for (const asArray of ambiguous ? [false, true] : [false]) {
    const seen = _visibleValueAt1(filter, segs, cur, asArray);
    if (seen.hidden) return seen;
    cur = seen.value;
  }
  return { hidden: false, value: cur };
}

/** One reading of {@linkcode visibleValueAt} — `asArray` nests an index-like
 *  segment as a one-element ARRAY (what the wire walks element-wise) instead
 *  of as an object key. */
function _visibleValueAt1(
  filter: Exclude<CellFieldFilter, "all" | "none">,
  segs: readonly string[],
  value: unknown,
  asArray: boolean,
): { hidden: true } | { hidden: false; value: unknown } {
  if (segs.length === 0) {
    // The leaf IS the whole slice (a root replacement). A slice that is not a
    // plain object has no fields to name: an `exclude` removes nothing from it
    // (and must not turn `undefined` into `{}`, or a report would show a cell
    // arriving where one vanished), while an `include` finds nothing in it and
    // so shows nothing — the closed direction, which is the right one here.
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return "include" in filter ? { hidden: true } : { hidden: false, value };
    }
    const projected = applyCellFieldFilter(
      filter,
      value as Record<string, unknown>,
    );
    return projected === undefined
      ? { hidden: true }
      : { hidden: false, value: projected };
  }
  let nested: unknown = value;
  // The key to read back at each level — `"0"`, not the real index, wherever
  // a segment was nested as a one-element array. The POSITION cannot matter:
  // both walkers treat every element of an array alike, so one element stands
  // in for index 9999 at a ten-thousandth of the allocation.
  const read: string[] = [...segs];
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i]!;
    // The head segment is a key of the cell SLICE, which is always an object.
    if (asArray && i > 0 && /^(0|[1-9][0-9]*)$/.test(seg)) {
      nested = [nested];
      read[i] = "0";
    } else nested = { [seg]: nested };
  }
  let cur = applyCellFieldFilter(filter, nested as Record<string, unknown>);
  for (const seg of read) {
    if (
      cur === null || typeof cur !== "object" ||
      !Object.hasOwn(cur as Record<string, unknown>, seg)
    ) {
      // The projection dropped the path on the way down — the field is hidden.
      return { hidden: true };
    }
    cur = (cur as Record<string, unknown>)[seg] as Record<string, unknown>;
  }
  return { hidden: false, value: cur };
}

/** Client-read visibility of ONE state key under a cell's visibility filter.
 *
 *  The `reason` strings name the key the APP AUTHOR writes — `visible:`, which
 *  is what `ui:` was renamed to in alpha52. They said `ui.exclude` for three
 *  releases after the rename, so the best error message in the framework sent
 *  people grepping their own code for a key that is not in it.
 *  Used by the client read seam (bindCellReactive) so `ui:` visibility holds
 *  on the cell object itself — not just at broadcast time. In standalone/
 *  electron there is no broadcast to filter, so without this the "secret"
 *  guarantee silently didn't exist there.
 *   - hidden        → reads must return undefined (with a loud one-time warn)
 *   - deepSegs      → sub-paths to strip from the read value (dot-path
 *                     excludes like "accounts.encSecKey"), relative to key */
export function uiKeyVisibility(
  filter: CellFieldFilter | undefined,
  key: string,
): { hidden: boolean; reason?: string; deepSegs?: string[][] } {
  if (!filter || filter === "all") return { hidden: false };
  if (filter === "none") {
    return { hidden: true, reason: 'the cell declares visible: "none"' };
  }
  if ("include" in filter) {
    return filter.include.includes(key)
      ? { hidden: false }
      : { hidden: true, reason: "the field is not in visible.include" };
  }
  if ("exclude" in filter) {
    if (filter.exclude.includes(key)) {
      return { hidden: true, reason: "the field is listed in visible.exclude" };
    }
    const deepSegs = filter.exclude
      .filter((p) => p.includes(".") && p.split(".")[0] === key)
      .map((p) => p.split(".").slice(1));
    if (deepSegs.length > 0) return { hidden: false, deepSegs };
  }
  return { hidden: false };
}

/** Match an Immer patch path against a deep-exclude path — the delta path's
 *  reading of THE RULE above, and it has to be the same reading: the full
 *  frame and the patches that follow it build the same client projection.
 *
 *  So: the exclude segments must appear in the op path in order, and any
 *  other op segment is a record id or an array index that consumes nothing —
 *  exactly what `deepExcludePaths` does when a key does not match the head.
 *  Matching only AFTER the first segment had matched (the rule until this
 *  fix) said `exclude: ["a.b"]` ignores a patch at `["x","a","b"]` while the
 *  full frame strips `x.a.b` from the same state: the field arrived on the
 *  very next delta.
 *
 *  A NUMBER is an Immer array index and never consumes a segment; a numeric
 *  STRING is an ordinary object key (a records-by-id map keyed "7") and reads
 *  like any other — it used to be skipped unconditionally, so `exclude:
 *  ["a.0"]` could not drop the patch that carried `a.0`. */
function matchDeepPath(
  opPath: (string | number)[],
  segs: string[],
):
  | { kind: "within" } // op targets the excluded field or below → drop op
  | { kind: "ancestor"; rest: string[] } { // op value CONTAINS it → strip value
  let j = 0;
  for (let i = 0; i < opPath.length && j < segs.length; i++) {
    const seg = opPath[i]!;
    if (typeof seg !== "number" && seg === segs[j]) j++;
  }
  if (j === segs.length) return { kind: "within" };
  return { kind: "ancestor", rest: segs.slice(j) };
}

/** Filter patch entries per-cell based on strategy map.
 *  Returns undefined → full-state fallback needed,
 *  [] → nothing to send, PatchEntry[] → filtered patches.
 *
 *  "full" strategy cells (those with uiForUser transforms) trigger a full-state
 *  fallback for the entire broadcast. This is intentional: per-user transforms
 *  need the complete cell state, and the broadcast protocol sends one payload
 *  per client — mixing patches with full-state per-cell is not supported. */
export function filterPatchesByStrategy(
  patches: { cell: string; ops: Patch[] }[],
  strategies: Map<string, CellPatchStrategy>,
  filterFields: Map<string, PatchFilterFields>,
): { cell: string; ops: Patch[] }[] | undefined {
  // Pass 1: any patch targeting a "full" strategy cell -> full fallback
  for (const entry of patches) {
    if (strategies.get(entry.cell) === "full") return undefined;
  }
  // Pass 2: filter per-cell
  const result: { cell: string; ops: Patch[] }[] = [];
  for (const entry of patches) {
    const strategy = strategies.get(entry.cell);
    if (strategy === undefined) return undefined; // unknown cell -> safety fallback
    if (strategy === "skip") continue;
    if (strategy === "raw") {
      result.push(entry);
      continue;
    }
    // strategy === "filter"
    const ff = filterFields.get(entry.cell);
    if (!ff) return undefined; // filter strategy but no field config -> safety
    // The LITERAL reading of each dotted exclude — a top-level key called
    // "a.b", which the frame drops (`applyCellFieldFilter`). Computed once per
    // cell, not once per op: this is the delta path.
    const literalDrops = ff.mode === "exclude" && ff.deepExcludes
      ? new Set(ff.deepExcludes.map((segs) => segs.join(".")))
      : undefined;
    const kept: Patch[] = [];
    for (const op of entry.ops) {
      if (op.path.length === 0) return undefined; // root replacement -> full fallback
      const seg = String(op.path[0]);
      if (ff.mode === "include") {
        // The whole top-level field is included — nothing to project.
        if (ff.fields.has(seg)) {
          kept.push(op);
          continue;
        }
        const deeps = (ff.deepIncludes ?? []).filter((segs) => segs[0] === seg);
        if (deeps.length === 0) continue; // field not included at all
        let within = false;
        const ancestorRests: string[][] = [];
        for (const segs of deeps) {
          const m = matchDeepPath(op.path, segs);
          if (m.kind === "within") {
            within = true;
            break;
          }
          if (m.kind === "ancestor") ancestorRests.push(m.rest);
        }
        // The op targets the included path or something under it — send it.
        if (within) {
          kept.push(op);
          continue;
        }
        // The op replaces/removes an ANCESTOR of an included path. A remove
        // carries no data, so it passes through as-is (the client must drop
        // the branch too). A replacement carries the whole ancestor value, so
        // only the included sub-branches of it are sent.
        if (!("value" in op)) {
          kept.push(op);
          continue;
        }
        // An `append` extends a STRING at an ancestor of the included path —
        // a string has no sub-branch to include, so (exactly like a `replace`
        // whose value lacks the included path) nothing survives projection.
        if (op.op === "append") continue;
        let projected: unknown = MISSING;
        for (const rest of ancestorRests) {
          const picked = pickPath((op as { value: unknown }).value, rest);
          if (picked === MISSING) continue;
          projected = projected === MISSING
            ? picked
            : mergePicked(projected, picked);
        }
        // Nothing included survives in this value — the client's projection is
        // unchanged by it, so there is nothing to send.
        if (projected !== MISSING) kept.push({ ...op, value: projected });
        continue;
      }
      // exclude mode: top-level drop, then deep-path handling
      if (ff.fields.has(seg)) continue;
      // …and the literal reading of a DOTTED entry: a top-level key called
      // "a.b" is dropped from the frame, so no op at it — or under it — may
      // ride in behind the frame's back. An op path's first segment is always
      // a top-level key, so an exact match is the whole rule.
      if (literalDrops?.has(seg)) continue;
      let out = op;
      let dropped = false;
      // ONE pass over all the paths whose tail can still be inside this op's
      // value, so the payload is filtered exactly as the full frame is.
      const rests: string[][] = [];
      for (const segs of ff.deepExcludes ?? []) {
        const m = matchDeepPath(op.path, segs);
        if (m.kind === "within") {
          dropped = true;
          break;
        }
        rests.push(m.rest);
      }
      // An `append` carries a string suffix: nothing excluded can be inside
      // it, so it passes as-is (a `replace` of the same ancestor would carry
      // an object and be stripped here).
      if (!dropped && rests.length > 0 && "value" in op && op.op !== "append") {
        const value = deepExcludePaths(op.value, rests);
        if (value !== op.value) out = { ...op, value };
      }
      if (!dropped) kept.push(out);
    }
    if (kept.length > 0) result.push({ cell: entry.cell, ops: kept });
  }
  return result;
}
