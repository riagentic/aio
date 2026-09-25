// Round 3 (db tier): on a `:memory:` database a `db.query()` from OUTSIDE an
// open callback `db.transaction()` waits for it (no second connection sees the
// same data — AIO-421 — and every in-memory sharing mode either refuses the
// reader or dirty-reads). A callback that awaited such a read deadlocked
// FOREVER, with no error: the read was queued behind the callback, never
// posted to the worker, so not even the request ceiling applied. It now fails
// by name after that ceiling. (The file-db case never waits — see
// db-callback-tx-outside-read-no-wait.test.ts.)

import { assertEquals, assertRejects } from "@std/assert";
import { createDB } from "../src/db/async-db.ts";

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

Deno.test("db: :memory: callback awaiting a read started outside it fails by name, not a silent deadlock", async () => {
  const db = createDB(":memory:", { requestTimeoutMs: 400 });
  try {
    await db.execute("CREATE TABLE cfg (k TEXT PRIMARY KEY, v TEXT)");
    await db.execute("INSERT INTO cfg VALUES ('rate', '5')");
    let memo: Promise<unknown[]> | null = null;
    const loadCfg = () =>
      memo ??= (async () => {
        await new Promise((r) => setTimeout(r, 10));
        return (await db.query("SELECT k, v FROM cfg ORDER BY k")).rows;
      })();
    loadCfg(); // outside any transaction, starts the loader
    const tx = db.transaction(async (t) => {
      await t.execute("INSERT INTO cfg VALUES ('x', '1')");
      return await loadCfg(); // the callback awaits the outside read
    });
    await assertRejects(
      () => within(tx, 5000, "the transaction"),
      Error,
      "DEADLOCK",
    );
    // Rolled back, and the handle still works.
    assertEquals(
      (await db.query("SELECT k FROM cfg ORDER BY k")).rows,
      [{ k: "rate" }],
    );
  } finally {
    await db.close();
  }
});

Deno.test("db: :memory: outside read still waits for a short callback and answers committed data", async () => {
  const db = createDB(":memory:", { requestTimeoutMs: 5000 });
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await db.execute("INSERT INTO t VALUES (1)");
    let inserted!: () => void;
    const didInsert = new Promise<void>((r) => inserted = r);
    const tx = db.transaction(async (t) => {
      await t.execute("INSERT INTO t VALUES (2)");
      inserted();
      await new Promise((r) => setTimeout(r, 50));
      throw new Error("abort");
    });
    await didInsert;
    const read = db.query<{ n: number }>("SELECT COUNT(*) AS n FROM t");
    await assertRejects(() => tx, Error, "abort");
    assertEquals((await read).rows, [{ n: 1 }], "never the rolled-back row");
  } finally {
    await db.close();
  }
});

Deno.test("db: :memory: outside read waits out a long transaction that keeps making progress", async () => {
  // The ceiling counts from the transaction's last tx.* request, not from the
  // read's call: ~800 ms of steady work under a 400 ms ceiling is not stuck.
  const db = createDB(":memory:", { requestTimeoutMs: 400 });
  try {
    await db.execute("CREATE TABLE t (v INTEGER)");
    let begun!: () => void;
    const didBegin = new Promise<void>((r) => begun = r);
    const tx = db.transaction(async (t) => {
      for (let i = 0; i < 8; i++) {
        await t.execute("INSERT INTO t VALUES (?)", [i]);
        if (i === 0) begun();
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await didBegin;
    const read = db.query<{ n: number }>("SELECT COUNT(*) AS n FROM t");
    read.catch(() => {}); // asserted below — never an unhandled rejection
    await within(tx, 5000, "the transaction");
    assertEquals((await within(read, 5000, "the read")).rows, [{ n: 8 }]);
  } finally {
    await db.close();
  }
});
