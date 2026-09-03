// Audit a4 (A, SILENT DATA LOSS): one SQL-only `db:` table disabled ALL
// bound-table persistence.
//
// `db:` tables come in two kinds: BOUND (`"cell.field"` — mirrored from a
// state array on every persist window) and SQL-only (a bare name the app
// drives through `app.db`). The boot handed the persistence manager the FULL
// schema while `getTableState` (correctly) reported only the bound arrays, so
// the planner met a table whose bound value was `undefined`, threw by name on
// every window, and the whole SQLite half stopped. Bound rows are excluded
// from the snapshot by design, so they were written NOWHERE; the snapshot half
// kept committing and the app looked healthy. Every row was gone at the next
// boot.
//
// Now the boot derives the plan schema from the bindings (one decider), and
// the manager refuses at construction any planned table the bindings do not
// vouch for — a regression fails the boot instead of the data.
import { assert, assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { aio, cell, pk, table, text } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { createPersistenceManager } from "../src/server/persistence.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

const rowsOf = (dbPath: string, sql: string): unknown[] => {
  const c = new DatabaseSync(dbPath);
  try {
    return c.prepare(sql).all();
  } finally {
    c.close();
  }
};

Deno.test("db: a bound table keeps persisting next to an SQL-only table", async () => {
  const dir = await Deno.makeTempDir({ prefix: "db-sql-only-" });
  const dbPath = join(dir, "data.db");
  _resetAioRuntime();
  const notes = cell("sqlonly_notes", {
    state: { items: [] as Array<{ id: number; v: string }> },
    methods: {
      add(
        s: { items: Array<{ id: number; v: string }> },
        id: number,
        v: string,
      ) {
        s.items.push({ id, v });
      },
    },
  });
  const errors: string[] = [];
  const app = await aio.run({
    cells: [notes],
    appId: "db-sql-only-coexist",
    client: "server-only",
    libraryMode: true,
    port: freePort(),
    dbPath,
    baseDir: dir,
    persistDebounceMs: 10,
    db: {
      "sqlonly_notes.items": table({ id: pk(), v: text() }),
      // SQL-only: nothing in state mirrors it; the app drives it via app.db.
      extra: table({ k: text(), v: text() }),
    },
    onError: (e: { message?: string }) => errors.push(e.message ?? String(e)),
  });
  try {
    await (notes as unknown as {
      add: (id: number, v: string) => Promise<void>;
    })
      .add(1, "one");
    // Read the FILE from a second connection — "landed" means on disk, not
    // "the loop reported nothing".
    let landed: unknown[] = [];
    for (let i = 0; i < 100 && landed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      landed = rowsOf(dbPath, "SELECT id, v FROM sqlonly_notes_items");
    }
    assertEquals(landed, [{ id: 1, v: "one" }], "the bound row is on disk");
    assertEquals(
      errors,
      [],
      "no persist window may be refused because of the SQL-only table",
    );
    // And the SQL-only table exists, empty, for the app to drive.
    assertEquals(rowsOf(dbPath, "SELECT * FROM extra"), []);
  } finally {
    await app.close();
    _resetAioRuntime();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("persistence manager: a planned table the bindings do not vouch for fails construction", () => {
  let threw: Error | null = null;
  try {
    createPersistenceManager({
      appId: "plan-guard",
      persistKey: "plan-guard",
      persistMode: "single",
      persistMs: 10,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      getState: () => ({}),
      getDBState: (s: Record<string, unknown>) => s,
      getTableState: () => ({ notes_items: [] }),
      asyncDb: {} as never,
      dbSchema: {
        notes_items: table({ id: pk(), v: text() }),
        extra: table({ k: text(), v: text() }),
      },
      tableBindings: [{ table: "notes_items", path: ["notes", "items"] }, {
        table: "extra",
        path: [],
      }],
      kvDb: null,
      getReportOpts: () => ({}),
      // deno-lint-ignore no-explicit-any
    } as any);
  } catch (e) {
    threw = e as Error;
  }
  assert(threw, "an SQL-only table in the plan must refuse the boot");
  assert(/"extra"/.test(threw.message) && /SQL-only/.test(threw.message));
});
