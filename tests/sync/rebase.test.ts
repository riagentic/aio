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

  // CONFIRMED STATE IS GROUND TRUTH. `rebase` replays UNCONFIRMED ops on top
  // of it to produce the optimistic view, and it hands the reducer a deep
  // clone precisely so a reducer that mutates in place cannot write into the
  // one copy of the server's answer this client has. The shipped reducer is
  // immer-based and cannot mutate — but `SyncReducer` is an injected seam, and
  // corruption here is invisible: the optimistic view looks right (it contains
  // the op either way), and the damage only surfaces on the NEXT rebase, which
  // replays the same ops onto a base that already has them.
  //
  // The clone had no test at all — deleting `structuredClone` left the whole
  // sync suite green.
  it("a reducer that mutates in place cannot corrupt confirmed state", () => {
    const confirmed = { items: ["a"], n: 1 };
    const mutating = (
      state: Record<string, unknown>,
      _action: string,
      payload: unknown,
    ): Record<string, unknown> => {
      (state.items as string[]).push((payload as { v: string }).v);
      state.n = (state.n as number) + 1;
      return state;
    };
    const result = rebase(confirmed, [mkOp("1", "push", { v: "b" })], mutating);

    assertEquals(
      confirmed,
      { items: ["a"], n: 1 },
      "the caller's confirmed state must be untouched",
    );
    assertEquals(result.optimistic, { items: ["a", "b"], n: 2 });
    assertEquals(result.surviving.length, 1);
  });

  it("replaying the same op twice does not compound onto confirmed state", () => {
    // The consequence the clone prevents, stated as behaviour: two rebases
    // over the same unconfirmed buffer must produce the same optimistic view.
    const confirmed = { items: ["a"] };
    const mutating = (
      state: Record<string, unknown>,
      _action: string,
      payload: unknown,
    ): Record<string, unknown> => {
      (state.items as string[]).push((payload as { v: string }).v);
      return state;
    };
    const ops = [mkOp("1", "push", { v: "b" })];
    const first = rebase(confirmed, ops, mutating);
    const second = rebase(confirmed, ops, mutating);
    assertEquals(first.optimistic, second.optimistic);
    assertEquals(second.optimistic, { items: ["a", "b"] });
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
