// The coverage gate must measure THIS repo, not every copy of it on the box.
//
// The filter was `path.includes("/src/")`. On any machine that has run
// `install.sh` — which the onboarding tests do — that also matches
// `~/.local/lib/aio/src/…`, a second copy of the same source, exercised
// sparsely by the tests that drive the INSTALLED CLI. The gate averaged the
// repo (83.5% over 374 files) with an installation of it (10.3% over 237) and
// reported 52.4%: thirty points under the truth, and only ever on a developer
// machine, because a fresh CI runner has no global install to find.
//
// That is the whole of "the coverage floor is flaky by nature". It was not
// flake. The number moved with whether `install.sh` had run lately.
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { coverageOf, includeFile } from "../scripts/check-coverage.ts";

const ROOT = "/repo/";

const record = (file: string, lf: number, lh: number) =>
  `SF:${file}\nLF:${lf}\nLH:${lh}\nend_of_record`;

Deno.test("coverage: a second copy of the source is not this repo", () => {
  assertEquals(includeFile("/repo/src/state/cell.ts", ROOT), true);
  // The exact path that cost thirty points.
  assertEquals(
    includeFile("/home/dev/.local/lib/aio/src/state/cell.ts", ROOT),
    false,
  );
  // A scaffolded app's `dep/aio` symlink resolves elsewhere too.
  assertEquals(
    includeFile("/tmp/app-x/dep/aio/src/state/cell.ts", ROOT),
    false,
  );
  // Still out: examples vendored inside the repo.
  assertEquals(includeFile("/repo/src/examples/demo.ts", ROOT), false);
  // Still out: anything of ours that is not src/.
  assertEquals(includeFile("/repo/tests/cell.test.ts", ROOT), false);
  assertEquals(includeFile("/repo/scripts/check-coverage.ts", ROOT), false);
});

Deno.test("coverage: an installed copy cannot drag the number down", () => {
  const lcov = [
    record("/repo/src/a.ts", 100, 90),
    record("/repo/src/b.ts", 100, 80),
    // The same two files, as the installed CLI's own copy: barely executed.
    record("/home/me/.local/lib/aio/src/a.ts", 100, 2),
    record("/home/me/.local/lib/aio/src/b.ts", 100, 1),
  ].join("\n");

  const got = coverageOf(lcov, ROOT);
  assertEquals(got.found, 200, "only this repo's lines are counted");
  assertEquals(got.hit, 170);
  assertAlmostEquals(got.pct, 85);
  assertEquals(got.perFile.length, 2);

  // What the OLD rule produced on the same profile, written out because it
  // cannot be expressed through the new one: `includes("/src/")` matched both
  // copies, so 400 lines and 43.25% — under any sane floor, from a codebase
  // that was actually at 85%.
  const oldRule = (f: string) =>
    f.includes("/src/") && !f.includes("/examples/");
  let found = 0, hit = 0, sf = "", lf = 0, lh = 0;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) sf = line.slice(3);
    else if (line.startsWith("LF:")) lf = Number(line.slice(3));
    else if (line.startsWith("LH:")) lh = Number(line.slice(3));
    else if (line === "end_of_record" && oldRule(sf)) {
      found += lf;
      hit += lh;
    }
  }
  assertEquals(found, 400);
  assertAlmostEquals((hit / found) * 100, 43.25);
});

Deno.test("coverage: an empty profile is zero, not a division by zero", () => {
  const got = coverageOf("", ROOT);
  assertEquals(got.found, 0);
  assertEquals(got.pct, 0);
  assertEquals(got.perFile, []);
});

Deno.test("coverage: a file with no lines does not enter the per-file report", () => {
  // LF:0 would be a NaN percentage in the "worst covered" list.
  const got = coverageOf(record("/repo/src/empty.ts", 0, 0), ROOT);
  assertEquals(got.perFile, []);
  assertEquals(got.found, 0);
});
