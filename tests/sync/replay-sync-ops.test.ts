// B1/AIO-416 (TBD feedback): sync cells must recover their committed state from
// the op-log AT BOOT — not only when a client reconnects. Before the fix, a
// server restart with no client online came back with EMPTY sync cells (silent
// data loss). `replaySyncOps` folds every committed op back through the composed
// reducer, HLC-ordered, so committed sync state survives a headless restart.

import { assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import type { DB, QueryResult } from "../../src/db/types.ts";
import { SYNC_SCHEMA } from "../../src/sync/compact.ts";
import { persistOp } from "../../src/sync/server-store.ts";
import type { HLC } from "../../src/sync/types.ts";
import { replaySyncOps } from "../../src/server/aio-boot.ts";

// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;

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
  return {
    query,
    execute,
    transaction:
      (async (a: unknown) =>
        typeof a === "function"
          ? await (a as () => unknown)()
          : undefined) as DB[
          "transaction"
        ],
    close: () => sqlite.close(),
  } as unknown as DB;
}

const hlc = (phys: number, cnt: number, node = "n1"): HLC =>
  [phys, cnt, node] as HLC;

const silentLog = { info: () => {}, error: () => {} };

// A tiny composed reducer over a `members` sync cell (add/remove by id).
type S = {
  members: { roster: Array<{ id: number }>; pins: Record<string, string> };
};
const initial: S = { members: { roster: [], pins: {} } };
function reduce(s: S, a: { type: string; payload?: unknown }): S {
  if (a.type === "members:add") {
    const p = a.payload as { id: number; pin: string };
    return {
      members: {
        roster: [...s.members.roster, { id: p.id }],
        pins: { ...s.members.pins, [p.id]: p.pin },
      },
    };
  }
  return s;
}

Deno.test("replaySyncOps: folds committed ops into state at boot", async () => {
  const db = createTestDb();
  await persistOp(db, {
    id: "o1",
    hlc: hlc(1000, 0),
    cell: "members",
    action: "add",
    payload: { id: 1, pin: "0000" },
  });
  await persistOp(db, {
    id: "o2",
    hlc: hlc(1001, 0),
    cell: "members",
    action: "add",
    payload: { id: 2, pin: "1234" },
  });

  const restored = await replaySyncOps(
    db,
    ["members"],
    reduce,
    initial,
    silentLog,
  );
  assertEquals(
    restored.members.roster,
    [{ id: 1 }, { id: 2 }],
    "both members restored",
  );
  assertEquals(
    restored.members.pins,
    { "1": "0000", "2": "1234" },
    "pins restored",
  );
});

Deno.test("replaySyncOps: applies ops in HLC order regardless of insert order", async () => {
  const db = createTestDb();
  // Insert out of order; loadOpsSince returns HLC-ordered → deterministic fold.
  await persistOp(db, {
    id: "b",
    hlc: hlc(2000, 0),
    cell: "members",
    action: "add",
    payload: { id: 2, pin: "b" },
  });
  await persistOp(db, {
    id: "a",
    hlc: hlc(1000, 0),
    cell: "members",
    action: "add",
    payload: { id: 1, pin: "a" },
  });
  const restored = await replaySyncOps(
    db,
    ["members"],
    reduce,
    initial,
    silentLog,
  );
  assertEquals(
    restored.members.roster.map((m) => m.id),
    [1, 2],
    "HLC order, not insert order",
  );
});

Deno.test("replaySyncOps: no ops → state unchanged; unknown cell → no-op", async () => {
  const db = createTestDb();
  const same = await replaySyncOps(
    db,
    ["members", "ghost"],
    reduce,
    initial,
    silentLog,
  );
  assertEquals(same, initial);
});
