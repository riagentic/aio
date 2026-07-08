// Entry point — define cell, wire to aio.run()
import { aio } from "aio";
import { counter } from "./cell.ts";

export { counter };

await aio.run({
  appId: "counter",
  appVersion: "1.0.0",
  cells: [counter],
  baseDir: import.meta.dirname!,
});
