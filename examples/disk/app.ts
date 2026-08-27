// Entry — zero-config: cells self-register on import; appId, version and
// baseDir are inferred. `onStart` kicks off the first scan so the app has
// something on screen the moment it opens.
import { disk } from "./cell.ts";
import { aio } from "aio";

await aio.run({
  // No `perfBudget` here: "this method may run as long as it needs" is a fact
  // about the METHOD, so it lives on the cell as `long: ["open"]` (see
  // cell.ts). Keyed by a string in this file, nothing would follow a rename.
  onStart: () => {
    // Bounded by `ScanLimits` in disk.server.ts — a scan kicked from boot must
    // cost a known amount. An unbounded recursive walk of $HOME here saturated
    // a core for as long as the process lived, in every app AND in aio's own
    // example boot gate.
    disk.open();
  },
});
