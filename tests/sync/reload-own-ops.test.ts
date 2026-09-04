// tests/sync/reload-own-ops.test.ts — a reload must rebuild the client's OWN
// history, not just its peers'.
//
// The client's confirmed state does not survive a page load (the engine is
// re-seeded from the cell's initialState) and neither does its cursor, so the
// catch-up has to rebuild the cell from the whole op-log. But the server
// filters the client's own ops out of that response — an old, correct rule for
// a LIVE client (its own in-flight ops arrive as acks, and folding them twice
// would double them) applied to one that has nothing at all. Every edit the
// user made before the reload is in the log, on the server, on every peer's
// screen — and missing from theirs.
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

const CELL = "notes";
const silentLog = { debug: () => {}, warn: () => {}, error: () => {} };

const add = (
  s: Record<string, unknown>,
  payload: unknown,
): Record<string, unknown> => ({
  items: [...(s.items as string[] ?? []), payload as string],
});

/** One page load: a fresh engine and a fresh (empty) confirmed state, with the
 *  SAME persisted client identity — exactly what `initBrowserSync` does. */
function boot(clientId: string, storage = createMemoryStorage()) {
  let confirmed: Record<string, unknown> = { items: [] };
  const sent: string[] = [];
  const engine = createSyncEngine({
    clientId,
    cells: { [CELL]: normalizeSyncConfig(true) },
    buffer: createOpBuffer(storage),
    send: (m) => sent.push(m),
    reducer: (s, action, payload) => action === "add" ? add(s, payload) : s,
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_c, s) => {
      confirmed = s;
    },
    onStateUpdate: () => {},
  });
  return { engine, sent, confirmed: () => confirmed };
}

// Stamped relative to NOW: an UNKNOWN op stamped older than the server's
// tombstone window is refused by name (`STALE_OP_REASON`), and an epoch-era
// literal is an ordering label, not "an op from 1970". Offsets keep order.
const T0 = Date.now();

Deno.test("a reloaded client gets its own past edits back, not just its peers'", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    let live: Record<string, unknown> = { items: [] };
    const handler = createServerSyncHandler({
      dispatch: (a) => {
        live = add(live, (a as { payload: unknown }).payload);
      },
      db,
      syncCellIds: [CELL],
      getCellState: () => live,
      getClientCellState: () => live,
      broadcastRaw: { fn: () => {} },
      log: silentLog,
    });
    const { socket, frames } = recordingSocket();
    const dead = { send: () => {} } as unknown as WebSocket;

    // Session 1: the user writes two notes; a peer writes one.
    await handler.handleOp(
      {
        id: "m1",
        hlc: [T0 + 0, 0, "me"] as HLC,
        cell: CELL,
        action: "add",
        payload: "mine-1",
      },
      { id: "me" },
      dead,
    );
    await handler.handleOp(
      {
        id: "p1",
        hlc: [T0 + 1, 0, "peer"] as HLC,
        cell: CELL,
        action: "add",
        payload: "peer-1",
      },
      { id: "peer" },
      dead,
    );
    await handler.handleOp(
      {
        id: "m2",
        hlc: [T0 + 2, 0, "me"] as HLC,
        cell: CELL,
        action: "add",
        payload: "mine-2",
      },
      { id: "me" },
      dead,
    );
    assertEquals(live.items, ["mine-1", "peer-1", "mine-2"], "server truth");

    // Session 2: page reload — no confirmed state, no cursor, same identity.
    const s2 = boot("me");
    await s2.engine.requestSync();
    handler.handleSync(JSON.parse(s2.sent[0]!).d, { id: "me" }, socket);
    await until(() => frames.some((f) => f.t === "sync-res"), "sync-res");
    // deno-lint-ignore no-explicit-any
    await s2.engine.handleSyncResponse(
      frames.find((f) => f.t === "sync-res")!.d as any,
    );

    assertEquals(
      s2.confirmed().items,
      live.items,
      "a reload must restore the whole cell — the user's own edits included",
    );
  } finally {
    close();
  }
});

Deno.test("a reload with a still-unsent op applies it exactly once", async () => {
  // The other half of the same rule: an op the log now echoes back to us AND
  // that we are still waiting on an ack for must be folded once, not twice.
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    let live: Record<string, unknown> = { items: [] };
    const handler = createServerSyncHandler({
      dispatch: (a) => {
        live = add(live, (a as { payload: unknown }).payload);
      },
      db,
      syncCellIds: [CELL],
      getCellState: () => live,
      getClientCellState: () => live,
      broadcastRaw: { fn: () => {} },
      log: silentLog,
    });
    const { socket, frames } = recordingSocket();
    await handler.handleOp(
      {
        id: "p1",
        hlc: [T0 + 0, 0, "peer"] as HLC,
        cell: CELL,
        action: "add",
        payload: "peer-1",
      },
      { id: "peer" },
      { send: () => {} } as unknown as WebSocket,
    );

    // The offline queue survives the reload; the cursor and confirmed state
    // do not.
    const storage = createMemoryStorage();
    await storage.saveOp({
      id: "queued",
      cell: CELL,
      action: "add",
      payload: "mine-offline",
      hlc: [T0 + 1, 0, "me"],
      confirmed: false,
      _clientTs: Date.now(),
    });

    const s = boot("me", storage);
    await s.engine.requestSync();
    handler.handleSync(JSON.parse(s.sent[0]!).d, { id: "me" }, socket);
    await until(() => frames.some((f) => f.t === "sync-res"), "sync-res");
    for (const f of frames) {
      if (f.t === "sync-ack") {
        await s.engine.handleAck(
          f.d.cell as string,
          f.d.opId as string,
          f.d.serverHlc as HLC,
          f.d.serverTs as number | undefined,
        );
      } else if (f.t === "sync-res") {
        // deno-lint-ignore no-explicit-any
        await s.engine.handleSyncResponse(f.d as any);
      }
    }

    assertEquals(live.items, ["peer-1", "mine-offline"], "server truth");
    assertEquals(
      s.confirmed().items,
      live.items,
      "the queued op must land once, in the server's position",
    );
  } finally {
    close();
  }
});
