import { assertEquals } from "@std/assert";
import { bindCell, cell, composeCells } from "../src/state/cell.ts";

// a selector may take ARGS after the state slice —
// `byId: (s, id) => …` surfaces as `cell.byId(id)`. Zero-arg selectors
// (own-slice + deps-form cross-cell) keep working unchanged.

Deno.test("parameterized selector: cell.byId(id) receives the arg", () => {
  type Item = { id: string; n: number };
  const listings = cell("listings", {
    state: { items: [{ id: "a", n: 1 }, { id: "b", n: 2 }] as Item[] },
    methods: { noop(_s) {} },
    selectors: {
      count: (s) => s.items.length,
      byId: (s, id: string) => s.items.find((x) => x.id === id) ?? null,
    },
  });

  const composed = composeCells([listings]);
  let state = composed.initialState;
  bindCell(
    listings,
    (a) => {
      state = composed.reduce(state, a as never).state;
      return Promise.resolve();
    },
    () => state as Record<string, unknown>,
  );

  // The accessor types come from SelectorAccessors: count → () => number,
  // byId → (id: string) => Item | null. These annotations type-check the surface.
  const count: number = listings.count();
  const b: Item | null = listings.byId("b");
  const miss: Item | null = listings.byId("z");

  assertEquals(count, 2);
  assertEquals(b?.n, 2);
  assertEquals(miss, null);
});

// "Is this selector the deps form?" was asked with `key in selectorDeps` — and
// `in` answers yes for every name Object.prototype carries, on an EMPTY
// object. A plain selector that happens to be named `valueOf` / `toString` /
// `constructor` was bound as a deps-form one: its first argument arrived as
// the full state, shifted.
Deno.test("parameterized selector: one named like an Object.prototype member is still a plain selector", () => {
  type Item = { id: string; n: number };
  const shelf = cell("shelf_proto_name", {
    state: { items: [{ id: "a", n: 1 }, { id: "b", n: 2 }] as Item[] },
    methods: { noop(_s) {} },
    selectors: {
      isPrototypeOf: (s: { items: Item[] }, id: string) =>
        s.items.find((x) => x.id === id)?.n ?? -1,
    },
  });
  const composed = composeCells([shelf]);
  let state = composed.initialState;
  bindCell(
    shelf,
    (a) => {
      state = composed.reduce(state, a as never).state;
      return Promise.resolve();
    },
    () => state as Record<string, unknown>,
  );
  const pick = (shelf as unknown as { isPrototypeOf(id: string): number })
    .isPrototypeOf;
  assertEquals(pick("b"), 2);
  assertEquals(pick("z"), -1);
});
