// `am record`: turn a recorded journal into a bootCells replay test.
import { assert, assertEquals } from "@std/assert";
import {
  generateReplayTest,
  journalDamage,
  parseJournal,
} from "../src/am/record.ts";

Deno.test("generateReplayTest: cell:method + args → bootCells calls", () => {
  const src = generateReplayTest([
    { type: "counter:add", payload: { args: [7] } },
    { type: "counter:add", payload: { args: [5] } },
    { type: "nav:go", payload: { args: ["home"] } },
    { type: "counter:__init", payload: {} }, // framework — skipped
  ]);
  assert(src.includes('import { bootCells } from "aio/testing";'));
  assert(src.includes('import { counter } from "../src/counter.ts";'));
  assert(src.includes('import { nav } from "../src/nav.ts";'));
  assert(src.includes("bootCells([counter, nav])"));
  assert(src.includes("await counter.add(7);"));
  assert(src.includes("await counter.add(5);"));
  assert(src.includes('await nav.go("home");'));
  assert(!src.includes("__init"), "framework __methods are not replayed");
  assert(src.includes("// TODO: assert"), "leaves an assertion stub");
});

Deno.test("generateReplayTest: empty → a valid empty test", () => {
  const src = generateReplayTest([]);
  assert(src.includes("bootCells([])"));
  assert(src.includes("Deno.test"));
});

Deno.test("parseJournal: JSONL → ordered rows, tolerates a torn tail", () => {
  const text = [
    JSON.stringify({ seq: 2, type: "c:b", payload: { args: [2] } }),
    JSON.stringify({ seq: 1, type: "c:a", payload: { args: [1] } }),
    '{"seq":3,"type":"c:c","payl', // torn line
  ].join("\n");
  const rows = parseJournal(text).rows;
  assertEquals(
    rows.map((r) => r.type),
    ["c:a", "c:b"],
    "sorted by seq, torn dropped",
  );
  assertEquals((rows[0]!.payload as { args: number[] }).args, [1]);
});

// ── A tear INSIDE the file is not a torn tail ─────────────────────────────
//
// The parser's `catch { break }` is right for a torn tail — a process killed
// mid-write — and was applied at any position, so ONE bad line in the middle
// truncated everything after it. Measured on a four-row journal with row 2
// truncated: `am timeline`, `am replay --dry` and `am record` each recovered
// ONE row, exited 0, and said nothing — and `am record` wrote a "replay test"
// from a quarter of the journal and called it a success. Silent loss under a
// green exit code. And the reach for `am replay` usually happens BECAUSE
// something crashed, which is exactly when a journal is likely damaged.
Deno.test("parseJournal: a bad line in the MIDDLE does not truncate the rest", () => {
  const text = [
    JSON.stringify({ seq: 1, type: "c:a", payload: {} }),
    '{"seq":2,"type":"c:b","payl', // torn, mid-file
    JSON.stringify({ seq: 3, type: "c:c", payload: {} }),
    JSON.stringify({ seq: 4, type: "c:d", payload: {} }),
  ].join("\n");
  const p = parseJournal(text);
  assertEquals(
    p.rows.map((r) => r.type),
    ["c:a", "c:c", "c:d"],
    "everything readable is recovered, not just what precedes the tear",
  );
  assertEquals(p.badLines, [2], "and the damage is reported, by line");
  assertEquals(p.tornTailOnly, false, "a mid-file tear is not a torn tail");
});

Deno.test("parseJournal: a torn LAST line is still an ordinary torn tail", () => {
  const text = [
    JSON.stringify({ seq: 1, type: "c:a", payload: {} }),
    JSON.stringify({ seq: 2, type: "c:b", payload: {} }),
    '{"seq":3,"type":"c:c","payl',
  ].join("\n");
  const p = parseJournal(text);
  assertEquals(p.rows.map((r) => r.type), ["c:a", "c:b"]);
  assertEquals(p.tornTailOnly, true);
});

Deno.test("parseJournal: a trailing newline is not damage", () => {
  const p = parseJournal(
    JSON.stringify({ seq: 1, type: "c:a", payload: {} }) + "\n",
  );
  assertEquals(p.badLines, []);
  assertEquals(p.tornTailOnly, true, "no bad lines at all");
  assertEquals(p.rows.length, 1);
});

Deno.test("parseJournal: a file that is not a journal at all reads as damaged", () => {
  // `am timeline --from=/etc/passwd` answered `{"entries":[]}`, exit 0 — a
  // file that is not a journal looked exactly like an empty one.
  const p = parseJournal("root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:\n");
  assertEquals(p.rows, []);
  assertEquals(p.badLines, [1, 2]);
  assertEquals(p.tornTailOnly, false);
});

Deno.test("journalDamage: says which kind of damage, or nothing at all", () => {
  const clean = parseJournal(
    JSON.stringify({ seq: 1, type: "c:a", payload: {} }),
  );
  assertEquals(journalDamage(clean, "/j"), null, "a clean file says nothing");

  const tail = parseJournal(
    JSON.stringify({ seq: 1, type: "c:a" }) + "\n{ torn",
  );
  const tailMsg = journalDamage(tail, "/j")!;
  assert(tailMsg.includes("torn"), tailMsg);
  assert(!tailMsg.includes("damaged"), tailMsg);

  const mid = parseJournal(
    "{ torn\n" + JSON.stringify({ seq: 2, type: "c:b" }),
  );
  const midMsg = journalDamage(mid, "/j")!;
  assert(midMsg.includes("damaged"), midMsg);
  assert(midMsg.includes("1 entries were recovered"), midMsg);
});
