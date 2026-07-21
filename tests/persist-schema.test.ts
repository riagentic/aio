// A4 — persistence schema versioning.
// Unit: migrateSchema (identity step, downgrade rejection, missing step).
// Integration (file-backed Deno.Kv): loadAndMigrateSnapshot loads + migrates
// alpha-era (unstamped) snapshots, refuses newer-schema stores loudly, and
// the persistence manager stamps __schema + __versions AFTER writes —
// closing the applyCellMigrations loop across restarts.
import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import {
  migrateSchema,
  PERSIST_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
} from "../src/server/persist-schema.ts";
import { AioError } from "../src/diagnostics/error.ts";
import {
  applyCellMigrations,
  type CellMigrationInfo,
  loadAndMigrateSnapshot,
} from "../src/server/aio-boot.ts";
import { createPersistenceManager } from "../src/server/persistence.ts";
import { type SkvInstance } from "../src/server/skv.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import { createDB } from "../src/db/mod.ts";
import type { DB } from "../src/db/types.ts";
import type { Log } from "../src/diagnostics/logger.ts";

type LogEntry = { level: string; msg: string };
function makeLog(entries: LogEntry[]): Log {
  const push = (level: string) => (msg: string) => entries.push({ level, msg });
  return {
    info: push("info"),
    debug: push("debug"),
    warn: push("warn"),
    error: push("error"),
  } as unknown as Log;
}

async function withKv(
  fn: (kv: SkvInstance, reopen: () => Promise<SkvInstance>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "test.db");
  let db: DB = createDB(path);
  await db.execute(SKV_SCHEMA);
  let kv = sqliteKv(db);
  const reopen = async () => {
    await db.close();
    db = createDB(path);
    await db.execute(SKV_SCHEMA);
    kv = sqliteKv(db);
    return kv;
  };
  try {
    await fn(kv, reopen);
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
}

// ── Unit: migrateSchema ──────────────────────────────────────────────

Deno.test("schema: every version below current has a migration step", () => {
  for (let v = 0; v < PERSIST_SCHEMA_VERSION; v++) {
    assertExists(
      SCHEMA_MIGRATIONS[v],
      `missing SCHEMA_MIGRATIONS[${v}] — bumping PERSIST_SCHEMA_VERSION requires a step`,
    );
  }
});

Deno.test("schema: current version migrates as no-op", () => {
  const state = { a: 1 };
  const r = migrateSchema(state, PERSIST_SCHEMA_VERSION);
  assertEquals(r.applied, []);
  assertEquals(r.state, state);
});

Deno.test("schema: v0 (alpha-era) migrates to current", () => {
  const r = migrateSchema({ counter: { n: 1 } }, 0);
  assertEquals(r.applied.length, PERSIST_SCHEMA_VERSION);
  assertEquals(r.state, { counter: { n: 1 } }); // v0→v1 is identity
});

Deno.test("schema: downgrade (stored newer than build) throws PERSIST_SCHEMA", () => {
  try {
    migrateSchema({}, PERSIST_SCHEMA_VERSION + 1);
    throw new Error("should have thrown");
  } catch (e) {
    assertEquals(e instanceof AioError, true);
    assertEquals((e as AioError).code, "PERSIST_SCHEMA");
  }
});

Deno.test("schema: missing migration step throws PERSIST_SCHEMA", () => {
  try {
    // Force a gap by targeting a far-future version with no steps defined.
    migrateSchema({}, PERSIST_SCHEMA_VERSION, PERSIST_SCHEMA_VERSION + 5);
    throw new Error("should have thrown");
  } catch (e) {
    assertEquals(e instanceof AioError, true);
    assertEquals((e as AioError).code, "PERSIST_SCHEMA");
  }
});

// ── Integration: load + migrate over real Deno.Kv ────────────────────

Deno.test("schema: loadAndMigrateSnapshot returns null on empty store", async () => {
  await withKv(async (kv) => {
    const logs: LogEntry[] = [];
    const r = await loadAndMigrateSnapshot(
      kv,
      "app",
      "app-state",
      "single",
      makeLog(logs),
    );
    assertEquals(r, null);
  });
});

Deno.test("schema: alpha-era snapshot (state, no stamp) loads and logs migration", async () => {
  await withKv(async (kv) => {
    await kv.set("app-state", { counter: { n: 42 } });
    const logs: LogEntry[] = [];
    const r = await loadAndMigrateSnapshot(
      kv,
      "app",
      "app-state",
      "single",
      makeLog(logs),
    );
    assertEquals(r, { counter: { n: 42 } });
    assertEquals(
      logs.some((l) => l.msg.includes("schema migrated v0")),
      true,
      "migration must be logged",
    );
  });
});

Deno.test("schema: store written by a NEWER schema fails loudly", async () => {
  await withKv(async (kv) => {
    await kv.set("app-state", { counter: { n: 1 } });
    await kv.set("app:__schema", PERSIST_SCHEMA_VERSION + 1);
    const logs: LogEntry[] = [];
    try {
      await loadAndMigrateSnapshot(
        kv,
        "app",
        "app-state",
        "single",
        makeLog(logs),
      );
      throw new Error("should have thrown");
    } catch (e) {
      assertEquals(e instanceof AioError, true);
      assertEquals((e as AioError).code, "PERSIST_SCHEMA");
    }
  });
});

Deno.test("schema: multi-mode snapshots migrate the same way", async () => {
  await withKv(async (kv) => {
    await kv.setMulti("app-state", { counter: { n: 3 }, user: { id: "x" } });
    const logs: LogEntry[] = [];
    const r = await loadAndMigrateSnapshot(
      kv,
      "app",
      "app-state",
      "multi",
      makeLog(logs),
    );
    assertEquals(r, { counter: { n: 3 }, user: { id: "x" } });
  });
});

// ── Integration: persistence manager stamps after write ─────────────

function makeManager(
  kv: SkvInstance,
  stateRef: { current: Record<string, unknown> },
  logs: LogEntry[],
  cellVersions?: Record<string, number>,
) {
  return createPersistenceManager({
    kvDb: kv,
    asyncDb: null,
    dbSchema: undefined,
    persistKey: "app-state",
    persistMode: "single",
    persistMs: 5,
    getState: () => stateRef.current,
    getDBState: (s) => s,
    log: makeLog(logs),
    getReportOpts: () => ({}),
    cellVersions,
    appId: "app",
  });
}

Deno.test("schema: persist stamps __schema after a successful write", async () => {
  await withKv(async (kv) => {
    const logs: LogEntry[] = [];
    const stateRef = { current: { counter: { n: 7 } } };
    const mgr = makeManager(kv, stateRef, logs);

    // Nothing written yet → no stamp yet (stamp never outruns state).
    assertEquals(await kv.get("app:__schema"), null);

    mgr.schedulePersist();
    await mgr.flushPersist();
    mgr.setShuttingDown();

    assertEquals(await kv.get("app:__schema"), PERSIST_SCHEMA_VERSION);
    assertEquals(await kv.get("app-state"), { counter: { n: 7 } });
  });
});

Deno.test("schema: cell versions stamp closes the migration loop across restarts", async () => {
  await withKv(async (kv, reopen) => {
    let migrateCalls = 0;
    const cellMigrations = new Map<string, CellMigrationInfo>([[
      "counter",
      {
        version: 2,
        initialState: { n: 0 },
        onMigrate: (s) => {
          migrateCalls++;
          return s;
        },
      },
    ]]);

    // "Run 1": alpha-era store (state, no version stamps) → migration runs.
    await kv.set("app-state", { counter: { n: 5 } });
    const logs: LogEntry[] = [];
    const state1 = (await loadAndMigrateSnapshot(
      kv,
      "app",
      "app-state",
      "single",
      makeLog(logs),
    ))!;
    const versions1 = await kv.get<Record<string, number>>("app:__versions") ??
      {};
    applyCellMigrations(state1, cellMigrations, versions1, makeLog(logs));
    assertEquals(migrateCalls, 1, "run 1 must migrate");

    // Persist → stamps __schema + __versions.
    const stateRef = { current: state1 };
    const mgr = makeManager(kv, stateRef, logs, { counter: 2 });
    mgr.schedulePersist();
    await mgr.flushPersist();
    mgr.setShuttingDown();
    assertEquals(await kv.get("app:__versions"), { counter: 2 });

    // "Run 2": reopen the store — versions stamped → no re-migration.
    const kv2 = await reopen();
    const state2 = (await loadAndMigrateSnapshot(
      kv2,
      "app",
      "app-state",
      "single",
      makeLog(logs),
    ))!;
    const versions2 = await kv2.get<Record<string, number>>("app:__versions") ??
      {};
    applyCellMigrations(state2, cellMigrations, versions2, makeLog(logs));
    assertEquals(migrateCalls, 1, "run 2 must not re-migrate");
  });
});
