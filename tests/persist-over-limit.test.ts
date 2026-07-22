// AIO-420 regression: in multi mode, a single cell over the ~64KB Deno KV
// limit must NOT nuke the whole commit — the healthy cells persist, the
// over-limit cell keeps its last-saved value and is named loudly. Data-loss
// class, previously untested. Uses the sqlite-backed KV harness (no real
// Deno.Kv needed) — same manager the runtime uses.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createPersistenceManager } from "../src/server/persistence.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import { createDB } from "../src/db/mod.ts";
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

Deno.test("persist multi: over-limit cell degrades, healthy cells still save", async () => {
  const dir = await Deno.makeTempDir();
  const db = createDB(join(dir, "kv.db"));
  await db.execute(SKV_SCHEMA);
  const kv = sqliteKv(db);
  const logs: LogEntry[] = [];

  // One healthy cell + one ~120KB cell (over the 63KB limit).
  const big = "x".repeat(120_000);
  const state = {
    counter: { n: 5 },
    huge: { blob: big },
  };
  const mgr = createPersistenceManager({
    kvDb: kv,
    asyncDb: null,
    dbSchema: undefined,
    persistKey: "app-state",
    persistMode: "multi",
    persistMs: 5,
    getState: () => state,
    getDBState: (s) => s,
    log: makeLog(logs),
    getReportOpts: () => ({}),
    appId: "app",
  });

  try {
    await mgr.flushPersist();

    const persisted = await kv.getMulti<Record<string, unknown>>("app-state");
    // Healthy cell persisted despite the over-limit sibling.
    assertEquals(persisted?.counter, { n: 5 });
    // Over-limit cell was NOT written (no partial/corrupt value).
    assert(
      !persisted || !("huge" in persisted),
      "over-limit cell must not be persisted",
    );
    // And it was named loudly so the dev can act.
    const err = logs.find((l) =>
      l.level === "error" && l.msg.includes("huge") && l.msg.includes("64KB")
    );
    assert(
      err,
      `over-limit cell must be named in an error log: ${JSON.stringify(logs)}`,
    );
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
});
