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
  type AvailableUpdate,
  type BlockedUpdate,
  type UpdatesCell,
  type UpdatesState,
  type UpdateStatus,
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
