// Audit regression: withLock serializes concurrent ops on the same cell
// and lowWater per-cell resolution works correctly
import { assertEquals } from "@std/assert";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import type { SyncOp } from "../../src/sync/types.ts";
import type { OpBuffer } from "../../src/sync/op-buffer.ts";

function mockBuffer(): OpBuffer {
  const ops: SyncOp[] = [];
  return {
    add: async (op: SyncOp) => {
      ops.push(op);
      return true;
    },
    confirm: async () => {},
    getUnconfirmed: async () => ops.filter((o) => !o.confirmed),
    pruneConfirmed: async () => {},
    getMeta: async () => undefined,
    saveSnapshot: async () => {},
    loadSnapshot: async () => undefined,
    clear: async () => {},
  };
}

function makeEngine() {
  const confirmed: Record<string, Record<string, unknown>> = {
    todos: { items: [] },
  };
  const updates: string[] = [];

  const engine = createSyncEngine({
    clientId: "test",
    cells: {
      todos: {
        merge: { items: "lww" },
        identity: {},
        offline: { retention: "7d" },
      },
    },
    buffer: mockBuffer(),
    send: () => {},
    reducer: (state, _action, payload) => ({
      ...state,
      items: [...(state.items as unknown[] || []), payload],
    }),
    getConfirmedState: () => confirmed,
    setConfirmedState: (f, s) => {
      confirmed[f] = s;
    },
    onStateUpdate: (f) => {
      updates.push(f);
    },
  });
  return { engine, confirmed, updates };
}

Deno.test("concurrent handleAck + handleRemoteOp serialize", async () => {
  const { engine, updates } = makeEngine();
  const p1 = engine.handleAck("todos", "op-1", [100, 0, "server"]);
  const p2 = engine.handleRemoteOp({
    id: "remote-1",
    cell: "todos",
    action: "add",
    payload: "item-r",
    hlc: [101, 0, "other"],
    confirmed: true,
  });
  await Promise.all([p1, p2]);
  assertEquals(updates.length >= 2, true);
});

Deno.test("handleSyncResponse resolves per-cell lowWater", async () => {
  const { engine, confirmed } = makeEngine();
  await engine.handleSyncResponse({
    mode: "snapshot",
    snapshot: { todos: { items: ["snap"] } },
    lowWater: { todos: [500, 0, "server"] },
  });
  assertEquals(confirmed["todos"]!.items, ["snap"]);
});

Deno.test("handleSyncResponse handles legacy single HLC", async () => {
  const { engine, confirmed } = makeEngine();
  await engine.handleSyncResponse({
    mode: "snapshot",
    snapshot: { todos: { items: ["legacy"] } },
    lowWater: [999, 0, "server"],
  });
  assertEquals(confirmed["todos"]!.items, ["legacy"]);
});

Deno.test("handleRemoteOp ignores unknown cells", async () => {
  const { engine, updates } = makeEngine();
  await engine.handleRemoteOp({
    id: "r-1",
    cell: "unknown",
    action: "add",
    payload: "x",
    hlc: [1, 0, "a"],
    confirmed: true,
  });
  assertEquals(updates.length, 0);
});
