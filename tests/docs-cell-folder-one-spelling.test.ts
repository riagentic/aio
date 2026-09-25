// "The folder is `cell/` (singular), never `cells/`" — docs/basics/
// project-structure.md, and the reason it gives: three spellings in
// circulation WAS the problem. Yet the cookbook, the page that calls itself
// "the paste buffer", put every recipe in `src/cells/…`, and aiol's scattered-
// cells hint recommended "a src/cells/ (or src/cell/) directory" and pointed at
// a `structure.md` that does not exist. A newcomer copying either got the
// spelling the structure page forbids.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";

const ROOT = new URL("..", import.meta.url);

/** A `cells/` PATH — `src/cells/x.ts`, `./cells/x.ts`, `../cells/…`. The
 *  structure page's own sentence ("never `cells/`") is prose, not a path. */
const CELLS_PATH = /(?:src\/|\.\.?\/)cells\//;

Deno.test("docs spell the cell folder `cell/`, never `cells/`", async () => {
  // All of docs/, not just basics/: react-islands.md imported
  // `./cells/market.ts` long after the getting-started pages were fixed —
  // every page is a paste buffer for somebody.
  const names: string[] = [];
  const walk = async (dir: URL, rel: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) {
        await walk(new URL(`${e.name}/`, dir), `${rel}${e.name}/`);
      } else if (e.isFile && e.name.endsWith(".md")) names.push(rel + e.name);
    }
  };
  await walk(new URL("docs/", ROOT), "");
  assert(names.includes("basics/cookbook.md"), "the cookbook is walked");
  assert(names.includes("ui/react-islands.md"), "sub-folders are walked");
  const hits: string[] = [];
  for (const name of names.sort()) {
    const text = await Deno.readTextFile(new URL(`docs/${name}`, ROOT));
    text.split("\n").forEach((l, i) => {
      if (CELLS_PATH.test(l)) hits.push(`docs/${name}:${i + 1}: ${l}`);
    });
  }
  assertEquals(hits, []);
});

Deno.test("aiol's scattered-cells hint names `src/cell/` and a page that exists", async () => {
  const dir = await tempDir("aiol-cell-dir-");
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1" } }),
    );
    await Deno.mkdir(join(dir, "src"));
    const names = ["a", "b", "c", "d"];
    for (const n of names) {
      await Deno.writeTextFile(
        join(dir, "src", `${n}.ts`),
        `import { cell } from "aio";\nexport const ${n} = cell("${n}", { state: { n: 0 }, methods: { go() {} } });\n`,
      );
    }
    const { ctx, report } = await buildContext(dir);
    const { checkStructure } = await import("../aiol/checks.ts");
    await checkStructure(ctx);
    const hint = report.issues.filter((i) =>
      i.message.includes("cell files scattered")
    );
    assertEquals(hint.length, 1, "four loose cell files are reported once");
    const { message, fix } = hint[0]!;
    assertStringIncludes(message, "src/cell/");
    assert(!message.includes("cells/"), message);
    const page = String(fix ?? "").match(/docs\/[\w/-]+\.md/)?.[0];
    assert(page, `the fix names a docs page: ${fix}`);
    assert(
      (await Deno.stat(new URL(page, ROOT))).isFile,
      `${page} exists`,
    );
  } finally {
    await dropTempDir(dir);
  }
});
