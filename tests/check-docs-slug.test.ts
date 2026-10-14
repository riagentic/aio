// Two rules of the docs gate that were weaker than what they check.
//
// Anchors: the gate dropped every `<…>` from a heading before making its
// anchor. GitHub drops an HTML TAG, and keeps the text of a code span — so
// for ``### `<Switch>` — an on/off toggle`` the gate accepted a link that is
// dead on GitHub and refused the one that works.
//
// Build keys: docs/build/targets.md says "a key that is not in this table …
// does nothing", beside a hand-written table; the code's list is
// `VALID_BUILD_KEYS`. Two keys once shipped working and absent from one list.
import { assertEquals } from "@std/assert";
import {
  BUILD_KEYS_PAGE,
  buildKeyTableIssues,
  headingSlugs,
  slugOf,
} from "../scripts/check-docs.ts";

Deno.test("check:docs — a heading's anchor is GitHub's: code-span text kept, HTML tags dropped", () => {
  for (
    const [heading, slug] of [
      ["`<Switch>` — an on/off toggle", "switch--an-onoff-toggle"],
      ["Per-page `<head>` — useHead()", "per-page-head--usehead"],
      [
        "Drop-in login UI (`<SignIn/>` + `useUser()`)",
        "drop-in-login-ui-signin--useuser",
      ],
      [
        "`<Breadcrumb>`, `<Skeleton>`, `<EmptyState>`",
        "breadcrumb-skeleton-emptystate",
      ],
      ["`useLocal<T>(initial)`", "uselocaltinitial"],
      ["A private copy: `--instance=<name>`", "a-private-copy---instancename"],
      // A real tag is markup: its text stays, the tag goes.
      ["Press <kbd>K</kbd> twice", "press-k-twice"],
      ["Line<br>break", "linebreak"],
      // Unchanged: no brackets at all.
      ["Plain `code_x` and a-b", "plain-code_x-and-a-b"],
      ["What's new? (2.0)", "whats-new-20"],
    ] as const
  ) assertEquals(slugOf(heading), slug, heading);
  // …and a repeated heading is numbered, as before.
  assertEquals(
    [...headingSlugs(["## `<Tabs>`", "text", "## `<Tabs>`", "### `<Tabs>`"])],
    ["tabs", "tabs-1", "tabs-2"],
  );
});

Deno.test("check:docs — the `build` key table and VALID_BUILD_KEYS are one list", () => {
  const page = [
    "## Targets",
    "### Every `build` key",
    "",
    "| Key       | Value | Default | What it decides |",
    "| --------- | ----- | ------- | --------------- |",
    "| `targets` | list  | —       | what is built   |",
    "| `out`     | dir   | `dist`  | where           |",
    "",
    "### The next section",
    "| `notAKey` | this table is another section's |",
  ].join("\n");
  assertEquals(buildKeyTableIssues(page, new Set(["targets", "out"])), []);
  // A key the build reads, undocumented.
  assertEquals(buildKeyTableIssues(page, new Set(["targets", "out", "css"])), [
    `  ${BUILD_KEYS_PAGE}:2  the build reads \`build.css\` and the table has no row for it`,
  ]);
  // A row the build would warn about.
  assertEquals(buildKeyTableIssues(page, new Set(["targets"])), [
    `  ${BUILD_KEYS_PAGE}:7  the table documents \`out\`, which the build does not read (VALID_BUILD_KEYS, src/server/config.ts)`,
  ]);
  // The table gone is not "nothing to compare".
  assertEquals(buildKeyTableIssues("# Targets\n", new Set(["out"])).length, 1);
});
