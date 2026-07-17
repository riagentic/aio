// ex-service — `compile:service` target example — zero-config except the one
// behavioral choice: this app has no UI (client: "server-only").
// Dev: deno task dev   Build: deno task compile
import "./cell/counter.ts";
import { aio } from "aio";

await aio.run({ client: "server-only" });
