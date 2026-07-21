// Pure state filtering — cell field filters + patch strategy filtering
import type { CellFieldFilter } from "./cell-types.ts";
import type { Patch } from "immer";

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
      if (key in cellState) result[key] = cellState[key];
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

/** Client-read visibility of ONE state key under a cell's ui filter (TBD B7).
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
    return { hidden: true, reason: 'the cell has ui: "none"' };
  }
  if ("include" in filter) {
    return filter.include.includes(key)
      ? { hidden: false }
      : { hidden: true, reason: "the field is not in ui.include" };
  }
  if ("exclude" in filter) {
    if (filter.exclude.includes(key)) {
      return { hidden: true, reason: "the field is listed in ui.exclude" };
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
        if (ff.fields.has(seg)) kept.push(op);
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
        if (m.kind === "ancestor" && "value" in out) {
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
