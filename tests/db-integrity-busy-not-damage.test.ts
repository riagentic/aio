// "database is locked" is not damage.
//
// `checkAndRecover` treats a check that THROWS as corruption too severe to
// describe ("database disk image is malformed") — and it treated SQLITE_BUSY
// the same way. A second instance (`singleton: false`) booting while the
// first one held a write lock on a perfectly sound file got "integrity check
// could not run: database is locked", QUARANTINED the live database the other
// instance was writing, and restored an older snapshot over it. Found by
// running two instances on one data directory: the second quarantine was of
// the file the first had just restored.
//
// A busy database is waited for; one that stays busy is left alone, and said.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { DB } from "../src/db/types.ts";
import {
  checkAndRecover,
  snapshotPathFor,
} from "../src/server/db-integrity.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const busy = (okAfter: number) => {
  let calls = 0;
  return {
    checkIntegrity: () =>
      ++calls > okAfter
        ? Promise.resolve({ ok: true, problems: [] })
        : Promise.reject(new Error("database is locked")),
    close: () => Promise.resolve(),
    calls: () => calls,
  };
};

async function seed(dir: string) {
  const dbPath = join(dir, "state.db");
  await Deno.writeTextFile(dbPath, "LIVE");
  await Deno.writeTextFile(snapshotPathFor(dbPath), "OLDER SNAPSHOT");
  return dbPath;
}

Deno.test("checkAndRecover: a database that is briefly locked is waited for, not quarantined", async () => {
  const dir = await tempDir("aio-integrity-busy-");
  try {
    const dbPath = await seed(dir);
    const db = busy(2);
    const r = await checkAndRecover({
      db: db as unknown as DB,
      dbPath,
      log: { info() {}, warn() {}, error() {} },
      busyWaitMs: 2_000,
    });
    assertEquals(r.action, "none");
    assertEquals(db.calls(), 3);
    assertEquals(await Deno.readTextFile(dbPath), "LIVE");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("checkAndRecover: a database that stays locked is left alone — and said", async () => {
  const dir = await tempDir("aio-integrity-busy-stays-");
  try {
    const dbPath = await seed(dir);
    const warns: string[] = [];
    const r = await checkAndRecover({
      db: busy(Infinity) as unknown as DB,
      dbPath,
      log: {
        info() {},
        warn: (m) => warns.push(m),
        error: (m) => warns.push(m),
      },
      busyWaitMs: 300,
    });
    assertEquals(r.action, "unavailable");
    assertEquals(await Deno.readTextFile(dbPath), "LIVE", "never moved");
    const names = [...Deno.readDirSync(dir)].map((e) => e.name);
    assert(!names.some((n) => n.includes(".corrupt-")), `${names}`);
    assert(warns.some((w) => w.includes("locked")), `${warns}`);
  } finally {
    await dropTempDir(dir);
  }
});
