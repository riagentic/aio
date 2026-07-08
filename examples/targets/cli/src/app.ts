// ex-cli — `compile:cli` target example
// Dev: deno task dev   Build: deno task compile
import { aio } from "aio";
import { counter } from "./cell/counter.ts";

await aio.run({
  appId: "ex-cli",
  appVersion: "0.1.0",
  cells: [counter],
  client: "server-only",
  baseDir: import.meta.dirname!,
});
