// One decider for "which deno.json is this app's" (v1.0.11 hunt).
//
// The browser import map (`readAppDenoImports`) looked at `baseDir/..` and
// `baseDir` only, while the runtime and the prod-bundle graph check walk up
// with `locateDenoJsonAbove`. An entry two folders deep (`src/agent/app.ts`,
// the layout docs/build/targets.md recommends) therefore got a browser import
// map with none of its npm packages — a page dying on an unmapped bare
// import — while the graph check, reading the same project, found the config.

import { assertEquals } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { readAppDenoImports } from "../src/server/server-html-importmap.ts";
import { locateDenoJsonAbove } from "../src/server/deno-json.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("import map: an entry two folders below deno.json finds the same config the graph check finds", async () => {
  const root = await tempDir("aio-nested-entry-");
  const elsewhere = await tempDir("aio-nested-cwd-");
  const cwd = Deno.cwd();
  try {
    const ui = join(root, "src", "agent");
    await Deno.mkdir(ui, { recursive: true });
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ imports: { "chart.js": "npm:chart.js@4" } }),
    );
    Deno.chdir(elsewhere); // cwd is NOT the project — the walk must find it
    const graph = locateDenoJsonAbove(toFileUrl(join(ui, "/")));
    assertEquals(fromFileUrl(graph!.dir), join(root, "/"));
    assertEquals(readAppDenoImports(ui), { "chart.js": "npm:chart.js@4" });
  } finally {
    Deno.chdir(cwd);
    await dropTempDir(root);
    await dropTempDir(elsewhere);
  }
});
