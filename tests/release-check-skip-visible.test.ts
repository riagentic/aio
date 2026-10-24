// A gate that did not RUN must never read like one that passed.
//
// `check:release` reported the docker-less lab as `✓ lab (fresh ubuntu)
// SKIPPED …` and closed with a bare "✓ releasable" — so the one gate that tests
// onboarding on a machine that is not this one could be missing from a release
// while its summary line looked exactly like a release where it had run. The
// skip stays non-fatal (a Linux laptop without docker can still cut a release;
// ci-mirrors-release-check.test.ts keeps the lab the ONLY gate allowed to
// skip), but it is `⚠` in the report and named in the last line.
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  electronAdvisory,
  heavyGateNames,
  heavyPlan,
  notRunReport,
  type Result,
  resultLine,
  STUB_REBUILD_TEST,
  stubRebuildAdvisory,
  stubRebuildNow,
  verdictLine,
} from "../scripts/release-check.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const LAB_SKIPPED: Result = {
  name: "lab (fresh ubuntu)",
  ok: true,
  detail: "SKIPPED — no docker/podman on this machine.",
  skipped: true,
};
const PASSED: Result = { name: "test", ok: true, detail: "150s" };
const FAILED: Result = { name: "lint", ok: false, detail: "3s" };

Deno.test("release check: a skipped lab is ⚠ in the report and named in the releasable line", () => {
  assertEquals(resultLine(LAB_SKIPPED).trimStart().slice(0, 1), "⚠");
  assertEquals(resultLine(PASSED).trimStart().slice(0, 1), "✓");
  assertEquals(resultLine(FAILED).trimStart().slice(0, 1), "✗");

  const skipped = verdictLine(false, [PASSED, LAB_SKIPPED]);
  assertStringIncludes(
    skipped,
    "✓ releasable (lab SKIPPED — no docker/podman)",
  );
  // The lab that RAN says nothing extra: the note is the skip's, not noise.
  const ran = verdictLine(false, [PASSED, {
    name: "lab (fresh ubuntu)",
    ok: true,
    detail: "412s",
  }]);
  assertStringIncludes(ran, "✓ releasable —");
  assertEquals(ran.includes("SKIPPED"), false);
  // --fast never ran the heavy tier at all, and says so in its own words.
  assertStringIncludes(verdictLine(true, [LAB_SKIPPED]), "run without --fast");
});

// The other gates that did not run: the whole heavy tier, when a fast gate is
// red. The report printed one line — "skipped: fix the failures above first" —
// and not one gate's name, so `✗ NOT releasable — 1 failing: fmt` read as "the
// suite, the builds and the mutation gate are fine". They had not run.
Deno.test("release check: a heavy tier that did not run names every gate in it", () => {
  const names = heavyGateNames();
  // Read off the real list, the lab included — and the perf gate is on it.
  for (const g of ["test", "check:mutations", "check:bench", "test:build"]) {
    assertEquals(names.includes(g), true, `${g} is a heavy gate`);
  }
  // The two that may skip run last, each saying so: the onboarding lab, then
  // the real X driver (the GPU lab).
  assertEquals(names.slice(-2), [
    "lab (fresh ubuntu)",
    "real X driver (GPU lab)",
  ]);

  const stopped = notRunReport("stopped", 2, names);
  assertStringIncludes(stopped, "NOT RUN: fix the 2 failure(s) above first");
  assertStringIncludes(stopped, "--keep-going");
  for (const g of names) {
    assertEquals(
      new RegExp(`^  – ${g.replace(/[()]/g, "\\$&")} +did not run$`, "m")
        .test(stopped),
      true,
      `${g} did not run and the report does not say so`,
    );
  }
  // --fast: the same list, its own reason, no advice to keep going.
  const fast = notRunReport("fast-only", 0, names);
  assertStringIncludes(fast, "NOT RUN (--fast)");
  assertEquals(fast.includes("--keep-going"), false);
  assertEquals(
    fast.split("\n").filter((l) => l.includes("did not run")).length,
    names.length,
  );
});

Deno.test("release check: a red fast gate stops the heavy tier — unless --keep-going", () => {
  const on = { fastOnly: false, keepGoing: false, failedEarly: 0 };
  assertEquals(heavyPlan(on), "run");
  // The default: cheap failures first.
  assertEquals(heavyPlan({ ...on, failedEarly: 1 }), "stopped");
  // --keep-going: one pass that reports everything.
  assertEquals(heavyPlan({ ...on, failedEarly: 1, keepGoing: true }), "run");
  // --fast is never overridden: it asked for the fast tier alone.
  assertEquals(
    heavyPlan({ fastOnly: true, keepGoing: true, failedEarly: 0 }),
    "fast-only",
  );
});

// From a field report: aio's tested Electron was a patch release behind
// upstream and nothing told the maintainer. The release check asks once and
// says so — as an advisory, never a red.
Deno.test("release check: a tested Electron behind the newest of its major is an ADVISORY line, never a failure", () => {
  const tags = { latest: "45.1.0", "44-x-y": "44.7.0", "45-x-y": "45.1.0" };
  const behind = electronAdvisory("44.5.1", tags)!;
  assertEquals([behind.ok, behind.skipped], [true, true]);
  assertStringIncludes(behind.detail, "44.5.1");
  assertStringIncludes(behind.detail, "44.7.0 is out");
  assertStringIncludes(resultLine(behind), "⚠");
  // Current — or ahead of the tag (a pre-announced bump) — is a plain tick.
  for (const tested of ["44.7.0", "44.10.0"]) {
    const r = electronAdvisory(tested, tags)!;
    assertEquals([r.ok, r.skipped, r.detail], [true, undefined, tested]);
  }
  // Numeric, not textual: 44.10.0 is newer than 44.9.9.
  assertEquals(
    electronAdvisory("44.9.9", { "44-x-y": "44.10.0" })!.skipped,
    true,
  );
  // The registry says nothing about this major, or nothing usable: no line.
  for (const t of [{}, { "44-x-y": 7 }, { "44-x-y": "44.7.0-beta.1" }]) {
    assertEquals(electronAdvisory("44.5.1", t), null);
  }
});

// An outside audit read the prebuilt Windows stub as "never rebuilt": the test
// that rebuilds it and compares the bytes is ignored without the pinned Rust
// and mingw-w64, and one ignored test among thousands says nothing. The
// release check runs that one test and names what happened. The outputs below
// are `deno test`'s own, from a machine with the toolchain and one without.
Deno.test("release check: a Windows stub that was not rebuilt here is an ADVISORY line; a rebuild that differs is red", async () => {
  const name = `${STUB_REBUILD_TEST} (rustc 1.98.0)`;
  const rebuilt = stubRebuildAdvisory(
    true,
    `${name} ... ok (24ms)\n\nok | 1 passed | 0 failed | 8 filtered out (29ms)\n`,
  );
  assertEquals([rebuilt.ok, rebuilt.skipped], [true, undefined]);
  const not = stubRebuildAdvisory(
    true,
    `${name} ... ignored (0ms)\n\nok | 0 passed | 0 failed | 1 ignored | 8 filtered out (6ms)\n`,
  );
  assertEquals([not.ok, not.skipped], [true, true]);
  assertStringIncludes(not.detail, "NOT rebuilt on this machine");
  assertStringIncludes(resultLine(not), "⚠");
  const differs = stubRebuildAdvisory(
    false,
    "FAILED | 0 passed | 1 failed | 8 filtered out (6s)\n",
  );
  assertEquals(differs.ok, false);
  assertStringIncludes(resultLine(differs), "✗");
  // The test renamed or removed: nothing ran, and that is not a pass.
  assertEquals(
    stubRebuildAdvisory(true, "ok | 0 passed | 0 failed | 9 filtered out\n")
      .ok,
    false,
  );
  // …and the name the check filters by is the test's.
  assertStringIncludes(
    await Deno.readTextFile(
      new URL("./build-windows-sfx-stub.test.ts", import.meta.url),
    ),
    `\`${STUB_REBUILD_TEST} (`,
  );
});

// The spawn itself — its file, its filter, its preload — was never run by a
// test: a renamed file or a preload that moved read as "not rebuilt here".
// With no toolchain on PATH the one test it runs is IGNORED, never filtered
// out or failed.
Deno.test("release check: the stub rebuild's own run finds its one test — shown ignored with no toolchain", async () => {
  const empty = await tempDir("aio-no-toolchain-");
  try {
    const r = await stubRebuildNow({ PATH: empty });
    assertEquals([r.ok, r.skipped], [true, true], r.detail);
  } finally {
    await dropTempDir(empty);
  }
});
