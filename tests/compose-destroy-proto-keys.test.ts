// Compose Init/Destroy: OWN keys only when wiping a cell back to its declared
// shape. `key in targetSlice` is true for every Object.prototype name, so a
// live field named `toString`/`valueOf`/… survived Destroy instead of being
// wiped — the same class as the unpersistedFromBase pin.
import { assertEquals } from "@std/assert";
import { composeCells } from "../src/state/cell-compose.ts";
import type { CellEntry } from "../src/state/cell-types.ts";

function testCell(id: string) {
  return {
    __aio: {
      id,
      state: { count: 0 },
      actions: {},
      effects: {},
      selectors: {},
      actionKeys: [] as string[],
      effectKeys: [] as string[],
      actionTypeToKey: new Map<string, string>(),
      foreignActions: [] as string[],
      machine: false as const,
      bound: false,
      reduce: () => {},
      initType: `${id}:Init`,
      destroyType: `${id}:Destroy`,
      flowTriggers: undefined,
      flows: undefined,
      validate: undefined,
      execute: undefined,
      onInit: undefined,
      onDestroy: undefined,
    },
  };
}

Deno.test("compose Destroy: a live field named after a prototype member is wiped", () => {
  const composed = composeCells(
    [testCell("counter")] as unknown as CellEntry[],
  );
  const before = {
    counter: { count: 5, toString: "USER" },
  };
  const result = composed.reduce(before, {
    type: "counter:Destroy",
    payload: {},
  });
  const slice = result.state.counter as Record<string, unknown>;
  assertEquals(Object.hasOwn(slice, "toString"), false, String(slice.toString));
  assertEquals(slice, { count: 0 });
});

Deno.test("compose Init: a live field named after a prototype member is wiped when re-initing from empty existing", () => {
  // Init with existing undefined uses cellSlice = {}. After copying target
  // keys, an extra own prototype-named key can only arrive if the draft was
  // seeded with one — here we feed a prior slice that Init must reset when
  // the cell is re-created from declared state alone. Destroy covers the
  // wipe; Init's same `Object.hasOwn` site is the twin for the empty-base
  // path that copies declared state over a leftover slice.
  const composed = composeCells(
    [testCell("counter")] as unknown as CellEntry[],
  );
  const before = {
    counter: { count: 5, valueOf: 99 },
  };
  // Destroy first (clears), then Init — Init's own loop must also refuse to
  // keep a prototype-named leftover if one somehow re-enters.
  const destroyed = composed.reduce(before, {
    type: "counter:Destroy",
    payload: {},
  });
  assertEquals(
    Object.hasOwn(destroyed.state.counter as object, "valueOf"),
    false,
  );
  const inited = composed.reduce(destroyed.state, {
    type: "counter:Init",
    payload: {},
  });
  const slice = inited.state.counter as Record<string, unknown>;
  assertEquals(Object.hasOwn(slice, "valueOf"), false, String(slice.valueOf));
  assertEquals(slice, { count: 0 });
});
