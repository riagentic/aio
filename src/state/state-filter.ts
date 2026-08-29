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

/** Deep-remove the field at `segs` under `value`. Arrays are traversed
 *  element-wise — the intuitive reading of `"accounts.encSecKey"` when
 *  `accounts` is a list. Clones only along the removal path; untouched
 *  branches keep referential identity. */
export function deepExclude(value: unknown, segs: string[]): unknown {
  if (segs.length === 0 || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((el) => {
      const next = deepExclude(el, segs);
      if (next !== el) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  const obj = value as Record<string, unknown>;
  const head = segs[0]!;
  if (!(head in obj)) return value;
  if (segs.length === 1) {
    const { [head]: _dropped, ...kept } = obj;
    return kept;
  }
  const child = deepExclude(obj[head], segs.slice(1));
  if (child === obj[head]) return value;
  return { ...obj, [head]: child };
}

const MISSING: unique symbol = Symbol("missing");

/** The value at ONE dotted path, or MISSING. The mirror of
 *  {@linkcode deepExclude}, including its array rule: a path through an array
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
    let result: Record<string, unknown> = { ...cellState };
    for (const key of filter.exclude) {
      if (key.includes(".")) {
        result = deepExclude(result, key.split(".")) as Record<
          string,
          unknown
        >;
      } else {
        delete result[key];
      }
    }
    return result;
  }
  return undefined;
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

/** Match an Immer patch path against a deep-exclude path. Numeric op-path
 *  segments (array indices) are skipped — the exclude path names fields, not
 *  positions. */
function matchDeepPath(
  opPath: (string | number)[],
  segs: string[],
):
  | { kind: "within" } // op targets the excluded field or below → drop op
  | { kind: "ancestor"; rest: string[] } // op value CONTAINS it → strip value
  | { kind: "none" } {
  let i = 0, j = 0;
  while (i < opPath.length && j < segs.length) {
    const seg = opPath[i]!;
    if (typeof seg === "number" || /^\d+$/.test(String(seg))) {
      i++;
      continue;
    }
    if (String(seg) !== segs[j]) return { kind: "none" };
    i++;
    j++;
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
        if (ancestorRests.length === 0) continue; // a sibling path — not ours
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
      let out = op;
      let dropped = false;
      for (const segs of ff.deepExcludes ?? []) {
        const m = matchDeepPath(out.path, segs);
        if (m.kind === "within") {
          dropped = true;
          break;
        }
        // An `append` carries a string suffix: nothing excluded can be
        // inside it, so it passes as-is (a `replace` of the same ancestor
        // would carry an object and be stripped below).
        if (m.kind === "ancestor" && "value" in out && out.op !== "append") {
          // The op replaces an ancestor — its value carries the excluded
          // field. Strip it from the payload before sending.
          out = { ...out, value: deepExclude(out.value, m.rest) };
        }
      }
      if (!dropped) kept.push(out);
    }
    if (kept.length > 0) result.push({ cell: entry.cell, ops: kept });
  }
  return result;
}
