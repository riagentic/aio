// The gate that keeps a field report out of git — tested on text, because a
// gate that only ever ran against a clean repo has never been shown to fire.
//
// The failure it exists for already happened once: `review/` was not ignored,
// a private app's key-security audit was tracked for a month in a public
// repository, and it shipped inside the published package as well. Nothing
// noticed, because nothing was looking.
import { assert, assertEquals } from "@std/assert";
import { REPORT_DIRS, verdict } from "../scripts/check-report-dirs.ts";

const IGNORED = "target/\nfeedback/\nreview/\nskills-lock.json\n";

Deno.test("a clean repo passes", () => {
  const v = verdict([""], IGNORED);
  assert(v.ok);
  assertEquals(v.tracked, []);
  assertEquals(v.unignored, []);
});

Deno.test("a TRACKED report is refused, and named", () => {
  const v = verdict(["review/some-app.md"], IGNORED);
  assertEquals(v.ok, false);
  assertEquals(v.tracked, ["review/some-app.md"]);
});

Deno.test("both report directories are watched, not just the one that leaked", () => {
  // `feedback/` was ignored from the start and held; `review/` was the one
  // that got out. A gate that learned only the specific failure would be
  // waiting for the next directory to be invented.
  //
  // The list is asserted BEFORE the loop: an empty `REPORT_DIRS` would make
  // every assertion below unreachable while this test stayed green — which is
  // the exact shape of the leak it is about.
  assertEquals(REPORT_DIRS.length, 2);
  for (const dir of REPORT_DIRS) {
    const v = verdict([`${dir}an-app.md`], IGNORED);
    assertEquals(v.ok, false, `${dir} must be watched`);
    assertEquals(v.tracked, [`${dir}an-app.md`]);
  }
});

Deno.test("dropping the .gitignore line is itself the failure", () => {
  // Otherwise the tracked-file half is one `git add` away from being
  // defeated, and the gate would still be green the whole time.
  const v = verdict([""], "target/\nfeedback/\n");
  assertEquals(v.ok, false);
  assertEquals(v.unignored, ["review/"]);
});

Deno.test("an ordinary source file is NOT mistaken for a report", () => {
  // A gate that fires on correct code is the same defect as one that stays
  // silent on broken code. `src/review-queue.ts` merely STARTS with the
  // letters of a report dir, and a prefix test on the wrong boundary would
  // refuse it.
  const v = verdict(
    ["src/review-queue.ts", "docs/feedback-policy.md", "reviewer.ts"],
    IGNORED,
  );
  assert(v.ok, `must not fire on: ${v.tracked.join(", ")}`);
});
