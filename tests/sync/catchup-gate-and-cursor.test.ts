// tests/sync/catchup-gate-and-cursor.test.ts — L1, L2, L3.
//
// L1: a cell the server decided it must NOT serve (its `ui` config hides it)
//     still had its reserved cursor echoed — the client advanced past ops it
//     was never sent and never asked again.
// L2: two catch-ups can be outstanding at once; response #1 opened the
//     ordering gate for response #2 as well, so frames arriving between them
//     applied AHEAD of the older ops #2 was carrying.
// L3: a bare re-ack (the server cannot state the op's position) under an
//     installed snapshot is ambiguous — it must never be resolved silently.
import { assert, assertEquals } from "@std/assert";
import { captureConsoleAsync } from "../console-capture.ts";
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
import { compactSyncOps } from "../../src/sync/compact.ts";
import type { HLC, SyncOp } from "../../src/sync/types.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";

const CELL = "cell";

const peer = (id: string, ts: number): SyncOp => ({
  id,
  cell: CELL,
  action: "add",
  payload: { id },
  hlc: [1000 + ts, 0, "peer"] as HLC,
  confirmed: true,
  serverTs: ts,
});

function makeEngine() {
  const buffer = createOpBuffer(createMemoryStorage());
  let confirmed: Record<string, unknown> = { items: [] };
  const sent: string[] = [];
  const engine = createSyncEngine({
    clientId: "me",
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
  return { engine, buffer, sent, items: () => confirmed.items as string[] };
}

// ── L1 ─────────────────────────────────────────────────────────────────
Deno.test("L1: a cell that cannot be served gets no cursor echo", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const handler = createServerSyncHandler({
      dispatch: () => {},
      db,
      syncCellIds: [CELL],
      getCellState: () => ({ items: [] }),
      // `ui: "none"` — the cell must not go out on a socket at all.
      getClientCellState: () => null,
      broadcastRaw: { fn: () => {} },
      log: { debug: () => {}, warn: () => {}, error: () => {} },
    });
    // Compact so the client's cursor sits below the compaction boundary —
    // that is the branch that must answer with a snapshot, and therefore the
    // branch that refuses.
    await persistOp(db, {
      id: "o1",
      hlc: [1000, 0, "peer"] as HLC,
      cell: CELL,
      action: "add",
      payload: { id: "o1" },
    });
    await compactSyncOps({
      db,
      cell: CELL,
      getState: () => ({ items: ["o1"] }),
      serverHlc: [2000, 0, "server"],
      compactOps: 1,
      log: { debug: () => {}, warn: () => {}, error: () => {} },
    });
    const { socket, frames } = recordingSocket();
    handler.handleSync(
      {
        clientId: "c1",
        cells: { [CELL]: { lastHlc: null, lastServerTs: 1 } },
        pendingOps: [],
      },
      { id: "s1" },
      socket,
    );
    await until(() => frames.some((f) => f.t === "sync-res"), "sync response");
    const res = frames.find((f) => f.t === "sync-res")!.d as {
      lastServerTs?: Record<string, number>;
      snapshot?: Record<string, unknown>;
    };
    assertEquals(res.snapshot?.[CELL], undefined, "nothing was served");
    assertEquals(
      res.lastServerTs?.[CELL],
      undefined,
      "a reserved cursor for a cell that was served NOTHING must be withdrawn",
    );
  } finally {
    close();
  }
});

// ── L2 ─────────────────────────────────────────────────────────────────
Deno.test("L2: response #1 does not open the ordering gate for response #2", async () => {
  const { engine, sent, items } = makeEngine();

  // Two catch-ups in flight (a reconnect while a manual sync is outstanding).
  await engine.requestSync();
  await engine.requestSync();
  const reqIds = sent.map((m) => JSON.parse(m)).filter((m) =>
    m.t === "sync-req"
  ).map((m) => m.d.reqId);
  assertEquals(reqIds.length, 2);
  assert(reqIds[1] > reqIds[0], "each request carries a fresh id");

  // A broadcast lands while both are outstanding. Response #1 folds it — with
  // its own ops, in server order — but must NOT re-open the gate.
  await engine.handleRemoteOp(peer("live-1", 20));
  await engine.handleSyncResponse({
    mode: "incremental",
    reqId: reqIds[0],
    ops: [peer("first", 15)],
    lowWater: {},
    lastServerTs: { [CELL]: 20 },
  });
  assertEquals(
    items(),
    ["first", "live-1"],
    "a response always drains the queue, sorted by server position",
  );

  // The gate is still shut, so this one is HELD rather than applied now…
  await engine.handleRemoteOp(peer("live-2", 30));
  assertEquals(
    items(),
    ["first", "live-1"],
    "an older response must not open the gate for the outstanding one",
  );

  // …and response #2 carries an op OLDER than it (position 25), which must
  // therefore fold first. With the gate wrongly open, live-2 was already in.
  await engine.handleSyncResponse({
    mode: "incremental",
    reqId: reqIds[1],
    ops: [peer("older", 25)],
    lowWater: {},
    lastServerTs: { [CELL]: 30 },
  });
  assertEquals(
    items(),
    ["first", "live-1", "older", "live-2"],
    "the fold order must be the server's (by position), not arrival order",
  );
});

Deno.test("L2: a server that does not echo reqId keeps the previous behaviour", async () => {
  const { engine, items } = makeEngine();
  await engine.requestSync();
  await engine.handleRemoteOp(peer("held", 20));
  await engine.handleSyncResponse({
    mode: "incremental",
    ops: [peer("older", 5)],
    lowWater: {},
    lastServerTs: { [CELL]: 20 },
  });
  assertEquals(items(), ["older", "held"], "any response opens the gate");
});

Deno.test("L2: the gate re-opens on the next answered request after a lost response", async () => {
  // A response that never arrives must not freeze the cell: the next request
  // is a new id, and its answer opens the gate.
  const { engine, sent, items } = makeEngine();
  await engine.requestSync(); // #1 — its response is lost
  await engine.requestSync(); // #2
  await engine.handleRemoteOp(peer("held", 20));
  const ids = sent.map((m) => JSON.parse(m)).filter((m) => m.t === "sync-req")
    .map((m) => m.d.reqId);
  await engine.handleSyncResponse({
    mode: "incremental",
    reqId: ids[1],
    ops: [],
    lowWater: {},
    lastServerTs: { [CELL]: 20 },
  });
  assertEquals(items(), ["held"]);
});

// ── L3 ─────────────────────────────────────────────────────────────────
Deno.test("L3: a bare re-ack under an installed snapshot is never resolved silently", async () => {
  const { engine, buffer } = makeEngine();
  // Install a snapshot with a known watermark.
  await engine.handleSyncResponse({
    mode: "snapshot",
    snapshot: { [CELL]: { items: ["from-snapshot"] } },
    ops: [],
    lowWater: {},
    lastServerTs: { [CELL]: 100 },
  });
  // An op of ours is still pending…
  await buffer.add({
    id: "mine-1",
    cell: CELL,
    action: "add",
    payload: { id: "mine-1" },
    hlc: [900, 0, "me"] as HLC,
    confirmed: false,
  });
  // …and the server re-acks it WITHOUT a position (a compaction tombstone
  // written before the server_ts column existed).
  const lines = await captureConsoleAsync(async () => {
    await engine.handleAck(CELL, "mine-1", [2000, 0, "server"]);
  });
  assert(
    lines.some((l) =>
      l.includes("mine-1") && /position|snapshot/.test(l) && /reload/.test(l)
    ),
    `the ambiguity must be reported with a way out — got ${
      JSON.stringify(lines)
    }`,
  );
});
