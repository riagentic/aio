// Audit regression: compact DELETE uses hlc_cnt <= (not <) for boundary correctness
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

  const del = recorded.find((s) => s.sql.includes("DELETE"));
  assertEquals(del !== undefined, true, "DELETE statement must exist");
  assertEquals(del!.sql.includes("hlc_cnt <= ?"), true, "must use <= not <");
  assertEquals(del!.params, ["todos", 1000, 1000, 5]);
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
