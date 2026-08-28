// Audit 2026-08-27 (HIGH, data corruption): the version stamp was written
// OUTSIDE the transaction that wrote the state it describes.
//
// `_stampVersions()` ran two `kvDb.set` calls AFTER the snapshot transaction
// committed, and its failure was caught-and-logged. So a kill between COMMIT
// and the stamp — or any stamp failure — left state on disk with no version
// beside it, the next boot read `persisted = 0`, and `onMigrate(state, 0)` ran
// again over already-migrated data. Verified end to end: a v1→v2 "amounts are
// now cents" migration applied twice, 101 → 10100. That is the exact failure
// the downgrade guard exists to prevent, reached through a crash window.
//
// Reproduced before the fix, by recording what the store was asked to do:
//   TX [app:state]
//   set app:__schema
//   set app:__versions
// The window between line 1 and line 2 is the bug. There is now one line.

import { assert, assertEquals } from "@std/assert";
import { createDB } from "../src/server-entry.ts";
import type { DB } from "../src/db/mod.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import { createPersistenceManager } from "../src/server/persistence.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const quietLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Log;

/** A db that records every transaction batch, and can be made to refuse one. */
function recordingDb(db: DB) {
  const batches: string[][] = [];
  let refuseNext = false;
  const inner = db.transaction.bind(db);
  // deno-lint-ignore no-explicit-any
  (db as any).transaction = (arg: any) => {
    if (Array.isArray(arg)) {
      batches.push(
        arg.map((s: { sql: string; params?: unknown[] }) =>
          String(s.params?.[0] ?? s.sql.slice(0, 24))
        ),
      );
      if (refuseNext) {
        refuseNext = false;
        return Promise.reject(new Error("disk I/O error"));
      }
    }
    return inner(arg);
  };
  return { batches, refuse: () => (refuseNext = true) };
}

async function setup(mode: "single" | "multi") {
  const db = createDB(":memory:");
  await db.execute(SKV_SCHEMA);
  const rec = recordingDb(db);
  const kv = sqliteKv(db);
  const sets: string[] = [];
  const spy = {
    ...kv,
    set: (k: string, v: unknown) => (sets.push(k), kv.set(k, v)),
  };
  const state = { v: { counter: { n: 1 } } as Record<string, unknown> };
  const mgr = createPersistenceManager({
    kvDb: spy as typeof kv,
    asyncDb: db,
    dbSchema: undefined,
    persistKey: "app:state",
    persistMode: mode,
    persistMs: 1,
    getState: () => state.v,
    getDBState: (s) => s,
    log: quietLog,
    getReportOpts: () => ({}),
    appId: "app",
    cellVersions: { counter: 2 },
  });
  const keys = async () =>
    (await db.query<{ k: string }>("SELECT k FROM aio_kv ORDER BY k")).rows.map(
      (r) => r.k,
    );
  return { db, kv, mgr, state, sets, keys, ...rec };
}

for (const mode of ["single", "multi"] as const) {
  Deno.test(`persist ${mode}: state and its version stamp land in ONE transaction`, async () => {
    const h = await setup(mode);
    try {
      await h.mgr.flushPersist();
      assertEquals(h.batches.length, 1, "one transaction, not two writes");
      const batch = h.batches[0]!;
      assert(
        batch.some((k) => k.startsWith("app:state")),
        `the snapshot row is in it — ${batch}`,
      );
      assert(
        batch.includes("app:__schema"),
        `the schema stamp is in it — ${batch}`,
      );
      assert(
        batch.includes("app:__versions"),
        `the cell versions are in it — ${batch}`,
      );
      assertEquals(
        h.sets,
        [],
        "and nothing is stamped by a separate write afterwards",
      );
    } finally {
      await h.db.close();
    }
  });

  Deno.test(`persist ${mode}: a refused write leaves NEITHER state nor version`, async () => {
    const h = await setup(mode);
    try {
      h.refuse();
      await h.mgr.flushPersist();
      assertEquals(
        (await h.keys()).filter((k) => k !== "__skv_meta"),
        [],
        "state written with no version beside it is the corruption window",
      );
      // The next cycle writes both, together.
      await h.mgr.flushPersist();
      const after = await h.keys();
      assert(after.includes("app:__versions"), `${after}`);
      assert(after.some((k) => k.startsWith("app:state")), `${after}`);
    } finally {
      await h.db.close();
    }
  });
}

Deno.test("persist: the stamp stays MONOTONIC per cell (a rollback never stamps down)", async () => {
  const db = createDB(":memory:");
  try {
    await db.execute(SKV_SCHEMA);
    const kv = sqliteKv(db);
    // A newer build was here first.
    await kv.set("app:__versions", { counter: 5 });
    const state = { counter: { n: 1 } };
    const mgr = createPersistenceManager({
      kvDb: kv,
      asyncDb: db,
      dbSchema: undefined,
      persistKey: "app:state",
      persistMode: "single",
      persistMs: 1,
      getState: () => state as unknown as Record<string, unknown>,
      getDBState: (s) => s,
      log: quietLog,
      getReportOpts: () => ({}),
      appId: "app",
      cellVersions: { counter: 2 }, // the rolled-back build
    });
    await mgr.flushPersist();
    assertEquals(
      await kv.get<Record<string, number>>("app:__versions"),
      { counter: 5 },
      "an older build cannot make newer data older",
    );
  } finally {
    await db.close();
  }
});
