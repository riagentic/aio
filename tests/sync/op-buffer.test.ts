import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { createOpBuffer } from "../../src/sync/op-buffer.ts";
import type { SyncOp } from "../../src/sync/types.ts";
import { createMemoryStorage } from "./_memory-storage.ts";

describe("OpBuffer", () => {
  const mkOp = (id: string, cell = "todos"): SyncOp => ({
    id,
    cell,
    action: "add",
    payload: { text: "test" },
    hlc: [Date.now(), 0, "c1"],
    confirmed: false,
  });

  it("adds and loads ops", async () => {
    const buf = createOpBuffer(createMemoryStorage());
    const op = mkOp("op1");
    await buf.add(op);
    const loaded = await buf.getUnconfirmed("todos");
    assertEquals(loaded.length, 1);
    assertEquals(loaded[0]!.id, "op1");
  });

  it("confirms ops", async () => {
    const buf = createOpBuffer(createMemoryStorage());
    await buf.add(mkOp("op1"));
    await buf.confirm("todos", "op1", [2000, 0, "s"]);
    const unconfirmed = await buf.getUnconfirmed("todos");
    assertEquals(unconfirmed.length, 0);
  });

  it("enforces pending cap", async () => {
    const buf = createOpBuffer(createMemoryStorage(), { pendingCap: 3 });
    await buf.add(mkOp("op1"));
    await buf.add(mkOp("op2"));
    await buf.add(mkOp("op3"));
    const result = await buf.add(mkOp("op4"));
    assertEquals(result, false); // rejected — cap hit
  });

  it("prunes confirmed ops", async () => {
    const buf = createOpBuffer(createMemoryStorage());
    await buf.add(mkOp("op1"));
    await buf.add(mkOp("op2"));
    await buf.confirm("todos", "op1", [2000, 0, "s"]);
    await buf.pruneConfirmed("todos");
    const all = await buf.getUnconfirmed("todos");
    assertEquals(all.length, 1);
    assertEquals(all[0]!.id, "op2");
  });

  it("tracks last confirmed HLC", async () => {
    const buf = createOpBuffer(createMemoryStorage());
    await buf.add(mkOp("op1"));
    await buf.confirm("todos", "op1", [2000, 5, "s"]);
    const meta = await buf.getMeta("todos");
    assertEquals(meta?.lastHlc, [2000, 5, "s"]);
  });

  it("clears all data for a cell", async () => {
    const buf = createOpBuffer(createMemoryStorage());
    await buf.add(mkOp("op1"));
    await buf.clear("todos");
    const loaded = await buf.getUnconfirmed("todos");
    assertEquals(loaded.length, 0);
  });
});
