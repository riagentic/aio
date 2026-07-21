// sqliteKv — the SkvInstance interface on SQLite (perfect-aio D4).
// Ported from the Deno.Kv wrapper tests; same interface, one store.
// Perf gate (recorded 2026-07-22, 500 ops, real cell-snapshot payloads):
//   set 0.031ms/op (KV: 0.845 — 27x faster) · setMulti 0.049 (KV: 0.850)
//   getMulti 0.040 (KV: 0.059) · get 0.032 (KV: 0.025 — us-level, boot-only)
import { assert, assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import type { DB, QueryResult, Tx } from "../src/db/types.ts";
import {
  migrateLegacyKv,
  SKV_SCHEMA,
  sqliteKv,
} from "../src/server/skv-sqlite.ts";

// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;

function testDb(): DB {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SKV_SCHEMA);
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
    const out: QueryResult[] = [];
    for (const s of arg as { sql: string; params?: unknown[] }[]) {
      out.push(await execute(s.sql, s.params));
    }
    return out;
    // deno-lint-ignore no-explicit-any
  }) as any;
  return { query, execute, transaction, close: () => Promise.resolve() };
}

Deno.test("sqliteKv: set/get/del round-trip preserves JSON structure", async () => {
  const kv = sqliteKv(testDb());
  const value = { count: 42, nested: { list: [1, 2, 3], ok: true } };
  await kv.set("state", value);
  assertEquals(await kv.get("state"), value);
  await kv.set("state", { count: 43 }); // upsert
  assertEquals(await kv.get("state"), { count: 43 });
  await kv.del("state");
  assertEquals(await kv.get("state"), null);
});

Deno.test("sqliteKv: values beyond KV's old 64KiB limit persist fine", async () => {
  const kv = sqliteKv(testDb());
  const big = { blob: "x".repeat(200_000) }; // 200KB — KV rejected this class
  await kv.set("big", big);
  const back = await kv.get<{ blob: string }>("big");
  assertEquals(back?.blob.length, 200_000);
});

Deno.test("sqliteKv: setMulti/getMulti — per-cell rows, atomic prune", async () => {
  const kv = sqliteKv(testDb());
  await kv.setMulti("cells", { counter: { n: 1 }, todo: { items: ["a"] } });
  assertEquals(await kv.getMulti("cells"), {
    counter: { n: 1 },
    todo: { items: ["a"] },
  });
  await kv.setMulti("cells", { counter: { n: 2 } }, ["counter", "todo"]);
  assertEquals(await kv.getMulti("cells"), { counter: { n: 2 } });
  assertEquals(await kv.getMulti("nothing"), null);
});

Deno.test("sqliteKv: prefixes never bleed into each other", async () => {
  const kv = sqliteKv(testDb());
  await kv.setMulti("cells", { a: 1 });
  await kv.setMulti("cellsX", { b: 2 });
  await kv.set("cells", "plain-key-not-multi");
  assertEquals(await kv.getMulti("cells"), { a: 1 });
  assertEquals(await kv.getMulti("cellsX"), { b: 2 });
  assertEquals(await kv.get("cells"), "plain-key-not-multi");
});

Deno.test("migrateLegacyKv: idempotent + silent when no legacy store", async () => {
  const db = testDb();
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: () => {} };
  await migrateLegacyKv(db, "/nonexistent/path.kv", log);
  const kv = sqliteKv(db);
  await kv.set("k", 1);
  await migrateLegacyKv(db, "/nonexistent/path.kv", log);
  assertEquals(await kv.get("k"), 1);
  assert(
    logs.every((l) => !l.includes("migrated")),
    "no false migration claims",
  );
});
