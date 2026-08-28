// `testCell(models, …)` could not call `models.visible()` —
// "TypeError: not a function". Selectors bound only on a booted runtime, so any
// unit test that touched one had to be rewritten around `bootCells`.
//
// A selector is a pure function of the cell's own slice — exactly what
// `t.getState()` already exposes — so the split was an inconsistency, not a
// design: the same line worked in testUI, bootCells and production, and threw in
// the tool that presents itself as the unit-level one.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testCell } from "../src/cell-test.ts";
import { bootCells } from "../src/testing/cell-test.ts";

type S = { items: { id: string; hidden: boolean }[]; filter: string };

const models = cell("tc-selectors", {
  state: {
    items: [
      { id: "a", hidden: false },
      { id: "b", hidden: true },
    ],
    filter: "",
  } as S,
  selectors: {
    visible: (s: S) => s.items.filter((i) => !i.hidden).map((i) => i.id),
    byId: (s: S, id: string) => s.items.find((i) => i.id === id) ?? null,
  },
  methods: {
    hide(s: S, id: string) {
      const it = s.items.find((i) => i.id === id);
      if (it) it.hidden = true;
    },
  },
});

const sel = models as unknown as {
  visible(): string[];
  byId(id: string): { id: string } | null;
};

testCell(
  models,
  "selectors are callable, and read the harness's state",
  (t) => {
    t.init();
    assertEquals(sel.visible(), ["a"], "a zero-arg selector works");
    assertEquals(sel.byId("b")?.id, "b", "a parameterized selector works");

    // …and they follow dispatches, because they read the live slice.
    t.send.hide("a");
    assertEquals(sel.visible(), [], "the selector reflects the new state");
  },
);

// The binding must not leak: a later harness in the same file re-binds for real.
Deno.test("testCell: selector binding is restored afterwards", async () => {
  await using _h = await bootCells([models]);
  assertEquals(
    sel.visible(),
    ["a"],
    "bootCells binds its own selectors over the cell's declared initial state",
  );
  assert(typeof sel.byId === "function");
});
