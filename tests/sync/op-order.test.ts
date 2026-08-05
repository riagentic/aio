// tests/sync/op-order.test.ts — confirmed state must be folded in the SERVER's
// apply order, not in frame-arrival order.
//
// The client's confirmed state is built by replaying ops one at a time through
// the cell's reducer. That is only equal to the server's state if the client
// folds them in the same ORDER the server did — the reducers real apps write
// (`s.value = x`, `s.items = s.items.filter(...)`) are not commutative, so a
// different order is a different state, permanently, with nothing to compare
// against.
//
// The order is the order the frames arrive in, and the server controls that.
// `handleSync` persists (and therefore applies) a reconnecting client's queued
// ops AFTER every op already in the log — but it sent the ACK for them BEFORE
// the catch-up response carrying that log. The client folded its own op first
// and the older peer ops on top: its own edit silently overwritten on its own
// screen while every other client, and the server, kept it.
import { assertEquals } from "@std/assert";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../../src/sync/server-store.ts";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import type { HLC } from "../../src/sync/types.ts";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";

const CELL = "board";
const silentLog = { debug: () => {}, warn: () => {}, error: () => {} };

/** Deliberately order-sensitive — the shape of `s.value = x` that every real
 *  app writes. Under any other fold order the answer is simply different. */
const reduce = (
  s: Record<string, unknown>,
  action: string,
  payload: unknown,
): Record<string, unknown> => action === "set" ? { ...s, value: payload } : s;

function makeClient(clientId: string) {
  let confirmed: Record<string, unknown> = { value: "initial" };
  const sent: string[] = [];
  const engine = createSyncEngine({
    clientId,
    cells: { [CELL]: normalizeSyncConfig(true) },
    buffer: createOpBuffer(createMemoryStorage()),
    send: (m) => sent.push(m),
    reducer: (s, action, payload) => reduce(s, action, payload),
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_c, s) => {
      confirmed = s;
    },
    onStateUpdate: () => {},
  });
  return { engine, sent, confirmed: () => confirmed };
}

Deno.test("a reconnecting client folds its own queued op in the server's order, not the ack's", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    let live: Record<string, unknown> = { value: "initial" };
    const handler = createServerSyncHandler({
      dispatch: (a) => {
        const m = a as { type: string; payload?: unknown };
        live = reduce(live, m.type.slice(m.type.indexOf(":") + 1), m.payload);
      },
      db,
      syncCellIds: [CELL],
      getCellState: () => live,
      getClientCellState: () => live,
      broadcastRaw: { fn: () => {} },
      log: silentLog,
    });

    // ── a peer writes while our client is offline ──────────────────────
    await handler.handleOp(
      {
        id: "peer-1",
        hlc: [1000, 0, "peer"] as HLC,
        cell: CELL,
        action: "set",
        payload: "peer-value",
      },
      { id: "peer" },
      { send: () => {} } as unknown as WebSocket,
    );

    // ── our client edits offline, then reconnects ──────────────────────
    const c = makeClient("me");
    c.engine.setOnline(false);
    await c.engine.handleLocalAction(CELL, "set", "mine");
    c.sent.length = 0;
    c.engine.setOnline(true); // flushes the queue via a sync-req
    await until(() => c.sent.length > 0, "sync-req");

    const { socket, frames } = recordingSocket();
    handler.handleSync(JSON.parse(c.sent[0]!).d, { id: "me" }, socket);
    await until(() => frames.some((f) => f.t === "sync-res"), "sync-res");

    // The server applied peer-1 first and our op second — that is the truth.
    assertEquals(live.value, "mine", "server applied the queued op last");

    // Deliver every frame in the order the socket sent it (TCP is FIFO).
    for (const f of frames) {
      if (f.t === "sync-ack") {
        await c.engine.handleAck(
          f.d.cell as string,
          f.d.opId as string,
          f.d.serverHlc as HLC,
          f.d.serverTs as number | undefined,
        );
      } else if (f.t === "sync-res") {
        // deno-lint-ignore no-explicit-any
        await c.engine.handleSyncResponse(f.d as any);
      }
    }

    assertEquals(
      c.confirmed().value,
      live.value,
      "the client must converge on the server's value — folding the catch-up " +
        "on top of its own already-acked op silently reverts its own edit",
    );
  } finally {
    close();
  }
});
