import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { rebase } from "../../src/sync/rebase.ts";
import type { SyncOp } from "../../src/sync/types.ts";

function testReducer(
  state: Record<string, unknown>,
  action: string,
  payload: unknown,
): Record<string, unknown> | null {
  switch (action) {
    case "set":
      return { ...state, ...(payload as Record<string, unknown>) };
    case "increment":
      return { ...state, count: (state.count as number) + 1 };
    case "invalid":
      return null;
    default:
      return state;
  }
}

const mkOp = (id: string, action: string, payload: unknown): SyncOp => ({
  id,
  cell: "test",
  action,
  payload,
  hlc: [Date.now(), 0, "c1"],
  confirmed: false,
});

describe("rebase", () => {
  it("replays unconfirmed ops on confirmed state", () => {
    const result = rebase(
      { count: 0 },
      [mkOp("1", "increment", {})],
      testReducer,
    );
    assertEquals(result.optimistic, { count: 1 });
    assertEquals(result.dropped.length, 0);
  });

  it("drops ops that become invalid after rebase", () => {
    const unconfirmed = [
      mkOp("1", "increment", {}),
      mkOp("2", "invalid", {}),
      mkOp("3", "increment", {}),
    ];
    const result = rebase({ count: 0 }, unconfirmed, testReducer);
    assertEquals(result.optimistic, { count: 2 });
    assertEquals(result.dropped.length, 1);
    assertEquals(result.dropped[0]!.id, "2");
  });

  it("returns confirmed state when no unconfirmed ops", () => {
    const result = rebase({ count: 5 }, [], testReducer);
    assertEquals(result.optimistic, { count: 5 });
  });

  it("applies multiple ops in order", () => {
    const unconfirmed = [
      mkOp("1", "set", { a: 1 }),
      mkOp("2", "set", { b: 2 }),
      mkOp("3", "set", { a: 10 }),
    ];
    const result = rebase({}, unconfirmed, testReducer);
    assertEquals(result.optimistic, { a: 10, b: 2 });
  });
});
