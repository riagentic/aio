// The beta line is `MAJOR.MINOR.PATCH-beta` — no digit after the word.
//
// `v1.0.0-beta1, beta2, …` was the alpha habit carried forward, and it has a
// cliff: SemVer compares `beta10` and `beta2` as ASCII, so every tool that is
// not `am` (JSR, `deno`, a shell `sort -V`) puts the tenth beta BELOW the
// second. `am` hides that with its own parser, which is exactly one decider
// too many. From 1.0.0-beta on, the patch number is the counter — a fix round
// bumps it, a feature bumps minor — and the first stable is the same triple
// with the suffix dropped. `1.0.0` itself is spent (the alphas and this beta
// sit under it) and is never cut.
//
// Every ordering surface the framework has agrees on this line, and this test
// is where that is pinned: `am pin latest`, `am fix` (seriesRank → removals),
// the in-app updater (compareVersions in updates-core), and the tag sort.
import { assert, assertEquals } from "@std/assert";
import {
  compareVersions,
  newestVersion,
  parseVersion,
  sortVersions,
} from "../src/am/am-versions.ts";
import { seriesRank } from "../src/am/am-cmd-migrate.ts";
import {
  compareVersions as compareRaw,
  isComparableVersion,
} from "../src/server/updates-core.ts";

/** Oldest → newest. The alpha tail, the beta line, an rc, the stable, and the
 *  next minor's beta — every transition the scheme will ever make. */
const LINE = [
  "v1.0.0-alpha9",
  "v1.0.0-alpha77",
  "v1.0.0-beta",
  "v1.0.1-beta",
  "v1.0.2-beta",
  "v1.0.10-beta",
  "v1.0.10-rc",
  "v1.0.10",
  "v1.1.0-beta",
  "v1.1.0",
  "v2.0.0-beta",
];

Deno.test("beta line: every tag is orderable and parses without a number", () => {
  for (const t of LINE) {
    assert(isComparableVersion(t), `${t} not orderable`);
    const v = parseVersion(t);
    assert(v, `${t} did not parse`);
  }
  assertEquals(parseVersion("v1.0.1-beta")?.pre, "beta");
  assertEquals(parseVersion("v1.0.1-beta")?.preNum, 0);
});

Deno.test("beta line: am's tag sort, the updater and seriesRank agree on one order", () => {
  const shuffled = [...LINE].reverse();
  assertEquals(sortVersions(shuffled).map((v) => v.raw), [...LINE].reverse());
  for (let i = 1; i < LINE.length; i++) {
    const a = LINE[i - 1]!, b = LINE[i]!;
    assert(compareRaw(a, b) < 0, `updater: ${a} should be older than ${b}`);
    assert(
      compareVersions(parseVersion(a)!, parseVersion(b)!) < 0,
      `am: ${a} should be older than ${b}`,
    );
    assert(seriesRank(a) < seriesRank(b), `seriesRank: ${a} < ${b}`);
  }
});

Deno.test("beta line: `am pin latest` picks the newest beta, and stays inside the major", () => {
  assertEquals(newestVersion(LINE)?.raw, "v2.0.0-beta");
  assertEquals(newestVersion(LINE, { major: 1 })?.raw, "v1.1.0");
  assertEquals(
    newestVersion(["v1.0.0-alpha77", "v1.0.0-beta", "v1.0.1-beta"])?.raw,
    "v1.0.1-beta",
  );
});

Deno.test("beta line: the bare series and the tagged spelling are the same release", () => {
  assertEquals(seriesRank("beta"), seriesRank("v1.0.0-beta"));
  assertEquals(seriesRank("beta"), seriesRank("1.0.0-beta"));
  assertEquals(seriesRank("alpha77"), seriesRank("v1.0.0-alpha77"));
  assert(seriesRank("alpha77") < seriesRank("beta"));
});
