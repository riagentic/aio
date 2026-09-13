// The three-way text merge must stay inside a memory budget a browser tab can
// afford.
//
// `MAX_TOKENS` caps each SIDE at 4000; the work is the PRODUCT. A 4000-
// character single-line field — a title, a URL list, a serialized blob —
// tokenizes per character, so it sits exactly on the per-side limit and builds
// a 4000×4000 table. MEASURED: 72.5 MB of RSS and 84 ms for one merge, and
// `mergeText3` runs `hunksOf` twice (local AND remote), so a single field
// peaks near 128 MB. On the sync path, in the tab.
//
// The comment in `lcsMatches` claimed "Row-at-a-time to keep the allocation
// O(m) rather than O(n·m)" — it is not: the backtrack needs every row and
// every row is kept. Measured allocation tracked the O(n·m) prediction, not
// the O(m) one, at every size.
import { assert, assertEquals } from "@std/assert";
import { MAX_LCS_CELLS, mergeText3 } from "../src/sync/merge-text.ts";
import type { HLC } from "../src/sync/types.ts";

const L: HLC = [2000, 0, "a"];
const R: HLC = [1000, 0, "b"];

Deno.test("text merge: the worst-case table is refused, not allocated", () => {
  // 3000x3000 = 9M cells, over the budget and under the per-side limit — the
  // shape that is 45+ MB of rows and has no line structure to exploit.
  const base = "ab".repeat(1500);
  const local = base.slice(0, 700) + "LOCAL" + base.slice(700);
  const remote = base.slice(0, 200) + "REMOTE" + base.slice(200);

  const t0 = performance.now();
  const out = mergeText3(base, local, L, remote, R);
  const ms = performance.now() - t0;

  // It still ANSWERS, with the documented fallback — the budget changes the
  // strategy, never the contract.
  assertEquals(
    out.value,
    local,
    "past the budget the field resolves LWW (the higher HLC wins)",
  );
  assertEquals(out.conflict, true, "…and is REPORTED as a conflict");
  assert(ms < 500, `and answers at once: ${ms.toFixed(0)}ms`);
});

// The boundary, in the other direction — and the reason the budget sits where
// it does. A ceiling low enough to refuse this would turn a 0.4ms merge into a
// lost edit, which is a worse bug than the memory it was saving.
Deno.test("text merge: an affordable single-line diff still merges BOTH edits", () => {
  const base = "ab".repeat(750); // 1500 tokens, no newline
  const local = base.slice(0, 700) + "LOCAL" + base.slice(700);
  const remote = base.slice(0, 200) + "REMOTE" + base.slice(200);
  const out = mergeText3(base, local, L, remote, R);
  assert(
    out.value.includes("LOCAL") && out.value.includes("REMOTE"),
    `both peers' edits must survive: ${out.value.slice(0, 40)}…`,
  );
  assertEquals(out.conflict, false, "different parts are not a conflict");
});

Deno.test("text merge: an ordinary co-edit still merges both sides", () => {
  // The other direction — a budget that refused everything would pass the
  // test above and delete the feature.
  const base = "Hello world\nsecond line\nthird line\n";
  const local = "Hello world\nsecond line CHANGED\nthird line\n";
  const remote = "Hello world\nsecond line\nthird line\nfourth line\n";
  const out = mergeText3(base, local, L, remote, R);
  assertEquals(out.conflict, false, "different paragraphs are not a conflict");
  assert(out.value.includes("CHANGED"), "my edit survived");
  assert(out.value.includes("fourth line"), "and so did theirs");
});

Deno.test("text merge: the table budget is a real number, not a placeholder", () => {
  // A ceiling that is effectively infinite is the same as no ceiling.
  // Not effectively infinite (the per-side limit already allows 16M cells),
  // and not so low that ordinary co-editing falls back to LWW.
  assert(
    MAX_LCS_CELLS >= 2_000_000 && MAX_LCS_CELLS < 16_000_000,
    `the table budget must bound a browser tab without eating merges: ` +
      `${MAX_LCS_CELLS}`,
  );
});
