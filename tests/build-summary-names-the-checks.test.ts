// The build summary has to say what was CHECKED, not only what was produced.
//
// A field report (quant §3) asked for the module-graph checker's output in the
// default build summary. It already runs — per target, refusing the artifact on
// a server-only leak, a module-scope Node global, or a bundle whose top level
// throws — so an artifact on the list is already proof it passed. But that
// proof was only legible to someone who read the whole build. A summary that
// lists files and never names the checks reads as "it compiled", which is the
// reading the audit exists to correct.
//
// The claim has to stay TRUE, which is the interesting part: the line is only
// honest while an artifact really cannot reach disk unaudited. So the refusal
// is asserted too.
import { assert, assertStringIncludes } from "@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../src/build-all.ts", import.meta.url),
);
const BUNDLE = await Deno.readTextFile(
  new URL("../src/build/build-bundle.ts", import.meta.url),
);

Deno.test("the summary names the client-graph checks", () => {
  assertStringIncludes(SRC, "client graph:");
  assertStringIncludes(SRC, "audited + evaluated");
});

Deno.test("it counts ARTIFACTS, not attempts", () => {
  // A failed or skipped target produced nothing to audit, and counting it
  // would make the line a lie in exactly the case someone is reading it to
  // find out what went wrong.
  // `deno fmt` wraps the declaration, so the STATEMENT is what to read, not
  // the line — a test that greps one physical line goes red on a reflow and
  // teaches the next person that this gate means nothing.
  const at = SRC.indexOf("const audited =");
  assert(at > 0, "the counter moved");
  const line = SRC.slice(at, SRC.indexOf(";", at));
  for (const guard of ["r.ok", "!r.skipped", "r.artifacts.length"]) {
    assertStringIncludes(line, guard);
  }
});

Deno.test("the claim is true: an artifact cannot reach disk unaudited", () => {
  // The line says "nothing above reached disk without passing". That is only
  // honest while the bundler still refuses on a bad verdict — so the refusal
  // is what makes the summary line legal, and it is asserted here rather than
  // trusted.
  assertStringIncludes(BUNDLE, "const verdict = await judgeClientBundle(");
  const after = BUNDLE.slice(
    BUNDLE.indexOf("const verdict = await judgeClientBundle("),
  );
  const guard = after.slice(0, after.indexOf("for (const note"));
  assertStringIncludes(guard, "if (!verdict.ok)");
  assertStringIncludes(
    guard,
    "refuseBundle",
    "a failing verdict must REFUSE the artifact — if it only warned, the " +
      "summary line would be false and this test is the one that should catch it",
  );
});
