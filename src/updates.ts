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
export {
  type AvailableUpdate,
  type BlockedUpdate,
  updates,
  type UpdatesCell,
  type UpdatesState,
  type UpdateStatus,
} from "./state/updates-cell.ts";

export type {
  CompatVerdict,
  UpdatesConfig,
  UpdatesInput,
  UpdateSourceKind,
} from "./server/updates-core.ts";
