// tests/sync/schema-one-default.test.ts
//
// `sync_ops.version` / `sync_snapshots.cell_version` are the shape stamp the
// boot replay reads (field report §3.1): -1 means UNKNOWN — resolve the shape
// from the KV version stamp — and 0 means KNOWN, "written under the cell's
// default version". Two very different instructions to `onMigrate`.
//
// The column is declared TWICE: once in SYNC_SCHEMA (a database created by
// this build) and once in SYNC_MIGRATIONS (a database created by an older
// one). They had drifted — 0 in the first, -1 in the second — so the same
// unstamped row would have meant "already current" on a fresh install and
// "migrate me" on an upgraded one. Nothing read the default today, which is
// precisely why nobody noticed.
//
// This gate asks SQLITE, not the strings: build both databases the way the
// framework builds them and compare what `PRAGMA table_info` reports. A future
// edit to either half that forgets the other is red here.
import { assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import {
  SYNC_MIGRATIONS,
  SYNC_SCHEMA,
  SYNC_VERSION_UNKNOWN,
} from "../../src/sync/compact.ts";

type ColInfo = { name: string; dflt_value: unknown };

function defaults(sqlite: DatabaseSync, table: string): Map<string, unknown> {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as ColInfo[];
  return new Map(rows.map((r) => [r.name, r.dflt_value]));
}

/** A database created by THIS build. */
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const stmt of SYNC_SCHEMA) db.exec(stmt);
  return db;
}

/** A database created by an aio that predates the version stamp, then brought
 *  forward by the migrations exactly as `applySyncMigrations` does. */
function upgradedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE sync_ops (
    id TEXT PRIMARY KEY, cell TEXT NOT NULL, action TEXT NOT NULL,
    payload TEXT NOT NULL, hlc_phys INTEGER NOT NULL, hlc_cnt INTEGER NOT NULL,
    hlc_node TEXT NOT NULL, server_ts INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE sync_snapshots (
    cell TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL,
    hlc_phys INTEGER NOT NULL, hlc_cnt INTEGER NOT NULL, hlc_node TEXT NOT NULL)`);
  db.exec(`CREATE TABLE sync_meta (
    cell TEXT PRIMARY KEY, low_water TEXT NOT NULL,
    last_compact INTEGER NOT NULL, op_count INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE sync_compacted_ids (
    id TEXT PRIMARY KEY, compacted_at INTEGER NOT NULL)`);
  for (const sql of SYNC_MIGRATIONS) {
    try {
      db.exec(sql);
    } catch { /* already applied — the tolerated case (see applyDdl) */ }
  }
  return db;
}

const STAMPED: [table: string, column: string][] = [
  ["sync_ops", "version"],
  ["sync_snapshots", "cell_version"],
];

Deno.test("schema: a fresh database and an upgraded one agree on every column default", () => {
  const fresh = freshDb();
  const upgraded = upgradedDb();
  try {
    for (
      const table of [
        "sync_ops",
        "sync_snapshots",
        "sync_meta",
        "sync_compacted_ids",
      ]
    ) {
      const a = defaults(fresh, table);
      const b = defaults(upgraded, table);
      assertEquals(
        [...a.keys()].sort(),
        [...b.keys()].sort(),
        `"${table}" has different COLUMNS depending on how old the database ` +
          `is — SYNC_SCHEMA and SYNC_MIGRATIONS have drifted`,
      );
      for (const [col, dflt] of a) {
        assertEquals(
          String(b.get(col) ?? "null"),
          String(dflt ?? "null"),
          `"${table}"."${col}" defaults to ${dflt} on a database this build ` +
            `created and to ${b.get(col)} on one it upgraded — one column, ` +
            `two meanings, decided by the database's age`,
        );
      }
    }
  } finally {
    fresh.close();
    upgraded.close();
  }
});

Deno.test("schema: an unstamped shape column reads back as UNKNOWN, not as version 0", () => {
  // The value that actually lands in a row, asked of SQLite — a row inserted
  // without the column must say "I do not know what shape wrote me", because
  // 0 is a real, current version and would send `onMigrate` over data that is
  // already in the current shape (or skip the hook that should have run).
  for (const make of [freshDb, upgradedDb]) {
    const db = make();
    try {
      db.exec(
        `INSERT INTO sync_ops (id, cell, action, payload, hlc_phys, hlc_cnt, hlc_node, server_ts)
         VALUES ('o1', 'c', 'add', '{}', 1, 0, 'n', 1)`,
      );
      db.exec(
        `INSERT INTO sync_snapshots (cell, version, state, hlc_phys, hlc_cnt, hlc_node)
         VALUES ('c', 1, '{}', 1, 0, 'n')`,
      );
      const op = db.prepare(`SELECT version AS v FROM sync_ops`).all() as {
        v: number;
      }[];
      const snap = db.prepare(`SELECT cell_version AS v FROM sync_snapshots`)
        .all() as { v: number }[];
      assertEquals(op[0]!.v, SYNC_VERSION_UNKNOWN);
      assertEquals(snap[0]!.v, SYNC_VERSION_UNKNOWN);
    } finally {
      db.close();
    }
  }
  // Referenced so the pair above cannot quietly stop covering both columns.
  assertEquals(STAMPED.length, 2);
});
