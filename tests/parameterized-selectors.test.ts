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
