// An op that fails `isValidSyncOp` but still carries an addressable id and
// cell is REFUSED with `op-rejected` — on the `op` frame and in
// `sync-req.pendingOps` alike.
//
// Both doors used to skip it with a server-side warn only. Every other refusal
// on these paths (unknown cell, quarantine, refused-before, clock drift, access
// denied, stale) tells the origin, because an op the server never answers is
// re-sent on every reconnect, forever, and `onRejected` never fires. An entry
// with a malformed HLC (a skewed / older bundle) or a reserved action name took
// the one exit that said nothing. D11: the origin is always told.
import { assert, assertEquals } from "@std/assert";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import { createOpBuffer } from "../../src/sync/op-buffer.ts";
import { createMemoryStorage } from "./_memory-storage.ts";
import { createTestDb } from "./_test-db.ts";

const CELL = "notes";
type Frame = { t: string; d: Record<string, unknown> };

function setup() {
  const { db, close } = createTestDb();
  const frames: Frame[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (m: string) => frames.push(JSON.parse(m)),
  } as unknown as WebSocket;
  const warns: string[] = [];
  const dispatched: unknown[] = [];
  const handler = createServerSyncHandler({
    dispatch: (a) => {
      dispatched.push(a);
    },
    db,
    syncCellIds: [CELL],
    getCellState: () => ({ items: [] }),
    getClientCellState: () => ({ items: [] }),
    broadcastRaw: { fn: () => {} },
    log: { debug: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  return { handler, socket, frames, warns, dispatched, close };
}

Deno.test("sync-req: an invalid pending op with an addressable id is refused out loud", async () => {
  const { handler, socket, frames, warns, dispatched, close } = setup();
  try {
    const badId = "c1-s1-7.0123456789ab";
    handler.handleSync(
      {
        clientId: "c1",
        session: "s1",
        cells: { [CELL]: { lastHlc: null } },
        pendingOps: [
          // id + cell are fine; the HLC is a 2-tuple (skewed bundle).
          { id: badId, cell: CELL, action: "add", payload: {}, hlc: [1, 2] },
          // Nothing addressable: there is no id to refuse — warn only.
          { cell: CELL, action: "add", payload: {}, hlc: [1, 2, "c1"] },
        ],
      },
      { id: "c1" },
      socket,
    );
    await new Promise((r) => setTimeout(r, 50));

    assert(
      warns.some((w) => w.includes("invalid pending op")),
      `precondition: the entry was judged invalid: ${JSON.stringify(warns)}`,
    );
    assert(
      frames.some((f) => f.t === "sync-res"),
      `the rest of the request is still answered: ${JSON.stringify(frames)}`,
    );
    const rejected = frames.filter((f) => f.t === "op-rejected");
    assertEquals(rejected.length, 1, JSON.stringify(frames));
    assertEquals(rejected[0]!.d.opId, badId);
    assertEquals(rejected[0]!.d.cell, CELL);
    assert(
      typeof rejected[0]!.d.reason === "string" &&
        (rejected[0]!.d.reason as string).length > 0,
    );
    assertEquals(dispatched, []);
  } finally {
    close();
  }
});

Deno.test("sync handleOp: an invalid op with an addressable id is refused out loud", async () => {
  const { handler, socket, frames, dispatched, close } = setup();
  try {
    const badId = "c1-s1-8.0123456789ab";
    await handler.handleOp(
      // A framework-internal action name: never a legal sync op.
      {
        id: badId,
        cell: CELL,
        action: "__setRefresh",
        payload: {},
        hlc: [Date.now(), 0, "c1"],
      },
      { id: "c1" },
      socket,
    );
    const rejected = frames.filter((f) => f.t === "op-rejected");
    assertEquals(rejected.length, 1, JSON.stringify(frames));
    assertEquals(rejected[0]!.d.opId, badId);
    assertEquals(rejected[0]!.d.cell, CELL);
    assertEquals(dispatched, []);

    // Not addressable (no string id): nothing to refuse, no frame.
    frames.length = 0;
    await handler.handleOp(
      { cell: CELL, action: "add", payload: {}, hlc: [1, 2, "c1"] },
      { id: "c1" },
      socket,
    );
    assertEquals(frames, []);
  } finally {
    close();
  }
});

Deno.test("sync engine: op-rejected for a malformed queued op drops it from the queue", async () => {
  const storage = createMemoryStorage();
  const rejected: string[] = [];
  const engine = createSyncEngine({
    clientId: "c1",
    cells: {
      [CELL]: {
        ...normalizeSyncConfig(true),
        onRejected: ({ opId }: { opId: string }) => rejected.push(opId),
      },
    },
    buffer: createOpBuffer(storage),
    send: () => {},
    reducer: (s: Record<string, unknown>) => s,
    getConfirmedState: () => ({ [CELL]: {} }),
    setConfirmedState: () => {},
    onStateUpdate: () => {},
    log: { warn: () => {}, debug: () => {} },
  });
  try {
    // A queued op the server cannot accept — the HLC a skewed bundle wrote.
    const badId = "c1-old-1.0123456789ab";
    await storage.saveOp({
      id: badId,
      cell: CELL,
      action: "add",
      payload: {},
      hlc: [1, 2] as unknown as [number, number, string],
      confirmed: false,
      _clientTs: Date.now(),
    });
    await engine.handleRejection(CELL, badId, "invalid sync op");
    assertEquals(await storage.countUnconfirmed(CELL), 0);
    assertEquals(engine.getStatus(CELL).pending, 0);
    assertEquals(rejected, [badId]);
  } finally {
    engine.dispose();
  }
});
