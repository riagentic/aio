import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { type CompactDeps, compactSyncOps } from "../../src/sync/compact.ts";
import type { HLC } from "../../src/sync/types.ts";

/** Mock DB that records all executed statements */
function createMockDb() {
  const executed: { sql: string; params?: unknown[] }[] = [];
  let opCount = 0;

  return {
    db: {
      query: async <T>(_sql: string, _params?: unknown[]) => {
        if (_sql.includes("COUNT")) {
          return {
            rows: [{ count: opCount }] as T[],
            changes: 0,
            lastInsertRowId: 0n,
          };
        }
        return { rows: [] as T[], changes: 0, lastInsertRowId: 0n };
      },
      execute: async (sql: string, params?: unknown[]) => {
        executed.push({ sql, params });
        return { rows: [], changes: 1, lastInsertRowId: 0n };
      },
      transaction: async (stmts: { sql: string; params?: unknown[] }[]) => {
        executed.push(...stmts);
        return stmts.map(() => ({
          rows: [],
          changes: 1,
          lastInsertRowId: 0n,
        }));
      },
      close: async () => {},
    },
    executed,
    setOpCount(n: number) {
      opCount = n;
    },
  };
}

describe("compactSyncOps", () => {
  it("compacts when op count exceeds threshold", async () => {
    const mock = createMockDb();
    mock.setOpCount(1500);

    const deps: CompactDeps = {
      db: mock.db as any,
      cell: "todos",
      getState: () => ({ items: [], filter: "all" }),
      serverHlc: [Date.now(), 0, "s"] as HLC,
      compactOps: 1000,
      log: { debug: () => {}, warn: () => {}, error: () => {} },
    };

    await compactSyncOps(deps);

    const txStmts = mock.executed.filter((s) =>
      s.sql.includes("sync_snapshots") ||
      s.sql.includes("DELETE") ||
      s.sql.includes("sync_meta")
    );
    assertEquals(txStmts.length >= 3, true);
  });

  it("skips compaction when op count below threshold", async () => {
    const mock = createMockDb();
    mock.setOpCount(500);

    const deps: CompactDeps = {
      db: mock.db as any,
      cell: "todos",
      getState: () => ({ items: [] }),
      serverHlc: [Date.now(), 0, "s"] as HLC,
      compactOps: 1000,
      log: { debug: () => {}, warn: () => {}, error: () => {} },
    };

    await compactSyncOps(deps);

    const txStmts = mock.executed.filter((s) =>
      s.sql.includes("sync_snapshots")
    );
    assertEquals(txStmts.length, 0);
  });
});
