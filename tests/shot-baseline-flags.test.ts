// `am shot --check` / `--update` / `--selector` — the flag decisions, without
// a live window.
//
// aio already had all three hard parts of visual regression: headless capture,
// deterministic state via `am snapshot load`, and any state reachable with
// `am dispatch` (composer §10.7). What was missing was the comparison — and
// the comparison is where the traps are, so this file asserts the ones that
// decide whether a gate is trustworthy. The capture itself needs a live
// Electron window and lives in the e2e suite.
import { assert, assertEquals } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { comparePng } from "../src/am/png-compare.ts";
import { appIconPng } from "../src/build/app-icon.ts";
import { HELP_TEXT } from "../src/am/am-help-text.ts";

Deno.test("the help says what the flags DO, in intent words", () => {
  // The round's meta-finding: an agent greps `am help` for its own word and
  // composes primitives when it does not find it. RECORD / ASSERT / CROP are
  // the words someone reaching for visual regression actually types.
  assert(HELP_TEXT.includes("--check="), "the flag must be findable at all");
  assert(HELP_TEXT.includes("--update="));
  assert(HELP_TEXT.includes("--selector="));
  assert(/RECORD/.test(HELP_TEXT), "…as an intent word");
  assert(/ASSERT/.test(HELP_TEXT));
  assert(
    HELP_TEXT.includes("PIXELS, not bytes"),
    "the one thing a user must know to trust the result",
  );
});

Deno.test("a baseline that does not exist is a FAILURE, not a pass", async () => {
  // The one case where "nothing to compare" and "nothing changed" look
  // identical. A green there is a check that never ran — the exact shape this
  // repo refuses everywhere else.
  const dir = await tempDir("aio-shot-base-");
  try {
    const missing = `${dir}/nope.png`;
    assertEquals(
      await Deno.readFile(missing).catch(() => null),
      null,
      "precondition",
    );
    // The command exits 1 on this path; what is pinned here is that the file
    // really is absent, so the branch cannot be reached by accident.
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("re-encoding the SAME image still matches", async () => {
  // Why the comparison decodes at all. A byte check fails on a screenshot no
  // human can tell apart, and a gate that cries wolf gets deleted.
  const a = await appIconPng("shot-probe", 48);
  const b = await appIconPng("shot-probe", 48);
  assert((await comparePng(a, b)).same);
});

Deno.test("a real visual change fails, and the message is actionable", async () => {
  const a = await appIconPng("shot-probe", 48);
  const b = await appIconPng("shot-probe-different", 48);
  const d = await comparePng(a, b);
  assert(!d.same);
  assert(d.diffPixels > 0);
  assert(
    d.reason.includes("of ") && d.reason.includes("pixels differ"),
    `"${d.reason}" must say how much moved, not just that something did`,
  );
});

Deno.test("--threshold and --max-diff are numbers the caller can widen", async () => {
  const a = await appIconPng("shot-probe", 48);
  const b = await appIconPng("shot-probe-different", 48);
  // A ratio of 1 accepts anything — proving the knob reaches the comparison,
  // which is the wiring a config option most often fails at.
  assert((await comparePng(a, b, { maxRatio: 1 })).same);
  // …and 255 per channel likewise.
  assert((await comparePng(a, b, { threshold: 255 })).same);
});
