// cli-table-wide-emoji.test.ts — width()/table() measure what a terminal draws.
//
// isWide() knew only U+1F300–1F64F and U+1F900–1F9FF, so the commonest CLI
// status glyphs (✅ ❌ ⚡ ⭐ ⏳ 🚀 🟢 🫠 — East-Asian-Width=W) measured one
// cell and rendered two: every column after them in a table() slid. A
// narrow base + VS16 (❤️) is emoji presentation, two cells. And a cell holding
// "\n" split its row in two; "\t" measured 0 cells.
import { assertEquals } from "@std/assert";
import { plainWidth, table } from "../src/cli.ts";
import { pad, width } from "../src/diagnostics/fmt.ts";

Deno.test("width counts East-Asian-Width=W emoji as two cells", () => {
  for (
    const s of ["✅", "❌", "⚡", "⭐", "⏳", "🚀", "🟢", "🫠", "⌚", "⛔"]
  ) {
    const at = `U+${s.codePointAt(0)!.toString(16)}`;
    assertEquals(width(s), 2, `${s} ${at}`);
    assertEquals(plainWidth(s), 2, `${s} ${at}`);
  }
  // Unchanged: narrow symbols stay one cell.
  for (const s of ["●", "✓", "✗", "→", "❤", "a"]) assertEquals(width(s), 1, s);
});

Deno.test("width: VS16 makes its narrow base two cells, once", () => {
  assertEquals(width("❤️"), 2);
  assertEquals(width("✔️ ok"), 5);
  assertEquals(width("✅️"), 2); // already wide: not three
  assertEquals(width("️"), 0); // nothing to widen
  assertEquals(width("a︎"), 1); // VS15 stays free
});

Deno.test("pad: a ✅ cell pads to the same width as a plain one", () => {
  assertEquals(width(pad("✅", 4)), 4);
  assertEquals(pad("✅", 4), "✅  ");
});

Deno.test("table: a ✅/❌ status column keeps the next column aligned", () => {
  const t = table([{ st: "✅", name: "deploy" }, { st: "❌", name: "test" }, {
    st: "ok",
    name: "lint",
  }], { color: false });
  // Measured by a reference independent of width(): the thing under test.
  const cells = (s: string) => {
    let n = 0;
    for (const ch of s) n += /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
    return n;
  };
  const starts = t.split("\n").map((l) =>
    cells(l.slice(0, l.lastIndexOf("  ") + 2))
  );
  assertEquals(new Set(starts).size, 1, `rows start at cells ${starts}:\n${t}`);
});

Deno.test("table: a cell with a newline or tab stays one aligned row", () => {
  const t = table([{ a: "x\ny", b: "z" }, { a: "p\r\nq", b: "r" }, {
    a: "t\tu",
    b: "s",
  }], { color: false });
  const lines = t.split("\n");
  assertEquals(lines.length, 4, JSON.stringify(t));
  assertEquals(lines[1], "x⏎y  z");
  assertEquals(lines[2], "p⏎q  r");
  assertEquals(lines[3], "t u  s");
});
