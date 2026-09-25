// Round 2 (db tier, review): a `db.query()` read from OUTSIDE an open
// callback `db.transaction()` must not see its uncommitted rows (see
// db-callback-tx-no-dirty-read.test.ts) — and must not WAIT for it either.
// Waiting deadlocked a callback that awaits that very read (a memoized loader
// first started outside it) and stalled every unrelated read for as long as a
// callback awaited anything slow. It now runs on a read-only connection.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} did not settle in ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

Deno.test("db: a callback transaction awaiting a read started outside it does not deadlock", async () => {
  const dir = await tempDir("db-outside-read-deadlock-");
  const db = createDB(join(dir, "state.db"));
  try {
    await db.execute("CREATE TABLE cfg (k TEXT PRIMARY KEY, v TEXT)");
    await db.execute("INSERT INTO cfg VALUES ('rate', '5')");
    let memo: Promise<unknown[]> | null = null;
    const loadCfg = () =>
      memo ??= (async () => {
        await new Promise((r) => setTimeout(r, 10));
        return (await db.query("SELECT k, v FROM cfg ORDER BY k")).rows;
      })();
    loadCfg(); // request A, outside any transaction, starts the loader
    const tx = db.transaction(async (t) => {
      await t.execute("INSERT INTO cfg VALUES ('x', '1')");
      return await loadCfg(); // request B awaits the same loader
    });
    assertEquals(
      await within(tx, 3000, "the transaction"),
      [{ k: "rate", v: "5" }],
      "the shared read answered committed data only",
    );
    assertEquals((await db.query("SELECT k FROM cfg")).rows.length, 2);
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});

Deno.test("db: an unrelated read answers while a callback transaction is still open", async () => {
  const dir = await tempDir("db-outside-read-stall-");
  const db = createDB(join(dir, "state.db"));
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await db.execute("INSERT INTO t VALUES (1)");
    let release!: () => void;
    const held = new Promise<void>((r) => release = r);
    let inserted!: () => void;
    const didInsert = new Promise<void>((r) => inserted = r);
    const tx = db.transaction(async (t) => {
      await t.execute("INSERT INTO t VALUES (2)");
      inserted();
      await held; // e.g. awaiting a slow external API
    });
    await didInsert;
    try {
      const r = await within(
        db.query<{ n: number }>("SELECT COUNT(*) AS n FROM t"),
        3000,
        "the unrelated read",
      );
      assertEquals(r.rows, [{ n: 1 }], "committed rows only, while open");
    } finally {
      release();
    }
    await tx;
    // The read-only connection starts a fresh read per statement: during the
    // NEXT open transaction it sees the first one's commit.
    let release2!: () => void;
    const held2 = new Promise<void>((r) => release2 = r);
    let began!: () => void;
    const didBegin = new Promise<void>((r) => began = r);
    const tx2 = db.transaction(async (t) => {
      await t.execute("INSERT INTO t VALUES (3)");
      began();
      await held2;
    });
    await didBegin;
    try {
      assertEquals(
        (await within(
          db.query<{ n: number }>("SELECT COUNT(*) AS n FROM t"),
          3000,
          "the second unrelated read",
        )).rows,
        [{ n: 2 }],
      );
    } finally {
      release2();
    }
    await tx2;
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});
