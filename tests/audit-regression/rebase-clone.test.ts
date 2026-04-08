// Audit regression: rebase() must deep-clone confirmed state before applying ops
import { assertEquals } from "@std/assert";
import { rebase, type SyncReducer } from "../../src/sync/rebase.ts";
import type { SyncOp } from "../../src/sync/types.ts";

const mutatingReducer: SyncReducer = (state, _action, _payload) => {
  (state as { count: number }).count++;
  (state as { items: number[] }).items.push(99);
  return state;
};

const op: SyncOp = {
  id: "op-1",
  cell: "test",
  action: "inc",
  payload: {},
  hlc: [1, 0, "a"],
  confirmed: false,
};

Deno.test("rebase does not mutate confirmed input", () => {
  const confirmed = { count: 0, items: [1, 2, 3] };
  const result = rebase(confirmed, [op], mutatingReducer);

  // Confirmed must be untouched
  assertEquals(confirmed.count, 0);
  assertEquals(confirmed.items, [1, 2, 3]);

  // Optimistic state has the mutation
  assertEquals((result.optimistic as { count: number }).count, 1);
  assertEquals((result.optimistic as { items: number[] }).items, [1, 2, 3, 99]);
  assertEquals(result.surviving.length, 1);
  assertEquals(result.dropped.length, 0);
});

Deno.test("rebase with empty ops returns confirmed ref directly", () => {
  const confirmed = { count: 5 };
  const result = rebase(confirmed, [], mutatingReducer);
  // With zero ops, rebase returns the original ref (no clone needed)
  assertEquals(result.optimistic, confirmed);
});

Deno.test("rebase drops ops where reducer returns null", () => {
  const nullReducer: SyncReducer = () => null;
  const confirmed = { count: 0, items: [1, 2, 3] };
  const result = rebase(confirmed, [op], nullReducer);

  assertEquals(result.dropped.length, 1);
  assertEquals(result.surviving.length, 0);
  assertEquals(confirmed.count, 0);
});
