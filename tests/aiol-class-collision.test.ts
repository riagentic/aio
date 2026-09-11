// A class name claimed twice, with the two claims disagreeing.
//
// _"The worst UI bug of one build"_: a `class="track"` defined in two
// stylesheets, one of them clipping every music row to a single line. No error,
// a correct DOM, a correct component tree, and a cascade doing exactly what a
// cascade does — the later rule won, and nothing said two people had claimed
// the same name. Three reports asked for scoped styles; this is the half that
// costs nothing and catches that exact bug.
//
// The rule has to be NARROW or it is noise people silence, and the true
// positives go with it. Most of this file is the things it must NOT report.
import { assert, assertEquals } from "@std/assert";
import { collidingClasses, topLevelClassRules } from "../aiol/checks.ts";

const hits = (files: Array<[string, string]>) =>
  collidingClasses(files.flatMap(([n, css]) => topLevelClassRules(n, css)));

Deno.test("the reported bug: the same class, two files, one clipping the other", () => {
  const found = hits([
    ["a.css", ".track {\n  display: flex;\n  overflow: visible;\n}"],
    ["b.css", ".track {\n  overflow: hidden;\n  height: 1.2rem;\n}"],
  ]);
  assertEquals(found.length, 1, JSON.stringify(found));
  assertEquals(found[0]!.class, "track");
  assertEquals(found[0]!.prop, "overflow");
  // BOTH sites, because "which two?" is the entire question at that point.
  assertEquals(found[0]!.a.file, "a.css");
  assertEquals(found[0]!.b.file, "b.css");
});

Deno.test("agreement is not a collision", () => {
  assertEquals(
    hits([
      ["a.css", ".btn { color: red; }"],
      ["b.css", ".btn { color: red; }"],
    ]).length,
    0,
  );
});

Deno.test("complementary rules are how CSS is meant to be written", () => {
  // A base rule here and a spacing rule there share a name and no property.
  assertEquals(
    hits([
      ["a.css", ".btn { color: red; }"],
      ["b.css", ".btn { margin-top: 4px; }"],
    ]).length,
    0,
  );
});

Deno.test("a MORE SPECIFIC selector is a different rule on purpose", () => {
  for (
    const sel of [
      ".track:hover",
      ".list .track",
      ".track.big",
      ".track > span",
      "div.track",
      ".track::after",
    ]
  ) {
    assertEquals(
      hits([
        ["a.css", ".track { overflow: visible; }"],
        ["b.css", `${sel} { overflow: hidden; }`],
      ]).length,
      0,
      `${sel} is deliberately distinct and must not be compared`,
    );
  }
});

Deno.test("inside @media the same class with a different value is the POINT", () => {
  assertEquals(
    hits([
      ["a.css", ".col { width: 50%; }"],
      ["b.css", "@media (max-width: 600px) {\n  .col { width: 100%; }\n}"],
    ]).length,
    0,
  );
  // …and nesting does not make the reader lose its place afterwards.
  const after = hits([
    ["a.css", ".col { width: 50%; }"],
    [
      "b.css",
      "@media (max-width: 600px) {\n  .col { width: 100%; }\n}\n" +
      ".col { width: 25%; }",
    ],
  ]);
  assertEquals(after.length, 1, "the TOP-LEVEL rule after the block is seen");
  assertEquals(after[0]!.prop, "width");
});

Deno.test("custom properties are a namespace, not a layout instruction", () => {
  // Redefining `--accent` on a class is how theming works.
  assertEquals(
    hits([
      ["a.css", ".t { --accent: red; }"],
      ["b.css", ".t { --accent: blue; }"],
    ]).length,
    0,
  );
});

Deno.test("a comment containing a brace does not blind the reader", () => {
  // A `{` inside a comment used to throw the brace depth off for the rest of
  // the file — and a depth that is wrong is a rule that silently stops looking,
  // which is the worst failure a linter has.
  const found = hits([
    [
      "a.css",
      "/* a rule looks like .x { y: z } */\n.track { overflow: visible; }",
    ],
    ["b.css", ".track { overflow: hidden; }"],
  ]);
  assertEquals(found.length, 1, "the rule after the comment is still read");
});

Deno.test("`.a, .b { … }` claims BOTH names with one body", () => {
  const found = hits([
    ["a.css", ".row, .track { gap: 8px; }"],
    ["b.css", ".track { gap: 0; }"],
  ]);
  assertEquals(found.length, 1);
  assertEquals(found[0]!.class, "track");
});

Deno.test("an @import before the first rule does not eat it", () => {
  // A blockless at-rule ends at `;`, not at a `}` — get that wrong and the
  // first real selector is swallowed into the at-rule's text.
  const rules = topLevelClassRules(
    "a.css",
    '@import "reset.css";\n.track { overflow: visible; }',
  );
  assertEquals(rules.length, 1);
  assertEquals(rules[0]!.class, "track");
});

Deno.test("line numbers point at the rule, not at the file", () => {
  const rules = topLevelClassRules(
    "a.css",
    "\n\n.first { a: 1; }\n\n\n.second { b: 2; }\n",
  );
  assertEquals(rules.map((r) => [r.class, r.line]), [
    ["first", 3],
    ["second", 6],
  ]);
});

Deno.test("two collisions in one pair report once, on the FIRST disagreement", () => {
  // A pair that disagrees about five things is one problem, not five lines.
  const found = hits([
    ["a.css", ".t { color: red; width: 1px; height: 2px; }"],
    ["b.css", ".t { color: blue; width: 9px; height: 8px; }"],
  ]);
  assertEquals(found.length, 1);
  assert(["color", "width", "height"].includes(found[0]!.prop));
});
