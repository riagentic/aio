// A time-travel line is refused PER CELL, not whole.
//
// `aio:__timeTravel` carries the persisted fields of EVERY cell as they were
// after the jump, and its version stamp names each of them. A stamp stale for
// ONE cell (that cell migrated between the crash and this boot) used to skip
// the whole line — every other cell, whose stamp matched, lost the jump too
// and came back at its pre-jump snapshot with the post-jump tail on top of it.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { replayJournal, TT_RESTORE_TYPE } from "../src/server/journal.ts";
import type { JournalEntry } from "../src/server/journal.ts";

type S = { a: { n: number }; b: { n: number } };

const reduce = (s: S) => ({ state: s });

Deno.test("replayJournal: a time-travel line stale for one cell still restores the others", () => {
  const tt: JournalEntry = {
    seq: 1,
    type: TT_RESTORE_TYPE,
    ts: 0,
    payload: { cmd: "goto", arg: 2, cells: { a: { n: 7 }, b: { n: 9 } } },
    v: { a: 1, b: 0 },
  };
  const r = replayJournal<S, unknown>(
    { a: { n: 100 }, b: { n: 1 } },
    [tt],
    reduce,
    undefined,
    (c) => (c === "a" ? 2 : 0),
    (c) => c === "a",
  );
  assertEquals(r.state.b, { n: 9 }, "b's stamp matches — its jump applies");
  assertEquals(r.state.a, { n: 100 }, "a migrated — its old fields do not");
  assertEquals(r.skipped.length, 1);
  assertEquals(r.skipped[0]!.reason, "version");
  assertStringIncludes(r.skipped[0]!.error ?? "", `"a" v1 → v2`);
});

Deno.test("replayJournal: a time-travel line stale for every cell it carries is skipped whole", () => {
  const tt: JournalEntry = {
    seq: 1,
    type: TT_RESTORE_TYPE,
    ts: 0,
    payload: { cmd: "undo", cells: { a: { n: 7 } } },
    v: { a: 1 },
  };
  const r = replayJournal<S, unknown>(
    { a: { n: 100 }, b: { n: 1 } },
    [tt],
    reduce,
    undefined,
    () => 2,
    () => true,
  );
  assertEquals(r.state, { a: { n: 100 }, b: { n: 1 } });
  assertEquals(r.replayed, 0);
  assertEquals(r.skipped.map((s) => s.reason), ["version"]);
});
