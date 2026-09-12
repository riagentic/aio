// `aio build --analyze` — where the bundle's bytes went.
//
// Two reports asked for a treemap (report 5 §8.9, report 1 §22.7). The answerable
// version of that question is smaller: "which twenty things are most of my
// bundle, and is anything in here that should not be".
//
// THE NUMBER HAS TO BE `bytesInOutput`, not a file's size on disk. A 400 KB
// dependency that tree-shakes to 3 KB is not a 400 KB problem, and a report
// saying it is sends someone optimising the wrong module — worse than no
// report, because it costs a day to find out.
import { assert, assertEquals } from "@std/assert";
import {
  analyzeBundle,
  formatAnalysis,
  groupOf,
} from "../src/build/bundle-analyze.ts";

Deno.test("a dependency folds to its PACKAGE, which is the actionable unit", () => {
  // Sixty rows of `three@0.160/build/*.js` answer "which dependency is big"
  // worse than one row does. The unit anyone can act on is the package:
  // remove it, replace it, import less of it.
  assertEquals(
    groupOf("node_modules/.deno/three@0.160.0/node_modules/three/build/a.js"),
    "node_modules/three/",
  );
  assertEquals(
    groupOf("node_modules/@scope/pkg/dist/index.js"),
    "node_modules/@scope/pkg/",
    "a scoped package keeps its scope",
  );
});

Deno.test("the framework folds per AREA — `how much of this is aio` has an answer", () => {
  assertEquals(groupOf("/home/x/aio/src/air/vdom.ts"), "aio/air/");
  assertEquals(groupOf("/home/x/aio/src/sync/merge.ts"), "aio/sync/");
});

Deno.test("an uncategorised module stands ALONE — that is the one worth seeing", () => {
  assertEquals(groupOf("src/App.tsx"), null);
  assertEquals(groupOf("/abs/path/weird-generated-thing.js"), null);
});

Deno.test("rows sum to the bundle, so a share is a real share", () => {
  const a = analyzeBundle({ "src/App.tsx": 300, "src/cell.ts": 100 });
  assertEquals(a.total, 400);
  assertEquals(a.rows.map((r) => [r.name, r.bytes]), [
    ["src/App.tsx", 300],
    ["src/cell.ts", 100],
  ]);
  assertEquals(a.rows[0]!.share, 0.75);
  assertEquals(a.rows.reduce((n, r) => n + r.bytes, 0) + a.restBytes, a.total);
});

Deno.test("grouped modules report their COUNT, so a big row is explicable", () => {
  const a = analyzeBundle({
    "node_modules/three/a.js": 100,
    "node_modules/three/b.js": 200,
    "src/App.tsx": 10,
  });
  const three = a.rows.find((r) => r.name === "node_modules/three/")!;
  assertEquals(three.bytes, 300);
  assertEquals(three.modules, 2);
});

Deno.test("the tail is SUMMARISED, never dropped", () => {
  // A list nobody scrolls is a list nobody reads; a list that silently omits
  // 40% of the bundle is a lie.
  const input: Record<string, number> = {};
  for (let i = 0; i < 50; i++) input[`mod-${i}.ts`] = 100 - i;
  const a = analyzeBundle(input, { limit: 5 });
  assertEquals(a.rows.length, 5);
  assertEquals(a.restModules, 45);
  assertEquals(
    a.rows.reduce((n, r) => n + r.bytes, 0) + a.restBytes,
    a.total,
    "everything is accounted for, in the rows or in the rest",
  );
  assert(formatAnalysis(a).some((l) => l.includes("everything else")));
});

Deno.test("the order is STABLE — a committed report is not a diff", () => {
  // Two rows of equal size must not swap places between runs.
  const a = analyzeBundle({ "b.ts": 10, "a.ts": 10, "c.ts": 10 });
  assertEquals(a.rows.map((r) => r.name), ["a.ts", "b.ts", "c.ts"]);
});

Deno.test("grouping off shows every module by name", () => {
  const a = analyzeBundle({
    "node_modules/three/a.js": 1,
    "node_modules/three/b.js": 1,
  }, { group: false });
  assertEquals(a.rows.length, 2);
});

Deno.test("an empty bundle says so rather than dividing by zero", () => {
  const a = analyzeBundle({});
  assertEquals(a.total, 0);
  assertEquals(a.rows, []);
  assertEquals(formatAnalysis(a), ["bundle analysis: nothing to report"]);
});

Deno.test("the report says WHICH bytes it is counting", () => {
  // The one sentence that stops someone optimising a 400 KB dependency that
  // contributes 3 KB.
  const lines = formatAnalysis(analyzeBundle({ "a.ts": 1000 }));
  assert(
    lines[0]!.includes("AFTER tree-shaking"),
    `the header must say what the number means: ${lines[0]}`,
  );
});
