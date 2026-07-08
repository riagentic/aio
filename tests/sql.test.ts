// Tests for src/sql.ts — buildWhereOr, buildQuerySuffix, isWhereOp
// (assertIdent, columnToSQL, createTableSQL, buildWhere already covered in db.test.ts)
import { assertEquals } from "@std/assert";
import {
  buildQuerySuffix,
  buildWhereOr,
  isWhereOp,
} from "../src/server/sql.ts";

// ── isWhereOp ──────────────────────────────────────────────────────

Deno.test("sql: isWhereOp — recognizes valid operators", () => {
  assertEquals(isWhereOp({ gt: 10 }), true);
  assertEquals(isWhereOp({ gte: 5, lte: 20 }), true);
  assertEquals(isWhereOp({ ne: "x" }), true);
  assertEquals(isWhereOp({ like: "foo%" }), true);
  assertEquals(isWhereOp({ in: [1, 2] }), true);
  assertEquals(isWhereOp({ lt: 0 }), true);
});

Deno.test("sql: isWhereOp — rejects non-operators", () => {
  assertEquals(isWhereOp(null), false);
  assertEquals(isWhereOp(undefined), false);
  assertEquals(isWhereOp(42), false);
  assertEquals(isWhereOp("string"), false);
  assertEquals(isWhereOp([1, 2]), false);
  assertEquals(isWhereOp({}), false); // empty object
  assertEquals(isWhereOp({ name: "alice" }), false); // non-op key
  assertEquals(isWhereOp({ gt: 10, badKey: true }), false); // mixed keys
});

// ── buildWhereOr ──────────────────────────────────────────────────

Deno.test("sql: buildWhereOr — empty array", () => {
  const { sql, params } = buildWhereOr([]);
  assertEquals(sql, "");
  assertEquals(params, []);
});

Deno.test("sql: buildWhereOr — single filter", () => {
  const { sql, params } = buildWhereOr([{ name: "alice" }]);
  assertEquals(sql, " WHERE (name = ?)");
  assertEquals(params, ["alice"]);
});

Deno.test("sql: buildWhereOr — multiple filters", () => {
  const { sql, params } = buildWhereOr([
    { name: "alice" },
    { age: { gt: 30 } },
  ]);
  assertEquals(sql, " WHERE (name = ?) OR (age > ?)");
  assertEquals(params, ["alice", 30]);
});

Deno.test("sql: buildWhereOr — multi-field filters", () => {
  const { sql, params } = buildWhereOr([
    { name: "alice", role: "admin" },
    { name: "bob" },
  ]);
  assertEquals(sql, " WHERE (name = ? AND role = ?) OR (name = ?)");
  assertEquals(params, ["alice", "admin", "bob"]);
});

Deno.test("sql: buildWhereOr — empty filter in array is skipped", () => {
  const { sql, params } = buildWhereOr([{}, { name: "x" }]);
  assertEquals(sql, " WHERE (name = ?)");
  assertEquals(params, ["x"]);
});

// ── buildQuerySuffix ──────────────────────────────────────────────

Deno.test("sql: buildQuerySuffix — undefined opts", () => {
  assertEquals(buildQuerySuffix(undefined), "");
});

Deno.test("sql: buildQuerySuffix — empty opts", () => {
  assertEquals(buildQuerySuffix({}), "");
});

Deno.test("sql: buildQuerySuffix — orderBy string (defaults to ASC)", () => {
  assertEquals(buildQuerySuffix({ orderBy: "name" }), " ORDER BY name ASC");
});

Deno.test("sql: buildQuerySuffix — orderBy tuple", () => {
  assertEquals(
    buildQuerySuffix({ orderBy: ["score", "desc"] }),
    " ORDER BY score DESC",
  );
});

Deno.test("sql: buildQuerySuffix — limit", () => {
  assertEquals(buildQuerySuffix({ limit: 10 }), " LIMIT 10");
});

Deno.test("sql: buildQuerySuffix — offset", () => {
  assertEquals(buildQuerySuffix({ offset: 20 }), " OFFSET 20");
});

Deno.test("sql: buildQuerySuffix — all combined", () => {
  assertEquals(
    buildQuerySuffix({ orderBy: ["id", "asc"], limit: 5, offset: 10 }),
    " ORDER BY id ASC LIMIT 5 OFFSET 10",
  );
});

Deno.test("sql: buildQuerySuffix — negative limit/offset clamped to 0", () => {
  assertEquals(buildQuerySuffix({ limit: -5 }), " LIMIT 0");
  assertEquals(buildQuerySuffix({ offset: -10 }), " OFFSET 0");
});

Deno.test("sql: buildQuerySuffix — fractional limit floored", () => {
  assertEquals(buildQuerySuffix({ limit: 3.7 }), " LIMIT 3");
});
