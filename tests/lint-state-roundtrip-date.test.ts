// The boot lint's "state loses data on JSON round-trip" warning names a Date —
// and could never fire for one: it compared `JSON.stringify(state)` with a
// second stringify of the parsed text, and a Date is the same ISO string in
// both (a Map and a Set are `{}` in both). It is judged by the walk
// persistence uses, so the warning sees what it says it sees.
import { assert, assertEquals } from "@std/assert";
import { lint } from "../src/server/lint.ts";

const reduce = (s: unknown) => ({ state: s, effects: [] });
const lossy = async (state: unknown) =>
  (await lint(state, { reduce, execute: () => {} }, Deno.cwd(), true, true))
    .warn.filter((w) => w.includes("JSON round-trip"));

Deno.test("lint: a Date, a Map and a Set in initial state are each named", async () => {
  for (
    const [kind, value] of [
      ["Date", new Date(0)],
      ["Map", new Map([["a", 1]])],
      ["Set", new Set([1])],
    ] as const
  ) {
    const w = await lossy({ ok: 1, nested: { at: value } });
    assertEquals(w.length, 1, `${kind} in state raised no warning`);
    assert(w[0]!.includes(`nested.at (${kind})`), w[0]);
  }
});

Deno.test("lint: JSON-shaped state raises no round-trip warning", async () => {
  assertEquals(
    await lossy({ n: 1, s: "x", list: [1, null, { a: true }], o: {} }),
    [],
  );
});
