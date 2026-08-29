// boot-refusals.ts — the in-process harnesses' half of `aio.run()`'s boot gate.
//
// `testUI`/`bootCells` do NOT boot through `aio.run()`: they compose the cells
// on the standalone runtime, so none of the composition refusals ran under
// them. A cell holding `apiKey` booted GREEN in the harness and was REFUSED the
// moment the app actually started — in dev AND in prod. A whole app could be
// built green against the harness the docs push hardest and then not start.
//
// This module exists SEPARATELY from `test-strict.ts` for one structural
// reason: `aio/renderer` (src/browser-air.ts) re-exports `testComponent`, which
// imports `test-strict.ts` — so a server import there lands in every browser
// bundle and the bundler refuses the build. Only `cell-test.ts` and
// `ui-test.ts` import THIS file, and neither is in the browser graph.
// `check:boundaries` cannot enforce that (root files have unrestricted reach),
// so it is stated here and in `test-strict.ts`, beside both import lists.

import {
  applyCellDefaults,
  applyLocalFirst,
  type CellDefaults,
} from "../state/cell-defaults.ts";
import { composeCells } from "../state/cell-compose.ts";
import { refuseUnsafeComposition } from "../server/aio-composition.ts";
import type { CellDef, CellEntry } from "../state/cell-types.ts";

/** Run EVERY boot refusal `aio.run()` runs, against the cells a harness is
 *  about to boot in-process — a credential exposed to the UI, a filtered sync
 *  cell, access escalation through `listensTo`, an unknown selector dep.
 *
 *  Composition here is a throwaway pass whose only product is the refusal:
 *  `composeCells` is pure over the defs, so the runtime composes its own
 *  moments later exactly as before.
 *
 *  Client-scoped cells are dropped, exactly as `composeCellsWiring` drops them:
 *  they never reach the server's broadcast, so refusing one here would be a
 *  harness-only failure for code production accepts — strictness must mirror a
 *  real boot, not invent a rule of its own.
 *  @internal */
export function _refuseUnsafeCells(
  cells: readonly CellEntry[],
  opts: HarnessBootOptions = {},
): void {
  const serverScoped = cells.filter((entry) => {
    const def =
      ("__aio" in entry ? entry : (entry as { cell: CellDef }).cell) as
        | CellDef
        | undefined;
    return def?.__aio?.scope !== "client";
  });
  if (serverScoped.length === 0) return; // nothing to refuse; composeCells would warn
  const composed = composeCells(serverScoped, { perfCheck: false });
  // The SAME two passes `aio.run` makes before it refuses: both change what a
  // cell hides and whether it syncs, and the contradiction is only decidable
  // once they have run. Without them an app whose only contradiction came
  // from its app-level defaults was green here and refused at boot.
  applyCellDefaults(composed, opts.cellDefaults);
  applyLocalFirst(composed, opts.localFirst === true);
  refuseUnsafeComposition(composed);
}

/** The app-level composition options a harness has to honour to boot the
 *  cells the way `aio.run({ cellDefaults, localFirst })` does. */
export type HarnessBootOptions = {
  cellDefaults?: CellDefaults;
  localFirst?: boolean;
  /** The app's `aio.run({ perfBudget })`.
   *
   *  The harness boots the cells directly and never sees `aio.run()`'s config,
   *  so every budget was the DEFAULT — and a method the app had already
   *  budgeted at 60 ms tripped the 5 ms default on every run, with a warning
   *  recommending the exact override the app applied months ago:
   *
   *      WARN [BUDGET_EFFECT] dm effect exceeded budget: 15.2ms > 5ms …
   *      Raise the budget for THIS method only:
   *      perfBudget: { methods: { "dm:createIdentity": { effect: 40 } } }
   *
   *  The cost is not the line. It is that a suite printing known-false
   *  warnings on every run teaches everyone to skim past the real ones. Pass
   *  the same object the app passes, and the harness measures what production
   *  measures. */
  perfBudget?: import("../state/dispatch.ts").PerfBudget;
};
