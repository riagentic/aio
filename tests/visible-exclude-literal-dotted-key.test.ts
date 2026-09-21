// `exclude: ["a.b"]` must mean the same thing at every seam — including when
// the cell really does hold a KEY NAMED "a.b".
//
// The framework had two answers for that key and shipped both:
//
//   • the client read seam (`uiKeyVisibility`, the `am surface` view and the
//     trojan `fields` badge) matched the exclude entry against the key STRING,
//     said "hidden", and refused the read with a loud warning;
//   • the wire frame (`applyCellFieldFilter`) and the delta path
//     (`filterPatchesByStrategy`) read it only as the PATH a → b, found no key
//     `a`, and broadcast the value to every client.
//
// So the field was in the client's own state and unreadable by the component
// that owns it — a leak and a broken feature at once, from one declaration.
// The ambiguity rule this file already states for a record id named like a
// field ("remove BOTH readings") settles it: the literal key goes too.
//
// NOT covered, and deliberately: a literal dotted key NESTED under the head
// (`{ creds: { "api.example.com": … } }` under `exclude:
// ["creds.api.example.com"]`). No seam hides that one today, so the readings
// do not disagree — they are all wrong together, which is a semantic change
// rather than a convergence. See the final report of the round that added
// this file.
import { assert, assertEquals } from "@std/assert";
import {
  applyCellFieldFilter,
  filterPatchesByStrategy,
  uiKeyVisibility,
} from "../src/state/state-filter.ts";
import type { WirePatch } from "../src/protocol/patch-ops.ts";
import type { CellFieldFilter } from "../src/state/cell-types.ts";

const LITERAL = "SECRET-in-the-literal-key";
const NESTED = "SECRET-in-the-nested-path";
const FILTER: CellFieldFilter = { exclude: ["a.b"] };

const slice = () => ({
  "a.b": LITERAL,
  a: { b: NESTED, c: "kept" },
  ok: 1,
});

Deno.test("visible.exclude: the frame hides a key literally named like the path", () => {
  const out = applyCellFieldFilter(FILTER, slice());
  const text = JSON.stringify(out);
  assert(!text.includes(LITERAL), `the literal key must go too: ${text}`);
  assert(!text.includes(NESTED), `…and the path reading still holds: ${text}`);
  assertEquals(out, { a: { c: "kept" }, ok: 1 });
});

Deno.test("visible.exclude: the client read seam already said hidden", () => {
  // The answer the frame now agrees with — pinned, so the two cannot drift
  // apart again in the other direction.
  assertEquals(uiKeyVisibility(FILTER, "a.b").hidden, true);
  assertEquals(uiKeyVisibility(FILTER, "a").hidden, false);
});

Deno.test("visible.exclude: the delta path drops an op at that literal key", () => {
  const ops = (path: (string | number)[], value: unknown): WirePatch[] =>
    [{
      op: "replace",
      path,
      value,
    }] as WirePatch[];
  const run = (p: WirePatch[]) =>
    filterPatchesByStrategy(
      [{ cell: "c", ops: p }],
      new Map([["c", "filter"]]),
      new Map([["c", {
        mode: "exclude",
        fields: new Set<string>(),
        deepExcludes: [["a", "b"]],
      }]]),
    );
  assertEquals(
    run(ops(["a.b"], LITERAL)),
    [],
    "a write to the literal key must not reach a client",
  );
  assertEquals(
    run(ops(["a.b", "deeper"], LITERAL)),
    [],
    "…nor one to anything under it",
  );
  assertEquals(
    run(ops(["a", "b"], NESTED)),
    [],
    "the path reading keeps working",
  );
  assertEquals(
    run(ops(["ok"], 2)),
    [{ cell: "c", ops: [{ op: "replace", path: ["ok"], value: 2 }] }],
    "an unrelated key still moves",
  );
  // A key that merely STARTS with the excluded name is not it.
  assertEquals(
    run(ops(["a.bc"], "kept")),
    [{ cell: "c", ops: [{ op: "replace", path: ["a.bc"], value: "kept" }] }],
    "the match is the whole key, never a prefix",
  );
});

Deno.test("visible.exclude: the frame and the delta agree, key by key", () => {
  // The invariant behind both: whatever the frame drops, no delta may carry.
  const frame = applyCellFieldFilter(FILTER, slice()) as Record<
    string,
    unknown
  >;
  const keys = Object.keys(slice());
  assertEquals(
    keys,
    ["a.b", "a", "ok"],
    "the shapes this invariant is checked over — an empty list would prove " +
      "nothing at all",
  );
  let checked = 0;
  for (const key of keys) {
    const kept = filterPatchesByStrategy(
      [{
        cell: "c",
        ops: [{ op: "replace", path: [key], value: "x" }] as WirePatch[],
      }],
      new Map([["c", "filter"]]),
      new Map([["c", {
        mode: "exclude",
        fields: new Set<string>(),
        deepExcludes: [["a", "b"]],
      }]]),
    );
    assertEquals(
      (kept ?? []).length > 0,
      key in frame,
      `${key}: the delta path and the frame must give the same answer`,
    );
    checked++;
  }
  assertEquals(checked, keys.length, "every key was actually compared");
});
