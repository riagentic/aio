// ex-service-remote — `compile:service:remote` target example — zero-config
// except the two behavioral choices below.
// Dev: deno task dev   Build: deno task compile
import "./cell/counter.ts";
import { aio } from "aio";

await aio.run({
  client: "server-only",
  // A remote service, so it opts into auth: `key: true` = a persisted key
  // (only enforced under `--expose`; inert on localhost). `--expose` prints a
  // share token + a pair code the aio client enters once. For per-user tokens:
  // users: { "change-me-token": { id: "admin", role: "admin" } },
  key: true,
});
