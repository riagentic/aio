// One question — "can this client still be served from the op log?" — and it
// gets ONE answer: its `server_ts` cursor against the position the cell's
// snapshot reflects (`compacted_ts`).
//
// Everything below that mark is either deleted from the log or was never an op
// at all (a server-origin write changes state without producing one), so an
// incremental response to such a cursor is a lie: the client is told it is up
// to date while its confirmed state silently diverges — forever, because the
// cursor echo then seals the gap.
//
// The versions of this decision that did NOT hold, each pinned by a test
// below: keyed on `lastHlc` alone (a client can hold a cursor with no HLC);
// scoped to clients with no `lastHlc` (an HLC is a maximum, not coverage);
// keyed on the highest DELETED ts (with an empty log that is 0, and a
// cursorless client is not below 0).
import { assert, assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import type { DB, QueryResult, Tx } from "../../src/db/types.ts";
import {
  applySyncMigrations,
  compactSyncOps,
  SYNC_SCHEMA,
} from "../../src/sync/compact.ts";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { getCompactedTs } from "../../src/sync/server-store.ts";
import type { HLC } from "../../src/sync/types.ts";

// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;
function createDb(): DB {
  const sqlite = new DatabaseSync(":memory:");
  for (const stmt of SYNC_SCHEMA) sqlite.exec(stmt);
  const query = <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) =>
    Promise.resolve({
      rows: sqlite.prepare(sql).all(..._p(params ?? [])) as T[],
      changes: 0,
      lastInsertRowId: 0n,
    } as QueryResult<T>);
  const execute = (sql: string, params?: unknown[]) => {
    const r = sqlite.prepare(sql).run(..._p(params ?? []));
    return Promise.resolve({
      rows: [],
      changes: Number(r.changes),
      lastInsertRowId: BigInt(r.lastInsertRowid),
    } as QueryResult);
  };
  const transaction = (async (arg: unknown) => {
    if (typeof arg === "function") {
      return await (arg as (tx: Tx) => Promise<unknown>)({ query, execute });
    }
    const out: QueryResult[] = [];
    for (const s of arg as { sql: string; params?: unknown[] }[]) {
      out.push(await execute(s.sql, s.params));
    }
    return out;
    // deno-lint-ignore no-explicit-any
  }) as any;
  return { query, execute, transaction, close: () => Promise.resolve() };
}

/** Insert an op row exactly as `persistOp` would. */
async function addOp(
  db: DB,
  id: string,
  hlc: HLC,
  serverTs: number,
): Promise<void> {
  await db.execute(
    `INSERT INTO sync_ops (id, cell, action, payload, hlc_phys, hlc_cnt, hlc_node, server_ts)
     VALUES (?, 'notes', 'add', ?, ?, ?, ?, ?)`,
    [id, JSON.stringify({ text: id }), hlc[0], hlc[1], hlc[2], serverTs],
  );
}

// This test used to seed an op with a far-future HLC and assert it SURVIVED a
// compaction — encoding the bug as the contract. That op is in live state, so
// it is in the snapshot too, and leaving its row behind made the boot replay
// (snapshot + surviving ops) apply it twice, compounding on every restart. The
// boundary is now the one fact the snapshot is built from — everything already
// persisted, i.e. MAX(server_ts) — so an op's HLC cannot exempt it.
Deno.test("compaction deletes through MAX(server_ts) and records that watermark", async () => {
  const db = createDb();
  await addOp(db, "o1", [1000, 0, "peer"], 1);
  await addOp(db, "o2", [1000, 1, "peer"], 2);
  await addOp(db, "o3", [9999, 0, "fast-clock"], 3); // in live state → in the snapshot

  await compactSyncOps({
    db,
    cell: "notes",
    getState: () => ({ items: ["a", "b", "c"] }),
    serverHlc: [1000, 1, "server"],
    compactOps: 1, // force
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });

  const left = await db.query<{ id: string }>(
    "SELECT id FROM sync_ops ORDER BY id",
  );
  assertEquals(
    left.rows.map((r) => r.id),
    [],
    "everything the snapshot contains is gone from the log — including the " +
      "op whose author stamped it with a far-future HLC",
  );
  const mark = await getCompactedTs(db, "notes");
  assert(
    mark > 3,
    `the watermark is the position the SNAPSHOT reflects, strictly above ` +
      `every op it contains (got ${mark}, ops went up to 3)`,
  );

  // An op persisted AFTER the boundary is the one that legitimately survives.
  await addOp(db, "o4", [1001, 0, "peer"], mark + 1);
  const after = await db.query<{ id: string }>("SELECT id FROM sync_ops");
  assertEquals(after.rows.map((r) => r.id), ["o4"]);
  assertEquals(
    await getCompactedTs(db, "notes"),
    mark,
    "…and the watermark does not move until it too is compacted",
  );
});

Deno.test("a server_ts cursor below the compaction watermark gets a SNAPSHOT", async () => {
  const db = createDb();
  await addOp(db, "o1", [1000, 0, "peer"], 1);
  await addOp(db, "o2", [1000, 1, "peer"], 2);
  await compactSyncOps({
    db,
    cell: "notes",
    getState: () => ({ items: ["a", "b"] }),
    serverHlc: [1000, 1, "server"],
    compactOps: 1,
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });

  const sent: Record<string, unknown>[] = [];
  const handler = createServerSyncHandler({
    dispatch: () => {},
    db,
    syncCellIds: ["notes"],
    getCellState: () => ({ items: ["a", "b"] }),
    getClientCellState: () => ({ items: ["a", "b"] }),
    broadcastRaw: { fn: () => {} },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  const socket = {
    send: (m: string) => sent.push(JSON.parse(m)),
  } as unknown as WebSocket;

  // The exact shape the cursor-echo path leaves behind: a server_ts cursor
  // from a response that delivered nothing, and NO lastHlc.
  handler.handleSync(
    {
      clientId: "idle-client",
      cells: { notes: { lastHlc: null, lastServerTs: 1 } },
      pendingOps: [],
    },
    { id: "c1" },
    socket,
  );

  for (let i = 0; i < 200 && !sent.some((m) => m.t === "sync-res"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const res = sent.find((m) => m.t === "sync-res");
  assert(res, "a sync response is sent");
  const d = res!.d as { mode: string; snapshot?: Record<string, unknown> };
  assertEquals(
    d.mode,
    "snapshot",
    "the ops this client needs no longer exist — incremental would lie",
  );
  assert(d.snapshot?.notes, "and the snapshot carries the cell's state");
});

Deno.test("a caught-up cursor above the watermark still gets incremental", async () => {
  const db = createDb();
  await addOp(db, "o1", [1000, 0, "peer"], 1);
  await compactSyncOps({
    db,
    cell: "notes",
    getState: () => ({ items: ["a"] }),
    serverHlc: [1000, 0, "server"],
    compactOps: 1,
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  // A client that completed a sync round AFTER that compaction holds a cursor
  // at the snapshot's position: it has the snapshot's contents, so the log
  // tail is all it needs.
  const caughtUp = await getCompactedTs(db, "notes");
  await addOp(db, "o2", [2000, 0, "peer"], caughtUp + 5); // after the compaction

  const sent: Record<string, unknown>[] = [];
  const handler = createServerSyncHandler({
    dispatch: () => {},
    db,
    syncCellIds: ["notes"],
    getCellState: () => ({ items: ["a"] }),
    getClientCellState: () => ({ items: ["a"] }),
    broadcastRaw: { fn: () => {} },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  const socket = {
    send: (m: string) => sent.push(JSON.parse(m)),
  } as unknown as WebSocket;

  handler.handleSync(
    {
      clientId: "fresh-client",
      // Cursor at the watermark: this client already has the snapshot.
      cells: { notes: { lastHlc: null, lastServerTs: caughtUp } },
      pendingOps: [],
    },
    { id: "c2" },
    socket,
  );

  for (let i = 0; i < 200 && !sent.some((m) => m.t === "sync-res"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const d = sent.find((m) => m.t === "sync-res")!.d as {
    mode: string;
    ops: unknown[];
  };
  assertEquals(
    d.mode,
    "incremental",
    "no snapshot needed — nothing was missed",
  );
  assertEquals(d.ops.length, 1, "just the op it hasn't seen");
});

// The rule above was once scoped to clients with NO `lastHlc`, on the theory
// that an HLC watermark meant the low-water rule already judged the client
// correctly. It does not: `lastHlc` is the HIGHEST HLC seen, not a coverage
// watermark. One post-compaction broadcast lifts it above low_water while the
// server_ts cursor — which deliberately does NOT advance on broadcasts — still
// sits below the compaction boundary. Two cursors deciding one fact, and they
// disagreed exactly where it mattered: the client was served an incremental
// response for rows that no longer exist.
Deno.test("a stale server_ts cursor is served a snapshot even when lastHlc is fresh", async () => {
  const db = createDb();
  // Ops the client missed while it was disconnected…
  await addOp(db, "o1", [1000, 0, "peer"], 1);
  await addOp(db, "o2", [1000, 1, "peer"], 2);
  await compactSyncOps({
    db,
    cell: "notes",
    getState: () => ({ items: ["o1", "o2"] }),
    serverHlc: [1500, 0, "server"], // …and which compaction then deleted.
    compactOps: 1,
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  // A newer op, broadcast to the client as it reconnects — its lastHlc jumps
  // above the compaction low-water, its server_ts cursor does not move.
  await addOp(db, "o3", [2000, 0, "peer"], 5);

  const sent: Record<string, unknown>[] = [];
  const handler = createServerSyncHandler({
    dispatch: () => {},
    db,
    syncCellIds: ["notes"],
    getCellState: () => ({ items: ["o1", "o2", "o3"] }),
    getClientCellState: () => ({ items: ["o1", "o2", "o3"] }),
    broadcastRaw: { fn: () => {} },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  const socket = {
    send: (m: string) => sent.push(JSON.parse(m)),
  } as unknown as WebSocket;

  handler.handleSync(
    {
      clientId: "reconnector",
      cells: { notes: { lastHlc: [2000, 0, "peer"], lastServerTs: 0 } },
      pendingOps: [],
    },
    { id: "c1" },
    socket,
  );
  for (let i = 0; i < 200 && !sent.some((m) => m.t === "sync-res"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const d = sent.find((m) => m.t === "sync-res")!.d as {
    mode: string;
    snapshot?: Record<string, unknown>;
  };
  assertEquals(
    d.mode,
    "snapshot",
    "o1/o2 exist nowhere but the snapshot — an incremental response tells " +
      "this client it is up to date while it silently misses them forever",
  );
  assertEquals(d.snapshot?.notes, { items: ["o1", "o2", "o3"] });
});

// A sync cell's state does not have to come from ops at all: a server-origin
// write (effect, cron, serverFn) changes state and produces none, and
// compaction folds it into the snapshot — the cell's only durable home. The
// watermark used to be "the highest server_ts compaction deleted", which is 0
// when the log was empty, and `0 < 0` is false: a brand-new client was handed
// an empty incremental response and left sitting on its initialState with no
// way to ever learn otherwise.
Deno.test("a cursorless client gets the snapshot when the log alone cannot rebuild the cell", async () => {
  const db = createDb();
  const live = { items: ["written-by-the-server"] };
  const handler = createServerSyncHandler({
    dispatch: () => {},
    db,
    syncCellIds: ["notes"],
    getCellState: () => live,
    getClientCellState: () => live,
    broadcastRaw: { fn: () => {} },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  // The server-origin durability path: fold live state into the snapshot with
  // an EMPTY op log.
  handler.noteServerWrite("notes");
  await handler.flushServerWrites();

  const sent: Record<string, unknown>[] = [];
  const socket = {
    send: (m: string) => sent.push(JSON.parse(m)),
  } as unknown as WebSocket;
  handler.handleSync(
    {
      clientId: "brand-new",
      cells: { notes: { lastHlc: null, lastServerTs: 0 } },
      pendingOps: [],
    },
    { id: "c1" },
    socket,
  );
  for (let i = 0; i < 200 && !sent.some((m) => m.t === "sync-res"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const d = sent.find((m) => m.t === "sync-res")!.d as {
    mode: string;
    snapshot?: Record<string, Record<string, unknown>>;
  };
  assertEquals(
    d.mode,
    "snapshot",
    "the op log holds nothing — an incremental response leaves this client " +
      "on its initialState forever",
  );
  assertEquals(d.snapshot?.notes, live);
});

Deno.test("sync migrations are idempotent and safe on an existing database", async () => {
  const db = createDb();
  const warnings: string[] = [];
  const logs = {
    debug: () => {},
    warn: (m: string) => warnings.push(m),
  };
  await applySyncMigrations(db, logs); // column already present from SYNC_SCHEMA
  await applySyncMigrations(db, logs); // and again
  assertEquals(warnings, [], "an already-applied migration is not a warning");
  assertEquals(await getCompactedTs(db, "notes"), 0);
});

// ── The catch-up snapshot is a WIRE frame ─────────────────────────────────
//
// It was wired to raw `getState()`, so a client that fell behind compaction
// received the cell's whole slice — `ui: "none"` cells, excluded fields and
// all — while every other channel honoured the filter. Raw state still feeds
// COMPACTION (sync cells are excluded from KV persistence, so the compaction
// snapshot is their durability record and must keep everything); the two
// answers are now two different deps, and the client-facing one is required
// rather than defaulted, so it cannot be forgotten back into a fail-open.
Deno.test("a catch-up snapshot ships the client projection, never raw state", async () => {
  const db = createDb();
  await addOp(db, "o1", [1000, 0, "peer"], 1);
  const raw = { items: ["a"], apiSecret: "RAW-ONLY-NEVER-ON-THE-WIRE" };
  await compactSyncOps({
    db,
    cell: "notes",
    getState: () => raw,
    serverHlc: [1000, 0, "server"],
    compactOps: 1,
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });

  const sent: string[] = [];
  const handler = createServerSyncHandler({
    dispatch: () => {},
    db,
    syncCellIds: ["notes"],
    getCellState: () => raw, // compaction/durability — the whole slice
    getClientCellState: () => ({ items: raw.items }), // ui: { exclude: [...] }
    broadcastRaw: { fn: () => {} },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  const socket = { send: (m: string) => sent.push(m) } as unknown as WebSocket;
  handler.handleSync(
    {
      clientId: "behind",
      cells: { notes: { lastHlc: null, lastServerTs: 0 } },
      pendingOps: [],
    },
    { id: "c1" },
    socket,
  );
  for (let i = 0; i < 200 && !sent.some((m) => m.includes("sync-res")); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const wire = sent.join("|");
  assert(wire.includes("sync-res"), "a sync response is sent");
  assert(
    !wire.includes("RAW-ONLY-NEVER-ON-THE-WIRE"),
    `the snapshot shipped a field the ui filter hides:\n${wire}`,
  );
  const d = JSON.parse(sent.find((m) => m.includes("sync-res"))!).d as {
    mode: string;
    snapshot: Record<string, Record<string, unknown>>;
  };
  assertEquals(d.mode, "snapshot");
  assertEquals(d.snapshot.notes, { items: ["a"] }, "…and the rest still ships");
});

Deno.test("a cell the ui hides entirely is never snapshotted to a client", async () => {
  const db = createDb();
  await addOp(db, "o1", [1000, 0, "peer"], 1);
  await compactSyncOps({
    db,
    cell: "notes",
    getState: () => ({ items: ["a"], body: "HIDDEN-CELL-BODY" }),
    serverHlc: [1000, 0, "server"],
    compactOps: 1,
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  const sent: string[] = [];
  const errors: string[] = [];
  const handler = createServerSyncHandler({
    dispatch: () => {},
    db,
    syncCellIds: ["notes"],
    getCellState: () => ({ items: ["a"], body: "HIDDEN-CELL-BODY" }),
    // `ui: "none"` — the cell is absent from the client projection entirely.
    getClientCellState: () => null,
    broadcastRaw: { fn: () => {} },
    log: {
      debug: () => {},
      warn: () => {},
      error: (m: string) => errors.push(m),
    },
  });
  const socket = { send: (m: string) => sent.push(m) } as unknown as WebSocket;
  handler.handleSync(
    {
      clientId: "behind",
      cells: { notes: { lastHlc: null, lastServerTs: 0 } },
      pendingOps: [],
    },
    { id: "c1" },
    socket,
  );
  for (let i = 0; i < 200 && !sent.some((m) => m.includes("sync-res")); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const wire = sent.join("|");
  assert(
    !wire.includes("HIDDEN-CELL-BODY"),
    `a cell hidden from the UI was snapshotted onto a socket:\n${wire}`,
  );
  // Fail closed AND loud: the client cannot converge on this cell and the
  // operator has to hear why (compose refuses the combination in the first
  // place — reaching here means something bypassed that gate).
  assert(
    errors.some((e) => e.includes("notes")),
    `the refusal must be logged, naming the cell — got: ${errors.join("|")}`,
  );
});
