// tests/sync/server-store.test.ts — Behavior tests for the server-side op-log store
import { assert, assertEquals, assertMatch } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them (see src/db/db-worker.ts)
import { DatabaseSync } from "node:sqlite";
import type { DB, QueryResult, Tx } from "../../src/db/types.ts";
import { SYNC_SCHEMA } from "../../src/sync/compact.ts";
import {
  getLowWater,
  loadOpsSince,
  persistOp,
} from "../../src/sync/server-store.ts";
import type { HLC, SyncOp } from "../../src/sync/types.ts";
import { normalizeSyncConfig, SYNC_DEFAULTS } from "../../src/sync/types.ts";

// node:sqlite requires SupportedValueType — runtime values are always valid SQL params
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
  }) as DB["transaction"];

  return {
    query,
    execute,
    transaction,
    close: () => {
      sqlite.close();
      return Promise.resolve();
    },
  };
}

/** Run a test body against a fresh in-memory DB, always closing it. */
async function withDb(fn: (db: DB) => Promise<void>): Promise<void> {
  const db = createTestDb();
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

const hlc = (phys: number, cnt: number, node = "n1"): HLC => [
  phys,
  cnt,
  node,
];

function op(
  id: string,
  h: HLC,
  payload: unknown = { id },
  cell = "todos",
): { id: string; hlc: HLC; cell: string; action: string; payload: unknown } {
  return { id, hlc: h, cell, action: "add", payload };
}

const ids = (ops: SyncOp[]): string[] => ops.map((o) => o.id);

describe("persistOp + loadOpsSince", () => {
  it("round-trips an op: payload, hlc, and confirmed=true", () =>
    withDb(async (db) => {
      const payload = { text: "buy milk", done: false, tags: ["a", "b"] };
      await persistOp(db, op("op-1", hlc(1000, 2, "client-a"), payload));

      const ops = await loadOpsSince(db, "todos", null);
      assertEquals(ops.length, 1);
      // `serverTs` — the op's POSITION in the server's apply order — rides
      // along: the client folds a catch-up batch in that order (see
      // sync-engine's ordered fold), so a loader that dropped it would leave
      // the client replaying the batch in an order the server never used.
      const { serverTs, ...rest } = ops[0]!;
      assertEquals(rest, {
        id: "op-1",
        cell: "todos",
        action: "add",
        payload,
        hlc: [1000, 2, "client-a"],
        confirmed: true,
        // The cell shape version the op was written under (field report §3.1) —
        // the default a cell declares when the caller passes none.
        version: 0,
      });
      assert(
        typeof serverTs === "number" && serverTs > 0,
        "a loaded op must know where it sits in the log",
      );
    }));

  it("is idempotent: re-persisting the same id keeps the original row", () =>
    withDb(async (db) => {
      await persistOp(db, op("dup", hlc(100, 0), { v: 1 }));
      await persistOp(db, op("dup", hlc(999, 9), { v: 2 }));

      const ops = await loadOpsSince(db, "todos", null);
      assertEquals(ops.length, 1);
      assertEquals(ops[0]?.payload, { v: 1 });
      assertEquals(ops[0]?.hlc, [100, 0, "n1"]);
    }));

  it("null cursor returns all ops for the cell in dispatch (server_ts) order", () =>
    withDb(async (db) => {
      await persistOp(db, op("c", hlc(102, 0)));
      await persistOp(db, op("b", hlc(100, 1)));
      await persistOp(db, op("a", hlc(100, 0)));
      await persistOp(db, op("d", hlc(101, 5)));

      // Persist order, NOT HLC order — a replay/fresh client must fold ops in
      // exactly the order the live server dispatched them.
      const ops = await loadOpsSince(db, "todos", null);
      assertEquals(ids(ops), ["c", "b", "a", "d"]);
    }));

  it("the HLC watermark is NEVER a delivery filter (chaos finding)", () =>
    withDb(async (db) => {
      // HLC order ≠ persist order: a client's HLC watermark can sit "above"
      // concurrently stamped peer ops it never received, so filtering by it
      // silently lost ops. Without a server_ts cursor the full log comes back.
      await persistOp(db, op("a", hlc(100, 0)));
      await persistOp(db, op("b", hlc(100, 1)));
      await persistOp(db, op("c", hlc(101, 0)));

      assertEquals(ids(await loadOpsSince(db, "todos", hlc(100, 1))), [
        "a",
        "b",
        "c",
      ]);
      assertEquals(ids(await loadOpsSince(db, "todos", hlc(101, 0))), [
        "a",
        "b",
        "c",
      ]);
    }));

  it("filters by cell — other cells' ops never leak", () =>
    withDb(async (db) => {
      await persistOp(db, op("t1", hlc(100, 0), { t: 1 }, "todos"));
      await persistOp(db, op("n1", hlc(50, 0), { n: 1 }, "notes"));
      await persistOp(db, op("t2", hlc(101, 0), { t: 2 }, "todos"));

      assertEquals(ids(await loadOpsSince(db, "todos", null)), ["t1", "t2"]);
      assertEquals(ids(await loadOpsSince(db, "notes", null)), ["n1"]);
    }));

  it("server_ts cursor wins over HLC cursor and orders by server_ts", () =>
    withDb(async (db) => {
      // HLC order (o3, o2, o1) is the REVERSE of server_ts order (o1, o2, o3)
      await persistOp(db, op("o1", hlc(300, 0)));
      await persistOp(db, op("o2", hlc(200, 0)));
      await persistOp(db, op("o3", hlc(100, 0)));
      await db.execute("UPDATE sync_ops SET server_ts = ? WHERE id = ?", [
        10,
        "o1",
      ]);
      await db.execute("UPDATE sync_ops SET server_ts = ? WHERE id = ?", [
        20,
        "o2",
      ]);
      await db.execute("UPDATE sync_ops SET server_ts = ? WHERE id = ?", [
        30,
        "o3",
      ]);

      // HLC cursor [0,0] would return everything — server_ts cursor must take precedence
      assertEquals(ids(await loadOpsSince(db, "todos", hlc(0, 0), 20)), [
        "o3",
      ]);
      // Strictly after: the row AT the cursor is excluded
      assertEquals(await loadOpsSince(db, "todos", null, 30), []);
      // Ordered by server_ts, not HLC
      assertEquals(ids(await loadOpsSince(db, "todos", null, 5)), [
        "o1",
        "o2",
        "o3",
      ]);
    }));

  it("lastServerTs of 0 or null means no cursor → full log", () =>
    withDb(async (db) => {
      await persistOp(db, op("a", hlc(100, 0)));
      await persistOp(db, op("b", hlc(101, 0)));

      // 0 is "no cursor" — never treated as a `server_ts > 0` filter, and the
      // HLC watermark must not filter either (client op-id dedup absorbs the
      // re-delivery; an HLC filter silently LOSES ops — see chaos suite).
      assertEquals(ids(await loadOpsSince(db, "todos", hlc(100, 0), 0)), [
        "a",
        "b",
      ]);
      assertEquals(ids(await loadOpsSince(db, "todos", hlc(100, 0), null)), [
        "a",
        "b",
      ]);
    }));
});

describe("getLowWater", () => {
  it("returns null when the cell has no sync_meta row", () =>
    withDb(async (db) => {
      assertEquals(await getLowWater(db, "todos"), null);
    }));

  it("returns the stored HLC for the requested cell only", () =>
    withDb(async (db) => {
      await db.execute(
        "INSERT INTO sync_meta (cell, low_water, last_compact, op_count) VALUES (?, ?, ?, ?)",
        ["todos", JSON.stringify([123, 4, "srv"]), 1_700_000_000_000, 42],
      );

      assertEquals(await getLowWater(db, "todos"), [123, 4, "srv"]);
      assertEquals(await getLowWater(db, "notes"), null);
    }));

  it("returns null (full snapshot) on corrupted low_water instead of throwing", () =>
    withDb(async (db) => {
      await db.execute(
        "INSERT INTO sync_meta (cell, low_water, last_compact, op_count) VALUES (?, ?, ?, ?)",
        ["todos", "{not json", 0, 0],
      );

      assertEquals(await getLowWater(db, "todos"), null);
    }));
});

describe("SYNC_DEFAULTS", () => {
  it("pins the documented default values (no extra keys)", () => {
    assertEquals(SYNC_DEFAULTS, {
      maxDrift: 60_000,
      pendingCap: 500,
      compactOps: 1000,
      compactIntervalMs: 3_600_000,
      syncRetryMs: 10_000,
      defaultRetention: "4h",
    });
  });

  it("numeric defaults are positive integers", () => {
    const numeric = [
      SYNC_DEFAULTS.maxDrift,
      SYNC_DEFAULTS.pendingCap,
      SYNC_DEFAULTS.compactOps,
      SYNC_DEFAULTS.compactIntervalMs,
      SYNC_DEFAULTS.syncRetryMs,
    ];
    for (const n of numeric) {
      assert(
        Number.isInteger(n) && n > 0,
        `expected positive integer, got ${n}`,
      );
    }
  });

  it("defaultRetention matches the op-buffer retention grammar and is consumed by normalizeSyncConfig", () => {
    // op-buffer's parseRetention accepts /^(\d+)(ms|s|m|h)$/ — the default must parse
    assertMatch(SYNC_DEFAULTS.defaultRetention, /^\d+(ms|s|m|h)$/);

    // sync: true → offline.retention falls back to the documented default
    assertEquals(
      normalizeSyncConfig(true).offline.retention,
      SYNC_DEFAULTS.defaultRetention,
    );
    // partial config without offline → same default; explicit offline wins
    assertEquals(
      normalizeSyncConfig({ merge: { items: "lww" } }).offline.retention,
      SYNC_DEFAULTS.defaultRetention,
    );
    assertEquals(
      normalizeSyncConfig({ offline: { retention: "30m" } }).offline.retention,
      "30m",
    );
  });
});
