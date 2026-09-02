// `test-strict.ts` rides in every app's browser bundle, and its own header says
// so: "everything reachable from here rides in every app's browser bundle. A
// single static import of a server module from here made the bundler refuse
// EVERY browser build." It then adds that `check:boundaries` cannot see this,
// "so the rule is kept here, in words, beside the import list it constrains."
//
// Words were not enough. Adding `import { join } from "@std/path"` to compute a
// temp path cost `test:e2e` 9 of its 11 cases: the server booted, the page
// loaded, and no browser client ever registered — a failure that names neither
// the file nor the import. The rule is now a test, which is the only kind of
// rule a bundle can be held to.
import { assertEquals } from "@std/assert";

/** Modules in the BROWSER graph whose static imports are pinned, with the set
 *  each may have. Empty means: no static imports at all. */
const PINNED: Record<string, string[]> = {
  // Reached from `aio/renderer` via `testComponent`. `cell-catalog` is
  // isomorphic core and already in the browser graph; a temp path is built by
  // concatenation precisely so nothing else has to be added here.
  "src/testing/test-strict.ts": ["../state/cell-catalog.ts"],
};

Deno.test("browser graph: pinned modules import exactly what they are allowed to", async () => {
  const root = new URL("../", import.meta.url).pathname;
  const wrong: string[] = [];
  for (const [file, allowed] of Object.entries(PINNED)) {
    const src = await Deno.readTextFile(root + file);
    // Value imports only — `import type` is erased before the bundler sees it.
    const found = [
      ...src.matchAll(/^\s*import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm),
    ].map((m) => m[1]!);
    const extra = found.filter((f) => !allowed.includes(f));
    if (extra.length > 0) {
      wrong.push(`${file} statically imports ${extra.join(", ")}`);
    }
  }
  assertEquals(
    wrong,
    [],
    `these ride in every app's browser bundle:\n  ${wrong.join("\n  ")}\n\n` +
      `  A static import here can make the bundler refuse EVERY browser build,\n` +
      `  and the failure names neither the file nor the import — it looks like\n` +
      `  "no browser client ever connected". If the import is genuinely needed,\n` +
      `  add it to PINNED in this test WITH the reason it is browser-safe.`,
  );
});
