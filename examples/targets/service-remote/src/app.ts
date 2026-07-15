// ex-service-remote — `compile:service:remote` target example
// Dev: deno task dev   Build: deno task compile
import { aio } from "aio";
import { counter } from "./cell/counter.ts";

await aio.run({
  appId: "ex-service-remote",
  appVersion: "0.1.0",
  cells: [counter],
  client: "server-only",
  baseDir: import.meta.dirname!,
  // A remote service, so it opts into auth: `key: true` = a persisted key
  // (only enforced under `--expose`; inert on localhost). `--expose` prints a
  // share token + a pair code the aio client enters once. For per-user tokens:
  // users: { "change-me-token": { id: "admin", role: "admin" } },
  key: true,
});
