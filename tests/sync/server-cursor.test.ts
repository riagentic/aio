// tests/sync/server-cursor.test.ts — server_ts cursor + reconnect dedup/ack.
// Regression suite for the 2026-07-21 audit findings:
//  A) server_ts was bare Date.now() — same-ms ties + strict `>` cursor lose ops
//  B) the echoed lastServerTs came from the CLIENT's own cursors, so the
//     cursor never advanced and the fast path was dead code
//  C) reconnect-flushed pendingOps were never acked and re-dispatched every
//     sync round (server-state drift + permanent client double-apply)
//  D) __ack / remote-op meta writes clobbered the stored lastServerTs
import { assert, assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them (see src/db/db-worker.ts)
import { DatabaseSync } from "node:sqlite";
import type { DB, QueryResult, Tx } from "../../src/db/types.ts";
import { SYNC_SCHEMA } from "../../src/sync/compact.ts";
import {
  _resetServerTsForTest,
  loadOpsSince,
  persistOp,
  reserveServerTs,
} from "../../src/sync/server-store.ts";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import {
  createSyncEngine,
  type SyncEngineDeps,
} from "../../src/sync/sync-engine.ts";
import type { HLC } from "../../src/sync/types.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";

// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;

/** Real in-memory SQLite implementing the framework DB interface (no worker). */
function createTestDb(): DB {
  const sqlite = new DatabaseSync(":memory:");
  for (const stmt of SYNC_SCHEMA) sqlite.exec(stmt);
  const query = <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> =>
    Promise.resolve({
      rows: sqlite.prepare(sql).all(..._p(params ?? [])) as T[],
      changes: 0,
      lastInsertRowId: 0n,
    });
  const execute = (sql: string, params?: unknown[]): Promise<QueryResult> => {
    const r = sqlite.prepare(sql).run(..._p(params ?? []));
    return Promise.resolve({
      rows: [],
      changes: Number(r.changes),
      lastInsertRowId: BigInt(r.lastInsertRowid),
    });
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

const hlc = (phys: number, cnt: number, node = "client-a"): HLC => [
  phys,
  cnt,
  node,
];

function op(
  id: string,
  h: HLC,
  payload: unknown = {},
  cell = "todos",
) {
  return { id, hlc: h, cell, action: "add", payload };
}

/** Handler harness: mock socket + dispatch/broadcast recorders. */
function harness(db: DB) {
  const dispatched: string[] = [];
  const broadcasts: { serverTs?: number; id: string }[] = [];
  const sent: Record<string, unknown>[] = [];
  const handler = createServerSyncHandler({
    dispatch: (a) => dispatched.push(a.type),
    db,
    syncCellIds: ["todos", "notes"],
    getCellState: () => ({ items: [] }),
    broadcastRaw: {
      fn: (msg) => broadcasts.push(JSON.parse(msg).__op),
    },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  const socket = {
    send: (m: string) => sent.push(JSON.parse(m)),
  } as unknown as WebSocket;
  const syncResponses = () => sent.filter((m) => m.__sync);
  const acks = () =>
    sent.filter((m) => m.__ack).map((m) => (m.__ack as { opId: string }).opId);
  const waitFor = async (cond: () => boolean, ms = 3000) => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error("waitFor timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return {
    handler,
    socket,
    dispatched,
    broadcasts,
    sent,
    syncResponses,
    acks,
    waitFor,
  };
}

describe("server_ts issuance (audit A)", () => {
  it("is strictly monotonic under a same-ms burst", async () => {
    const db = createTestDb();
    for (let i = 0; i < 50; i++) {
      await persistOp(db, op(`m-${i}`, hlc(1000 + i, 0)));
    }
    const { rows } = await db.query<{ server_ts: number }>(
      "SELECT server_ts FROM sync_ops ORDER BY rowid",
    );
    assertEquals(rows.length, 50);
    for (let i = 1; i < rows.length; i++) {
      assert(
        rows[i]!.server_ts > rows[i - 1]!.server_ts,
        `ts[${i}] (${rows[i]!.server_ts}) must be > ts[${i - 1}] (${
          rows[i - 1]!.server_ts
        })`,
      );
    }
  });

  it("returns the issued ts on insert, null on duplicate", async () => {
    const db = createTestDb();
    const ts = await persistOp(db, op("dup", hlc(100, 0)));
    assertExists(ts);
    assertEquals(await persistOp(db, op("dup", hlc(999, 9))), null);
  });

  it("reserveServerTs: later persists are strictly above the reservation", async () => {
    const db = createTestDb();
    await persistOp(db, op("before", hlc(1, 0)));
    const cursor = await reserveServerTs(db);
    const after = await persistOp(db, op("after", hlc(2, 0)));
    assertExists(after);
    assert(after > cursor, `${after} must be > reserved ${cursor}`);
    // Cursor semantics end-to-end: querying above the reservation returns
    // exactly the ops persisted after it.
    const ops = await loadOpsSince(db, "todos", null, cursor);
    assertEquals(ops.map((o) => o.id), ["after"]);
  });

  it("restart re-seeds from the op-log: no ts below persisted max", async () => {
    const db = createTestDb();
    // Burst inflates server_ts past wall-clock…
    let maxTs = 0;
    for (let i = 0; i < 40; i++) {
      const ts = await persistOp(db, op(`burst-${i}`, hlc(500 + i, 0)));
      if (ts !== null && ts > maxTs) maxTs = ts;
    }
    // …then the server "restarts" inside the inflation window.
    _resetServerTsForTest();
    const cursor = await reserveServerTs(db);
    assert(
      cursor >= maxTs,
      `re-seeded cursor ${cursor} must cover persisted max ${maxTs}`,
    );
    const ts = await persistOp(db, op("post-restart", hlc(999, 0)));
    assertExists(ts);
    assert(ts > maxTs, `post-restart ts ${ts} must be > persisted ${maxTs}`);
  });
});

describe("handleSync pendingOps (audit C)", () => {
  it("acks every pending op and dispatches it exactly once across re-sends", async () => {
    const db = createTestDb();
    const h = harness(db);
    const pending = { ...op("p-1", hlc(100, 0)), confirmed: false };

    h.handler.handleSync(
      { clientId: "client-a", cells: {}, pendingOps: [pending] },
      { id: "s1" },
      h.socket,
    );
    await h.waitFor(() => h.acks().includes("p-1"));
    assertEquals(h.dispatched, ["todos:add"], "dispatched on first flush");

    // Ack lost / client re-sends on the next sync round: ack again (it's the
    // retransmit), but never re-dispatch to live state.
    h.handler.handleSync(
      { clientId: "client-a", cells: {}, pendingOps: [pending] },
      { id: "s1" },
      h.socket,
    );
    await h.waitFor(() => h.acks().filter((id) => id === "p-1").length === 2);
    assertEquals(h.dispatched, ["todos:add"], "no double dispatch on re-send");
  });

  it("broadcasts newly flushed pending ops to peers with a serverTs stamp", async () => {
    const db = createTestDb();
    const h = harness(db);
    h.handler.handleSync(
      {
        clientId: "client-a",
        cells: {},
        pendingOps: [{ ...op("p-2", hlc(100, 0)), confirmed: false }],
      },
      { id: "s1" },
      h.socket,
    );
    await h.waitFor(() => h.broadcasts.length === 1);
    assertEquals(h.broadcasts[0]!.id, "p-2");
    assertExists(h.broadcasts[0]!.serverTs, "broadcast carries serverTs");
  });
});

describe("handleOp dedup (audit C)", () => {
  it("duplicate op → acked twice, dispatched and broadcast once", async () => {
    const db = createTestDb();
    const h = harness(db);
    const o = op("o-1", hlc(100, 0));
    await h.handler.handleOp(o, { id: "s1" }, h.socket);
    await h.handler.handleOp(o, { id: "s1" }, h.socket);
    assertEquals(h.acks(), ["o-1", "o-1"], "both deliveries acked");
    assertEquals(h.dispatched, ["todos:add"], "single dispatch");
    assertEquals(h.broadcasts.length, 1, "single broadcast");
    assertExists(h.broadcasts[0]!.serverTs, "broadcast carries serverTs");
  });
});

describe("catch-up cursor (audit B)", () => {
  it("echoes an advancing per-cell cursor; re-sync with it returns nothing", async () => {
    const db = createTestDb();
    const h = harness(db);
    // Ops from another client land in the log.
    await h.handler.handleOp(
      op("b-1", hlc(100, 0, "client-b")),
      { id: "s2" },
      h.socket,
    );
    await h.handler.handleOp(
      op("b-2", hlc(101, 0, "client-b")),
      { id: "s2" },
      h.socket,
    );

    h.handler.handleSync(
      {
        clientId: "client-a",
        cells: { todos: { lastHlc: null } },
        pendingOps: [],
      },
      { id: "s1" },
      h.socket,
    );
    await h.waitFor(() => h.syncResponses().length === 1);
    const first = h.syncResponses()[0]!.__sync as {
      ops: { id: string }[];
      lastServerTs?: Record<string, number>;
    };
    assertEquals(first.ops.map((o) => o.id), ["b-1", "b-2"]);
    const cursor = first.lastServerTs?.todos;
    assertExists(cursor, "response carries a per-cell server_ts cursor");

    // Second round with the echoed cursor → no re-delivery.
    h.handler.handleSync(
      {
        clientId: "client-a",
        cells: { todos: { lastHlc: hlc(101, 0), lastServerTs: cursor } },
        pendingOps: [],
      },
      { id: "s1" },
      h.socket,
    );
    await h.waitFor(() => h.syncResponses().length === 2);
    const second = h.syncResponses()[1]!.__sync as { ops: unknown[] };
    assertEquals(second.ops.length, 0, "cursor advanced — no re-delivery");
  });

  it("never echoes the requesting client's own ops back", async () => {
    const db = createTestDb();
    const h = harness(db);
    await h.handler.handleOp(
      op("own-1", hlc(100, 0, "client-a")),
      { id: "s1" },
      h.socket,
    );
    await h.handler.handleOp(
      op("peer-1", hlc(101, 0, "client-b")),
      { id: "s2" },
      h.socket,
    );
    h.handler.handleSync(
      {
        clientId: "client-a",
        cells: { todos: { lastHlc: null } },
        pendingOps: [],
      },
      { id: "s1" },
      h.socket,
    );
    await h.waitFor(() => h.syncResponses().length === 1);
    const resp = h.syncResponses()[0]!.__sync as { ops: { id: string }[] };
    assertEquals(
      resp.ops.map((o) => o.id),
      ["peer-1"],
      "own ops arrive via __ack, not the catch-up echo",
    );
  });
});

describe("client cursor preservation (audit D)", () => {
  it("op-buffer confirm() keeps lastServerTs", async () => {
    const storage = createMemoryStorage();
    const buffer = createOpBuffer(storage);
    await buffer.saveMeta("todos", { lastHlc: hlc(1, 0), lastServerTs: 4321 });
    await buffer.confirm("todos", "op-x", hlc(2, 0, "server"));
    const meta = await buffer.getMeta("todos");
    assertEquals(meta?.lastServerTs, 4321, "confirm must not wipe the cursor");
    assertEquals(meta?.lastHlc, hlc(2, 0, "server"));
  });

  it("engine handleRemoteOp advances lastServerTs from the broadcast stamp", async () => {
    const storage = createMemoryStorage();
    const buffer = createOpBuffer(storage);
    const deps: SyncEngineDeps = {
      clientId: "c1",
      cells: { todos: normalizeSyncConfig(true) },
      buffer,
      send: () => {},
      reducer: (s) => s,
      getConfirmedState: () => ({ todos: {} }),
      setConfirmedState: () => {},
      onStateUpdate: () => {},
    };
    const engine = createSyncEngine(deps);
    await engine.handleRemoteOp({
      ...op("r-1", hlc(100, 0, "c2")),
      confirmed: true,
      serverTs: 7777,
    });
    assertEquals((await buffer.getMeta("todos"))?.lastServerTs, 7777);

    // Never regress on an older/unstamped broadcast.
    await engine.handleRemoteOp({
      ...op("r-2", hlc(101, 0, "c2")),
      confirmed: true,
      serverTs: 5555,
    });
    assertEquals((await buffer.getMeta("todos"))?.lastServerTs, 7777);
  });
});
