// One refused row must never leave a TORN cell on disk.
//
// A cell's data lives in two places in one `state.db`: its bound `db:` rows,
// and its scalars in the snapshot row. They are only meaningful together — a
// counter, a `nextId`, the rows they count. The table half used to fail ALONE:
// a row the planner refused (a NUL in a TEXT column) or SQLite refused (NOT
// NULL, UNIQUE) rolled back the tables while the snapshot — and, with
// `journal: true`, the journal watermark — committed without them.
//
// Measured through a real reboot, identically with and without the journal:
// before shutdown `{counter:5, nextId:5, ids:[2,3,4]}`, after it
// `{counter:5, nextId:5, ids:[1,2]}` — deleted row 1 back, valid row 4 gone.
// The journal could not help: its watermark had advanced past the refused
// actions and compaction had deleted them.
//
// The contract pinned here:
//   • journal off — the refused cell is held WHOLE (snapshot + rows) at its
//     last clean write; every other cell still persists;
//   • journal on — nothing advances (no subset is consistent under a replay
//     that re-reduces every action over the whole state), so the refused tail
//     replays at the next boot, and is refused again, loudly, until fixed.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import { createPersistenceManager } from "../src/server/persistence.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import type { DB, QueryResult, Tx } from "../src/db/types.ts";
import { initSchema } from "../src/db/state-sync.ts";
import { pk, table, text } from "../src/server/sql.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

type Row = { id: number; body: string };
type C = { items: Row[]; counter: number; nextId: number };

function makeCells() {
  const c = cell("torn_c", {
    state: { items: [] as Row[], counter: 0, nextId: 1 },
    methods: {
      add(s: C, body: string) {
        s.items.push({ id: s.nextId++, body });
        s.counter++;
      },
      del(s: C, id: number) {
        s.items = s.items.filter((r) => r.id !== id);
        s.counter++;
      },
      clean(s: C) {
        s.items = s.items.map((r) => ({
          ...r,
          body: r.body.replaceAll("\0", ""),
        }));
        s.counter++;
      },
    },
  });
  const other = cell("torn_other", {
    state: { v: 0 },
    methods: {
      set(s: { v: number }, v: number) {
        s.v = v;
      },
    },
  });
  return { c, other };
}

type Api = {
  add: (b: string) => Promise<void>;
  del: (id: number) => Promise<void>;
  clean: () => Promise<void>;
};

async function boot(dir: string, journal: boolean) {
  _resetAioRuntime();
  const { c, other } = makeCells();
  const port = freePort();
  const app = await aio.run({
    cells: [c, other],
    db: { items: table({ id: pk(), body: text() }) },
    appId: "torn",
    journal,
    dbPath: join(dir, "state.db"),
    port,
    persistDebounceMs: 999999, // only an explicit flush (or close) writes
    libraryMode: true,
    client: "server-only",
    baseDir: dir,
  } as Any);
  const flush = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/persist`, {
      method: "POST",
      headers: { "X-AIO": "1" },
    });
    return { status: r.status, text: await r.text() };
  };
  const view = () => {
    const s = (app.getState() as Any).torn_c as C;
    return {
      counter: s.counter,
      nextId: s.nextId,
      ids: s.items.map((r) => r.id),
    };
  };
  return {
    app,
    api: c as unknown as Api,
    other: other as unknown as { set: (v: number) => Promise<void> },
    otherV: () => ((app.getState() as Any).torn_other as { v: number }).v,
    flush,
    view,
  };
}

/** What the file itself says, read with the app closed: the snapshot's
 *  scalars and the table's ids. */
function onDisk(dir: string): { counter: number; ids: number[] } {
  const db = new DatabaseSync(join(dir, "state.db"), { readOnly: true });
  try {
    const ids = (db.prepare("SELECT id FROM items ORDER BY id").all() as {
      id: number;
    }[]).map((r) => r.id);
    const rows = db.prepare("SELECT k, v FROM aio_kv").all() as {
      k: string;
      v: string;
    }[];
    // Single mode: one document holding every cell. Multi: a row per cell.
    let counter: number | undefined;
    for (const r of rows) {
      const v = JSON.parse(r.v) as Any;
      if (r.k.endsWith("\x1ftorn_c")) counter = v.counter;
      else if (v?.torn_c) counter = v.torn_c.counter;
    }
    assert(
      counter !== undefined,
      `no snapshot of torn_c in ${rows.map((r) => r.k)}`,
    );
    return { counter, ids };
  } finally {
    db.close();
  }
}

Deno.test("persist (journal off): a refused row holds its WHOLE cell through a real reboot; other cells still land", async () => {
  const dir = await Deno.makeTempDir({ prefix: "torn-j0-" });
  try {
    const a = await boot(dir, false);
    await a.api.add("good-1");
    await a.api.add("good-2");
    assertEquals((await a.flush()).status, 200);
    const clean = a.view();
    assertEquals(clean, { counter: 2, nextId: 3, ids: [1, 2] });

    await a.api.add("bad\0row"); // id 3 — the planner refuses a NUL
    await a.api.add("good-4");
    await a.api.del(1);
    await a.other.set(42); // a DIFFERENT cell, changed in the same window
    const refused = await a.flush();
    assertEquals(refused.status, 500, "the refusal is the verdict");
    assertEquals(a.view(), { counter: 5, nextId: 5, ids: [2, 3, 4] });
    await a.app.close();

    // On disk: the cell's scalars and its rows describe ONE moment.
    assertEquals(onDisk(dir), { counter: 2, ids: [1, 2] });

    const b = await boot(dir, false);
    assertEquals(
      b.view(),
      clean,
      "after reboot the cell is its last clean write, WHOLE — never a " +
        "counter from one moment next to rows from another",
    );
    assertEquals(b.otherV(), 42, "every OTHER cell still persisted");
    await b.app.close();
    // Last: the verdict says what IS on disk, truthfully (a shutdown quotes it).
    assertMatch(refused.text, /NUL/);
    assertMatch(refused.text, /held there TOGETHER/);
  } finally {
    _resetAioRuntime();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("persist (journal on): a refused row advances NOTHING; the tail replays at reboot and is refused again until fixed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "torn-j1-" });
  try {
    const a = await boot(dir, true);
    await a.api.add("good-1");
    await a.api.add("good-2");
    assertEquals((await a.flush()).status, 200);

    await a.api.add("bad\0row");
    await a.api.add("good-4");
    await a.api.del(1);
    await a.other.set(42);
    const refused = await a.flush();
    assertEquals(refused.status, 500);
    const live = a.view();
    assertEquals(live, { counter: 5, nextId: 5, ids: [2, 3, 4] });
    await a.app.close();

    // Nothing past the clean write reached the store — not the rows, not the
    // snapshot, not the watermark (so compaction kept the tail).
    assertEquals(onDisk(dir), { counter: 2, ids: [1, 2] });

    const b = await boot(dir, true);
    assertEquals(
      b.view(),
      live,
      "the journal replays the refused tail: the state the app HAD",
    );
    assertEquals(b.otherV(), 42, "and the cell that was never refused");
    // The data is still invalid, so the refusal repeats — loudly.
    const again = await b.flush();
    assertEquals(again.status, 500, "still refused: the row still has a NUL");
    await b.app.close();
    assertEquals(onDisk(dir), { counter: 2, ids: [1, 2] });

    // A second reboot replays the SAME tail once — nothing applied twice.
    const c = await boot(dir, true);
    assertEquals(c.view(), live);
    await c.api.clean(); // the developer fixes the value at its source
    assertEquals((await c.flush()).status, 200, "lands the moment it is fixed");
    await c.app.close();
    assertEquals(onDisk(dir), { counter: 6, ids: [2, 3, 4] });

    const d = await boot(dir, true);
    assertEquals(d.view(), { counter: 6, nextId: 5, ids: [2, 3, 4] });
    assertEquals(d.otherV(), 42);
    await d.app.close();
    assertMatch(refused.text, /journal: true/, "the verdict names the hold");
  } finally {
    _resetAioRuntime();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── The SQLite-side refusal (a constraint the planner cannot see) ─────────

// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;

function realDb(): { db: DB; close: () => void } {
  const sqlite = new DatabaseSync(":memory:");
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
    sqlite.exec("BEGIN");
    try {
      const out: QueryResult[] = [];
      for (const s of arg as { sql: string; params?: unknown[] }[]) {
        out.push(await execute(s.sql, s.params));
      }
      sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    }
  }) as Any;
  return {
    db: { query, execute, transaction, close: () => Promise.resolve() },
    close: () => sqlite.close(),
  };
}

type NRow = { id: number; v: string | null };
type Two = {
  a: { rows: NRow[]; n: number };
  b: { rows: NRow[]; n: number };
  c: { n: number };
};

async function twoCells(mode: "single" | "multi", journal: boolean) {
  const schema = {
    a_rows: table({ id: pk(), v: text() }), // `v` NOT NULL, as aio declares it
    b_rows: table({ id: pk(), v: text() }),
  };
  const rec = realDb();
  await initSchema(rec.db, schema);
  await rec.db.execute(SKV_SCHEMA);
  const kv = sqliteKv(rec.db);
  const state: Two = {
    a: { rows: [], n: 0 },
    b: { rows: [], n: 0 },
    c: { n: 0 },
  };
  let seq = 0;
  const marks: number[] = [];
  const errors: string[] = [];
  const p = createPersistenceManager({
    appId: "torn2",
    persistKey: "torn2",
    persistMode: mode,
    persistMs: 999999,
    log: { debug() {}, info() {}, warn() {}, error() {} } as Any,
    getState: () => state as unknown as Record<string, unknown>,
    // The snapshot never carries bound rows (as the boot's projection does).
    getDBState: (s) => {
      const t = s as unknown as Two;
      return { a: { n: t.a.n }, b: { n: t.b.n }, c: t.c };
    },
    getTableState: (s) => {
      const t = s as unknown as Two;
      return { a_rows: t.a.rows, b_rows: t.b.rows };
    },
    tableBindings: [
      { table: "a_rows", path: ["a", "rows"] },
      { table: "b_rows", path: ["b", "rows"] },
    ],
    asyncDb: rec.db,
    dbSchema: schema,
    kvDb: kv,
    getReportOpts: () => ({ onError: (e: Error) => errors.push(e.message) }),
    ...(journal
      ? {
        getJournalSeq: () => seq,
        onPersisted: (s: number) => marks.push(s),
        planPersisted: (s: number) => kv.planSet!("torn2:__journal_wm", s),
      }
      : {}),
  });
  const read = async () => {
    const ids = async (t: string) =>
      (await rec.db.query<{ id: number }>(`SELECT id FROM ${t} ORDER BY id`))
        .rows.map((r) => r.id);
    const snap = mode === "single"
      ? await kv.get<Any>("torn2")
      : await kv.getMulti<Any>("torn2");
    return {
      a: { n: snap?.a?.n ?? null, ids: await ids("a_rows") },
      b: { n: snap?.b?.n ?? null, ids: await ids("b_rows") },
      c: snap?.c?.n ?? null,
      wm: await kv.get<number>("torn2:__journal_wm"),
    };
  };
  const bump = () => seq++;
  return { p, rec, state, read, bump, marks, errors };
}

for (const mode of ["single", "multi"] as const) {
  Deno.test(`persist ${mode}: a row SQLite refuses holds ITS cell whole; the other cells land`, async () => {
    const t = await twoCells(mode, false);
    try {
      t.state.a = { rows: [{ id: 1, v: "a1" }], n: 1 };
      t.state.b = { rows: [{ id: 1, v: "b1" }], n: 1 };
      t.state.c = { n: 1 };
      await t.p.flushPersist();
      assertEquals(t.p.lastCycleError(), null);

      // One window: a's new row is NULL in a NOT NULL column (SQLite refuses
      // it at write time), b and c change validly.
      t.state.a = { rows: [{ id: 1, v: "a1" }, { id: 2, v: null }], n: 2 };
      t.state.b = { rows: [{ id: 1, v: "b1" }, { id: 2, v: "b2" }], n: 2 };
      t.state.c = { n: 2 };
      await t.p.flushPersist();

      assertEquals(await t.read(), {
        a: { n: 1, ids: [1] }, // held TOGETHER at the last clean write
        b: { n: 2, ids: [1, 2] }, // its own unit, landed
        c: 2,
        wm: null,
      });
      const err = t.p.lastCycleError();
      assert(err, "the refusal is the verdict");
      assertMatch(err.message, /NOT NULL/);
      assertMatch(err.message, /Cell "a"/);

      // Fixed at the source: the whole cell lands in one go.
      t.state.a = { rows: [{ id: 1, v: "a1" }, { id: 2, v: "a2" }], n: 3 };
      await t.p.flushPersist();
      assertEquals(t.p.lastCycleError(), null);
      assertEquals((await t.read()).a, { n: 3, ids: [1, 2] });
    } finally {
      t.p.setShuttingDown();
      t.rec.close();
    }
  });

  Deno.test(`persist ${mode} + journal: a row SQLite refuses writes NOTHING and never advances the watermark`, async () => {
    const t = await twoCells(mode, true);
    try {
      t.bump();
      t.state.a = { rows: [{ id: 1, v: "a1" }], n: 1 };
      t.state.b = { rows: [{ id: 1, v: "b1" }], n: 1 };
      await t.p.flushPersist();
      assertEquals((await t.read()).wm, 1);

      t.bump();
      t.state.a = { rows: [{ id: 1, v: "a1" }, { id: 2, v: null }], n: 2 };
      t.state.b = { rows: [{ id: 1, v: "b1" }, { id: 2, v: "b2" }], n: 2 };
      t.state.c = { n: 2 };
      await t.p.flushPersist();
      assertEquals(
        await t.read(),
        {
          a: { n: 1, ids: [1] },
          b: { n: 1, ids: [1] },
          c: 0,
          wm: 1,
        },
        "replay re-reduces EVERY action past the watermark over the whole " +
          "state — writing b or c here would apply their actions twice",
      );
      assertEquals(t.marks, [1], "the journal is never told seq 2 landed");
      assertMatch(t.p.lastCycleError()!.message, /journal: true/);
    } finally {
      t.p.setShuttingDown();
      t.rec.close();
    }
  });
}
