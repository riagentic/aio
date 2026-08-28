// Object-shaped `db:` mappings (todo.md → Internals, "db:/persist
// granularity"): a `db:` entry may be `{ table, shape?, path? }` instead of a
// bare TableDef — binding a pk-keyed object MAP (`Record<id, Row>`) or a
// SUBSET deeper than one field of the slice. Additive: a bare TableDef still
// means `{ table, shape: "array" }`. Every misuse is refused at boot by name.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { produce } from "immer";
import {
  omitPaths,
  placeLoadedTables,
  resolveDbBindings,
} from "../src/server/aio-boot.ts";
import { dbMappingOf, integer, pk, table, text } from "../src/server/sql.ts";
import {
  planTables,
  planTablesIncremental,
  type TableIndex,
} from "../src/db/state-sync.ts";

const t = () => table({ id: pk(), name: text(), qty: integer() });
const quiet = () => ({
  infos: [] as string[],
  warns: [] as string[],
  info(m: string) {
    this.infos.push(m);
  },
  warn(m: string) {
    this.warns.push(m);
  },
});

Deno.test("object mapping: a bare TableDef and { table } resolve identically", () => {
  const initial = { inv: { items: [] as unknown[] } };
  const a = resolveDbBindings(initial, { items: t() }, quiet());
  const b = resolveDbBindings(initial, { items: { table: t() } }, quiet());
  assertEquals(a.bindings, b.bindings);
  assertEquals(a.bindings[0]!.shape, "array");
  assertEquals(dbMappingOf(t()).shape, "array");
});

Deno.test("object mapping: shape 'map' binds a pk-keyed object and loads rows back into it", () => {
  const initial = { wallet: { byMint: {} as Record<string, unknown>, n: 0 } };
  const log = quiet();
  const { bindings, sqlSchema } = resolveDbBindings(
    initial,
    { "wallet.byMint": { table: t(), shape: "map" } },
    log,
  );
  assertEquals(bindings[0], {
    table: "wallet_byMint",
    path: ["wallet", "byMint"],
    shape: "map",
    pk: "id",
  });
  assertEquals(sqlSchema.wallet_byMint!.shape, "map");
  assert(
    log.infos.some((m) => m.includes('map keyed by "id"')),
    log.infos.join(),
  );
  const placed = placeLoadedTables(initial, bindings, {
    wallet_byMint: [{ id: 7, name: "a", qty: 1 }, { id: 9, name: "b", qty: 2 }],
  }) as typeof initial;
  assertEquals(Object.keys(placed.wallet.byMint), ["7", "9"]);
  assertEquals(placed.wallet.n, 0);
  // The bound map is what leaves the KV snapshot — nothing else.
  assertEquals(omitPaths(placed, [bindings[0]!.path]), { wallet: { n: 0 } });
});

Deno.test("object mapping: a map binding diffs by pk and refuses a key that disagrees with its row", () => {
  const schema = { m: { ...t(), shape: "map" as const } };
  const base = produce(
    {
      m: {
        "1": { id: 1, name: "a", qty: 0 },
        "2": { id: 2, name: "b", qty: 0 },
      } as Record<string, { id: number; name: string; qty: number }>,
    },
    () => {},
  );
  const index: Record<string, TableIndex> = {};
  planTablesIncremental(schema, base, { m: {} }, index).commit();
  const next = produce(base, (d) => {
    d.m["2"]!.qty = 5;
    d.m["3"] = { id: 3, name: "c", qty: 0 };
  });
  const plan = planTablesIncremental(schema, next, base, index);
  assertEquals(plan.stmts.map((s) => s.sql.split(" ")[0]), [
    "INSERT",
    "UPDATE",
  ]);
  plan.commit();
  const gone = produce(next, (d) => {
    delete d.m["1"];
  });
  const del = planTablesIncremental(schema, gone, next, index);
  assertEquals(del.stmts.length, 1);
  assert(del.stmts[0]!.sql.startsWith("DELETE FROM m WHERE id IN"));
  assertEquals(del.stmts[0]!.params, [1]);
  // key "9" holding a row whose id is 3 — one fact, two spellings.
  const lie = produce(gone, (d) => {
    d.m["9"] = { id: 3, name: "c", qty: 0 };
  });
  assertThrows(() => planTables(schema, lie, gone), Error, "must agree");
});

Deno.test("object mapping: path binds a subset deeper than one field, table still named cell_field", () => {
  const initial = {
    ledger: { book: { entries: [] as unknown[], open: true } },
  };
  const { bindings } = resolveDbBindings(
    initial,
    { "ledger.entries": { table: t(), path: "book.entries" } },
    quiet(),
  );
  assertEquals(bindings[0]!.table, "ledger_entries");
  assertEquals(bindings[0]!.path, ["ledger", "book", "entries"]);
  const placed = placeLoadedTables(initial, bindings, {
    ledger_entries: [{ id: 1, name: "x", qty: 1 }],
  }) as typeof initial;
  assertEquals(placed.ledger.book.entries.length, 1);
  assertEquals(placed.ledger.book.open, true);
  assertEquals(omitPaths(placed, [bindings[0]!.path]), {
    ledger: { book: { open: true } },
  });
});

Deno.test("object mapping: every misuse is refused at boot by name", () => {
  const initial = {
    inv: { items: [] as unknown[], byId: {} as Record<string, unknown> },
  };
  const noPk = table({ name: text() });
  assertThrows(
    () =>
      resolveDbBindings(
        initial,
        { "inv.byId": { table: noPk, shape: "map" } },
        quiet(),
      ),
    Error,
    "declares no pk() column",
  );
  assertThrows(
    () =>
      resolveDbBindings(
        initial,
        { "inv.items": { table: t(), shape: "map" } },
        quiet(),
      ),
    Error,
    'has no object field "items"',
  );
  assertThrows(
    () => resolveDbBindings(initial, { "inv.byId": t() }, quiet()),
    Error,
    'has no array field "byId"',
  );
  assertThrows(
    () =>
      resolveDbBindings(
        initial,
        { items: { table: t(), path: "a.b" } },
        quiet(),
      ),
    Error,
    'must be "<cell>.<field>"',
  );
  assertThrows(
    () =>
      resolveDbBindings(initial, {
        "inv.items": { table: t(), path: "nope.deeper" },
      }, quiet()),
    Error,
    'has no array at "nope.deeper"',
  );
  assertThrows(
    () =>
      resolveDbBindings(initial, {
        "inv.items": { table: t(), shape: "list" as unknown as "array" },
      }, quiet()),
    Error,
    'not one of "array" | "map"',
  );
  // A bare-key map binding is ambiguous by construction — explicit or nothing.
  assertThrows(
    () =>
      resolveDbBindings(
        { byId: {} },
        { byId: { table: t(), shape: "map" } },
        quiet(),
      ),
    Error,
    "must be explicit",
  );
});
