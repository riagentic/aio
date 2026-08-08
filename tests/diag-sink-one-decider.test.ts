// One sink for client-side diagnostics, pinned at the ROUTER level.
//
// Every transport that can receive a `diag` frame used to inline the same
// check: `if (typeof _w._aioDiag === "function") _w._aioDiag(ev)`. With no
// overlay on the page — the normal case, since the overlay script is not
// injected — that meant every client-side diagnostic was itself silently
// dropped. A framework's diagnostics going quiet is the one failure it must
// never have, so the decision moved into `_deliverDiag` (overlay when present,
// console otherwise, and a THROWING overlay still falls through to console).
//
// The tests that cover the behaviour all call `_deliverDiag` directly, so
// reverting any single router to the old inline check left the suite green.
// This is the missing half: a pin on the ROUTERS, not just the sink.
import { assert } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const SRC = join(dirname(fromFileUrl(import.meta.url)), "..", "src");

/** Where the sink itself is defined or installed — the only places allowed to
 *  name `_aioDiag`. Everything else must go through `_deliverDiag`. */
const SINK_OWNERS = [
  join("protocol", "protocol-diagnostics.ts"), // the decision
  join("protocol", "protocol-types.ts"), // its type
  join("server", "server-html-scripts.ts"), // the dev overlay that DEFINES it
  join("browser", "console-intercept.ts"), // names it only in a comment
];

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) yield* walk(p);
    else if (e.name.endsWith(".ts")) yield p;
  }
}

Deno.test("diag: no transport re-inlines the _aioDiag check", async () => {
  const offenders: string[] = [];
  for await (const path of walk(SRC)) {
    const rel = path.slice(SRC.length + 1);
    if (SINK_OWNERS.some((o) => rel.endsWith(o))) continue;
    const src = await Deno.readTextFile(path);
    // The call, not the word: a comment mentioning the overlay is fine.
    if (
      /_aioDiag\s*(\?\.)?\s*\(/.test(src) || /typeof\s+\w+\._aioDiag/.test(src)
    ) {
      offenders.push(rel);
    }
  }
  assert(
    offenders.length === 0,
    `these route diagnostics around the one sink — call _deliverDiag instead, ` +
      `or the events go silent the moment no overlay is installed:\n  ${
        offenders.join("\n  ")
      }`,
  );
});

Deno.test("diag: every router that handles a diag frame uses the sink", async () => {
  // A file that switches on a `diag` frame and does NOT reach `_deliverDiag`
  // is either dropping the event or inventing a second sink. (Deliberate
  // ignores state it: `cli-client.ts` groups `diag` with the browser-only
  // frames a CLI has no use for — see the case list there.)
  const IGNORES_ON_PURPOSE = [join("server", "cli-client.ts")];
  const missing: string[] = [];
  for await (const path of walk(SRC)) {
    const rel = path.slice(SRC.length + 1);
    if (IGNORES_ON_PURPOSE.some((o) => rel.endsWith(o))) continue;
    const src = await Deno.readTextFile(path);
    if (!/case\s+["']diag["']/.test(src)) continue;
    if (!src.includes("_deliverDiag")) missing.push(rel);
  }
  assert(
    missing.length === 0,
    `these handle a diag frame without the shared sink:\n  ${
      missing.join("\n  ")
    }`,
  );
});
