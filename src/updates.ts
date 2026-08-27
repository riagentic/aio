// updates.ts — public entry for the built-in `updates` cell (`aio/updates`).
//
// A separate entry point on purpose. `cell()` self-registers, so re-exporting
// the cell from `mod.ts` would register it in every aio app ever written,
// including the ones that never update themselves. Importing `aio/updates` is
// the act of opting in, and it is the same act whether you do it to render a
// banner or to read the state in a test.
//
//   import { updates } from "aio/updates";
//   …
//   {updates.available && <UpdateBanner />}
import { createUpdatesCell, type UpdatesCell } from "./state/updates-cell.ts";

export {
  type ApplyOptions,
  type AvailableUpdate,
  type BlockedUpdate,
  // `CheckResult` is the return type of `updates.check()` and `CheckOptions`
  // its argument — production types, so they belong on the production entry.
  // They were reachable only from `aio/testing`, which meant an app that named
  // the type of its own `check()` call imported a TESTING entry to do it.
  // They stay exported there too: that is where a stub runtime is built.
  type CheckOptions,
  type CheckResult,
  type UpdatesCell,
  type UpdatesState,
  type UpdateStatus,
} from "./state/updates-cell.ts";

/** Drive updates YOURSELF, instead of configuring `updates:` in `aio.run()`.
 *
 *  The config covers the shapes aio knows how to verify: a directory of signed
 *  manifests, or a git ref. Some apps deliver differently — an internal
 *  artifact server with its own auth, an MDM push, a signed blob the app
 *  already syncs — and for those the whole platform half is replaceable. Supply
 *  a `check()` and an `apply()` and the rest of the feature still works: the
 *  cell state a UI binds to, the dismissal that holds across polls, `canApply`,
 *  the phase and progress reporting, and the same testability.
 *
 *  TWO THINGS TO KNOW.
 *
 *  It is exclusive with `updates:` in `aio.run()` — boot refuses rather than
 *  silently replacing your implementation with aio's.
 *
 *  And the guarantees become yours. aio's runtime is where the signature is
 *  verified against a pinned key, the download is bounded and checked against
 *  the signed digest, the data contract is measured from the artifact, and a
 *  backup is taken before a migration. A runtime that skips those installs
 *  whatever the source served. If you only need a different TRANSPORT, prefer a
 *  `source` aio can read. */
export {
  installUpdatesRuntime,
  type UpdatesRuntime,
} from "./state/updates-cell.ts";

/** The built-in `updates` cell. Created HERE, at the import of this entry —
 *  which is the opt-in act described above, unchanged. The cell module itself
 *  no longer registers on import, so the boot path can reach it with an
 *  ordinary static import instead of a dynamic one (see `createUpdatesCell`). */
export const updates: UpdatesCell = createUpdatesCell();

export type {
  CompatVerdict,
  UpdatesConfig,
  UpdatesInput,
  UpdateSourceKind,
} from "./server/updates-core.ts";
