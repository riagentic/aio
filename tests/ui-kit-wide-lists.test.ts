// <Table> and <Select> must render a WIDE list. Both handed their rows /
// options to `h()` as spread arguments, and V8 caps a call's argument count:
// past ~120k the call throws `RangeError: Maximum call stack size exceeded`
// — out of the render, so a table of a large query result (or a select of
// every city) took the whole page down instead of being slow. They now use
// the same chunking as <Markdown> (`src/ui/h-spread.ts`).
import { assert, assertEquals } from "@std/assert";
import { renderToString } from "../src/air/vdom.ts";
import { Select, Table } from "../src/ui/mod.ts";

const N = 130_000;
const count = (html: string, s: string): number => html.split(s).length - 1;

Deno.test("ui wide: a 130k-row Table and a 130k-option Select render", () => {
  const rows = Array.from({ length: N }, (_, i) => ({ id: i }));
  const options = Array.from({ length: N }, (_, i) => `o${i}`);
  const cases: [string, () => unknown, string][] = [
    ["Table", () => Table({ columns: [{ key: "id" }], rows }), "<tr"],
    ["Select", () => Select({ options, value: "o7" }), "<option"],
  ];
  assertEquals(cases.length, 2);
  for (const [name, build, tag] of cases) {
    let html = "";
    try {
      html = renderToString(build() as never);
    } catch (e) {
      throw new Error(`${name}: render threw ${String(e)}`);
    }
    // Table: N body rows + the header row.
    const n = count(html, tag);
    assert(n >= N, `${name}: expected ${N} ${tag}, got ${n}`);
  }
});

Deno.test("ui wide: a chunked Table/Select is the same markup as an unchunked one", () => {
  // Chunking must be invisible: row i of a 20k table is the same markup as
  // row i of the 20k-row table built one row at a time.
  const M = 20_000;
  const rows = Array.from({ length: M }, (_, i) => ({ id: i }));
  const table = renderToString(Table({ columns: [{ key: "id" }], rows }));
  const tr = (i: number) =>
    renderToString(Table({ columns: [{ key: "id" }], rows: [{ id: i }] }))
      .split("<tbody>")[1]!.split("</tbody>")[0]!;
  const want = Array.from({ length: M }, (_, i) => tr(i)).join("");
  assertEquals(table.split("<tbody>")[1]!.split("</tbody>")[0]!, want);

  const options = Array.from({ length: M }, (_, i) => `o${i}`);
  const sel = renderToString(Select({ options }));
  const one = (o: string) =>
    renderToString(Select({ options: [o] })).replace(/^<select[^>]*>/, "")
      .replace(/<\/select>$/, "");
  assertEquals(
    sel.replace(/^<select[^>]*>/, "").replace(/<\/select>$/, ""),
    options.map(one).join(""),
  );
});
