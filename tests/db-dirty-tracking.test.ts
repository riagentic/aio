// Row-level dirty tracking for `db:` persistence — the "largest open design
// debt" (todo.md → Internals, RIS-5a/6): one changed row used to cost a clone
// of the whole table (3.3 ms per 10k rows) plus a column-by-column diff of
// every row (3.4–8.4 ms). Now a frozen table is held by reference, an
// unchanged row is recognized by IDENTITY (immer shares structure; committed
// state is frozen), the pk index survives across windows, and the window's
// immer patches narrow the pass to the touched rows — O(change).
//
// Correctness never depends on the hint: a patch the hint cannot express
// (shrink, remove, replace) and a row that moved both fall back to the full
// identity-first pass, which is exercised here against the same expectations.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { produce } from "immer";
import {
  planTables,
  planTablesIncremental,
  type TableIndex,
} from "../src/db/state-sync.ts";
import { integer, pk, table, text } from "../src/server/sql.ts";
import { createPersistenceManager } from "../src/server/persistence.ts";
import { createDB } from "../src/db/async-db.ts";
import { initSchema } from "../src/db/state-sync.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import { log } from "../src/diagnostics/logger-api.ts";

type Row = { id: number; name: string; qty: number };
const schema = { items: table({ id: pk(), name: text(), qty: integer() }) };
const mk = (n: number): { items: Row[] } =>
  produce(
    {
      items: Array.from(
        { length: n },
        (_, i) => ({ id: i + 1, name: `n${i}`, qty: i }),
      ),
    },
    () => {},
  );

Deno.test("dirty tracking: an identity-unchanged row costs no comparison, and the plan is exactly the change", () => {
  const index: Record<string, TableIndex> = {};
  const base = mk(1000);
  // First window: everything is new relative to an empty baseline.
  const w0 = planTablesIncremental(schema, base, { items: [] }, index);
  assertEquals(w0.stmts.length, 1000);
  w0.commit();
  assertEquals(index.items!.size, 1000);
  // Second window: ONE row changed.
  const next = produce(base, (d) => {
    d.items[500]!.qty = 9999;
  });
  const w1 = planTablesIncremental(schema, next, base, index);
  assertEquals(w1.stmts.length, 1);
  assert(w1.stmts[0]!.sql.startsWith("UPDATE items"));
  assertEquals(w1.stmts[0]!.params, [`n500`, 9999, 501]);
  w1.commit();
  // The index now holds the NEW reference — a third identical window is empty.
  const w2 = planTablesIncremental(schema, next, next, index);
  assertEquals(w2.stmts.length, 0);
});

Deno.test("dirty tracking: the index advances ONLY on commit — a refused window is retried whole", () => {
  const index: Record<string, TableIndex> = {};
  const base = mk(10);
  planTablesIncremental(schema, base, { items: [] }, index).commit();
  const next = produce(base, (d) => {
    d.items.push({ id: 11, name: "new", qty: 0 });
    d.items[0]!.qty = 42;
  });
  const first = planTablesIncremental(schema, next, base, index);
  assertEquals(first.stmts.length, 2);
  // NOT committed (the transaction was refused) → same plan again.
  const again = planTablesIncremental(schema, next, base, index);
  assertEquals(again.stmts, first.stmts);
  again.commit();
  assertEquals(planTablesIncremental(schema, next, next, index).stmts, []);
});

Deno.test("dirty tracking: a hinted window touches only the hinted rows (O(change)) and matches the full pass", () => {
  const N = 10_000;
  const base = mk(N);
  const idxA: Record<string, TableIndex> = {};
  const idxB: Record<string, TableIndex> = {};
  planTablesIncremental(schema, base, { items: [] }, idxA).commit();
  planTablesIncremental(schema, base, { items: [] }, idxB).commit();
  const next = produce(base, (d) => {
    d.items[7]!.name = "seven";
    d.items.push({ id: N + 1, name: "tail", qty: 1 });
  });
  const hinted = planTablesIncremental(schema, next, base, idxA, {
    items: new Set([7, N]),
  });
  const full = planTablesIncremental(schema, next, base, idxB);
  assertEquals(hinted.stmts, full.stmts);
  assertEquals(hinted.stmts.length, 2);
  hinted.commit();
  full.commit();
  assertEquals(idxA.items!.size, N + 1);
  assertEquals(idxB.items!.size, N + 1);
});

Deno.test("dirty tracking: a hint that cannot be trusted falls back to the full pass (shrink, move)", () => {
  const base = mk(20);
  const index: Record<string, TableIndex> = {};
  planTablesIncremental(schema, base, { items: [] }, index).commit();
  // A shift: row 0 removed → every row moved down one. The hint says the
  // touched indices are 0..18 (what immer emits) but the array SHRANK: the
  // count check refuses the hint and the full pass finds the DELETE.
  const shifted = produce(base, (d) => {
    d.items.splice(0, 1);
  });
  const plan = planTablesIncremental(schema, shifted, base, index, {
    items: new Set(Array.from({ length: 19 }, (_, i) => i)),
  });
  assertEquals(plan.stmts.length, 1);
  assert(plan.stmts[0]!.sql.startsWith("DELETE FROM items WHERE id IN"));
  assertEquals(plan.stmts[0]!.params, [1]);
  plan.commit();
  assertEquals(index.items!.size, 19);
  // A swap of two rows under a hint: the pk moved between two hinted indices
  // → null → full pass → nothing to write (same rows, same contents).
  const swapped = produce(shifted, (d) => {
    const a = d.items[0]!, b = d.items[1]!;
    d.items[0] = b;
    d.items[1] = a;
  });
  const swapPlan = planTablesIncremental(schema, swapped, shifted, index, {
    items: new Set([0, 1]),
  });
  assertEquals(swapPlan.stmts.length, 0);
});

Deno.test("dirty tracking: a duplicate pk is caught in BOTH passes — never written as an UPDATE", () => {
  const base = mk(5);
  const index: Record<string, TableIndex> = {};
  planTablesIncremental(schema, base, { items: [] }, index).commit();
  const dup = produce(base, (d) => {
    d.items.push({ id: 3, name: "twin", qty: 0 }); // pk 3 already lives at #2
  });
  assertThrows(
    () =>
      planTablesIncremental(schema, dup, base, index, { items: new Set([5]) }),
    Error,
    "duplicate primary key",
  );
  assertThrows(
    () => planTablesIncremental(schema, dup, base, index),
    Error,
    "duplicate primary key",
  );
  // A hint must not let a bad row skip validation either.
  const bad = produce(base, (d) => {
    (d.items[1] as unknown as { qty: unknown }).qty = new Date(0);
  });
  assertThrows(
    () =>
      planTablesIncremental(schema, bad, base, index, { items: new Set([1]) }),
    Error,
    'row #1 column "qty"',
  );
});

Deno.test("dirty tracking: planTables (index-free) still produces the same statements", () => {
  const base = mk(50);
  const next = produce(base, (d) => {
    d.items[3]!.qty = -1;
    d.items.splice(10, 2);
    d.items.push({ id: 51, name: "x", qty: 0 });
  });
  const a = planTables(schema, next, base);
  const index: Record<string, TableIndex> = {};
  const b = planTablesIncremental(schema, next, base, index);
  assertEquals(a, b.stmts);
  assertEquals(a.length, 3);
});

Deno.test("dirty tracking: 10k rows, one changed row — measured, with a generous ceiling", () => {
  const N = 10_000, R = 40;
  let live = mk(N);
  let prev: Record<string, unknown> = live;
  const index: Record<string, TableIndex> = {};
  planTablesIncremental(schema, live, { items: [] }, index).commit();
  const time = (dirty: boolean): number => {
    let total = 0;
    for (let r = 0; r < R; r++) {
      const i = (r * 97) % N;
      live = produce(live, (d) => {
        d.items[i]!.qty += 1;
      });
      const t0 = performance.now();
      const plan = planTablesIncremental(
        schema,
        live,
        prev,
        index,
        dirty ? { items: new Set([i]) } : undefined,
      );
      total += performance.now() - t0;
      assertEquals(plan.stmts.length, 1);
      plan.commit();
      prev = live;
    }
    return total / R;
  };
  const full = time(false);
  const hinted = time(true);
  console.log(
    `  10k rows / 1 changed: full identity pass ${full.toFixed(3)} ms, ` +
      `hinted ${
        hinted.toFixed(3)
      } ms per window (was 3.3 ms clone + 3.4 ms diff)`,
  );
  // Ceilings ~10x above what a slow CI box measures; the point is the ORDER:
  // the old path was ~7 ms here, and 2 ms would already be a regression.
  assert(full < 2, `full identity pass took ${full} ms`);
  assert(hinted < 0.5, `hinted pass took ${hinted} ms`);
  assert(hinted < full, "the hinted pass must not cost more than the full one");
});

Deno.test("dirty tracking: the persistence manager consumes patches and holds a frozen table by reference", async () => {
  const db = createDB(":memory:");
  const kv = sqliteKv(db);
  await initSchema(db, schema);
  await db.execute(SKV_SCHEMA);
  try {
    let state = { inv: mk(200) } as Record<string, unknown>;
    let planned = 0;
    const pm = createPersistenceManager({
      kvDb: kv,
      asyncDb: db,
      dbSchema: schema,
      getTableState: (s) => ({ items: (s.inv as { items: Row[] }).items }),
      tableBindings: [{ table: "items", path: ["inv", "items"] }],
      // What SQLite holds at boot: nothing — so the seed is written.
      dbBaselineOverride: { items: [] },
      persistKey: "t",
      persistMode: "single",
      persistMs: 1,
      getState: () => state,
      getDBState: (s) => s,
      log: {
        ...log,
        debug: (...a: unknown[]) => {
          if (String(a[0]).includes("sqlite synced")) planned++;
        },
      } as unknown as typeof log,
      getReportOpts: () => ({}),
    });
    pm.resetPrevState();
    await pm.flushPersist();
    const count = async () =>
      Number(
        (await db.query<{ n: number }>("SELECT COUNT(*) n FROM items")).rows[0]!
          .n,
      );
    assertEquals(await count(), 200);
    state = produce(state, (d) => {
      (d.inv as { items: Row[] }).items[10]!.qty = 777;
    });
    pm.schedulePersist(
      new Map([["inv", [{
        op: "replace",
        path: ["items", 10, "qty"],
        value: 777,
      }]]]),
    );
    await pm.flushPersist();
    const { rows } = await db.query<{ qty: number }>(
      "SELECT qty FROM items WHERE id = 11",
    );
    assertEquals(rows[0]!.qty, 777);
    assert(planned >= 2);
    // The baseline is the frozen live reference — no clone was minted.
    assert(Object.isFrozen((state.inv as { items: Row[] }).items));
  } finally {
    await db.close();
  }
});
