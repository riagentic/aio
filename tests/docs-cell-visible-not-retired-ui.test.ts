// The cell's read filter is `visible:`. Its old name, `ui:`, is RETIRED: a
// cell written with it is refused at `cell()` (dev/test throw, prod logs and
// degrades — src/state/removals-core.ts). The tutorial still taught it —
// "Both `persist` and `ui` accept …", "`ui` controls what reaches browsers" —
// so a newcomer copying section 6 got a throw naming a spelling the docs had
// just told them to use. Prose can't be type-checked, so this reads it.
import { assert, assertEquals } from "@std/assert";

const ROOT = new URL("..", import.meta.url);

/** Phrasings that present `ui` as a CELL filter beside `persist`. */
const RETIRED_CELL_UI = [
  /`persist`\s*(?:and|or|\/|,)\s*`ui`/,
  /`ui`\s+controls what reaches/,
  /\bui\/persist\b|\bpersist\/ui\b/,
];

Deno.test("getting-started docs name the cell filter `visible`, never the retired `ui`", async () => {
  const dir = new URL("docs/basics/", ROOT);
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.endsWith(".md")) files.push(e.name);
  }
  assert(files.length > 10, `doc walk found ${files.length} files`);
  assert(files.includes("tutorial.md"), "the tutorial is walked");

  const hits: string[] = [];
  for (const name of files) {
    const lines = (await Deno.readTextFile(new URL(name, dir))).split("\n");
    lines.forEach((line, i) => {
      if (RETIRED_CELL_UI.some((re) => re.test(line))) {
        hits.push(`docs/basics/${name}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assertEquals(hits, []);
});
