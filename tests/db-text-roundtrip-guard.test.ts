// A `db:` TEXT value SQLite reads back altered is refused at write time.
//
// `node:sqlite` cuts a string at its first NUL ("nul\0after" loads as "nul")
// and replaces a lone UTF-16 surrogate with U+FFFD. The write succeeded, no
// error was reported, and the next boot loaded the damaged copy into state.
// The row gate (`checkRow`) now refuses both, naming the column — the same
// treatment it gives an integer beyond ±2^53.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { planTables } from "../src/db/state-sync.ts";
import { pk, table, text } from "../src/server/sql.ts";
import type { TableDef } from "../src/server/sql.ts";

const SCHEMA: Record<string, TableDef> = {
  notes: table({ id: pk(), v: text() }),
};
const plan = (rows: unknown) =>
  planTables(SCHEMA, { notes: rows }, { notes: [] });

const NUL = "nul" + String.fromCharCode(0) + "after";
const LONE = "lone" + String.fromCharCode(0xdc00);

Deno.test("db text: the premise — node:sqlite does NOT round-trip NUL or a lone surrogate", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const ins = db.prepare("INSERT INTO t (id, v) VALUES (?, ?)");
    ins.run(1, NUL);
    ins.run(2, LONE);
    const rows = db.prepare("SELECT v FROM t ORDER BY id").all() as {
      v: string;
    }[];
    // If a future node:sqlite round-trips these, the guard below can be
    // relaxed — this assertion is what will say so.
    assert(rows[0]!.v !== NUL && rows[1]!.v !== LONE);
  } finally {
    db.close();
  }
});

Deno.test("db text: a NUL in a TEXT column is refused, naming the row, column and index", () => {
  assertThrows(
    () => plan([{ id: 1, v: "ok" }, { id: 2, v: NUL }]),
    Error,
    `row #1 column "v" holds a string with a NUL character (at index 3)`,
  );
});

Deno.test("db text: a lone surrogate in a TEXT column is refused, naming the column", () => {
  assertThrows(
    () => plan([{ id: 1, v: LONE }]),
    Error,
    `column "v" holds a string with a lone UTF-16 surrogate`,
  );
});

Deno.test("db text: ordinary text — tabs, emoji, paired surrogates — still passes", () => {
  const p = plan([
    { id: 1, v: "tab\there" },
    { id: 2, v: "emoji 🎉" },
    { id: 3, v: JSON.stringify(NUL) }, // the suggested escape round-trips
  ]);
  assertEquals(p.length > 0, true);
});
