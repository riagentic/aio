// A server API imported into a component, said in aio's words.
//
// This is the single most likely build error a new author hits: the API they
// want IS on `aio/server`, and a component is where they are writing. What the
// bundler said:
//
//     No matching export in "../../../../../../../home/dev/code/gen/aio/
//     src/server-entry.ts" for import "route"
//
// — the rule nowhere, the fix nowhere, and seven `../` in the path. The
// browser build maps `aio/server` to a browser-safe SUBSET, so the import
// RESOLVES and only the name is missing, which is why the server-only
// specifier check never sees it and the bundler's sentence is what reaches the
// author. Found by the build audit round.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { explainServerOnlyImport } from "../src/server/server-only-specs.ts";

const RESOLVED =
  "../../../../../../../home/dev/.aio/versions/v1.0.0-alpha72/src/server-entry.ts";

Deno.test("server API: the explanation names the rule, the fix and the escape hatch", () => {
  const out = explainServerOnlyImport(
    `No matching export in "${RESOLVED}" for import "route"`,
    "src/App.tsx",
    2,
  );
  assert(out, "the shape must be recognised");
  assertStringIncludes(out, "`route` is a SERVER API");
  assertStringIncludes(out, "src/App.tsx:2");
  assertStringIncludes(out, '"aio/server"');
  assertStringIncludes(out, "cell METHOD");
  assertStringIncludes(out, 'await import("aio/server")');
  assert(
    !out.includes("../../.."),
    "and it does not repeat the unreadable path",
  );
});

Deno.test("server API: the location is recovered from a THROWN aggregate", () => {
  // esbuild sometimes throws `Build failed with 1 error:\n<file>:<l>:<c>: …`
  // instead of returning structured errors, and that string is all the caller
  // has — which is exactly the path this fires on in a real build.
  const out = explainServerOnlyImport(
    `Error: Build failed with 1 error:\n` +
      `src/App.tsx:2:9: ERROR: No matching export in "${RESOLVED}" for import "route"`,
  );
  assert(out);
  assertStringIncludes(out, "src/App.tsx:2");
});

Deno.test("server API: every server-only entry is recognised, by its resolved file", () => {
  const cases: [string, string][] = [
    ["src/server-entry.ts", "aio/server"],
    ["src/db/mod.ts", "aio/db"],
    ["src/cell-test.ts", "aio/testing"],
    ["src/cli.ts", "aio/cli"],
    ["src/build.ts", "aio/build"],
    ["src/build/ship.ts", "aio/ship"],
  ];
  for (const [tail, spec] of cases) {
    const out = explainServerOnlyImport(
      `No matching export in "/x/y/${tail}" for import "thing"`,
      "src/App.tsx",
      1,
    );
    assert(out, tail);
    assertStringIncludes(out, `"${spec}"`);
  }
});

Deno.test("server API: an unrelated error keeps its own words", () => {
  for (
    const text of [
      'Expected identifier but found "/"',
      `No matching export in "/x/y/node_modules/lodash/index.js" for import "map"`,
      `No matching export in "./src/utils.ts" for import "helper"`,
      'Could not resolve "react"',
      "",
    ]
  ) {
    assertEquals(
      explainServerOnlyImport(text, "src/App.tsx", 1),
      null,
      `must not claim: ${text.slice(0, 60)}`,
    );
  }
});
