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
  type Result,
  resultLine,
  verdictLine,
} from "../scripts/release-check.ts";

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
