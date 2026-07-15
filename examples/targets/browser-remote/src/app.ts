// ex-browser-remote — `compile:browser:remote` target example
// Dev: deno task dev   Build: deno task compile
import { aio } from "aio";
import { counter } from "./cell/counter.ts";

await aio.run({
  appId: "ex-browser-remote",
  appVersion: "0.1.0",
  cells: [counter],
  ui: { title: "ex-browser-remote" },
  baseDir: import.meta.dirname!,
  // A remote example, so it opts into auth: `key: true` = a persisted key
  // (stable across restarts). `--expose` prints a share token + a pair code
  // the aio client enters once. For per-user tokens instead:
  // users: { "change-me-token": { id: "admin", role: "admin" } },
  key: true,
});
