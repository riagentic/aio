// tests/db-row-guards.test.ts — the row-shape gate in front of every `db:` write.
//
// `planTables` checks every row BEFORE it builds a single statement, because
// each of these shapes is a QUIET loss otherwise:
//
//  • a row with no primary key — the first one INSERTs (SQLite assigns a rowid
//    state never learns), and every later window diffs it as an UPDATE
//    `WHERE <pk> = NULL`, which matches nothing. The row is gone and every
//    promise resolves;
//  • a row that is not an object — the built statement binds `undefined` and
//    SQLite refuses the whole transaction, on every debounce window, forever;
//  • two rows whose pks are ONE key to SQLite and two to JavaScript (`1` and
//    `"1"` against an INTEGER PRIMARY KEY, which is the rowid). The second
//    INSERT is refused and rolls back the entire persist window — every other
//    table's changes with it — and the identical batch is rebuilt and refused
//    on every window after that.
//
// All three guards existed and none was tested: deleting any of them left the
// db suite green. The third is the one that needed a test most — the guard
// looked correct while comparing raw JS values, which is exactly the mistake
// it was written to catch.
import { assertThrows } from "@std/assert";
import { planTables } from "../src/db/state-sync.ts";
import { integer, pk, table, text } from "../src/server/sql.ts";
import type { TableDef } from "../src/server/sql.ts";

const SCHEMA: Record<string, TableDef> = {
  items: table({ id: pk(), title: text(), n: integer() }),
};
const plan = (rows: unknown) =>
  planTables(SCHEMA, { items: rows }, { items: [] });

Deno.test("db rows: a row with no primary key is refused, naming the row", () => {
  assertThrows(
    () => plan([{ title: "a", n: 1 }]),
    Error,
    "no primary key",
  );
  assertThrows(
    () => plan([{ id: null, title: "a", n: 1 }]),
    Error,
    "no primary key",
  );
  // …and the message has to point at WHICH row, or a 500-row array is a
  // scavenger hunt.
  assertThrows(
    () => plan([{ id: 1, title: "a", n: 1 }, { title: "b", n: 2 }]),
    Error,
    "row #1",
  );
});

Deno.test("db rows: a row that is not an object is refused, naming its type", () => {
  assertThrows(() => plan([42]), Error, "row #0 is a number");
  assertThrows(() => plan([null]), Error, "row #0 is null");
  assertThrows(() => plan([["id", 1]]), Error, "row #0 is an array");
});

Deno.test("db rows: pks that differ in JS but collide in SQLite are refused", () => {
  // `id: pk()` is INTEGER PRIMARY KEY — the rowid — and SQLite applies INTEGER
  // affinity before filing a row under it. A `Map` keyed on the raw values
  // sees two keys; the table sees one, and refuses the second INSERT.
  for (
    const pair of [
      [1, "1"],
      ["1", 1],
      [1, 1.0],
      [2, " 2 "],
    ] as const
  ) {
    assertThrows(
      () =>
        plan([
          { id: pair[0], title: "a", n: 1 },
          { id: pair[1], title: "b", n: 2 },
        ]),
      Error,
      "duplicate primary key",
      `${JSON.stringify(pair[0])} and ${
        JSON.stringify(pair[1])
      } are ONE key in an INTEGER PRIMARY KEY`,
    );
  }
});

Deno.test("db rows: distinct pks still plan cleanly", () => {
  // The mirror: the normalisation must not start reporting collisions that
  // are not collisions.
  const stmts = plan([
    { id: 1, title: "a", n: 1 },
    { id: 2, title: "b", n: 2 },
    { id: 10, title: "c", n: 3 },
  ]);
  if (stmts.length !== 3) {
    throw new Error(`expected 3 inserts, got ${stmts.length}`);
  }
});
