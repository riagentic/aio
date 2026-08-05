// ONE persist cycle, ONE picture of state — across BOTH stores.
//
// A cell's data is split over two places in the SAME `state.db`: rows bound to
// a `db:` table go to that table, everything else goes to the `aio_kv` snapshot
// row. One method writes both halves (`s.items.push(row); s.n += 1`), so the
// two are only ever meaningful together.
//
// The persist cycle used to read live state TWICE — once to diff the tables,
// once to build the snapshot, several awaits apart — and commit them in TWO
// transactions. Two consequences, both silent:
//
//   * an action landing between the two reads put the snapshot ONE AHEAD of
//     the table (163 rows, counter says 164);
//   * a process dying between the two COMMITS left the rows with no snapshot
//     at all, so the next launch restored the rows next to a counter of 0.
//
// Either way the app came back describing two different moments, and nothing —
// not the log, not `checkIntegrityOnBoot` — said so. Both halves are pinned
// here: the in-process test pins the mechanism, the subprocess test pins the
// property against a real SIGKILL on a real disk.
import { assert, assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { createPersistenceManager } from "../src/server/persistence.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import type { DB, QueryResult, Tx } from "../src/db/types.ts";
import { initSchema } from "../src/db/state-sync.ts";
import { integer, pk, table } from "../src/server/sql.ts";
import { freePort } from "../src/testing/server-test.ts";

// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;
// deno-lint-ignore no-explicit-any
type Any = any;

/** A real in-memory SQLite DB that records every batch it is asked to commit,
 *  and can run a hook the moment a batch starts — the seam where "the app kept
 *  running while the persist was writing" lives. */
function recordingDb(): {
  db: DB;
  batches: { sql: string; params?: unknown[] }[][];
  onBatch: (fn: (() => void) | null) => void;
  close: () => void;
} {
  const sqlite = new DatabaseSync(":memory:");
  const batches: { sql: string; params?: unknown[] }[][] = [];
  let hook: (() => void) | null = null;
  const query = <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> =>
    Promise.resolve({
      rows: sqlite.prepare(sql).all(..._p(params ?? [])) as T[],
      changes: 0,
      lastInsertRowId: 0n,
    });
  const execute = (sql: string, params?: unknown[]): Promise<QueryResult> => {
    const r = sqlite.prepare(sql).run(..._p(params ?? []));
    return Promise.resolve({
      rows: [],
      changes: Number(r.changes),
      lastInsertRowId: BigInt(r.lastInsertRowid),
    });
  };
  const transaction = (async (arg: unknown) => {
    if (typeof arg === "function") {
      return await (arg as (tx: Tx) => Promise<unknown>)({ query, execute });
    }
    const stmts = arg as { sql: string; params?: unknown[] }[];
    batches.push(stmts);
    // Fires INSIDE the write, before any statement runs: exactly when a method
    // that landed a moment ago commits its own change.
    const h = hook;
    hook = null;
    h?.();
    const out: QueryResult[] = [];
    for (const s of stmts) out.push(await execute(s.sql, s.params));
    return out;
  }) as Any;
  return {
    db: { query, execute, transaction, close: () => Promise.resolve() },
    batches,
    onBatch: (fn) => {
      hook = fn;
    },
    close: () => sqlite.close(),
  };
}

async function makeManager(mode: "single" | "multi") {
  const schema = { notes_items: table({ id: pk(), v: integer() }) };
  const rec = recordingDb();
  await initSchema(rec.db, schema);
  await rec.db.execute(SKV_SCHEMA);
  rec.batches.length = 0; // schema setup is not a persist cycle

  const state = { notes: { items: [] as { id: number; v: number }[], n: 0 } };
  const add = () => {
    state.notes = {
      items: [...state.notes.items, {
        id: state.notes.n + 1,
        v: state.notes.n + 1,
      }],
      n: state.notes.n + 1,
    };
  };
  const p = createPersistenceManager({
    appId: "atomicity-probe",
    persistKey: "atomicity-probe",
    persistMode: mode,
    persistMs: 2,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as Any,
    getState: () => state as unknown as Record<string, unknown>,
    getDBState: (s: Record<string, unknown>) => s,
    getTableState: () => ({ notes_items: state.notes.items }),
    asyncDb: rec.db,
    dbSchema: schema,
    kvDb: sqliteKv(rec.db),
    getReportOpts: () => ({ onError: () => {} }),
  } as Any);
  return { p, rec, state, add, schema };
}

/** What the two stores say, read straight back out. */
async function readStores(
  db: DB,
  mode: "single" | "multi",
): Promise<{ rows: number; n: number | null }> {
  const rows = (await db.query("SELECT id FROM notes_items")).rows.length;
  const kv = (await db.query<{ k: string; v: string }>(
    "SELECT k, v FROM aio_kv",
  )).rows;
  const row = mode === "single"
    ? kv.find((r) => r.k === "atomicity-probe")
    : kv.find((r) =>
      r.k.startsWith("atomicity-probe") && r.k.endsWith("notes")
    );
  if (!row) return { rows, n: null };
  const doc = JSON.parse(row.v) as Any;
  return { rows, n: (mode === "single" ? doc.notes.n : doc.n) as number };
}

for (const mode of ["single", "multi"] as const) {
  Deno.test(`persist (${mode}): the db: table and the state snapshot land in ONE transaction`, async () => {
    const { p, rec, add } = await makeManager(mode);
    try {
      add();
      await p.flushPersist();
      const withTable = rec.batches.filter((b) =>
        b.some((s) => /INSERT INTO notes_items/.test(s.sql))
      );
      assertEquals(
        withTable.length,
        1,
        `the table rows must be written exactly once, got ${rec.batches.length} batch(es)`,
      );
      assert(
        withTable[0]!.some((s) => /aio_kv/.test(s.sql)),
        "the aio_kv snapshot must ride in the SAME transaction as the table " +
          "rows — two commits means a process that dies between them comes " +
          "back with the rows and no snapshot. Batch was:\n" +
          withTable[0]!.map((s) => s.sql.split("\n")[0]).join("\n"),
      );
    } finally {
      p.setShuttingDown();
      rec.close();
    }
  });

  Deno.test(`persist (${mode}): an action landing MID-WRITE cannot desync the two stores`, async () => {
    const { p, rec, add, db = rec.db } = await makeManager(mode) as Any;
    try {
      add(); // one row, n = 1
      // The app keeps running while the persist writes: a second `add`
      // commits the instant the transaction opens. The cycle must still write
      // ONE consistent picture — the one it read before it started.
      rec.onBatch(() => add());
      await p.flushPersist();

      const { rows, n } = await readStores(db, mode);
      assert(n !== null, "the snapshot row must exist");
      assertEquals(
        n,
        rows,
        `the counter and the table must describe the same moment — ` +
          `table has ${rows} row(s), snapshot says ${n}. Two reads of live ` +
          `state in one cycle is how a killed process comes back with N rows ` +
          `and a counter of N+1.`,
      );
    } finally {
      p.setShuttingDown();
      rec.close();
    }
  });
}

// ── The property, against a real process on a real disk ──────────────────

const CHILD = `
import { aio, cell, integer, pk, table } from "${
  new URL("../mod.ts", import.meta.url).href
}";
const box = cell("box", {
  state: { items: [], n: 0, pad: "" },
  methods: {
    add(s) { s.n += 1; s.items.push({ id: s.n, v: s.n }); },
    setPad(s, v) { s.pad = v; },
  },
});
const app = await aio.run({
  cells: [box],
  appId: "kill-atomicity-probe",
  appVersion: "0.0.0",
  client: "server-only",
  persist: true,
  persistDebounceMs: 15,
  port: Number(Deno.env.get("PORT")),
  appDir: Deno.env.get("DIR"),
  db: { items: table({ id: pk(), v: integer() }) },
});
// A large snapshot makes the KV half of the write measurably slower than the
// table half — it WIDENS the window this test aims at, it does not create it.
await box.setPad("x".repeat(200_000));
Deno.writeTextFileSync(Deno.env.get("DIR") + "/ready", "1");
for (;;) { await box.add(); await new Promise((r) => setTimeout(r, 2)); }
`;

Deno.test("persist: SIGKILL never leaves the db: table and the snapshot disagreeing", async () => {
  const KILLS = 6;
  const torn: string[] = [];
  for (let i = 0; i < KILLS; i++) {
    const dir = await Deno.makeTempDir({ prefix: "aio-kill-atomicity-" });
    await Deno.writeTextFile(`${dir}/app.ts`, CHILD);
    const proc = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        `${dir}/app.ts`,
      ],
      env: { DIR: dir, PORT: String(freePort()), AIO_APPS_DIR: dir },
      stdout: "null",
      stderr: "null",
    }).spawn();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        await Deno.stat(`${dir}/ready`);
        break;
      } catch { /* still booting */ }
      await new Promise((r) => setTimeout(r, 10));
    }
    // Long enough for several debounce windows to have committed.
    await new Promise((r) =>
      setTimeout(r, 150 + Math.floor(Math.random() * 300))
    );
    try {
      proc.kill("SIGKILL");
    } catch { /* already gone */ }
    await proc.output();

    const sqlite = new DatabaseSync(`${dir}/data/state.db`, { readOnly: true });
    const rows =
      (sqlite.prepare("SELECT id FROM items").all() as unknown[]).length;
    const kv = sqlite.prepare("SELECT v FROM aio_kv WHERE k = 'state'")
      .all() as { v: string }[];
    sqlite.close();
    const n = kv[0] ? (JSON.parse(kv[0].v) as Any).box.n as number : 0;
    if (n !== rows) {
      torn.push(`kill ${i}: table has ${rows} row(s), snapshot says ${n}`);
    }
    await Deno.remove(dir, { recursive: true });
  }
  assertEquals(
    torn,
    [],
    "a killed process must come back with ONE state, not two:\n" +
      torn.join("\n"),
  );
});
