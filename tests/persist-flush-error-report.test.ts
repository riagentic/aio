// A SQLite table sync that fails during the SHUTDOWN flush must reach
// `onError`, exactly as the scheduled one does.
//
// The flush carried its own hand-copy of `_syncSqlite`, and the copy had
// drifted: it logged and stopped, never calling `_reportPersistError`. So a
// failure on the app's LAST chance to write anything — the one you most need to
// hear about — reached the log file and nothing else. The KV half of the very
// same block carries a comment explaining that it was unified with the
// scheduled path for exactly this class of reason; the SQLite half had not been.
import { assert, assertEquals } from "@std/assert";
import { createPersistenceManager } from "../src/server/persistence.ts";
import type { DB } from "../src/db/types.ts";
import { pk, table, text } from "../src/server/sql.ts";

/** A DB whose writes always fail — the shape of a full disk or a bad schema. */
function failingDb(): DB {
  return {
    // deno-lint-ignore no-explicit-any
    async query<T>(): Promise<any> {
      return { rows: [] as T[], changes: 0, lastInsertRowId: 0n };
    },
    async execute() {
      return { rows: [], changes: 0, lastInsertRowId: 0n };
    },
    async transaction(): Promise<never> {
      throw new Error("disk is full");
    },
    async close() {},
  };
}

Deno.test("a failed table sync during the shutdown flush reaches onError", async () => {
  const errors: string[] = [];
  const state = { notes: { items: [{ id: "a", v: "one" }] } };

  const p = createPersistenceManager({
    appId: "flush-error-probe",
    persistKey: "flush-error-probe",
    persistMode: "single",
    persistMs: 10,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      // deno-lint-ignore no-explicit-any
    } as any,
    getState: () => state as unknown as Record<string, unknown>,
    getDBState: (s: Record<string, unknown>) => s,
    getTableState: () => ({ notes_items: state.notes.items }),
    asyncDb: failingDb(),
    dbSchema: { notes_items: table({ id: pk(), v: text() }) },
    kvDb: null,
    getReportOpts: () => ({
      onError: (e: { message?: string }) => {
        errors.push(String(e?.message ?? e));
      },
    }),
    // deno-lint-ignore no-explicit-any
  } as any);

  // Change something so the flush has work, then flush as shutdown does.
  state.notes.items = [{ id: "a", v: "two" }];
  await p.flushPersist();

  assert(
    errors.length > 0,
    "a table sync that failed on the shutdown flush must be reported to " +
      "onError — a log line is the one place nobody is watching at exit",
  );
  assertEquals(
    errors.some((e) => /disk is full|PERSIST/i.test(e)),
    true,
    `the report must carry the real cause, got: ${JSON.stringify(errors)}`,
  );
});
