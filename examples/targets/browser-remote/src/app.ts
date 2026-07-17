// ex-browser-remote — `compile:browser:remote` target example — zero-config
// except the one behavioral choice below.
// Dev: deno task dev   Build: deno task compile
import "./cell/counter.ts";
import { aio } from "aio";

await aio.run({
  // A remote example, so it opts into auth: `key: true` = a persisted key
  // (stable across restarts). `--expose` prints a share token + a pair code
  // the aio client enters once. For per-user tokens instead:
  // users: { "change-me-token": { id: "admin", role: "admin" } },
  key: true,
});
