// risoto #4 — `am record`: turn a recorded journal into a bootCells replay test.
import { assert, assertEquals } from "@std/assert";
import { generateReplayTest, parseJournalActions } from "../src/am/record.ts";

Deno.test("generateReplayTest: cell:method + args → bootCells calls", () => {
  const src = generateReplayTest([
    { type: "counter:add", payload: { args: [7] } },
    { type: "counter:add", payload: { args: [5] } },
    { type: "nav:go", payload: { args: ["home"] } },
    { type: "counter:__init", payload: {} }, // framework — skipped
  ]);
  assert(src.includes('import { bootCells } from "aio/testing";'));
  assert(src.includes('import { counter } from "../src/counter.ts";'));
  assert(src.includes('import { nav } from "../src/nav.ts";'));
  assert(src.includes("bootCells([counter, nav])"));
  assert(src.includes("await counter.add(7);"));
  assert(src.includes("await counter.add(5);"));
  assert(src.includes('await nav.go("home");'));
  assert(!src.includes("__init"), "framework __methods are not replayed");
  assert(src.includes("// TODO: assert"), "leaves an assertion stub");
});

Deno.test("generateReplayTest: empty → a valid empty test", () => {
  const src = generateReplayTest([]);
  assert(src.includes("bootCells([])"));
  assert(src.includes("Deno.test"));
});

Deno.test("parseJournalActions: JSONL → ordered actions, tolerates a torn tail", () => {
  const text = [
    JSON.stringify({ seq: 2, type: "c:b", payload: { args: [2] } }),
    JSON.stringify({ seq: 1, type: "c:a", payload: { args: [1] } }),
    '{"seq":3,"type":"c:c","payl', // torn line
  ].join("\n");
  const actions = parseJournalActions(text);
  assertEquals(
    actions.map((a) => a.type),
    ["c:a", "c:b"],
    "sorted by seq, torn dropped",
  );
  assertEquals((actions[0]!.payload as { args: number[] }).args, [1]);
});
