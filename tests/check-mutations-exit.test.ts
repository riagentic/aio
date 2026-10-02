// `check:mutations` cannot be green without having killed every row.
//
// `--jobs=0` made zero workers: no row left the queue, nothing "survived",
// and the gate printed "0/N invariants are genuinely guarded" and exited 0.
// `--jobs=abc` (NaN) did the same. The exit counted failures seen instead of
// kills made — a gate that passes by not looking.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  allKilled,
  mutationExitCode,
  mutationJobs,
} from "../scripts/check-mutations.ts";

const SCRIPT = new URL("../scripts/check-mutations.ts", import.meta.url)
  .pathname;

Deno.test("check:mutations --jobs: a whole number ≥ 1, or a refusal", () => {
  assertEquals(mutationJobs(undefined), 4);
  assertEquals(mutationJobs("1"), 1);
  assertEquals(mutationJobs("12"), 12);
  for (const bad of ["0", "", "abc", "-1", "1.5", "2x", " 3", "Infinity"]) {
    assertThrows(() => mutationJobs(bad), Error, "--jobs=", bad);
  }
});

Deno.test("check:mutations is green only when every selected row was killed", () => {
  assert(allKilled(3, 3));
  assert(!allKilled(2, 3), "a row that was never checked is not a pass");
  assert(!allKilled(0, 3));
  assert(!allKilled(0, 0), "nothing selected is nothing proven");
});

Deno.test("check:mutations exit code: 0 only when every selected row reported killed", async () => {
  const k = { verdict: "killed" } as const;
  assertEquals(mutationExitCode([k, k, k], 3), 0);
  assertEquals(mutationExitCode([k, { verdict: "survived" }, k], 3), 1);
  assertEquals(mutationExitCode([k, { verdict: "invalid" }, k], 3), 1);
  // No survivor and no broken row — and still not green: a row that never
  // came back, and a selection of nothing.
  assertEquals(mutationExitCode([k, k], 3), 1);
  assertEquals(mutationExitCode([], 3), 1);
  assertEquals(mutationExitCode([], 0), 1);
  // A survivor is red however many kills stand beside it: the kills are not
  // counted up to the selection, each report is read.
  const s = { verdict: "survived" } as const,
    b = { verdict: "invalid" } as const;
  for (
    const [results, selected, code] of [
      [[k, k, k, s], 3, 1],
      [[k, k, k, b], 3, 1],
      [[s, k, k, k], 3, 1],
      [[k, k, k, k], 3, 1],
      [[k, k, k, s], 4, 1],
      [[k, k, k, k], 4, 0],
      [[k], 1, 0],
    ] as const
  ) {
    assertEquals(
      mutationExitCode(results, selected),
      code,
      `${results.map((r) => r.verdict)} of ${selected}`,
    );
  }
  // …and it is what the run exits with: the last line of main, over every
  // result and the whole selection. A full run takes minutes per row, so the
  // wiring is pinned where it is written.
  const src = await Deno.readTextFile(SCRIPT);
  const exits = src.slice(src.indexOf("const results: Result[] = [];"))
    .match(/Deno\.exit\([^\n]*/g);
  assertEquals(exits, [
    "Deno.exit(mutationExitCode(results, entries.length));",
  ]);
});

Deno.test("check:mutations --jobs=0 exits 1 before it checks nothing", async () => {
  for (const jobs of ["0", "abc"]) {
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", SCRIPT, `--jobs=${jobs}`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr);
    assertEquals(r.code, 1, out);
    assert(out.includes(`--jobs=${jobs}`), out);
    assert(!out.includes("genuinely guarded"), out);
  }
});
