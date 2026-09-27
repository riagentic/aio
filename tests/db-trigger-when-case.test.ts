// countSqlStatements closes a CREATE TRIGGER at the END of a
// CASE in its WHEN clause (before the BEGIN body), so a valid single-statement
// trigger is refused by db.execute() as "several statements".

import { assertEquals } from "@std/assert";
import { countSqlStatements } from "../src/db/async-db.ts";

Deno.test("countSqlStatements: a trigger whose WHEN holds a CASE is one statement", () => {
  const sql = "CREATE TRIGGER t AFTER UPDATE ON mail " +
    "WHEN CASE WHEN new.n > 0 THEN 1 ELSE 0 END " +
    "BEGIN UPDATE mail SET seen = 1 WHERE id = new.id; END;";
  assertEquals(countSqlStatements(sql), 1);
});

Deno.test("countSqlStatements: a column named `begin`/`end` is not the trigger body's keyword — statements after END still count", () => {
  const sql = "CREATE TRIGGER t AFTER INSERT ON x WHEN new.begin > 0 " +
    "BEGIN SELECT 1; END; DROP TABLE users; SELECT 1 AS end";
  assertEquals(countSqlStatements(sql), 3);
  assertEquals(
    countSqlStatements(
      "CREATE TRIGGER t AFTER INSERT ON x BEGIN " +
        "UPDATE x SET a = new . end; END; DROP TABLE users",
    ),
    2,
  );
  assertEquals(
    countSqlStatements(
      'CREATE TRIGGER t AFTER INSERT ON x WHEN new."begin" > 0 ' +
        "BEGIN SELECT 1; END;",
    ),
    1,
  );
});

Deno.test("countSqlStatements: a number with a trailing dot (`1.`) is not a qualifier", () => {
  for (
    const sql of [
      "CREATE TRIGGER t AFTER INSERT ON a WHEN 1. BEGIN SELECT 1; END",
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN " +
      "SELECT CASE WHEN 1 THEN 1. END; END",
    ]
  ) assertEquals(countSqlStatements(sql), 1, sql);
  // A quoted table still qualifies.
  assertEquals(
    countSqlStatements(
      'CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE x SET a = "x".end; ' +
        "END; DROP TABLE users",
    ),
    2,
  );
});
