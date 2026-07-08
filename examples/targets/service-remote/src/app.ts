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
  // Exposed servers (--expose) authenticate — uncomment to pin tokens:
  // users: { "change-me-token": { id: "admin", role: "admin" } },
});
