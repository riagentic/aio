// ex-browser — `compile:browser` target example
// Dev: deno task dev   Build: deno task compile
import { aio } from "aio";
import { counter } from "./cell/counter.ts";

await aio.run({
  appId: "ex-browser",
  appVersion: "0.1.0",
  cells: [counter],
  ui: { title: "ex-browser" },
  baseDir: import.meta.dirname!,
});
