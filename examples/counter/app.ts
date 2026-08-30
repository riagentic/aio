// Entry — near-zero-config: cells self-register on import; appId/version/
// baseDir are inferred from deno.json + this file's location.
//
// `theme: "auto"` is the one opt-in: aio's default look (typography, colour
// in light AND dark, controls, cards — accented from this app's own name)
// until you write `src/style.css`, at which point it steps aside and leaves
// only the `--aio-*` variables. Delete the line and the app renders with the
// browser's own defaults; `"full"` keeps the look alongside your own CSS.
import "./cell.ts";
import { aio } from "aio";

await aio.run({ ui: { theme: "auto" } });
