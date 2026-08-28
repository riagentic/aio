// The `db:` write path, adversarially. Every case here was found by the
// differential fuzzer in tests/db-state-differential.test.ts or by probing the
// diff directly, and every one of them used to end in state and SQLite
// disagreeing with NOTHING said about it.
//
// The rule the whole file encodes: a row the cell holds either reaches the
// table intact, or the framework says exactly which row, which column and why.
// There is no third outcome.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { createDB } from "../src/db/async-db.ts";
import {
  _resetDbReports,
  initSchema,
  loadTables,
  syncTables,
} from "../src/db/state-sync.ts";
import {
  createTableSQL,
  integer,
  pk,
  ref,
  table,
  text,
} from "../src/server/sql.ts";
import type { TableDef } from "../src/server/sql.ts";
import type { DB } from "../src/db/mod.ts";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";

const ITEMS: Record<string, TableDef> = {
  items: table({ id: pk(), title: text(), n: integer() }),
};

/** A fresh on-disk DB with `schema` initialised, plus its temp dir. */
async function freshDb(
  schema: Record<string, TableDef> = ITEMS,
): Promise<{ db: DB; dir: string; path: string }> {
  const dir = await Deno.makeTempDir({ prefix: "db-integrity-" });
  const path = join(dir, "state.db");
  const db = createDB(path);
  await initSchema(db, schema);
  return { db, dir, path };
}

async function withDb(
  fn: (db: DB, path: string) => Promise<void>,
  schema: Record<string, TableDef> = ITEMS,
): Promise<void> {
  const { db, dir, path } = await freshDb(schema);
  try {
    await fn(db, path);
  } finally {
    await db.close().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Capture console.warn for the duration of `fn`. */
async function capturingWarn(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    seen.push(a.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return seen;
}

// ── 1. A pk that is not a value ───────────────────────────────────────
//
// `{ id: null }` used to be the quietest data loss in the framework. The first
// such row INSERTs and SQLite auto-assigns a rowid; the SECOND is diffed
// against the first (both key `null` in the prev map), classified as an UPDATE,
// and written as `UPDATE … WHERE id = NULL` — which matches nothing. The row is
// gone, the promise resolves, no error is raised anywhere. Verified end to end
// through aio.run: state held two rows, the table held one, onError saw [].

Deno.test("db sync: a null primary key is refused, not silently dropped", async () => {
  await withDb(async (db) => {
    await assertRejects(
      () =>
        syncTables(db, ITEMS, {
          items: [{ id: null, title: "a", n: 1 }],
        }, { items: [] }),
      Error,
      "items",
    );
    const { rows } = await db.query("SELECT * FROM items");
    assertEquals(rows, [], "nothing is written when the pk is unusable");
  });
});

Deno.test("db sync: a missing primary key names the row and the column", async () => {
  await withDb(async (db) => {
    const e = await assertRejects(
      () =>
        syncTables(db, ITEMS, { items: [{ title: "a", n: 1 }] }, { items: [] }),
      Error,
    );
    assert(/items/.test(e.message), `names the table: ${e.message}`);
    assert(/\bid\b/.test(e.message), `names the pk column: ${e.message}`);
    assert(/row/i.test(e.message), `names the row: ${e.message}`);
  });
});

// ── 2. Two rows, one pk ───────────────────────────────────────────────
//
// The diff deduplicates ids into a Set for the delete pass but not for the
// insert pass, so both rows are INSERTed and SQLite rejects the second. The
// whole transaction rolls back — including every OTHER table's changes in that
// window — the baseline never advances, and the app retries the same doomed
// batch on every debounce forever. All the user got was
// "UNIQUE constraint failed: items.id".

Deno.test("db sync: duplicate primary keys are named, not left to a UNIQUE rollback", async () => {
  await withDb(async (db) => {
    const e = await assertRejects(
      () =>
        syncTables(db, ITEMS, {
          items: [{ id: 1, title: "a", n: 1 }, { id: 1, title: "b", n: 2 }],
        }, { items: [] }),
      Error,
    );
    assert(
      /duplicate/i.test(e.message),
      `says what is wrong: ${e.message}`,
    );
    assert(/\b1\b/.test(e.message), `names the offending pk: ${e.message}`);
  });
});

// ── 3. A field with no column ─────────────────────────────────────────
//
// The bound array is deliberately excluded from the KV snapshot — SQLite owns
// it. So a row field the table has no column for is not persisted ANYWHERE,
// and vanishes on the next boot. Through aio.run:
//   before restart: [{"id":1,"title":"hello","pinned":true,"tags":["x"]}]
//   after  restart: [{"id":1,"title":"hello"}]
// with no warning, no error, nothing in the log.

Deno.test("db sync: a row field with no column is named before it is lost", async () => {
  await withDb(async (db) => {
    const warns = await capturingWarn(async () => {
      await syncTables(db, ITEMS, {
        items: [{ id: 1, title: "a", n: 1, pinned: true, tags: ["x"] }],
      }, { items: [] });
      // A second sync must not repeat the warning — one report per field.
      await syncTables(db, ITEMS, {
        items: [{ id: 1, title: "b", n: 1, pinned: true, tags: ["x"] }],
      }, { items: [{ id: 1, title: "a", n: 1, pinned: true, tags: ["x"] }] });
    });
    const joined = warns.join("\n");
    assert(/pinned/.test(joined), `names the field: ${joined}`);
    assert(/tags/.test(joined), `names every field: ${joined}`);
    assert(/items/.test(joined), `names the table: ${joined}`);
    assertEquals(
      warns.filter((w) => /pinned/.test(w)).length,
      1,
      "one report per field, not one per persist window",
    );
    // The declared columns still made it — reporting never blocks the write.
    const { rows } = await db.query("SELECT * FROM items");
    assertEquals(rows, [{ id: 1, title: "b", n: 1 }]);
  });
});

Deno.test({
  name:
    "db sync: an undeclared row field is reported through a real app restart",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "db-undeclared-" });
    const appId = `undeclared-${crypto.randomUUID().slice(0, 8)}`;
    type Note = { id: number; title: string; pinned?: boolean };
    const notes = cell("notesUndeclared", {
      state: { items: [] as Note[], nextId: 1 },
      methods: {
        add(s: { items: Note[]; nextId: number }, title: string) {
          s.items.push({ id: s.nextId++, title, pinned: true });
        },
      },
    });
    const boot = () =>
      aio.run({
        cells: [notes],
        appId,
        client: "server-only",
        libraryMode: true,
        singleton: false,
        port: freePort(),
        appDir: dir,
        baseDir: dir,
        persistDebounceMs: 10,
        db: { "notesUndeclared.items": table({ id: pk(), title: text() }) },
      });
    try {
      const warns = await capturingWarn(async () => {
        const app = await boot();
        await notes.add("hello");
        await new Promise((r) => setTimeout(r, 200));
        await app.close();
      });
      assert(
        warns.some((w) => /pinned/.test(w) && /notesUndeclared_items/.test(w)),
        `the loss is named before the restart proves it: ${warns.join("\n")}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── 4. Values SQLite cannot bind ──────────────────────────────────────
//
// node:sqlite's message is "Provided value cannot be bound to SQLite parameter
// 3" — a 1-based index into a parameter list the user never wrote, for a
// statement built by the framework. `loadTables` already goes to the trouble of
// naming the table and column on a READ failure; the write path said nothing.

Deno.test("db sync: an unbindable value names the row, the column and the type", async () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["boolean", true, /boolean/i],
    ["object", { x: 1 }, /object/i],
    ["Date", new Date(0), /date/i],
    ["NaN", NaN, /nan/i],
    ["undefined", undefined, /undefined|missing/i],
  ];
  for (const [label, value, typeRe] of cases) {
    await withDb(async (db) => {
      const e = await assertRejects(
        () =>
          syncTables(db, ITEMS, {
            items: [{ id: 1, title: "a", n: value }],
          }, { items: [] }),
        Error,
        undefined,
        `${label} must be refused`,
      );
      assert(
        /items/.test(e.message),
        `${label}: names the table — ${e.message}`,
      );
      assert(
        /\bn\b/.test(e.message),
        `${label}: names the column — ${e.message}`,
      );
      assert(typeRe.test(e.message), `${label}: names the type — ${e.message}`);
    });
  }
});

// ── 4b. Array order that a restart will not preserve ──────────────────
//
// A SQL table is a set. `loadTables` reads it back with `SELECT *`, which on a
// `pk()` table walks the rowid — the pk — in ascending order. So an array a
// method reordered (drag-and-drop, unshift, a delete-and-re-append) comes back
// SORTED on the next boot. The fuzzer found this on its first run:
//   model [23, 24, 25] restored as [23, 25, 24].
// Nothing was written to the log; the app simply had a different order.

Deno.test("db sync: an order a restart cannot keep is reported, once", async () => {
  const schema: Record<string, TableDef> = {
    ordered: table({ id: pk(), v: text() }),
  };
  _resetDbReports();
  await withDb(async (db) => {
    const ascending = [
      { id: 1, v: "a" },
      { id: 2, v: "b" },
      { id: 3, v: "c" },
    ];
    const quiet = await capturingWarn(async () => {
      await syncTables(db, schema, { ordered: ascending }, { ordered: [] });
    });
    assertEquals(quiet, [], "ascending pk order survives — nothing to report");

    const reordered = [ascending[2]!, ascending[0]!, ascending[1]!];
    const warns = await capturingWarn(async () => {
      await syncTables(db, schema, { ordered: reordered }, {
        ordered: ascending,
      });
      await syncTables(db, schema, { ordered: [...reordered] }, {
        ordered: reordered,
      });
    });
    const joined = warns.join("\n");
    assert(/ordered/.test(joined), `names the table: ${joined}`);
    assert(/order/i.test(joined), `says what is lost: ${joined}`);
    assertEquals(warns.length, 1, "one report per table, not one per persist");

    // And the loss it warned about is real: the restore is ascending pk.
    assertEquals(
      (await loadTables(db, schema)).ordered!.map((r) =>
        (r as { id: number }).id
      ),
      [1, 2, 3],
      "the table restores sorted by pk, not in array order",
    );
  }, schema);
});

// ── 5. Silent type coercion ───────────────────────────────────────────
//
// A number in a TEXT column does not fail — SQLite's TEXT affinity converts it,
// and `42` comes back as the string "42.0". State says 42, the table says
// "42.0", and the next boot puts "42.0" into state.

Deno.test("db sync: a value coerced by column affinity is reported", async () => {
  await withDb(async (db) => {
    const warns = await capturingWarn(async () => {
      await syncTables(db, ITEMS, {
        items: [{ id: 1, title: 42, n: 1 }],
      }, { items: [] });
    });
    const joined = warns.join("\n");
    assert(/title/.test(joined), `names the column: ${joined}`);
    assert(/TEXT/i.test(joined), `names the declared type: ${joined}`);
    // The coercion it warned about is real — this is what the table now holds.
    const { rows } = await db.query("SELECT title FROM items");
    assertEquals(rows[0]!.title, "42.0");
  });
});

// ── 6. A bound path that stopped being an array ───────────────────────

Deno.test("db sync: a bound value that is not an array names the table", async () => {
  await withDb(async (db) => {
    for (const bad of [null, undefined, { a: 1 }, "str"]) {
      const e = await assertRejects(
        () => syncTables(db, ITEMS, { items: bad }, { items: [] }),
        Error,
      );
      assert(
        /items/.test(e.message) && /array/i.test(e.message),
        `${JSON.stringify(bad)}: ${e.message}`,
      );
    }
  });
});

// ── 7. ref() vs pk() — one decider for "the primary key" ──────────────
//
// `columnToSQL` hard-coded `REFERENCES <table>(id)` while the diff finds the pk
// by its `pk: true` flag. A table whose key column is named anything else
// produced a schema SQLite accepts and then refuses to write to:
// "foreign key mismatch - posts referencing users", on every persist, forever.

Deno.test("db sql: ref() targets the referenced table's actual primary key", () => {
  const schema: Record<string, TableDef> = {
    users: table({ userId: pk(), name: text() }),
    posts: table({ id: pk(), owner: ref("users"), body: text() }),
  };
  const sql = createTableSQL("posts", schema.posts!, schema);
  assert(
    /REFERENCES users\(userId\)/.test(sql),
    `must reference the real pk column, got: ${sql}`,
  );
});

Deno.test("db sql: a ref() to a declared table with no primary key fails loud", () => {
  const schema: Record<string, TableDef> = {
    tags: table({ label: text() }),
    posts: table({ id: pk(), tag: ref("tags") }),
  };
  let msg = "";
  try {
    createTableSQL("posts", schema.posts!, schema);
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(/tags/.test(msg) && /primary key|pk\(\)/i.test(msg), `got: ${msg}`);
});

Deno.test({
  name: "db sql: a ref() to a non-`id` pk actually writes",
  fn: async () => {
    const schema: Record<string, TableDef> = {
      users: table({ userId: pk(), name: text() }),
      posts: table({ id: pk(), owner: ref("users"), body: text() }),
    };
    await withDb(async (db) => {
      await syncTables(db, schema, {
        users: [{ userId: 1, name: "ada" }],
        posts: [{ id: 1, owner: 1, body: "hi" }],
      }, { users: [], posts: [] });
      const loaded = await loadTables(db, schema);
      assertEquals(loaded.posts, [{ id: 1, owner: 1, body: "hi" }]);
    }, schema);
  },
});

// ── 8. A schema that changed since the last run ───────────────────────
//
// `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table, so a
// column added to a `db:` table never reached SQLite. Boot looked perfect; then
// EVERY write failed with "no such column: b", the baseline never advanced, and
// the app retried the same doomed statement on every debounce window for the
// rest of its life. A removed column is the same story with
// "NOT NULL constraint failed".

Deno.test({
  name: "db schema: a column added since the last run is migrated in",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "db-drift-add-" });
    const path = join(dir, "state.db");
    const V1: Record<string, TableDef> = {
      items: table({ id: pk(), a: text() }),
    };
    const V2: Record<string, TableDef> = {
      items: table({ id: pk(), a: text(), b: text({ nullable: true }) }),
    };
    try {
      let db = createDB(path);
      await initSchema(db, V1);
      await syncTables(db, V1, { items: [{ id: 1, a: "x" }] }, { items: [] });
      await db.close();

      db = createDB(path);
      try {
        await initSchema(db, V2);
        // The old row survives, with the new column empty…
        assertEquals(await loadTables(db, V2), {
          items: [{ id: 1, a: "x", b: null }],
        });
        // …and writes work again, which is the whole point.
        await syncTables(db, V2, { items: [{ id: 1, a: "x", b: "new" }] }, {
          items: [{ id: 1, a: "x", b: null }],
        });
        assertEquals(await loadTables(db, V2), {
          items: [{ id: 1, a: "x", b: "new" }],
        });
      } finally {
        await db.close().catch(() => {});
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "db schema: a NOT NULL column added to a non-empty table fails loud at boot",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "db-drift-notnull-" });
    const path = join(dir, "state.db");
    const V1: Record<string, TableDef> = {
      items: table({ id: pk(), a: text() }),
    };
    const V2: Record<string, TableDef> = {
      items: table({ id: pk(), a: text(), b: text() }),
    };
    try {
      let db = createDB(path);
      await initSchema(db, V1);
      await syncTables(db, V1, { items: [{ id: 1, a: "x" }] }, { items: [] });
      await db.close();

      db = createDB(path);
      try {
        const e = await assertRejects(() => initSchema(db, V2), Error);
        assert(/\bb\b/.test(e.message), `names the column: ${e.message}`);
        assert(/items/.test(e.message), `names the table: ${e.message}`);
        assert(
          /nullable|default/i.test(e.message),
          `says how to fix it: ${e.message}`,
        );
      } finally {
        await db.close().catch(() => {});
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "db schema: a NOT NULL column added to an EMPTY table just works",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "db-drift-empty-" });
    const path = join(dir, "state.db");
    const V1: Record<string, TableDef> = {
      items: table({ id: pk(), a: text() }),
    };
    const V2: Record<string, TableDef> = {
      items: table({ id: pk(), a: text(), b: text() }),
    };
    try {
      let db = createDB(path);
      await initSchema(db, V1);
      await db.close();
      db = createDB(path);
      try {
        await initSchema(db, V2);
        await syncTables(db, V2, { items: [{ id: 1, a: "x", b: "y" }] }, {
          items: [],
        });
        assertEquals(await loadTables(db, V2), {
          items: [{ id: 1, a: "x", b: "y" }],
        });
      } finally {
        await db.close().catch(() => {});
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "db schema: a column the DB has and the app dropped is named, not left to break every write",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "db-drift-drop-" });
    const path = join(dir, "state.db");
    const V1: Record<string, TableDef> = {
      items: table({ id: pk(), a: text(), b: text() }),
    };
    const V2: Record<string, TableDef> = {
      items: table({ id: pk(), a: text() }),
    };
    try {
      let db = createDB(path);
      await initSchema(db, V1);
      await syncTables(db, V1, { items: [{ id: 1, a: "x", b: "y" }] }, {
        items: [],
      });
      await db.close();

      db = createDB(path);
      try {
        const e = await assertRejects(() => initSchema(db, V2), Error);
        assert(/\bb\b/.test(e.message), `names the column: ${e.message}`);
        assert(
          /NOT NULL|no longer declared|dropped/i.test(e.message),
          `says why it cannot be ignored: ${e.message}`,
        );
      } finally {
        await db.close().catch(() => {});
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── 8b. A column name SQLite will not accept ──────────────────────────
//
// `assertIdent` passes anything shaped like an identifier, but SQLite refuses
// its own keywords bare. `table({ id: pk(), order: text() })` produced
// `near "order": syntax error` — naming neither the table nor the schema key —
// which aio's boot path then degrades into one "sqlite: unavailable" warning,
// leaving the app running with no tables at all.

Deno.test("db schema: a SQL keyword used as a column name is named", async () => {
  await withDb(async (db) => {
    const e = await assertRejects(
      () =>
        initSchema(db, {
          notes: table({ id: pk(), order: text() }),
        }),
      Error,
    );
    assert(/notes/.test(e.message), `names the table: ${e.message}`);
    assert(/\border\b/.test(e.message), `names the column: ${e.message}`);
    assert(
      /keyword/i.test(e.message),
      `says why SQLite refused it: ${e.message}`,
    );
    assert(/rename/i.test(e.message), `says what to do: ${e.message}`);
  });
});

// ── 9. Nothing above weakens the happy path ───────────────────────────

Deno.test({
  name: "db sync: the ordinary insert/update/delete path is untouched",
  fn: async () => {
    await withDb(async (db, path) => {
      await syncTables(db, ITEMS, {
        items: [{ id: 1, title: "a", n: 1 }, { id: 2, title: "b", n: 2 }],
      }, { items: [] });
      await syncTables(db, ITEMS, {
        items: [{ id: 2, title: "B", n: 2 }, { id: 3, title: "c", n: 3 }],
      }, { items: [{ id: 1, title: "a", n: 1 }, { id: 2, title: "b", n: 2 }] });
      assertEquals(await loadTables(db, ITEMS), {
        items: [{ id: 2, title: "B", n: 2 }, { id: 3, title: "c", n: 3 }],
      });
      // A pk of 0 and an empty-string text value are values, not absences.
      await syncTables(db, ITEMS, {
        items: [{ id: 0, title: "", n: 0 }],
      }, { items: [{ id: 2, title: "B", n: 2 }, { id: 3, title: "c", n: 3 }] });
      const raw = new DatabaseSync(path);
      const rows = raw.prepare("SELECT * FROM items").all();
      raw.close();
      assertEquals(rows, [{ id: 0, title: "", n: 0 }]);
    });
  },
});

// A rejected batch must leave NOTHING behind — a half-applied persist window
// would put the table into a state no cell state ever described, and the diff
// baseline (which only advances on success) would then be wrong about it
// forever.
Deno.test("db sync: a statement SQLite rejects rolls the whole window back", async () => {
  const schema: Record<string, TableDef> = {
    a: table({ id: pk(), v: text() }),
    b: table({ id: pk(), v: text() }),
  };
  await withDb(async (db) => {
    await syncTables(db, schema, { a: [{ id: 1, v: "keep" }], b: [] }, {
      a: [],
      b: [],
    });
    // `b` row #2 violates NOT NULL. `a`'s change is in the SAME transaction.
    await assertRejects(() =>
      syncTables(db, schema, {
        a: [{ id: 1, v: "changed" }, { id: 2, v: "new" }],
        b: [{ id: 1, v: "ok" }, { id: 2, v: null }],
      }, { a: [{ id: 1, v: "keep" }], b: [] })
    );
    assertEquals(
      await loadTables(db, schema),
      { a: [{ id: 1, v: "keep" }], b: [] },
      "no table keeps a partial write from a rejected window",
    );
  }, schema);
});

Deno.test({
  name: "db sync: 10k rows insert, mutate and restore intact",
  fn: async () => {
    const schema: Record<string, TableDef> = {
      big: table({ id: pk(), v: text() }),
    };
    const dir = await Deno.makeTempDir({ prefix: "db-big-" });
    const path = join(dir, "state.db");
    let db = createDB(path);
    try {
      await initSchema(db, schema);
      const rows = Array.from({ length: 10_000 }, (_, i) => ({
        id: i,
        v: `v${i}`,
      }));
      await syncTables(db, schema, { big: rows }, { big: [] });
      // Touch one row in the middle and drop one — the diff must send two
      // statements, not 10k.
      const next = rows.filter((r) => r.id !== 4321).map((r) =>
        r.id === 5000 ? { ...r, v: "touched" } : r
      );
      await syncTables(db, schema, { big: next }, { big: rows });
      await db.close();
      db = createDB(path);
      await initSchema(db, schema);
      const loaded = (await loadTables(db, schema)).big as Array<
        { id: number; v: string }
      >;
      assertEquals(loaded.length, 9_999);
      assertEquals(loaded.find((r) => r.id === 5000)!.v, "touched");
      assertEquals(loaded.find((r) => r.id === 4321), undefined);
    } finally {
      await db.close().catch(() => {});
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test("db sync: a nullable column accepts an explicit null", async () => {
  const schema: Record<string, TableDef> = {
    items: table({ id: pk(), note: text({ nullable: true }) }),
  };
  await withDb(async (db) => {
    await syncTables(db, schema, { items: [{ id: 1, note: null }] }, {
      items: [],
    });
    assertEquals(await loadTables(db, schema), {
      items: [{ id: 1, note: null }],
    });
  }, schema);
});
