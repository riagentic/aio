// ex-electron — `compile:electron` target example — zero-config: cells self-register on
// import; appId/title/version infer from deno.json, baseDir from the entry.
// Dev: deno task dev   Build: deno task compile
import "./cell/counter.ts";
import { aio } from "aio";

await aio.run();
