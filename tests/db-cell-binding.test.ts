// `db:` tables address a CELL's array field — the whole reason the feature
// exists under the cells API.
//
// v1.0.0-alpha45: `db:` keys addressed the ROOT state namespace, but with cells
// every root key is a cell id whose slice is an object. So a table name either
// equalled a cell id → hard boot throw (AIO-419), or it matched nothing → the
// table stayed empty forever, silently, while an unowned array key was injected
// into state and broadcast. `examples/contacts` — the shipped answer to a field
// report's top request — could not boot at all.
//
// Now: a `db:` key names the array it stores (`contacts` → the one cell that
// declares an array field `contacts`; `cell.field` to be explicit), the rows
// land at that path, and a table nothing binds to is SQL-only and says so.
import { assert, assertEquals, assertThrows } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { aio, cell, pk, table, text } from "../mod.ts";
import {
  omitPaths,
  placeLoadedTables,
  resolveDbBindings,
} from "../src/server/aio-boot.ts";
import type { TableDef } from "../src/server/sql.ts";
import { freePort } from "../src/testing/server-test.ts";
import { contacts } from "../examples/contacts/cell.ts";

const t = (): TableDef => table({ id: pk(), v: text() });

function quietLog() {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info: (m: string) => info.push(m),
    warn: (m: string) => warn.push(m),
    infos: info,
    warns: warn,
  };
}

// ── The decision table ────────────────────────────────────────────────

Deno.test("db binding: a bare key binds to the one cell array field of that name", () => {
  const log = quietLog();
  const { bindings, sqlSchema } = resolveDbBindings(
    { contacts: { contacts: [], nextId: 1 } },
    { contacts: t() },
    log,
  );
  assertEquals(bindings.map(({ table, path }) => ({ table, path })), [{
    table: "contacts",
    path: ["contacts", "contacts"],
  }]);
  assertEquals(Object.keys(sqlSchema), ["contacts"]);
  assert(
    log.infos.some((m) => m.includes("state.contacts.contacts")),
    `the binding is announced at boot: ${log.infos.join(" | ")}`,
  );
});

Deno.test("db binding: a bare key binds a cell array field with a different cell name", () => {
  const { bindings } = resolveDbBindings(
    { metrics: { history: [], cpu: 0 } },
    { history: t() },
    quietLog(),
  );
  assertEquals(bindings.map(({ table, path }) => ({ table, path })), [{
    table: "history",
    path: ["metrics", "history"],
  }]);
});

Deno.test("db binding: a root-level array still binds (engine-level config)", () => {
  const { bindings } = resolveDbBindings(
    { rows: [] },
    { rows: t() },
    quietLog(),
  );
  assertEquals(bindings.map(({ table, path }) => ({ table, path })), [{
    table: "rows",
    path: ["rows"],
  }]);
});

Deno.test("db binding: an explicit cell.field key binds and names the table cell_field", () => {
  const { bindings, sqlSchema } = resolveDbBindings(
    { nfts: { items: [] } },
    { "nfts.items": t() },
    quietLog(),
  );
  assertEquals(bindings.map(({ table, path }) => ({ table, path })), [{
    table: "nfts_items",
    path: ["nfts", "items"],
  }]);
  assertEquals(Object.keys(sqlSchema), ["nfts_items"]);
});

Deno.test("db binding: an ambiguous bare key throws, naming both cells", () => {
  const err = assertThrows(
    () =>
      resolveDbBindings(
        { a: { items: [] }, b: { items: [] } },
        { items: t() },
        quietLog(),
      ),
    Error,
  );
  assert(/ambiguous/.test(err.message), err.message);
  assert(/"a"/.test(err.message) && /"b"/.test(err.message), err.message);
  assert(/a\.items/.test(err.message), `names the fix: ${err.message}`);
});

Deno.test("db binding: an explicit key that resolves to nothing throws", () => {
  const noCell = assertThrows(
    () =>
      resolveDbBindings({ a: { items: [] } }, { "b.items": t() }, quietLog()),
    Error,
  );
  assert(/no cell "b"/.test(noCell.message), noCell.message);

  const noField = assertThrows(
    () =>
      resolveDbBindings({ a: { items: [] } }, { "a.rows": t() }, quietLog()),
    Error,
  );
  assert(/no array field "rows"/.test(noField.message), noField.message);
  assert(
    /a\.items/.test(noField.message),
    `lists candidates: ${noField.message}`,
  );
});

Deno.test("db binding: two keys mapping to one SQL table throw", () => {
  const err = assertThrows(
    () =>
      resolveDbBindings(
        { a_b: { x: [] }, a: { b: [] } },
        { "a.b": t(), a_b: t() },
        quietLog(),
      ),
    Error,
  );
  assert(/both map to SQL table "a_b"/.test(err.message), err.message);
});

Deno.test("db binding: an unbound table is SQL-only and warns — never silent, never injected", () => {
  const log = quietLog();
  const { bindings } = resolveDbBindings(
    { notes: { items: [], n: 0 } },
    { rows: t() },
    log,
  );
  assertEquals(bindings.map(({ table, path }) => ({ table, path })), [{
    table: "rows",
    path: [],
  }]);
  assert(
    log.warns.some((m) => m.includes("SQL-only") && m.includes("notes.items")),
    `the no-op half is loud and names the alternative: ${
      log.warns.join(" | ")
    }`,
  );
});

Deno.test("db binding: a table named after a cell does not touch that cell's slice", () => {
  const log = quietLog();
  const initial = { nfts: { items: [] as unknown[] } };
  const { bindings } = resolveDbBindings(initial, { nfts: t() }, log);
  assertEquals(bindings.map(({ table, path }) => ({ table, path })), [{
    table: "nfts",
    path: [],
  }]);
  assert(
    log.warns.some((m) => m.includes(`Cell "nfts" exists`)),
    `the near-miss is named: ${log.warns.join(" | ")}`,
  );
  // …and placing rows leaves the cell's object slice exactly as it was.
  const placed = placeLoadedTables(initial, bindings, { nfts: [{ id: 1 }] });
  assertEquals(placed, initial);
});

Deno.test("db binding: rows land at the bound path, copy-on-write", () => {
  const initial = { contacts: { contacts: [] as unknown[], nextId: 1 } };
  const rows = [{ id: 1, name: "Ada" }];
  const placed = placeLoadedTables(
    initial,
    [{ table: "contacts", path: ["contacts", "contacts"] }],
    { contacts: rows },
  );
  assertEquals(placed, { contacts: { contacts: rows, nextId: 1 } });
  assertEquals(initial.contacts.contacts, [], "the input is not mutated");
});

Deno.test("db binding: omitPaths removes only the bound array", () => {
  const s = { contacts: { contacts: [1], nextId: 7 }, ui: { open: true } };
  const out = omitPaths(s, [["contacts", "contacts"]]);
  assertEquals(out, { contacts: { nextId: 7 }, ui: { open: true } });
  assertEquals(s.contacts.contacts, [1], "the input is not mutated");
});

// ── The shipped example, end to end ───────────────────────────────────

Deno.test({
  name:
    "examples/contacts: boots, writes rows to its db: table, and restores them",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-contacts-db-" });
    const appId = `contacts-${crypto.randomUUID().slice(0, 8)}`;
    const boot = () =>
      aio.run({
        cells: [contacts],
        appId,
        appVersion: "0.0.0",
        client: "server-only",
        libraryMode: true,
        singleton: false,
        port: freePort(),
        appDir: dir,
        baseDir: dir,
        persistDebounceMs: 10,
        db: {
          contacts: table({
            id: pk(),
            name: text(),
            email: text(),
            note: text(),
          }),
        },
      });

    try {
      const app1 = await boot();
      await contacts.create({ name: "Ada", email: "ada@example.com" });
      await contacts.create({ name: "Bob", email: "bob@example.com" });
      await new Promise((r) => setTimeout(r, 150));
      await app1.close();

      // The rows are REALLY in the table — the feature is not a no-op.
      const dbPath = join(dir, "data", "state.db");
      const db = new DatabaseSync(dbPath);
      const rows = db.prepare("SELECT id, name FROM contacts ORDER BY id")
        .all();
      // …and the KV snapshot does not hold a stale second copy of them.
      const snap = db.prepare("SELECT v FROM aio_kv WHERE k = 'state'")
        .all() as Array<{ v: string }>;
      db.close();
      assertEquals(rows.length, 2, "both contacts reached SQLite");
      assertEquals((rows[0] as { name: string }).name, "Ada");
      const stored = JSON.parse(snap[0]!.v) as {
        contacts: Record<string, unknown>;
      };
      assertEquals(
        stored.contacts.contacts,
        undefined,
        "SQLite owns the rows — the snapshot keeps no stale twin",
      );
      assertEquals(stored.contacts.nextId, 3, "the rest of the cell persists");

      // Restart: the rows come back INTO THE CELL, once.
      const app2 = await boot();
      try {
        const state = app2.getState() as unknown as {
          contacts: { contacts: Array<{ name: string }>; nextId: number };
        };
        assertEquals(state.contacts.contacts.length, 2);
        assertEquals(state.contacts.contacts[0]!.name, "Ada");
        assertEquals(state.contacts.nextId, 3);
        // A later write must not duplicate the restored rows.
        await contacts.create({ name: "Cy", email: "cy@example.com" });
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        await app2.close();
      }
      const db2 = new DatabaseSync(join(dir, "data", "state.db"));
      const after = db2.prepare("SELECT id FROM contacts").all();
      db2.close();
      assertEquals(
        after.length,
        3,
        "restored rows are updated, not re-inserted",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "db: an explicit cell.field binding auto-syncs a differently-named field",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-db-explicit-" });
    const appId = `explicit-${crypto.randomUUID().slice(0, 8)}`;
    const notes = cell("notes", {
      state: { items: [] as Array<{ id: number; v: string }> },
      methods: {
        add(s: { items: Array<{ id: number; v: string }> }, v: string) {
          s.items.push({ id: s.items.length + 1, v });
        },
      },
    });
    const boot = () =>
      aio.run({
        cells: [notes],
        appId,
        appVersion: "0.0.0",
        client: "server-only",
        libraryMode: true,
        singleton: false,
        port: freePort(),
        appDir: dir,
        baseDir: dir,
        persistDebounceMs: 10,
        db: { "notes.items": table({ id: pk(), v: text() }) },
      });
    try {
      const app1 = await boot();
      await notes.add("first");
      await new Promise((r) => setTimeout(r, 150));
      await app1.close();

      const db = new DatabaseSync(join(dir, "data", "state.db"));
      const rows = db.prepare("SELECT v FROM notes_items").all() as Array<
        { v: string }
      >;
      db.close();
      assertEquals(rows.map((r) => r.v), ["first"]);

      const app2 = await boot();
      try {
        const s = app2.getState() as unknown as {
          notes: { items: Array<{ v: string }> };
        };
        assertEquals(s.notes.items.map((i) => i.v), ["first"]);
      } finally {
        await app2.close();
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test("db binding: an empty table never empties a non-empty bound array", () => {
  // Adopting an existing array is the ONLY safe reading of "table empty, state
  // full": either the binding is new (an app adding `db:`, or upgrading to a
  // build where the binding finally resolves and whose rows were never
  // written), or `state:` seeded it. Wiping it would be the upgrade itself
  // destroying data.
  const warns: string[] = [];
  const seeded = {
    contacts: { contacts: [{ id: 1, name: "Ada" }], nextId: 2 },
  };
  const kept = placeLoadedTables(
    seeded,
    [{ table: "contacts", path: ["contacts", "contacts"] }],
    { contacts: [] },
    (m) => warns.push(m),
  );
  assertEquals(kept, seeded);
  assert(warns.some((m) => m.includes("next sync")), warns.join(" | "));

  // A table WITH rows still wins (SQLite owns the data once it is there)…
  const rows = [{ id: 2, name: "Bob" }];
  assertEquals(
    placeLoadedTables(
      seeded,
      [{ table: "contacts", path: ["contacts", "contacts"] }],
      { contacts: rows },
    ),
    { contacts: { contacts: rows, nextId: 2 } },
  );
  // …and an empty table over an empty array is just an empty array.
  assertEquals(
    placeLoadedTables(
      { contacts: { contacts: [], nextId: 1 } },
      [{ table: "contacts", path: ["contacts", "contacts"] }],
      { contacts: [] },
    ),
    { contacts: { contacts: [], nextId: 1 } },
  );
});

Deno.test({
  name: "db: a seeded array survives its first boot and reaches the table",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-db-seed-" });
    const appId = `seed-${crypto.randomUUID().slice(0, 8)}`;
    const catalog = cell("catalog", {
      state: {
        items: [{ id: 1, v: "seed" }] as Array<{ id: number; v: string }>,
      },
      methods: {
        add(s: { items: Array<{ id: number; v: string }> }, v: string) {
          s.items.push({ id: s.items.length + 1, v });
        },
      },
    });
    const boot = () =>
      aio.run({
        cells: [catalog],
        appId,
        appVersion: "0.0.0",
        client: "server-only",
        libraryMode: true,
        singleton: false,
        port: freePort(),
        appDir: dir,
        baseDir: dir,
        persistDebounceMs: 10,
        db: { items: table({ id: pk(), v: text() }) },
      });
    try {
      const app1 = await boot();
      await catalog.add("added");
      await new Promise((r) => setTimeout(r, 150));
      await app1.close();

      const db = new DatabaseSync(join(dir, "data", "state.db"));
      const rows = db.prepare("SELECT v FROM items ORDER BY id").all() as Array<
        { v: string }
      >;
      db.close();
      assertEquals(
        rows.map((r) => r.v),
        ["seed", "added"],
        "the declared seed is written to the table, not wiped by it",
      );

      const app2 = await boot();
      try {
        const s = app2.getState() as unknown as {
          catalog: { items: Array<{ v: string }> };
        };
        assertEquals(s.catalog.items.map((i) => i.v), ["seed", "added"]);
      } finally {
        await app2.close();
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
