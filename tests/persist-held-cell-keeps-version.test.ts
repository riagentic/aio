// Persist tier: a HELD cell was stamped with this build's version.
//
// `_versionStamp(written)` narrowed the SHAPE stamp to the cells a write
// actually carries ("a cell left untouched on disk still holds what an earlier
// declaration wrote, and stamping it with this one would vouch for bytes it
// never wrote") — but the VERSION stamp was merged for EVERY cell in
// `cfg.cellVersions`, written or not. A cell held at its last clean write (a
// value JSON refuses, a refused table) keeps its OLD bytes on disk — in single
// mode they are literally written back — while `<appId>:__versions` was bumped
// to the running build's version. The next boot read v2 beside v1 bytes and
// skipped `onMigrate`: the "amounts are now cents" migration never ran over the
// data that needed it. Once the cell writes cleanly, it is stamped.

import { assertEquals } from "@std/assert";
import { createDB } from "../src/server-entry.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import { createPersistenceManager } from "../src/server/persistence.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const quietLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Log;

for (const mode of ["single", "multi"] as const) {
  Deno.test(`persist ${mode}: a held cell keeps its stored version beside its stored bytes`, async () => {
    const db = createDB(":memory:");
    try {
      await db.execute(SKV_SCHEMA);
      const kv = sqliteKv(db);
      // What build v1 left on disk: wallet at v1 (amount in whole units).
      const stored = { counter: { n: 1 }, wallet: { amount: 1 } };
      if (mode === "single") await kv.set("app:state", stored);
      else await kv.setMulti("app:state", stored);
      await kv.set("app:__schema", 1);
      await kv.set("app:__versions", { counter: 1, wallet: 1 });

      // Build v2 booted: wallet migrated v1→v2 in memory (cents), and a
      // method then put a value JSON refuses into it, so the wallet cell is
      // HELD at its last clean write. The counter cell persists normally.
      const live = {
        counter: { n: 2 },
        wallet: { amount: 100, big: 1n },
      } as Record<string, unknown>;
      const mgr = createPersistenceManager({
        kvDb: kv,
        asyncDb: db,
        dbSchema: undefined,
        persistKey: "app:state",
        persistMode: mode,
        persistMs: 1,
        getState: () => live,
        getDBState: (s) => s,
        log: quietLog,
        getReportOpts: () => ({}),
        appId: "app",
        cellVersions: { counter: 1, wallet: 2 },
        storedKeys: Object.keys(stored),
      });
      await mgr.flushPersist();

      const doc = mode === "single"
        ? await kv.get<Record<string, unknown>>("app:state")
        : await kv.getMulti<Record<string, unknown>>("app:state");
      // The hold itself works: counter landed, wallet kept its v1 bytes.
      assertEquals(doc, { counter: { n: 2 }, wallet: { amount: 1 } });
      // …so the version beside those bytes must still say v1, or the next
      // boot skips the migration they need.
      const versions = await kv.get<Record<string, number>>("app:__versions");
      assertEquals(versions?.wallet, 1, JSON.stringify(versions));

      // The value is fixed: the cell's next clean write carries v2 bytes, and
      // the stamp moves with them.
      live.wallet = { amount: 100 };
      await mgr.flushPersist();
      const after = mode === "single"
        ? await kv.get<Record<string, unknown>>("app:state")
        : await kv.getMulti<Record<string, unknown>>("app:state");
      assertEquals(after, { counter: { n: 2 }, wallet: { amount: 100 } });
      const v2 = await kv.get<Record<string, number>>("app:__versions");
      assertEquals(v2?.wallet, 2, JSON.stringify(v2));
    } finally {
      await db.close();
    }
  });
}
