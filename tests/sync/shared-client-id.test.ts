// tests/sync/shared-client-id.test.ts — M4 regression.
//
// The client id is a localStorage UUID, so two live clients CAN carry the same
// one: a cloned browser profile, a copied Electron app directory, a restored
// backup. Echo suppression keyed on that id alone ("this op's HLC node is me →
// it is my own op coming back") then made the two clones mutually invisible,
// permanently and silently: each dropped the other's ops as its own echo on
// the broadcast path, and the server filtered them out of each catch-up as
// "the client's own ops" too.
//
// Identity for echo suppression has to be per SESSION, not per install. Op ids
// already carry a session nonce (`clientId-session-counter`) — that is the
// mechanism, reused: a genuine echo is still suppressed, a clone is visible.
import { assert, assertEquals } from "@std/assert";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import {
  _resetServerTsForTest,
  persistOp,
} from "../../src/sync/server-store.ts";
import type { HLC, SyncOp } from "../../src/sync/types.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";

const CELL = "clip";
const SHARED = "sameid00"; // both clones read the same localStorage UUID

function makeClone() {
  const buffer = createOpBuffer(createMemoryStorage());
  let confirmed: Record<string, unknown> = { items: [] };
  const sent: string[] = [];
  const engine = createSyncEngine({
    clientId: SHARED,
    cells: { [CELL]: normalizeSyncConfig(true) },
    buffer,
    send: (m) => sent.push(m),
    reducer: (s, _a, p) => ({
      items: [...(s.items as string[]), (p as { id: string }).id],
    }),
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_c, s) => {
      confirmed = s;
    },
    onStateUpdate: () => {},
    log: { warn: () => {}, debug: () => {} },
  });
  return { engine, buffer, sent, confirmed: () => confirmed };
}

/** The "op" frame the engine emitted, as the server would relay it. */
function lastOpFrame(sent: string[], serverTs: number): SyncOp {
  const f = sent.map((m) => JSON.parse(m)).findLast((m) => m.t === "op");
  assert(f, `no op frame in ${sent.join(" | ")}`);
  return { ...f.d, confirmed: true, serverTs } as SyncOp;
}

Deno.test("M4: a clone's op is applied, not swallowed as an own-op echo", async () => {
  const a = makeClone();
  const b = makeClone();

  await a.engine.handleLocalAction(CELL, "add", { id: "from-a" });
  const opFromA = lastOpFrame(a.sent, 10);
  assertEquals(opFromA.hlc[2], SHARED, "both clones stamp the same HLC node");

  // The server broadcasts it to every other socket — including the clone.
  await b.engine.handleRemoteOp(opFromA);
  assertEquals(
    b.confirmed().items,
    ["from-a"],
    "a clone is a DIFFERENT client: its ops must be applied",
  );

  // …and the reverse direction works too.
  await b.engine.handleLocalAction(CELL, "add", { id: "from-b" });
  const opFromB = lastOpFrame(b.sent, 11);
  await a.engine.handleRemoteOp(opFromB);
  assertEquals(a.confirmed().items, ["from-b"]);
});

Deno.test("M4: a genuine own-op echo is still suppressed", async () => {
  // The reconnect race the suppression exists for: the server excludes the
  // socket an op arrived on, but after a reconnect this client holds a NEW
  // socket, so its own op comes back as a broadcast. Applying it AND the ack
  // would double it.
  const a = makeClone();
  await a.engine.handleLocalAction(CELL, "add", { id: "mine" });
  const own = lastOpFrame(a.sent, 12);

  await a.engine.handleRemoteOp(own);
  assertEquals(
    a.confirmed().items,
    [],
    "an own op reaches confirmed state through its ACK, never the echo",
  );

  // The ack lands: exactly one application.
  await a.engine.handleAck(CELL, own.id, [2000, 0, "server"], 12);
  assertEquals(a.confirmed().items, ["mine"]);
});

Deno.test("M4: an unconfirmed op resent from a previous session is still suppressed", async () => {
  // A reload keeps the offline queue but starts a new session nonce, so a
  // resent op carries the OLD prefix. It is still ours and still awaiting an
  // ack — the pending buffer is what says so.
  const a = makeClone();
  const stale: SyncOp = {
    id: `${SHARED}-oldsess-1`,
    cell: CELL,
    action: "add",
    payload: { id: "resent" },
    hlc: [1000, 0, SHARED] as HLC,
    confirmed: false,
  };
  await a.buffer.add(stale);
  await a.engine.handleRemoteOp({ ...stale, confirmed: true, serverTs: 13 });
  assertEquals(
    a.confirmed().items,
    [],
    "an op we are still awaiting an ack for enters confirmed state via the ack",
  );
});

Deno.test("M4 (server): a catch-up carries the clone's ops but not the requester's own", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const handler = createServerSyncHandler({
      dispatch: () => {},
      db,
      syncCellIds: [CELL],
      getCellState: () => ({}),
      getClientCellState: () => ({}),
      broadcastRaw: { fn: () => {} },
      log: { debug: () => {}, warn: () => {}, error: () => {} },
    });
    // Both clones wrote, both stamped with the shared HLC node.
    await persistOp(db, {
      id: `${SHARED}-sessA-1`,
      hlc: [1000, 0, SHARED] as HLC,
      cell: CELL,
      action: "add",
      payload: { id: "from-a" },
    });
    await persistOp(db, {
      id: `${SHARED}-sessB-1`,
      hlc: [1001, 0, SHARED] as HLC,
      cell: CELL,
      action: "add",
      payload: { id: "from-b" },
    });

    const { socket, frames } = recordingSocket();
    handler.handleSync(
      {
        clientId: SHARED,
        session: "sessB",
        cells: { [CELL]: { lastHlc: null, lastServerTs: 1 } },
        pendingOps: [],
      },
      { id: "s1" },
      socket,
    );
    await until(() => frames.some((f) => f.t === "sync-res"), "sync response");
    const ops = (frames.find((f) => f.t === "sync-res")!.d as {
      ops: SyncOp[];
    }).ops;
    const ids = ops.map((o) => o.id);
    assert(
      ids.includes(`${SHARED}-sessA-1`),
      `the clone's op must be delivered — got ${JSON.stringify(ids)}`,
    );
    assert(
      !ids.includes(`${SHARED}-sessB-1`),
      `the requester's own op must NOT be echoed — got ${JSON.stringify(ids)}`,
    );
  } finally {
    close();
  }
});

Deno.test("M4 (server): without a session, the old client-id filter still applies", async () => {
  // A client built before the session field simply omits it; the server must
  // keep its previous behaviour rather than start echoing its own ops back.
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const handler = createServerSyncHandler({
      dispatch: () => {},
      db,
      syncCellIds: [CELL],
      getCellState: () => ({}),
      getClientCellState: () => ({}),
      broadcastRaw: { fn: () => {} },
      log: { debug: () => {}, warn: () => {}, error: () => {} },
    });
    await persistOp(db, {
      id: "legacy-1",
      hlc: [1000, 0, SHARED] as HLC,
      cell: CELL,
      action: "add",
      payload: { id: "mine" },
    });
    const { socket, frames } = recordingSocket();
    handler.handleSync(
      {
        clientId: SHARED,
        cells: { [CELL]: { lastHlc: null, lastServerTs: 1 } },
        pendingOps: [],
      },
      { id: "s1" },
      socket,
    );
    await until(() => frames.some((f) => f.t === "sync-res"), "sync response");
    const ops = (frames.find((f) => f.t === "sync-res")!.d as {
      ops: SyncOp[];
    }).ops;
    assertEquals(ops.map((o) => o.id), []);
  } finally {
    close();
  }
});
