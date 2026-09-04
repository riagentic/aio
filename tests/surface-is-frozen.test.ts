// The compatibility freeze, as a gate rather than a paragraph.
//
// Declared 2026-09-04, effective alpha77: an app that compiles and runs against
// v1.0.0-alpha76 compiles and runs against every later alpha, every beta, and
// 1.0.0. No removals, no renames, no narrowing, no signature reshapes — not
// even ones that are provably source-compatible.
//
// A promise stated only in prose is a promise until someone is in a hurry. Two
// things have to stay true for this one to mean anything: the contract document
// must say it, and `check:api` must refuse a break outright rather than tell
// the reader how to get one approved. The second is the load-bearing half —
// the gate's message is what a person actually reads at the moment they are
// about to break something.
import { assert, assertStringIncludes } from "@std/assert";

const REPO = new URL("..", import.meta.url).pathname;

Deno.test("freeze: check:api offers no approval path for a break", async () => {
  const src = await Deno.readTextFile(`${REPO}scripts/api-snapshot.ts`);
  // The message a break prints. It used to end "Get it approved, write the
  // upgrade guide and the removals registry row, THEN `deno task update:api`"
  // — a documented procedure for doing the thing that is now never done.
  assert(
    !/[Gg]et it approved/.test(src),
    "the breaking-change message still tells the reader how to get a break " +
      "approved; there is no approval path any more",
  );
  assertStringIncludes(
    src,
    "FROZEN",
    "the breaking-change message must say the surface is frozen",
  );
  // …and it must point at what to do INSTEAD, or it is just a wall.
  assertStringIncludes(src, "ADDITIVE");
});

Deno.test("freeze: the semver policy says the budget is zero", async () => {
  const doc = await Deno.readTextFile(
    `${REPO}docs/basics/semver-policy.md`,
  );
  assertStringIncludes(doc, "frozen as of alpha77");
  // The superseded position budgeted "one or two isolated breaks" across beta.
  // It may be REFERENCED (the doc explains what it supersedes) but must not
  // stand as the live rule: the phase table is what a reader scans.
  const table = doc.slice(doc.indexOf("| Phase"), doc.indexOf("| 2.0.0+"));
  assert(
    !/very rarely|isolated break/.test(table),
    `the release-phase table still budgets breaks:\n${table}`,
  );
});

Deno.test("freeze: the upgrade index promises no later migration", async () => {
  const doc = await Deno.readTextFile(`${REPO}docs/upgrade/README.md`);
  assertStringIncludes(doc, "Nothing after alpha76 breaks");
});
