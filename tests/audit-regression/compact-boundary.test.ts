// Audit regression: the compaction DELETE boundary is INCLUSIVE (<=, not <).
//
// The original intent — an off-by-one here strands or destroys an op — is
// unchanged. What changed is WHICH value is the boundary. This test used to
// assert `hlc_cnt <= ?`, and deleting by HLC was itself a bug: the snapshot
// contains everything APPLIED, while `HLClock.receive` deliberately refuses to
// follow a remote clock more than `maxDrift` ahead, so a fast-clocked client's
// op could be inside the snapshot AND left in the log — replayed on boot,
// applied twice, and re-snapshotted doubled, compounding on every restart.
//
// The boundary is now a position issued on the `server_ts` sequence, which is
// the one value that answers all three questions at once: what the snapshot
// contains, what the DELETE removes, and which client cursors can still be
// served. Asserted here for the DELETE and for the tombstone INSERT, because
// those two must use the SAME boundary — a tombstone narrower than the delete
// silently re-opens the double-apply this replaced.
import { assertEquals } from "@std/assert";
import { compactSyncOps } from "../../src/sync/compact.ts";
import type { DB } from "../../src/db/types.ts";
import type { HLC } from "../../src/sync/types.ts";

function createMockDb() {
  const recorded: { sql: string; params?: unknown[] }[] = [];

  const db: DB = {
    async query<T>(_sql: string, _params?: unknown[]) {
      return { rows: [{ count: 200 }] as T[], changes: 0, lastInsertRowId: 0n };
    },
    async execute(_sql: string, _params?: unknown[]) {
      return { rows: [], changes: 0, lastInsertRowId: 0n };
    },
    async transaction(
      input: unknown,
      // deno-lint-ignore no-explicit-any
    ): Promise<any> {
      const stmts = input as { sql: string; params?: unknown[] }[];
      for (const s of stmts) recorded.push(s);
      return stmts.map(() => ({ rows: [], changes: 0, lastInsertRowId: 0n }));
    },
    async close() {},
  };

  return { db, recorded };
}

const noop = () => {};
const log = { debug: noop, warn: noop, error: noop };

Deno.test("compact DELETE uses hlc_cnt <= (inclusive boundary)", async () => {
  const { db, recorded } = createMockDb();
  const hlc: HLC = [1000, 5, "server"];

  await compactSyncOps({
    db,
    cell: "todos",
    getState: () => ({ items: [] }),
    serverHlc: hlc,
    compactOps: 100,
    log,
  });

  const del = recorded.find((s) => s.sql.includes("DELETE FROM sync_ops"));
  assertEquals(del !== undefined, true, "DELETE statement must exist");
  assertEquals(
    del!.sql.includes("server_ts <= ?"),
    true,
    "must be inclusive (<=) and keyed on the issued server_ts boundary — " +
      "`<` strands the boundary op in the log after the snapshot already " +
      "contains it, which is a double-apply on the next replay",
  );
  // The tombstone INSERT must cover exactly the same rows the DELETE removes.
  const tomb = recorded.find((s) =>
    s.sql.includes("INSERT OR IGNORE INTO sync_compacted_ids")
  );
  assertEquals(tomb !== undefined, true, "tombstone INSERT must exist");
  assertEquals(
    tomb!.sql.includes("server_ts <= ?"),
    true,
    "the tombstone must use the SAME inclusive boundary as the DELETE, or " +
      "op-id dedup stops covering rows compaction just removed",
  );
  // Same cell, same boundary value, in both statements.
  const delParams = del!.params as unknown[];
  const tombParams = tomb!.params as unknown[];
  assertEquals(delParams[0], "todos");
  assertEquals(
    delParams[1],
    tombParams[tombParams.length - 1],
    "DELETE and tombstone must share one boundary value",
  );
});

Deno.test("compact skips when op count below threshold", async () => {
  const belowDb: DB = {
    async query<T>(_sql: string, _params?: unknown[]) {
      return { rows: [{ count: 50 }] as T[], changes: 0, lastInsertRowId: 0n };
    },
    async execute() {
      return { rows: [], changes: 0, lastInsertRowId: 0n };
    },
    async transaction() {
      throw new Error("should not compact");
    },
    async close() {},
  };

  // Should not throw — returns early before transaction
  await compactSyncOps({
    db: belowDb,
    cell: "todos",
    getState: () => ({}),
    serverHlc: [1, 0, "s"],
    compactOps: 100,
    log,
  });
});
