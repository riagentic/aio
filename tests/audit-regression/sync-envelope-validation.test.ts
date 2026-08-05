// Audit regression: handleSync validates outer envelope before processing
import { assertEquals } from "@std/assert";
import {
  createServerSyncHandler,
  type SyncHandlerDeps,
} from "../../src/sync/server-handler.ts";

const QR = { rows: [], changes: 0, lastInsertRowId: 0n };

function mockDeps(warnings: string[]): SyncHandlerDeps {
  return {
    db: {
      execute: async () => QR,
      query: async () => QR,
      transaction: async () => [],
      close: async () => {},
    },
    dispatch: () => {},
    syncCellIds: ["todos"],
    getCellState: () => ({}),
    getClientCellState: () => ({}),
    broadcastRaw: { fn: () => {} },
    log: {
      debug: () => {},
      warn: (msg: string) => {
        warnings.push(msg);
      },
      error: () => {},
    },
  };
}

function mockSocket(sent: string[]): WebSocket {
  return { send: (d: string) => sent.push(d) } as unknown as WebSocket;
}

Deno.test("handleSync rejects missing clientId", () => {
  const w: string[] = [];
  createServerSyncHandler(mockDeps(w))
    .handleSync({ cells: {} }, { id: "c1" }, mockSocket([]));
  assertEquals(w.length, 1);
  assertEquals(w[0]!.includes("invalid envelope"), true);
});

Deno.test("handleSync rejects empty clientId", () => {
  const w: string[] = [];
  createServerSyncHandler(mockDeps(w))
    .handleSync({ clientId: "", cells: {} }, { id: "c1" }, mockSocket([]));
  assertEquals(w.length, 1);
});

Deno.test("handleSync rejects non-object cells", () => {
  const w: string[] = [];
  createServerSyncHandler(mockDeps(w))
    .handleSync({ clientId: "c1", cells: "bad" }, { id: "c1" }, mockSocket([]));
  assertEquals(w.length, 1);
});

Deno.test("handleSync rejects non-array pendingOps", () => {
  const w: string[] = [];
  createServerSyncHandler(mockDeps(w))
    .handleSync(
      { clientId: "c1", cells: {}, pendingOps: "bad" },
      { id: "c1" },
      mockSocket([]),
    );
  assertEquals(w.length, 1);
});

Deno.test("handleSync accepts valid envelope", async () => {
  const w: string[] = [];
  const sent: string[] = [];
  createServerSyncHandler(mockDeps(w))
    .handleSync(
      { clientId: "c1", cells: { todos: { lastHlc: null } } },
      { id: "c1" },
      mockSocket(sent),
    );
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(w.length, 0);
  assertEquals(sent.length, 1);
});
