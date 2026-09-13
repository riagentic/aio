// `CompactDeps.alsoWrite` — statements that commit in the snapshot's OWN
// transaction, or not at all.
//
// The fold watermark (server-handler.ts `SyncFoldWatermark`) says "the
// snapshot holds up to journal seq N": true only if that snapshot is on disk.
// It rode in by wrapping `db` in a Proxy that rewrote `transaction`, which
// depends on compaction making exactly one batch call. This is the seam named
// for it: called after the state capture, inside the same batch, and never for
// a fold that does not commit.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { compactSyncOps } from "../../src/sync/compact.ts";
import type { DB } from "../../src/db/types.ts";
import type { HLC } from "../../src/sync/types.ts";

type Stmt = { sql: string; params?: unknown[] };

function mockDb(opCount: number, failTx = false) {
  const batches: Stmt[][] = [];
  const db = {
    query: <T>(sql: string) =>
      Promise.resolve({
        rows: (sql.includes("COUNT") ? [{ count: opCount }] : []) as T[],
        changes: 0,
        lastInsertRowId: 0n,
      }),
    execute: () =>
      Promise.resolve({ rows: [], changes: 1, lastInsertRowId: 0n }),
    transaction: (stmts: Stmt[]) => {
      if (failTx) return Promise.reject(new Error("disk full"));
      batches.push(stmts);
      return Promise.resolve(
        stmts.map(() => ({ rows: [], changes: 1, lastInsertRowId: 0n })),
      );
    },
    close: () => Promise.resolve(),
  } as unknown as DB;
  return { db, batches };
}

const base = {
  cell: "notes",
  serverHlc: [1000, 0, "server"] as HLC,
  compactOps: 10,
  log: { debug: () => {}, warn: () => {}, error: () => {} },
};

const MARK: Stmt = { sql: "INSERT INTO marks (seq) VALUES (?)", params: [7] };

Deno.test("compact alsoWrite: its statements ride in the snapshot's one transaction, after the capture", async () => {
  const { db, batches } = mockDb(50);
  const order: string[] = [];
  await compactSyncOps({
    ...base,
    db,
    getState: () => {
      order.push("capture");
      return { items: [] };
    },
    alsoWrite: () => {
      order.push("alsoWrite");
      return [MARK];
    },
  });
  assertEquals(order, ["capture", "alsoWrite"]);
  assertEquals(batches.length, 1, "one transaction, not a second write");
  assert(
    batches[0]!.some((s) => s.sql.includes("sync_snapshots")),
    "the batch is the snapshot's own",
  );
  assertEquals(batches[0]!.at(-1), MARK);
});

Deno.test("compact alsoWrite: not called for a fold below the threshold", async () => {
  const { db, batches } = mockDb(3);
  let called = false;
  await compactSyncOps({
    ...base,
    db,
    getState: () => ({ items: [] }),
    alsoWrite: () => {
      called = true;
      return [MARK];
    },
  });
  assertEquals(batches.length, 0);
  assertEquals(
    called,
    false,
    "a fold that commits nothing must record nothing",
  );
});

Deno.test("compact alsoWrite: a refused transaction rejects the fold", async () => {
  const { db } = mockDb(50, true);
  await assertRejects(
    () =>
      compactSyncOps({
        ...base,
        db,
        getState: () => ({ items: [] }),
        alsoWrite: () => [MARK],
      }),
    Error,
    "disk full",
  );
});
