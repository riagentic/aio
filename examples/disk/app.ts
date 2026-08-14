// Entry — zero-config: cells self-register on import; appId, version and
// baseDir are inferred. `onStart` kicks off the first scan so the app has
// something on screen the moment it opens.
import { disk } from "./cell.ts";
import { aio } from "aio";

await aio.run({
  // A filesystem walk is long-running by nature — don't let the framework's
  // 30s call ceiling cut it off (docs/state/methods.md#long-running-server-work).
  perfBudget: { methods: { "disk:open": { timeout: 0 } } },
  onStart: () => {
    disk.open();
  },
});
