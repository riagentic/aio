// A refused table write already says a lot — "datatype mismatch / in a
// transaction of 17 statements, at statement 1 / sql: INSERT INTO rows (id,
// name) VALUES (?, ?) / params: 2 / (the whole transaction was rolled back)".
// What it gives for the VALUES is a COUNT, so the one thing a reader cannot
// see is the mistake itself: `id` arriving as a string where the table
// declares an integer key.
//
// MEASURED by crash-testing a db-backed cell whose `pk()` column was handed
// `"r1"`: the app accepted 400 writes, reported success to every caller,
// logged the refusal every window, and restored `[]`. The framework's handling
// is right (the table half fails alone, the state stays in memory, the batch
// retries whole) — but "the moment the value is fixed" is unreachable if the
// value cannot be seen.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { refusedWriteDetail } from "../src/db/state-sync.ts";

Deno.test("refused write: names the table and the row's SHAPE", () => {
  const msg = refusedWriteDetail([
    { sql: "INSERT INTO rows (id, name) VALUES (?, ?)", params: ["r1", "n1"] },
    { sql: "DELETE FROM rows" },
  ]);
  assertStringIncludes(msg, '"rows"');
  assertStringIncludes(msg, "id: a string");
  assertStringIncludes(msg, "name: a string");
  // the state is not lost, and the batch retries — say so, or the reader
  // assumes the write is gone
  assertStringIncludes(msg, "retried whole");
});

Deno.test("refused write: VALUES never reach the log", () => {
  const msg = refusedWriteDetail([{
    sql: "INSERT INTO users (id, secret) VALUES (?, ?)",
    params: [1, "hunter2-SUPERSECRET"],
  }]);
  assertStringIncludes(msg, "secret: a string");
  assert(
    !msg.includes("hunter2"),
    `a row is user data and this goes to a log:\n${msg}`,
  );
});

Deno.test("refused write: several tables are all named", () => {
  const msg = refusedWriteDetail([
    { sql: "INSERT INTO a (x) VALUES (?)", params: [1] },
    { sql: "UPDATE b SET y = ?", params: [2] },
  ]);
  assertStringIncludes(msg, '"a"');
  assertStringIncludes(msg, '"b"');
});

Deno.test("refused write: nothing to say about an empty batch", () => {
  assertEquals(refusedWriteDetail([]), "");
  // a batch with no table statement adds nothing rather than guessing
  assertEquals(refusedWriteDetail([{ sql: "PRAGMA user_version" }]), "");
});
