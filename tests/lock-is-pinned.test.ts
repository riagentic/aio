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

// The lock also records WHICH config asked for what (`workspace`), and deno
// rewrites that on every run from the config it finds. `package.json` is not
// tracked (.gitignore), so a lock that names one describes a tree no checkout
// has: the first `am` or build run from a fresh checkout rewrote deno.lock,
// and the install stopped being the commit it was cloned at. The committed
// lock is the one a checkout KEEPS — what deno.json declares, nothing else.
Deno.test("lock: the committed lock is the one a fresh checkout keeps — it records deno.json and no untracked config", async () => {
  const read = async (name: string) =>
    JSON.parse(
      await Deno.readTextFile(new URL(`../${name}`, import.meta.url)),
    );
  const declared = Object.values(
    (await read("deno.json")).imports as Record<string, string>,
  ).filter((spec) => /^(jsr|npm):/.test(spec)).sort();
  assertEquals(
    (await read("deno.lock")).workspace,
    { dependencies: declared },
    "deno.lock's `workspace` is not what deno writes for a checkout of this " +
      "commit. A `packageJson` block comes from a root package.json, which " +
      "git does not track: remove that file and let any deno run rewrite the " +
      "lock (or run once with DENO_NO_PACKAGE_JSON=1), then commit it.",
  );
});

// The whole-tree sweep is `deno task check:lock`, which runs in CI and in
// release-check.ts — repeating it here would be a second decider for the same
// question, and the two would drift.

Deno.test("unpinnedImports: a specifier the code talks ABOUT is not an import", () => {
  // Comments, strings, templates and regex literals — every non-code home a
  // specifier can have. The scanner reads offsets through codeMask now; the
  // old line-stripper only knew about comments.
  const src = [
    `// import { x } from "npm:left-pad";`,
    `/* import("jsr:@std/assert") */`,
    `const s = "from 'npm:react'";`,
    'const t = `import "npm:esbuild"`;',
    `const re = /from "npm:[^"]+"/;`,
    `const doc = "see import('npm:chalk') in the guide";`,
  ].join("\n");
  assertEquals(unpinnedImports(src), []);
});

Deno.test("unpinnedImports: a real import beside a comment on the same line still counts", () => {
  const src = `import { x } from "npm:left-pad"; // pinned? no`;
  assertEquals(unpinnedImports(src), ["npm:left-pad"]);
});
