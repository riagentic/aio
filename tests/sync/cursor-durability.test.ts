// tests/sync/cursor-durability.test.ts — the server_ts sequence must survive
// a restart, not just a well-behaved one.
//
// THE INVARIANT (see src/sync/server-store.ts):
//   a `server_ts` handed to a client as a catch-up cursor is NEVER crossed
//   backwards by a later-issued op, including across a process restart.
// `loadOpsSince` filters with a strict `server_ts > cursor`, so an op stamped
// at or below a cursor a client already holds is undeliverable to that client
// FOREVER, silently.
//
// Why this file exists: the in-memory issuer runs AHEAD of what the op-log can
// prove — a duplicate INSERT OR IGNORE used to burn a ts no row carries,
// compaction DELETEs rows, a D11-rejected op is DELETEd after being stamped.
// Seeding a restart from `MAX(server_ts) FROM sync_ops` therefore re-issued
// values that had already been echoed as cursors. The chaos suite reproduced
// it only at seed 3858958063 (1 episode in 80 large seeds, 0 in seeds 1–120):
// the fuzzer cannot be the guard, so the invariant is pinned directly here.

import { assert, assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them (see src/db/db-worker.ts)
import { DatabaseSync } from "node:sqlite";
import type { DB, QueryResult, Tx } from "../../src/db/types.ts";
import { compactSyncOps, SYNC_SCHEMA } from "../../src/sync/compact.ts";
import {
  _resetServerTsForTest,
  loadOpsSince,
  persistOp,
  reserveServerTs,
} from "../../src/sync/server-store.ts";
import type { HLC } from "../../src/sync/types.ts";

// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;

/** Real in-memory SQLite behind the framework DB interface. */
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

const CELL = "todos";
const silentLog = { debug: () => {}, warn: () => {}, error: () => {} };
const op = (id: string, phys: number, node = "c1") => ({
  id,
  hlc: [phys, 0, node] as HLC,
  cell: CELL,
  action: "add",
  payload: { id },
});

/** Ids currently in the op-log for the cell. */
async function liveIds(db: DB): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM sync_ops WHERE cell = ?",
    [CELL],
  );
  return new Set(rows.map((r) => r.id));
}

describe("server_ts cursor durability across restart", () => {
  it("a cursor reserved after duplicate re-sends survives a restart", async () => {
    // The exact shape of chaos seed 3858958063. Every reconnect re-sends the
    // client's whole pending buffer, so duplicate persists are the common case
    // — and each one used to consume a server_ts that no row carries.
    const db = createTestDb();
    _resetServerTsForTest();

    const real = await persistOp(db, op("a", 100));
    assertExists(real);
    // …now a flood of duplicates (reconnect re-sends).
    for (let i = 0; i < 40; i++) {
      assertEquals(
        await persistOp(db, op("a", 100)),
        null,
        "duplicate must not insert",
      );
    }
    // A client syncs and is told this cursor.
    const cursor = await reserveServerTs(db);
    assert(
      cursor >= real,
      `reservation ${cursor} must cover the persisted op ${real}`,
    );

    // Server restarts: the issuer forgets everything not in the store.
    _resetServerTsForTest();

    const next = await persistOp(db, op("b", 200));
    assertExists(next);
    assert(
      next > cursor,
      `post-restart ts ${next} must be > the cursor ${cursor} a client holds ` +
        `(otherwise op "b" is undeliverable to that client forever)`,
    );
    assertEquals(
      (await loadOpsSince(db, CELL, null, cursor)).map((o) => o.id),
      ["b"],
      "the op persisted after the reservation must be deliverable above it",
    );
  });

  it("a cursor reserved before a D11 rejection DELETE survives a restart", async () => {
    // A rejected op is stamped, then DELETEd from the log (state and log must
    // agree). Its server_ts is gone from every row — but it was already the
    // issuer's high-water mark.
    const db = createTestDb();
    _resetServerTsForTest();
    await persistOp(db, op("keep", 100));
    const poison = await persistOp(db, op("poison", 101));
    assertExists(poison);
    await db.execute("DELETE FROM sync_ops WHERE id = ?", ["poison"]);
    const cursor = await reserveServerTs(db);

    _resetServerTsForTest();
    const next = await persistOp(db, op("after", 200));
    assertExists(next);
    assert(next > cursor, `post-restart ts ${next} must be > cursor ${cursor}`);
    assertEquals(
      (await loadOpsSince(db, CELL, null, cursor)).map((o) => o.id),
      ["after"],
    );
  });

  it("a cursor reserved before compaction survives a restart", async () => {
    // Compaction DELETEs the rows it folded into the snapshot; their max only
    // survives in sync_meta.compacted_ts, which the restart seed must honour.
    const db = createTestDb();
    _resetServerTsForTest();
    for (let i = 0; i < 5; i++) await persistOp(db, op(`old-${i}`, 100 + i));
    const cursor = await reserveServerTs(db);
    await compactSyncOps({
      db,
      cell: CELL,
      getState: () => ({ items: [] }),
      serverHlc: [1_000_000, 0, "server"],
      compactOps: 1,
      log: silentLog,
    });
    assertEquals((await liveIds(db)).size, 0, "compaction emptied the log");

    _resetServerTsForTest();
    const next = await persistOp(db, op("fresh", 2_000_000));
    assertExists(next);
    assert(
      next > cursor,
      `post-compaction/restart ts ${next} must be > cursor ${cursor}`,
    );
    assertEquals(
      (await loadOpsSince(db, CELL, null, cursor)).map((o) => o.id),
      ["fresh"],
    );
  });

  it("property: every cursor ever reserved stays a valid delivery boundary", async () => {
    // Randomized mix of the four ways the issuer can outrun the log
    // (duplicates, rejection deletes, compaction, restarts). After every step,
    // every cursor handed out so far must still deliver every op persisted
    // after it that the log still holds. Seeded — a failure replays exactly.
    let a = 0x1234_5678 >>> 0;
    const rand = () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const db = createTestDb();
    _resetServerTsForTest();
    // cursor → ids persisted strictly after it was reserved
    const cursors: { ts: number; after: Set<string> }[] = [];
    const persisted: string[] = [];
    let seq = 0;

    const check = async () => {
      const live = await liveIds(db);
      for (const c of cursors) {
        const got = new Set(
          (await loadOpsSince(db, CELL, null, c.ts)).map((o) => o.id),
        );
        for (const id of c.after) {
          if (!live.has(id)) continue; // compacted away — served by snapshot
          assert(
            got.has(id),
            `op ${id} was persisted after cursor ${c.ts} but is not ` +
              `deliverable above it — silently lost for any client at that cursor`,
          );
        }
      }
    };

    for (let step = 0; step < 300; step++) {
      const r = rand();
      if (r < 0.45) {
        const id = `op-${++seq}`;
        const ts = await persistOp(db, op(id, 1000 + seq));
        if (ts !== null) {
          persisted.push(id);
          for (const c of cursors) {
            assert(
              ts > c.ts,
              `op ${id} stamped ${ts} at or below an outstanding cursor ${c.ts}`,
            );
            c.after.add(id);
          }
        }
      } else if (r < 0.65 && persisted.length) {
        // duplicate re-send (reconnect flush)
        const id = persisted[Math.floor(rand() * persisted.length)]!;
        assertEquals(await persistOp(db, op(id, 1)), null);
      } else if (r < 0.80) {
        cursors.push({ ts: await reserveServerTs(db), after: new Set() });
      } else if (r < 0.87 && persisted.length) {
        // D11 rejection: stamped, then removed from the log
        const id = `rej-${++seq}`;
        await persistOp(db, op(id, 1000 + seq));
        await db.execute("DELETE FROM sync_ops WHERE id = ?", [id]);
      } else if (r < 0.93) {
        await compactSyncOps({
          db,
          cell: CELL,
          getState: () => ({ items: [...persisted] }),
          serverHlc: [1000 + seq, 0, "server"],
          compactOps: 1,
          log: silentLog,
        });
      } else {
        _resetServerTsForTest(); // restart
      }
      await check();
    }
    assert(cursors.length > 5, "property loop must actually reserve cursors");
    assert(persisted.length > 20, "property loop must actually persist ops");
  });
});
