// aiol cell extraction — only REAL code declares a cell. A `cell("x", …)` in a
// doc comment or inside a code generator's template literal is an example, not
// a cell of the project. Before codeMask() those produced phantom cells and an
// unfixable `duplicate cell name` ERROR (the framework's own repo hit both).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { codeMask, codeMatches } from "../aiol/scan.ts";
import { buildContext } from "../aiol/context.ts";
import { checkCells } from "../aiol/checks.ts";

const CELL_RE = /\bcell\s*\(\s*(['"`])(\w[\w-]*)\1/g;
const names = (src: string) =>
  codeMatches(src, CELL_RE).map((m) => m[2] as string);

Deno.test("codeMask: comments, strings, templates and regexes are not code", () => {
  const src = `const a = 1; // lineC\n/* blockC */ const b = "strC";`;
  const mask = codeMask(src);
  const codeOf = (needle: string) => mask[src.indexOf(needle)] === 1;
  assert(codeOf("const a"), "plain code is code");
  assert(!codeOf("lineC"), "line-comment body is not code");
  assert(!codeOf("blockC"), "block-comment body is not code");
  assert(!codeOf("strC"), "string body is not code");
  assert(codeOf(`"strC"`), "the quote delimiter itself stays code");
  assertEquals(mask.length, src.length, "offsets are preserved 1:1");
});

Deno.test("codeMatches: a real cell() is found, a documented one is not", () => {
  assertEquals(names(`export const w = cell("widget", { state: {} });`), [
    "widget",
  ]);
  assertEquals(names(`// example: cell("counter", { state: { n: 0 } })`), []);
  assertEquals(
    names(`/** Usage:\n *   const c = cell("counter", {});\n */`),
    [],
    "JSDoc examples are documentation, not declarations",
  );
  assertEquals(
    names('const tpl = `import { cell } from "aio";\ncell("todo", {});`;'),
    [],
    "a scaffolded cell inside a template literal belongs to the generated app",
  );
});

Deno.test("codeMatches: a quote inside a regex doesn't blind the rest of the file", () => {
  // The scanner must know `/["']/` is a regex literal — otherwise its quote
  // opens a phantom string and every later cell() goes missing.
  const src =
    `const q = /["']/g;\nexport const w = cell("widget", { state: {} });`;
  assertEquals(names(src), ["widget"]);
});

Deno.test("codeMatches: an apostrophe in JSX text can't swallow later lines", () => {
  const src =
    `const v = <p>it's fine</p>;\nexport const w = cell("widget", {});`;
  assertEquals(names(src), ["widget"], "unterminated quotes stop at the line");
});

async function cellsOf(source: string) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { "aio": "jsr:@riagentic/aio@1.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "src", "widget.ts"), source);
    const { ctx, report } = await buildContext(dir);
    await checkCells(ctx);
    return { cells: ctx.cells.map((c) => c.name), issues: report.issues };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("aiol: documented + scaffolded cells never become phantom duplicates", async () => {
  const { cells, issues } = await cellsOf(`
import { cell } from "aio";

/** Counter example:
 *
 *   const counter = cell("counter", { state: { n: 0 } });
 */
export const widget = cell("widget", { state: { count: 0 } });

// A generator that scaffolds an app — its cells are the generated app's.
export const template = \`
import { cell } from "aio";
export const counter = cell("counter", { state: { n: 0 } });
export const widget = cell("widget", { state: {} });
\`;
`);
  assertEquals(cells, ["widget"], "exactly one declared cell");
  assertEquals(
    issues.filter((i) => /duplicate cell name/i.test(i.message)),
    [],
    "no phantom duplicate from the doc comment / template literal",
  );
});

Deno.test("aiol: a REAL duplicate cell name is still an error", async () => {
  // Guards the fix from over-skipping — the rule must keep firing on code.
  const { cells, issues } = await cellsOf(`
import { cell } from "aio";
export const a = cell("widget", { state: { count: 0 } });
export const b = cell("widget", { state: { other: 1 } });
`);
  assertEquals(cells, ["widget", "widget"]);
  assert(
    issues.some((i) =>
      i.severity === "error" && /duplicate cell name/i.test(i.message)
    ),
    "two declared cells with one name must still error",
  );
});
