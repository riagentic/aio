// A module-level `new URL(…, import.meta.url)` is a bundle that DIES AT LOAD.
//
// From a field report (rimote, Android): `src/state/blocking.ts` resolved its
// worker module at module scope. In a bundle there is no module URL to be
// relative to — esbuild rewrites `import.meta` to a shim whose `url` is not a
// valid absolute URL — so the constructor threw while the module was still
// evaluating, before any app code ran and long before anything asked for a
// worker. One throw there takes the WHOLE bundle down: a blank Android app,
// no UI, one `Failed to construct 'URL': Invalid URL` naming app.js and no
// frame of the app's own.
//
// The feature being unavailable in a bundle is fine. The app not booting is
// not. So: no client-reachable module may build such a URL at load time —
// resolve on FIRST USE, where the error can name what the caller asked for.
import { assert } from "@std/assert";

const SRC = new URL("../src/", import.meta.url);

/** Every entry that can end up inside a browser/standalone bundle. */
const CLIENT_ENTRIES = [
  "browser-air.ts", // browser + electron renderer
  "standalone-air.ts", // android / standalone: the whole app in the WebView
  "air.ts",
  "jsx-runtime.ts",
  "air/aio-renderer.ts",
];

// VALUE imports only: `import type` / `export type` vanish at compile time and
// pull nothing into a bundle (that is how the server's own modules appear in a
// naive walk of the client graph).
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^"'\n]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Every TOP-LEVEL statement in a module: a run of lines starting at column 0
 *  and ending where the next one begins. Everything inside a function body is
 *  indented, so what is left is exactly what runs at import time.
 *
 *  Line-anchored matching was not enough — the first version of this gate
 *  matched only `const X = new URL(…, import.meta.url);` on ONE line, so
 *  `deno fmt` wrapping the same statement over four lines (which it does above
 *  80 columns) walked straight through it, as did an object literal, an IIFE
 *  and `Deno.readFileSync(new URL(…))`. */
function topLevelStatements(src: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const line of src.split("\n")) {
    const startsStatement = /^[^\s})\]]/.test(line);
    if (startsStatement && cur.length) {
      out.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

/** What must not happen while a module evaluates: resolving a module-relative
 *  URL, or reaching for `Deno` at all (a bundle may have neither). */
const LOAD_TIME_HAZARD = /import\.meta\.(url|dirname|filename)|\bDeno\./;

/** …except inside a function body, which only runs when something calls it. */
const DEFERS = /=>|\bfunction\b|\bclass\b/;

async function clientGraph(): Promise<string[]> {
  const visited = new Set<string>();
  const queue = CLIENT_ENTRIES.map((e) => new URL(e, SRC).href);
  while (queue.length > 0) {
    const url = queue.pop()!;
    if (visited.has(url)) continue;
    visited.add(url);
    let text: string;
    try {
      text = await Deno.readTextFile(new URL(url));
    } catch {
      continue;
    }
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec || !spec.startsWith(".")) continue;
      queue.push(new URL(spec, url).href);
    }
  }
  return [...visited];
}

Deno.test("no client-reachable module touches Deno or import.meta at load time", async () => {
  const offenders: string[] = [];
  for (const url of await clientGraph()) {
    let text: string;
    try {
      text = await Deno.readTextFile(new URL(url));
    } catch {
      continue;
    }
    for (const stmt of topLevelStatements(text)) {
      const code = stmt.replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      if (!LOAD_TIME_HAZARD.test(code)) continue;
      if (DEFERS.test(code)) continue; // a function body: runs on demand
      offenders.push(
        `${url.slice(SRC.href.length)}: ${
          code.trim().split("\n")[0]!.slice(0, 90)
        }`,
      );
    }
  }
  assert(
    offenders.length === 0,
    "these touch `import.meta.url` / `Deno` while the module EVALUATES, so a " +
      "bundle that merely LINKS them fails before the app boots — move the " +
      "call into the function that needs it and throw an error naming the " +
      "feature:\n  " + offenders.join("\n  "),
  );
});

Deno.test("the deferred resolver is still reached (blocking pool spawns)", async () => {
  // The fix must not have turned the feature off: the pool still resolves its
  // worker and runs a task where a module URL DOES exist (here).
  const { createBlockingPool } = await import("../src/state/blocking.ts");
  const pool = createBlockingPool({ size: 1 });
  try {
    const out = await pool.run<number>(
      "double",
      (n) => (n as number) * 2,
      21,
    );
    assert(out === 42, `blocking pool returned ${out}`);
  } finally {
    pool.dispose();
  }
});
