// `testCell(models, …)` could not call `models.visible()` —
// "TypeError: not a function". Selectors bound only on a booted runtime, so any
// unit test that touched one had to be rewritten around `bootCells`.
//
// A selector is a pure function of the cell's own slice — exactly what
// `t.getState()` already exposes — so the split was an inconsistency, not a
// design: the same line worked in testUI, bootCells and production, and threw in
// the tool that presents itself as the unit-level one.
import { assertEquals } from "@std/assert";
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
  // CALL it: `typeof sel.byId === "function"` was true even when the binding
  // had leaked, which is the exact thing this test exists to catch.
  assertEquals(
    sel.byId("a")?.id,
    "a",
    "the parameterized selector is re-bound to THIS harness too",
  );
});

// A deps-form selector takes the FULL state second and its accessor args
// behind it — the server bind's rule. testCell passed the first arg in the
// full-state slot, so `lineTotal("a")` answered 0 here and 30 in bootCells.
const shop = cell("tc-deps-sel", {
  state: { qty: { a: 3 } as Record<string, number>, rate: 10 },
  selectors: {
    lineTotal: {
      deps: ["tc-deps-sel"],
      fn: (
        s: { qty: Record<string, number> },
        [self]: unknown[],
        id: string,
      ) => (s.qty[id] ?? 0) * (self as { rate: number }).rate,
    },
  },
  methods: {
    add(s, id: string) {
      s.qty[id] = (s.qty[id] ?? 0) + 1;
    },
  },
});
const shopSel = shop as unknown as { lineTotal(id: string): number };

testCell(
  shop,
  "a parameterized deps selector answers as bootCells does",
  async (t) => {
    assertEquals(shopSel.lineTotal("a"), 30);
    await t.send.add("a");
    assertEquals(shopSel.lineTotal("a"), 40, "follows the live slice");
  },
);

Deno.test("deps selector: bootCells agrees with testCell", async () => {
  await using _h = await bootCells([shop]);
  assertEquals(shopSel.lineTotal("a"), 30);
});

// The cell's STATE getters too: unbound, `cell.n` was the creation-time
// getter over the DECLARED initial, so a method reading its own cell through
// the def saw 0 under testCell while every booted runtime saw the live value.
const peeker = cell("tc-live-getter", {
  state: { n: 0, seen: -1 },
  methods: {
    inc(s) {
      s.n++;
    },
    async peek(s) {
      await Promise.resolve();
      s.seen = (peeker as unknown as { n: number }).n;
    },
  },
});

testCell(
  peeker,
  "a state getter on the def reads the live slice",
  async (t) => {
    await t.send.inc();
    await t.send.inc();
    assertEquals(
      (peeker as unknown as { n: number }).n,
      2,
      "the def getter is live",
    );
    await t.send.peek();
    assertEquals(
      t.state.seen,
      2,
      "a method reading the def sees the live value",
    );
  },
);
