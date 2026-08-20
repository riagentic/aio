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

/** `new URL(…, import.meta.url)` in a TOP-LEVEL statement — column 0, so it
 *  runs the moment the module is evaluated. The same call inside a function
 *  body is indented and runs only when something asks for it. */
const LOAD_TIME_URL_RE =
  /^(?:export\s+)?(?:const|let|var)\s+\w+[^\n]*=\s*new URL\([^\n]*import\.meta\.url|^new URL\([^\n]*import\.meta\.url/gm;

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

Deno.test("no client-reachable module resolves a URL at load time", async () => {
  const offenders: string[] = [];
  for (const url of await clientGraph()) {
    let text: string;
    try {
      text = await Deno.readTextFile(new URL(url));
    } catch {
      continue;
    }
    for (const m of text.matchAll(LOAD_TIME_URL_RE)) {
      offenders.push(`${url.slice(SRC.href.length)}: ${m[0].split("\n")[0]}`);
    }
  }
  assert(
    offenders.length === 0,
    "these run `new URL(…, import.meta.url)` while the module evaluates, so a " +
      "bundle that merely LINKS them throws before the app boots — move the " +
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
