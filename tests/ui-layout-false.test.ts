// `ui.layout: false` — style my ELEMENTS, do not place my boxes.
//
// _"I want my own layout; I do not want to restyle `<input>`, `<textarea>`,
// `<button>` and focus rings from scratch."_ (report 5 §4). Between `"tokens"`
// (nothing paints, so every control is the browser's) and `"auto"`/`"full"`
// (a whole page shell) there was nothing, and the choice was ~200 lines of
// control CSS or fighting a layout you did not ask for.
//
// A SEPARATE knob and not a fifth `theme` value — partly because "how much
// look" and "does it place my boxes" are different questions that compose, and
// partly because `UiTheme` is frozen public surface and `check:api` refused
// the widening. The additive shape turned out to be the better design.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  appThemeBaseCss,
  appThemeCss,
  appThemeTokensCss,
} from "../src/build/app-theme.ts";
import { _themeBootNote } from "../src/server/aio.ts";
import { generateHTML } from "../src/server/server-html-gen.ts";

/** The rules that DECIDE WHERE THINGS GO. Dropped by `layout: false`. */
const LAYOUT_RULES = [
  ":where(main){",
  ":where(body>header,body>footer,#root>header,#root>footer){",
  ":where(.card){",
  ":where(.stack)",
  ":where(.row)",
  ":where(.grid)",
  ":where(.muted)",
];

/** The rules that make an ELEMENT look right. Kept. */
const ELEMENT_RULES = [
  "color-scheme",
  "::selection",
  ":focus-visible",
  ":where(input,textarea",
  ":where(table",
  "pointer:coarse",
];

Deno.test("base keeps every ELEMENT default and drops every LAYOUT one", () => {
  const full = appThemeCss("probe");
  const base = appThemeBaseCss("probe");
  for (const rule of LAYOUT_RULES) {
    assert(full.includes(rule), `precondition: the full sheet has ${rule}`);
    assert(!base.includes(rule), `layout rule survived into base: ${rule}`);
  }
  for (const rule of ELEMENT_RULES) {
    assert(base.includes(rule), `element rule was lost from base: ${rule}`);
  }
  // It is a SLICE of the one stylesheet, not a second stylesheet — so the two
  // can never drift into two palettes.
  assert(base.length < full.length);
  assert(base.length > appThemeTokensCss("probe").length * 2);
});

Deno.test("the cut leaves valid CSS, not a half-open block", () => {
  // Cutting between banners is only safe if a banner never lands inside a
  // rule. Unbalanced braces would make everything after the cut parse as part
  // of the last selector — a stylesheet that is worse than none.
  const base = appThemeBaseCss("probe");
  assertEquals(
    (base.match(/{/g) ?? []).length,
    (base.match(/}/g) ?? []).length,
    "braces must balance after both regions are removed",
  );
  assert(base.trimStart().startsWith("@layer aio"), "still one layer block");
});

Deno.test("a missing banner REFUSES instead of guessing", () => {
  // Same discipline as `sliceTokens`. Falling back to the whole sheet would
  // silently hand every `layout: false` app the page shell it declined;
  // returning less would drop rules nobody asked to lose. Both are invisible.
  // This is a build-time invariant of a file in this repo, so it throws.
  //
  // Driven through the real function by checking that the banners it depends
  // on are actually present and unique — a test that edited the source to
  // prove the throw would be testing its own edit.
  const full = appThemeCss("probe");
  for (
    const banner of [
      "/* ── page shell ",
      "/* ── type ",
      "/* ── the six classes worth having ",
      "/* ── the three environments ",
    ]
  ) {
    assertEquals(
      full.split(banner).length - 1,
      1,
      `${banner} must appear exactly once — the cut is index-based`,
    );
  }
});

Deno.test("the SHELL emits the sliced sheet when ui.layout is false", () => {
  // The half that actually reaches a browser. A pure slicer that nothing wires
  // up is the shape this repo keeps finding.
  const opts = {
    title: "probe",
    hasCSS: false,
    prod: false,
    importMap: "{}",
    theme: "full" as const,
    themeName: "probe",
  };
  const withLayout = generateHTML(opts);
  const without = generateHTML({ ...opts, layout: false });
  assert(withLayout.includes(":where(main){"), "precondition");
  assert(
    !without.includes(":where(main){"),
    "the page container reached the browser despite ui.layout: false",
  );
  assertStringIncludes(without, "::selection", "…and the controls did arrive");
});

Deno.test("ui.layout is ignored by the themes that paint nothing — and says so", () => {
  // A setting with no effect is worse than a missing one: the author believes
  // it is doing something.
  const tokensOnly = generateHTML({
    title: "probe",
    hasCSS: false,
    prod: false,
    importMap: "{}",
    theme: "tokens",
    themeName: "probe",
    layout: false,
  });
  assert(!tokensOnly.includes(":where(main){"));
  assert(!tokensOnly.includes("::selection"), "tokens paints nothing, still");

  const warn = _themeBootNote("tokens", false, false);
  assertEquals(warn?.level, "warn");
  assertStringIncludes(warn!.message, "no effect");
  assertStringIncludes(warn!.message, '"full"', "it names the fix");

  // …and on a theme that DOES paint, it is an ordinary info line.
  const info = _themeBootNote("full", true, false);
  assertEquals(info?.level, "info");
  assertStringIncludes(info!.message, "NO layout");
  // The pre-existing lines are untouched when `layout` is not set.
  assertEquals(_themeBootNote("tokens", false), null);
  assertEquals(_themeBootNote("full", true)?.level, "warn");
});
