// Regression: SQLite-only persistence has NO ~64KB per-value limit (that was a
// Deno.Kv-era ceiling; Deno.Kv was retired in D4). A large cell must persist
// fine in BOTH modes — the old "over-limit degrade" that dropped it was a
// vestigial guard against a limit the SQLite backend doesn't have.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createPersistenceManager } from "../src/server/persistence.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import { createDB } from "../src/server-entry.ts";
import type { Log } from "../src/diagnostics/logger.ts";

type LogEntry = { level: string; msg: string };
function makeLog(entries: LogEntry[]): Log {
  const push = (level: string) => (msg: string) => entries.push({ level, msg });
  return {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  } as unknown as Log;
}

const BIG = "x".repeat(200_000); // 200KB — far past the retired ~64KB Deno.Kv limit

async function run(mode: "single" | "multi") {
  const dir = await Deno.makeTempDir();
  const db = createDB(join(dir, "kv.db"));
  await db.execute(SKV_SCHEMA);
  const kv = sqliteKv(db);
  const logs: LogEntry[] = [];
  const state = { counter: { n: 5 }, huge: { blob: BIG } };
  const mgr = createPersistenceManager({
    kvDb: kv,
    asyncDb: null,
    dbSchema: undefined,
    persistKey: "app-state",
    persistMode: mode,
    persistMs: 5,
    getState: () => state,
    getDBState: (s) => s,
    log: makeLog(logs),
    getReportOpts: () => ({}),
    appId: "app",
  });
  await mgr.flushPersist();
  return { kv, logs, dir, db };
}

Deno.test("persist multi: a 200KB cell persists to SQLite (no phantom KV limit)", async () => {
  const { kv, logs, dir, db } = await run("multi");
  try {
    const persisted = await kv.getMulti<Record<string, unknown>>("app-state");
    assertEquals(persisted?.counter, { n: 5 });
    assertEquals(
      (persisted?.huge as { blob: string }).blob.length,
      200_000,
      "large cell persisted in full — SQLite has no ~64KB limit",
    );
    // No over-limit error is logged (the vestigial guard is gone).
    assertEquals(
      logs.filter((l) => l.level === "error" && /64KB|over.limit/i.test(l.msg))
        .length,
      0,
      "no phantom over-limit error",
    );
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("persist single: a 200KB blob persists to SQLite (no phantom KV limit)", async () => {
  const { kv, logs, dir, db } = await run("single");
  try {
    const persisted = await kv.get<Record<string, unknown>>("app-state");
    assertEquals((persisted?.counter as { n: number }).n, 5);
    assertEquals(
      (persisted?.huge as { blob: string }).blob.length,
      200_000,
      "large single-mode blob persisted in full",
    );
    assertEquals(
      logs.filter((l) => l.level === "error").length,
      0,
      "no over-limit refusal",
    );
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
});
