import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { rebase, REDUCER_FAILED } from "../../src/sync/rebase.ts";
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

// A `null` return is the contract's no-op. `undefined` and REDUCER_FAILED mean
// the reducer could NOT apply the op — the "blank-screen-class" bug D11 names,
// and the three other paths that fold an op (ack, catch-up, broadcast) have
// always reported it. Rebase collapsed all three into `dropped`, which no
// caller read, so the ONE path replaying the user's own unsent changes was the
// only silent one: the change left the optimistic view and `pending` stopped
// counting it, with nothing logged.
describe("rebase: a no-op and a broken reducer are different facts", () => {
  const op = (id: string, action: string): SyncOp => ({
    id,
    cell: "test",
    action,
    payload: {},
    hlc: [Date.now(), 0, "c1"],
    confirmed: false,
  });

  it("separates them, and a null no-op is NOT reported", () => {
    const r = rebase(
      { count: 0 },
      [op("a", "noop"), op("b", "undef"), op("c", "threw"), op("d", "ok")],
      (s, action) => {
        if (action === "noop") return null;
        if (action === "undef") return undefined as never;
        if (action === "threw") return REDUCER_FAILED;
        return { ...s, ok: true };
      },
    );
    assertEquals(r.dropped.map((o) => o.id), ["a", "b", "c"]);
    assertEquals(r.surviving.map((o) => o.id), ["d"]);
    // only the two the reducer could not apply, each with WHICH failure
    assertEquals(r.notApplied.map((n) => [n.op.id, n.why]), [
      ["b", "undefined"],
      ["c", "failed"],
    ]);
  });

  it("an empty rebase reports nothing", () => {
    const r = rebase({ count: 1 }, [], () => null);
    assertEquals(r.notApplied, []);
    assertEquals(r.dropped, []);
  });

  it("a clean rebase reports nothing", () => {
    const r = rebase({ count: 0 }, [op("x", "set")], (s) => ({ ...s, x: 1 }));
    assertEquals(r.notApplied, []);
    assertEquals(r.surviving.length, 1);
  });
});
