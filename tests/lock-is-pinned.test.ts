// The exact-pin invariant, at both ends: the request written in source, and
// the request recorded in deno.lock.
//
// 17 test files imported `jsr:@std/assert` bare while 862 used the pinned
// `@std/assert` mapping. Two spellings of one dependency — one bounded, one
// floating at `@*`. They happened to resolve to the same 1.0.19, which is
// exactly why it survived: nothing behaved differently until the day upstream
// published, and then it would have been a suite that changed without a commit.
//
// These pin the PREDICATE, because the gate's whole value is the line between
// "bounded" and "anything", and both of its first two implementations drew that
// line in the wrong place — one flagged every string that mentions a specifier,
// the next flagged a regex literal that matches import statements.
import { assert, assertEquals } from "@std/assert";
import {
  isUnpinned,
  unpinnedImports,
  unpinnedSpecifiers,
} from "../scripts/check-lock.ts";

Deno.test("lock: a bounded range is pinned enough, an open one is not", () => {
  for (const s of ["jsr:@std/assert@*", "npm:foo@latest", "npm:esbuild"]) {
    assert(isUnpinned(s), `${s} should be unpinned`);
  }
  for (
    const s of [
      "jsr:@std/assert@1",
      "jsr:@std/assert@^1.0.17",
      "jsr:@std/assert@1.0.19",
      "npm:esbuild@^0.24",
      "jsr:@std/fs@1/walk",
      "jsr:@riagentic/aio@1.0.0-alpha74",
    ]
  ) {
    assert(!isUnpinned(s), `${s} should be pinned`);
  }
});

// The fixtures are BUILT, never written out — a literal `from "jsr:@std/assert"`
// in this file is a real bare import as far as any scanner is concerned, and
// `check:lock` scans tests/ too. The first version of this file made the gate
// fail on the gate's own tests, which is its point demonstrated at my expense.
const imp = (spec: string) => `import { x } from ${JSON.stringify(spec)};`;
const dynImp = (spec: string) =>
  `const m = await import(${JSON.stringify(spec)});`;
const reExport = (spec: string) => `export { y } from ${JSON.stringify(spec)};`;

Deno.test("lock: only real import positions count", () => {
  assertEquals(unpinnedImports(imp("jsr:@std/assert")), ["jsr:@std/assert"]);
  assertEquals(unpinnedImports(dynImp("npm:electron")), ["npm:electron"]);
  assertEquals(unpinnedImports(reExport("npm:lodash")), ["npm:lodash"]);
  // …and a version makes it fine.
  assertEquals(unpinnedImports(imp("jsr:@std/assert@1")), []);
  assertEquals(unpinnedImports(imp("npm:esbuild@^0.24")), []);
});

Deno.test("lock: this repo's own deno.lock has no open-ended request", async () => {
  const lock = JSON.parse(
    await Deno.readTextFile(new URL("../deno.lock", import.meta.url)),
  );
  assertEquals(
    unpinnedSpecifiers(lock),
    [],
    "an unpinned lock entry makes the same commit build differently on different days",
  );
});

// The whole-tree sweep is `deno task check:lock`, which runs in CI and in
// release-check.ts — repeating it here would be a second decider for the same
// question, and the two would drift.
