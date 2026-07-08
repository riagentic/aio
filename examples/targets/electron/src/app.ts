// ex-electron — `compile:electron` target example
// Dev: deno task dev   Build: deno task compile
import { aio } from "aio";
import { counter } from "./cell/counter.ts";

await aio.run({
  appId: "ex-electron",
  appVersion: "0.1.0",
  cells: [counter],
  ui: { title: "ex-electron" },
  baseDir: import.meta.dirname!,
});
