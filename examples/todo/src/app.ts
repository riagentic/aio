// Entry — cells self-register on import.
//
// `theme: "auto"` opts into aio's default look (it styles the semantic HTML
// and the card / row / stack / badge classes the UI uses) until you write
// `src/style.css`, at which point every visual default steps aside.
import "./cell.ts";
import { aio } from "aio";

export type { Filter, Todo } from "./cell.ts";

await aio.run({
  ui: { theme: "auto" },
  // The safe values, written out. aio's own defaults stay what they were, so
  // an app from an older aio upgrades with no change in behaviour — a new one
  // starts closed. Delete a line to get the default back.
  //
  // ignoreDebugEnv: as a desktop app, an AIO_CDP or AIO_PORT left in the
  //   environment by another app opens no DevTools port and no TCP port here.
  //   Typed for one launch, --cdp and --port still do.
  // strictPin: a remote client (--server-url) REFUSES a paired server whose
  //   certificate changed, until it is paired again by PIN. (Without it the
  //   server is asked to prove it holds the app's key first — and one too
  //   old to answer is still sent the key.) A packaged client reads the same
  //   switch from deno.json, "build": { "strictPin": true } — written there.
  electron: { ignoreDebugEnv: true, strictPin: true },
  // refuseShortCalls: a hand-written client that states no argument list for
  //   a method that takes arguments is refused, not run with undefined.
  wire: { refuseShortCalls: true },
});
