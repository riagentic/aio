// aio's schema versioning lives in its PRIVATE `aio_schema` table — and
// `PRAGMA user_version` belongs to the APP, untouched by aio, ever.
//
// The field lesson this pins: `user_version` is the standard SQLite idiom
// for an app's own "have I run this migration" marker. aio once stamped it
// on open, a fresh file read 1, and every `at >= version` app correction
// silently skipped. One integer cannot serve two owners.
//
// The ladder itself (src/db/ddl.ts): a file with no `aio_schema` table reads
// 0 ("pre-versioned/legacy") — the idempotent epoch-1 reconcilers run every
// boot as they always have, and `runDdlSteps` stamps the epoch; registered
// steps (version ≥ 2) run strictly once per file, in order, fatal on any
// refused statement.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/mod.ts";
import type { DB } from "../src/db/types.ts";
import {
  AIO_SCHEMA_TABLE,
  applyDdl,
  DB_SCHEMA_VERSION,
  DB_VERSION_EPOCH,
  getAioSchemaVersion,
  runDdlSteps,
  stampAioSchemaVersion,
} from "../src/db/ddl.ts";
import { applySyncMigrations, SYNC_SCHEMA } from "../src/sync/compact.ts";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "aio-schemaver-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function userVersion(db: DB): Promise<number> {
  const { rows } = await db.query<{ user_version: number }>(
    "PRAGMA user_version",
  );
  return Number(rows[0]?.user_version ?? 0);
}

// ── THE contract: user_version is the app's ─────────────────────────────

Deno.test("user_version: an APP-set value survives ALL of aio's schema work (the regression-proof)", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "app-owned.db");
    // The app uses the standard idiom: its own migration marker at N.
    {
      const db = createDB(path);
      await db.execute("PRAGMA user_version = 41");
      await db.close();
    }
    // aio then does EVERYTHING it does to a database on boot: opens it, runs
    // the versioned ladder, creates its sync schema, runs the epoch
    // reconcilers.
    const db = createDB(path);
    try {
      await runDdlSteps(db);
      for (const sql of SYNC_SCHEMA) await db.execute(sql);
      await applySyncMigrations(db);
      assertEquals(
        await userVersion(db),
        41,
        "aio touched PRAGMA user_version — that integer is the APP's " +
          "migration marker; aio's version lives in aio_schema",
      );
      // aio's own bookkeeping landed in its private table instead.
      assertEquals(await getAioSchemaVersion(db), DB_VERSION_EPOCH);
    } finally {
      await db.close();
    }
  });
});

Deno.test("user_version: a fresh aio DB leaves user_version at 0", async () => {
  await withDir(async (dir) => {
    const db = createDB(join(dir, "fresh.db"));
    try {
      await db.execute("CREATE TABLE t (a TEXT)"); // force the lazy open
      assertEquals(await userVersion(db), 0, "open must not stamp");
      await runDdlSteps(db);
      assertEquals(await userVersion(db), 0, "the ladder must not stamp");
      assertEquals(await getAioSchemaVersion(db), DB_VERSION_EPOCH);
    } finally {
      await db.close();
    }
  });
});

Deno.test("user_version: aio's source writes it nowhere", async () => {
  // Belt and braces on top of the behavioral tests: no aio source line may
  // assign PRAGMA user_version. (Reading it is not asserted against — only
  // writes clobber the app's marker.)
  const offenders: string[] = [];
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (e.name.endsWith(".ts")) {
        const text = await Deno.readTextFile(p);
        for (const m of text.matchAll(/user_version\s*=/gi)) {
          // Comments explaining the contract are fine; code is not.
          const lineStart = text.lastIndexOf("\n", m.index!) + 1;
          const line = text.slice(lineStart, text.indexOf("\n", m.index!));
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
          offenders.push(`${p}: ${line.trim()}`);
        }
      }
    }
  };
  await walk("src");
  assertEquals(
    offenders,
    [],
    "aio must never write PRAGMA user_version — it is the app's",
  );
});

// ── aio's private ladder (aio_schema) ───────────────────────────────────

Deno.test("aio_schema: a legacy (pre-versioned) db is upgraded AND stamped", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "legacy.db");
    // Build a LEGACY file: old-shape sync tables (no compacted_ts /
    // server_ts columns), no aio_schema table.
    {
      const old = createDB(path);
      await old.execute(`CREATE TABLE sync_meta (
        cell TEXT PRIMARY KEY, low_water TEXT NOT NULL,
        last_compact INTEGER NOT NULL, op_count INTEGER NOT NULL)`);
      await old.execute(`CREATE TABLE sync_compacted_ids (
        id TEXT PRIMARY KEY, compacted_at INTEGER NOT NULL)`);
      await old.close();
    }
    const db = createDB(path);
    try {
      assertEquals(await getAioSchemaVersion(db), 0, "legacy reads 0");
      await runDdlSteps(db);
      assertEquals(await getAioSchemaVersion(db), DB_VERSION_EPOCH);
      // The epoch-1 reconcilers still upgrade the legacy shape — after the
      // CREATE IF NOT EXISTS pass boot always runs first (a legacy file may
      // hold sync_meta and no sync_ops; the ALTER on a missing table is fatal
      // by design, see tests/ddl-fatal.test.ts).
      for (const sql of SYNC_SCHEMA) await db.execute(sql);
      await applySyncMigrations(db);
      const meta = await db.query<{ name: string }>(
        "PRAGMA table_info(sync_meta)",
      );
      assert(
        meta.rows.some((r) => r.name === "compacted_ts"),
        "legacy sync_meta gained compacted_ts",
      );
      const tomb = await db.query<{ name: string }>(
        "PRAGMA table_info(sync_compacted_ids)",
      );
      assert(
        tomb.rows.some((r) => r.name === "server_ts"),
        "legacy sync_compacted_ids gained server_ts",
      );
      assertEquals(
        await userVersion(db),
        0,
        "and user_version stays the app's",
      );
    } finally {
      await db.close();
    }
  });
});

Deno.test("aio_schema: a file stamped ABOVE the epoch is not re-stamped down", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "ahead.db");
    {
      const db = createDB(path);
      await stampAioSchemaVersion(db, 7);
      await db.close();
    }
    const db = createDB(path);
    try {
      await runDdlSteps(db);
      assertEquals(await getAioSchemaVersion(db), 7);
      // And the one-row shape holds.
      const { rows } = await db.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${AIO_SCHEMA_TABLE}`,
      );
      assertEquals(Number(rows[0]?.n), 1);
    } finally {
      await db.close();
    }
  });
});

Deno.test("runDdlSteps: ordered steps run ONCE each — idempotent on reboot", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "ladder.db");
    // Steps deliberately NOT idempotent (CREATE TABLE without IF NOT EXISTS,
    // plus an ALTER on the table v2 created) — a re-run would throw, so a
    // green second pass PROVES run-once. v3 depends on v2's table, so order
    // is load-bearing too.
    const steps = [
      { version: 3, statements: ["ALTER TABLE ladder ADD COLUMN b TEXT"] },
      { version: 2, statements: ["CREATE TABLE ladder (a TEXT)"] },
    ];
    const ctx = { ns: "db", source: "test", maxVersion: 3 };

    const db = createDB(path);
    try {
      const first = await runDdlSteps(db, steps, ctx);
      assertEquals(first, { from: 0, to: 3 });
      const cols = await db.query<{ name: string }>(
        "PRAGMA table_info(ladder)",
      );
      assertEquals(cols.rows.map((r) => r.name).sort(), ["a", "b"]);
      assertEquals(await userVersion(db), 0, "ladder never touches the app's");
    } finally {
      await db.close();
    }

    // "Reboot": a fresh handle on the same file — nothing re-runs.
    const db2 = createDB(path);
    try {
      const again = await runDdlSteps(db2, steps, ctx);
      assertEquals(again, { from: 3, to: 3 });
    } finally {
      await db2.close();
    }
  });
});

Deno.test("runDdlSteps: an empty ladder stamps the epoch in aio_schema only", async () => {
  await withDir(async (dir) => {
    const db = createDB(join(dir, "empty.db"));
    try {
      const r = await runDdlSteps(db, []);
      assertEquals(r, { from: 0, to: DB_VERSION_EPOCH });
      assertEquals(await getAioSchemaVersion(db), DB_VERSION_EPOCH);
      assertEquals(await userVersion(db), 0);
    } finally {
      await db.close();
    }
  });
});

Deno.test("runDdlSteps: a malformed ladder is refused loudly", async () => {
  await withDir(async (dir) => {
    const db = createDB(join(dir, "bad.db"));
    try {
      // Duplicate versions — one version stamps exactly one move.
      await assertRejects(
        () =>
          runDdlSteps(db, [
            { version: 2, statements: [] },
            { version: 2, statements: [] },
          ], { ns: "db", source: "test", maxVersion: 2 }),
        Error,
        "two DDL steps claim version 2",
      );
      // Versions below 2 belong to the epoch, not the ladder.
      await assertRejects(
        () => runDdlSteps(db, [{ version: 1, statements: [] }]),
        Error,
        "start at 2",
      );
      // A step above DB_SCHEMA_VERSION means the constant was not bumped.
      await assertRejects(
        () =>
          runDdlSteps(db, [{
            version: DB_SCHEMA_VERSION + 1,
            statements: [],
          }]),
        Error,
        "exceeds DB_SCHEMA_VERSION",
      );
    } finally {
      await db.close();
    }
  });
});

Deno.test("runDdlSteps: a refused statement is FATAL and does not stamp", async () => {
  await withDir(async (dir) => {
    const db = createDB(join(dir, "fatal.db"));
    try {
      const err = await assertRejects(
        () =>
          runDdlSteps(db, [{
            version: 2,
            statements: ["ALTER TABLE does_not_exist ADD COLUMN x TEXT"],
          }], { ns: "db", source: "runDdlSteps-test", maxVersion: 2 }),
        Error,
      );
      const msg = (err as Error).message;
      assert(msg.includes("schema migration failed"), msg);
      assert(msg.includes("ALTER TABLE does_not_exist"), msg);
      assert(msg.includes("runDdlSteps-test"), msg);
      // The failed step must NOT have been stamped as done.
      assertEquals(await getAioSchemaVersion(db), 0);
    } finally {
      await db.close();
    }
  });
});

Deno.test("applyDdl: ONE decider — duplicate column tolerated, all else fatal", async () => {
  await withDir(async (dir) => {
    const db: DB = createDB(join(dir, "decider.db"));
    try {
      await db.execute("CREATE TABLE t (a TEXT)");
      assertEquals(
        await applyDdl(db, "ALTER TABLE t ADD COLUMN b TEXT", {
          ns: "db",
          subject: 'table "t"',
          source: "test",
        }),
        "applied",
      );
      assertEquals(
        await applyDdl(db, "ALTER TABLE t ADD COLUMN b TEXT", {
          ns: "db",
          subject: 'table "t"',
          source: "test",
        }),
        "already-applied",
      );
      const err = await assertRejects(
        () =>
          applyDdl(db, "ALTER TABLE nope ADD COLUMN b TEXT", {
            ns: "sync",
            subject: 'table "nope"',
            source: "the-seam, some/file.ts",
          }),
        Error,
      );
      const msg = (err as Error).message;
      assert(msg.startsWith("sync: schema migration failed"), msg);
      assert(msg.includes('table "nope"'), msg);
      assert(msg.includes("ALTER TABLE nope ADD COLUMN b TEXT"), msg);
      assert(msg.includes("the-seam, some/file.ts"), msg);
    } finally {
      await db.close();
    }
  });
});

Deno.test("aio_schema: sync boot path (ladder + schema + migrations) lands stamped", async () => {
  await withDir(async (dir) => {
    const db = createDB(join(dir, "syncboot.db"));
    try {
      await runDdlSteps(db); // what aio-boot runs
      for (const sql of SYNC_SCHEMA) await db.execute(sql);
      await applySyncMigrations(db); // fresh schema → every ALTER tolerated
      await applySyncMigrations(db); // and idempotent
      assertEquals(await getAioSchemaVersion(db), DB_VERSION_EPOCH);
      assertEquals(await userVersion(db), 0);
    } finally {
      await db.close();
    }
  });
});
