// cell-persist-filter.ts — WHAT a composed app writes to its store.
//
// ONE decider for every runtime. It used to live in `src/server/
// aio-composition.ts`, so it was the SERVER's rule and nothing else's: the
// standalone/Android runtime (`src/standalone-air.ts`) stringified the whole
// composed state on every change, and a cell that declared `persist: "none"`
// — a session token, a draft, a decoded frame — was fsync'd to the phone's
// `filesDir` anyway and restored on the next launch. Measured (tests/
// standalone-persist-filter.test.ts): `persist: "none"` round-tripped intact.
//
// That is the dev==prod break this project refuses: the same app.ts, run by
// `deno task dev`, dropped the slice; packaged as an APK, it kept it. It also
// made the durable store's own advice untrue — the ">32ms save" warning in
// standalone-air.ts points the developer at `persist`, which did nothing on
// the one runtime that prints it.
//
// So the rule moved here (state/, isomorphic, dependency-light) and BOTH
// runtimes import it. Nothing is reimplemented on either side.
import type { CellFieldFilter } from "./cell-types.ts";
import type { ComposedCells } from "./cell-compose.ts";
import { applyCellFieldFilter } from "./state-filter.ts";

/** One composed cell, as this module reads it. */
type ComposedCell = ComposedCells["cells"][number];

/** A cell's persist filter, RESOLVED: what it declared (after `cellDefaults`
 *  has been applied onto it), else `"all"`. Every reader that describes or
 *  replays what the store holds — the composition report, journal replay's
 *  per-cell filter — asks this instead of restating `?? "all"`, so the default
 *  cannot drift from the one the store's own getter applies.
 *  `scripts/check-persist-decider.ts` keeps it that way.
 *
 *  @decider */
export function persistFilterOf(cell: ComposedCell): CellFieldFilter {
  return cell.__aio.persist ?? "all";
}

/** The cells whose state reaches the store at all — everything not explicitly
 *  `persist: "none"`. The write side ({@linkcode buildDBStateGetter}) and the
 *  restore side read the SAME set, so a slice that can never be written can
 *  never be restored either (a blob written by an older build, or by a
 *  downgrade, would otherwise come back into a cell that asked for none).
 *
 *  @decider */
export function persistingCellIds(composed: ComposedCells): Set<string> {
  return new Set(
    composed.cells.filter((f) => persistFilterOf(f) !== "none")
      .map((f) => f.__aio.id),
  );
}

/** Build getDBState from per-cell persist filters.
 *  Default resolution: cell.persist > cellDefaults.persist > "all".
 *  Every cell always gets an entry; "all" persists the full slice, "none" is filtered out.
 *
 *  @decider */
export function buildDBStateGetter(
  composed: ComposedCells,
): (s: unknown) => unknown {
  const cellPersistFilters = new Map<string, CellFieldFilter>();
  const cellPersistTransforms = new Map<
    string,
    (state: Record<string, unknown>) => Record<string, unknown>
  >();
  const persisting = persistingCellIds(composed);
  for (const f of composed.cells) {
    const resolved = persistFilterOf(f);
    if (persisting.has(f.__aio.id)) {
      cellPersistFilters.set(f.__aio.id, resolved);
      const t = f.__aio.persistTransform;
      if (t) cellPersistTransforms.set(f.__aio.id, t);
    }
  }
  return (s: unknown) => {
    const full = s as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [cellName, filter] of cellPersistFilters) {
      const cellState = full[cellName];
      if (!cellState || typeof cellState !== "object") continue;
      const filtered = applyCellFieldFilter(
        filter,
        cellState as Record<string, unknown>,
      );
      if (!filtered) continue;
      // `persist: { transform }` — the app SHAPES what goes to disk (report 9 §8.4).
      // AFTER include/exclude, so the two compose in the order they read.
      //
      // A THROW HERE IS NOT SWALLOWED. This runs on the persist path, and
      // "the write quietly stopped happening" is the worst outcome aio has:
      // the app keeps running on state that is not on disk. So the error is
      // re-thrown with the cell named, and the persistence layer's own
      // PERSIST_ERROR reporting carries it — the same treatment a failed
      // write gets, because it is the same failure.
      const transform = cellPersistTransforms.get(cellName);
      if (!transform) {
        result[cellName] = filtered;
        continue;
      }
      let shaped: Record<string, unknown>;
      try {
        shaped = transform(filtered);
      } catch (e) {
        throw new Error(
          `[cell:${cellName}] persist.transform threw — nothing was written ` +
            `for this cell. It runs on every persist cycle, so this will not ` +
            `resolve on its own.\n  cause: ${
              e instanceof Error ? e.message : String(e)
            }`,
          { cause: e },
        );
      }
      if (shaped === null || typeof shaped !== "object") {
        throw new Error(
          `[cell:${cellName}] persist.transform returned ${
            shaped === null ? "null" : typeof shaped
          } — it must return the OBJECT to write. Returning nothing would ` +
            `persist an empty cell, which restores as one.`,
        );
      }
      result[cellName] = shaped;
    }
    return result;
  };
}
