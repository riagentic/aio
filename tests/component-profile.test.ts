// A component profile — which components re-render, how often, for how long.
//
// One page root ran `tuneAll` three times per render at ~14 ms, half of "typing
// is slow while the model answers". It was found by READING CODE and then
// confirmed over CDP (llama.master §16, wallet report §22.3) — the expensive order,
// because the renderer already counts every re-render and already times them
// and nothing added the numbers up.
//
// So the ranking is what is being tested. It is pure over a tree, which is why
// it can be.
import { assert, assertEquals } from "@std/assert";
import {
  componentProfile,
  formatProfile,
  profileTree,
  setProfiling,
} from "../src/air/component-profile.ts";
import type { ComponentTreeNode } from "../src/diagnostics/devtools.ts";

const node = (
  name: string,
  renderCount: number,
  lastRenderMs = 0,
  signalCount = 0,
  children: ComponentTreeNode[] = [],
): ComponentTreeNode =>
  ({
    name,
    props: {},
    renderCount,
    signalCount,
    lastRenderMs,
    children,
  }) as ComponentTreeNode;

Deno.test("busiest first — that is the question being asked", () => {
  const p = profileTree([
    node("Quiet", 1),
    node("Busy", 400),
    node("Middling", 30),
  ], true);
  assertEquals(p.rows.map((r) => r.name), ["Busy", "Middling", "Quiet"]);
  assertEquals(p.totalRenders, 431);
});

Deno.test("instances are summed BY NAME — 400 Rows is the finding", () => {
  // "This particular Row rendered 4 times", a hundred times over, is the same
  // fact in a hundred pieces and answers nothing.
  const rows = Array.from({ length: 100 }, () => node("Row", 4, 0.5, 2));
  const p = profileTree([node("List", 1, 1, 1, rows)], true);
  const row = p.rows.find((r) => r.name === "Row")!;
  assertEquals(row.renders, 400);
  assertEquals(row.instances, 100);
  assertEquals(row.signals, 200);
  assertEquals(row.lastMs, 50, "one pass over all of them");
});

Deno.test("the tree is walked to the bottom, not just its roots", () => {
  const p = profileTree([
    node("A", 1, 0, 0, [node("B", 2, 0, 0, [node("C", 3)])]),
  ], true);
  assertEquals(p.rows.map((r) => r.name).sort(), ["A", "B", "C"]);
  assertEquals(p.totalComponents, 3);
});

Deno.test("the order is stable — two runs of one page can be diffed", () => {
  const p = profileTree([node("b", 5), node("a", 5), node("c", 5)], true);
  assertEquals(p.rows.map((r) => r.name), ["a", "b", "c"]);
});

Deno.test("timings OFF says so, instead of reporting zeros as 'instant'", () => {
  // The difference between "every render was free" and "nothing was timed" is
  // the whole value of the number, so it is stated rather than inferred.
  const p = profileTree([node("A", 3, 0)], false);
  assertEquals(p.timing, false);
  const lines = formatProfile(p);
  assert(lines[0]!.includes("timings OFF"), lines[0]);
  assert(
    lines[0]!.includes("setProfiling"),
    `it says how to turn them on: ${lines[0]}`,
  );
  assert(lines.some((l) => l.includes(" - ")), "…and prints `-`, not `0.0`");
});

Deno.test("the table is capped, and says what it left out", () => {
  const many = Array.from({ length: 40 }, (_, i) => node(`C${i}`, 40 - i));
  const lines = formatProfile(profileTree(many, true), 5);
  assertEquals(lines.filter((l) => l.startsWith("  C")).length, 5);
  assert(lines.some((l) => l.includes("and 35 more")), lines.join("\n"));
});

Deno.test("an empty page says so rather than printing a header over nothing", () => {
  assertEquals(formatProfile(profileTree([], true)), ["no components mounted"]);
});

Deno.test("the live profile runs with nothing mounted", () => {
  // It is called from `am eval` against whatever the page happens to be, so
  // "no roots" has to be an answer and not a throw.
  setProfiling(false);
  const p = componentProfile();
  assertEquals(p.timing, false);
  assertEquals(typeof p.totalRenders, "number");
  setProfiling(false);
});
