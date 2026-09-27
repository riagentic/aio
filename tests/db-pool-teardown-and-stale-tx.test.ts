// async-db worker pool — a crash of ONE worker tears the whole
// pool down, and a tx handle outliving its callback.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** A stand-in Worker: answers `open`/`close`, never answers `HANG`, and
 *  fires `onerror` for `CRASH` — so a worker death is deterministic. */
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  sqls: string[] = [];
  static all: FakeWorker[] = [];
  constructor(_url: URL, _opts?: unknown) {
    FakeWorker.all.push(this);
  }
  postMessage(msg: { id: number; type: string; sql?: string }) {
    if (this.terminated) return;
    if (msg.sql) this.sqls.push(msg.sql);
    queueMicrotask(() => {
      if (this.terminated) return;
      if (msg.sql === "HANG") return; // still running
      if (msg.sql === "CRASH") {
        this.onerror?.({ message: "boom" } as ErrorEvent);
        return;
      }
      this.onmessage?.(
        {
          data: {
            id: msg.id,
            ok: true,
            data: { rows: [], changes: 0, lastInsertRowId: 0 },
          },
        } as MessageEvent,
      );
    });
  }
  terminate() {
    this.terminated = true;
  }
}

function race<T>(p: Promise<T>, ms: number): Promise<T | "HUNG"> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<"HUNG">((r) => {
      t = setTimeout(() => r("HUNG"), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

Deno.test("hunt r12-a: one reader crashing must not strand the OTHER workers' in-flight requests", async () => {
  const Real = globalThis.Worker;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Worker = FakeWorker;
  try {
    const db = createDB("/nonexistent/fake.db", { readers: 2 });
    // readers round-robin: first query → reader 0, second → reader 1.
    const slow = db.query("HANG").then(
      () => "resolved",
      (e: Error) => `rejected: ${e.message}`,
    );
    await new Promise((r) => setTimeout(r, 10));
    const crash = db.query("CRASH").catch((e: Error) => e.message);
    assert(String(await crash).includes("db worker error"));
    // The reader running "HANG" was terminated by _teardownPool — its
    // answer is never coming. It must fail now, not after 120 s.
    const got = await race(slow, 300);
    assert(
      got !== "HUNG",
      "request on a worker terminated by the pool teardown never settled " +
        "(would hang until the 120s request ceiling)",
    );
    assert(String(got).startsWith("rejected"), String(got));
    await db.close();
  } finally {
    globalThis.Worker = Real;
    FakeWorker.all = [];
  }
});

Deno.test("hunt r12-a: a tx handle used after its callback returned must be refused, not join another transaction", async () => {
  const dir = await tempDir("hunt-r12a-tx-");
  const db = createDB(join(dir, "t.db"));
  try {
    await db.execute("CREATE TABLE t (v TEXT)");
    // deno-lint-ignore no-explicit-any
    let leaked: any;
    await db.transaction(async (tx) => {
      leaked = tx;
      await tx.execute("INSERT INTO t VALUES ('inside')");
    });
    // A second, unrelated callback transaction that rolls back.
    let release!: () => void;
    const gate = new Promise<void>((r) => release = r);
    const second = db.transaction(async (tx) => {
      await tx.execute("INSERT INTO t VALUES ('second')");
      await gate;
      throw new Error("second rolls back");
    }).catch(() => "rolled back");
    await new Promise((r) => setTimeout(r, 50));
    // The stale handle writes while the second transaction is open.
    const stale = await leaked.execute("INSERT INTO t VALUES ('stale')").then(
      () => "resolved",
      (e: Error) => `rejected: ${e.message}`,
    );
    release();
    assertEquals(await second, "rolled back");
    const { rows } = await db.query<{ v: string }>(
      "SELECT v FROM t ORDER BY v",
    );
    const vals = rows.map((r) => r.v);
    // Either the stale write is refused loudly, or it is durable. Resolving
    // OK and then vanishing with someone else's ROLLBACK is the bug.
    assert(
      stale.startsWith("rejected") || vals.includes("stale"),
      `stale tx.execute() ${stale}, but the row is gone (rows: ${
        JSON.stringify(vals)
      }) — it joined another callback's transaction and was rolled back`,
    );
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});

Deno.test("db teardown: a write stranded by a reader crash says its outcome is UNKNOWN, not that it never ran", async () => {
  const Real = globalThis.Worker;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Worker = FakeWorker;
  try {
    const db = createDB("/nonexistent/fake.db", { readers: 1 });
    // The writer has the write in hand; its reply is still queued.
    const write = db.execute("HANG").then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await new Promise((r) => setTimeout(r, 10));
    await db.query("CRASH").catch(() => {});
    const msg = String(await race(write, 300));
    // "never ran to completion" tells the app it is safe to retry — a write
    // that DID commit would then be written twice.
    assert(!/never ran/.test(msg), msg);
    assert(/may still have committed/.test(msg), msg);
    await db.close();
  } finally {
    globalThis.Worker = Real;
    FakeWorker.all = [];
  }
});

Deno.test("db teardown: a callback transaction whose writer was torn down refuses its later statements, never runs them in autocommit", async () => {
  const Real = globalThis.Worker;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Worker = FakeWorker;
  try {
    const db = createDB("/nonexistent/fake.db", { readers: 1 });
    const out = await db.transaction(async (tx) => {
      await tx.execute("INSERT A");
      // A reader dies mid-transaction: the whole pool, writer included,
      // is torn down — SQLite rolls back `INSERT A` with the connection.
      await db.query("CRASH").catch(() => {});
      await tx.execute("INSERT B");
    }).then(() => "resolved", (e: Error) => e.message);
    assert(/torn down/.test(out) && /NOT run/.test(out), out);
    const [w0, ...rest] = FakeWorker.all;
    assertEquals(w0!.sqls, ["BEGIN", "INSERT A"]);
    // No statement of the transaction reached any later connection.
    const leaked = rest.flatMap((w) => w.sqls).filter((q) => q !== "CRASH");
    assertEquals(leaked, [], `ran outside the tx: ${leaked.join(", ")}`);
    await db.close();
  } finally {
    globalThis.Worker = Real;
    FakeWorker.all = [];
  }
});
