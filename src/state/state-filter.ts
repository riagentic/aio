// Pure state filtering — cell field filters + patch strategy filtering
import type { CellFieldFilter } from "./cell-types.ts";
import type { Patch } from "immer";

/** Per-cell patch delivery strategy */
export type CellPatchStrategy = "raw" | "skip" | "filter" | "full";

/** Field-level filter config for "filter" strategy cells */
export type PatchFilterFields = {
  mode: "include" | "exclude";
  fields: Set<string>;
};

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
    const result = { ...cellState };
    for (const key of filter.exclude) delete result[key];
    return result;
  }
  return undefined;
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
      if (ff.mode === "include" && ff.fields.has(seg)) kept.push(op);
      if (ff.mode === "exclude" && !ff.fields.has(seg)) kept.push(op);
    }
    if (kept.length > 0) result.push({ cell: entry.cell, ops: kept });
  }
  return result;
}
