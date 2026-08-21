// `ui.theme` — aio's default look is OPT-IN, and the opt-in still steps aside.
//
// Two rules, one file:
//   1. An app that never mentions `theme` gets NOTHING that paints. A shell
//      cannot see every way an app brings CSS (a `style.css`, a `<style>` in
//      `ui.head`, a sheet the component renders, a CSS-in-JS runtime), and a
//      cascade layer does not make an unasked-for rule safe: `@layer aio` wins
//      only where the app DISAGREES, so wherever it said nothing — `max-width`
//      on `<main>`, `display`/`gap` on a class it happens to call `.row` — the
//      default applied unopposed and re-laid-out the page. Reported from the
//      field against alpha61/alpha62.
//   2. `"auto"` — the opt-in a new app is scaffolded with — still leaves the
//      moment the app ships its own `style.css`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { appThemeCss, appThemeTokensCss } from "../src/build/app-theme.ts";
import { generateHTML } from "../src/server/server-html-gen.ts";
import { _themeBootNote } from "../src/server/aio.ts";
import { appHasStylesheet } from "../src/server/app-files.ts";
import type { UiTheme } from "../src/server/aio-types.ts";

/** Every declaration in the default look that can MOVE or PAINT a box — the
 *  half an app's own stylesheet must not have to fight. */
const VISUAL = [
  ":where(main)", // max-width + margin-inline + padding: the page shell
  ":where(body>header", // header/footer padding
  ".card",
  ".row",
  ".stack",
  ".grid", // class names every app already uses
  "background:var(--aio-bg)", // body paint
  "font-family:var(--aio-font)", // body type
  // NOT a custom property, and not inert: on a dark-mode machine it repaints
  // the UA canvas, the default text colour, form controls and scrollbars. It
  // shipped inside the "inert" half through alpha63, which turned an app that
  // never asked for a theme into a dark-mode app — with its own light panels
  // still painting white text on white (measured in Chromium).
  // The DECLARATION, not the `@media (prefers-color-scheme)` condition the
  // inert half legitimately carries.
  "color-scheme: light dark",
];

function html(opts: { hasCSS: boolean; theme?: UiTheme }) {
  return generateHTML({
    title: "probe",
    prod: true,
    hasCSS: opts.hasCSS,
    importMap: "{}",
    theme: opts.theme,
    themeName: "probe",
  });
}

Deno.test("theme tokens are INERT — EVERY declaration is a custom property", () => {
  // The general form of the rule, so the next non-inert declaration fails here
  // rather than in someone's dark-mode screenshot: a `--x: …` renders nothing
  // by itself; anything else can paint. (A `@media (prefers-color-scheme)`
  // CONDITION is not a declaration and is deliberately allowed.)
  const inert = appThemeTokensCss("probe");
  const declarations = inert.split("\n").map((l) => l.trim())
    .filter((l) => /^[a-zA-Z-]+\s*:/.test(l));
  const paints = declarations.filter((l) => !l.startsWith("--"));
  assertEquals(
    paints,
    [],
    "the tokens half must hold nothing but --aio-* custom properties",
  );
  assert(declarations.length > 20, "…and it must still carry the palette");
});

Deno.test("theme tokens are INERT — variables only, nothing that paints", () => {
  const tokens = appThemeTokensCss("probe");
  for (const v of VISUAL) {
    assert(!tokens.includes(v), `tokens must not carry a visual rule: ${v}`);
  }
  // …but the palette IS there, so `chrome: "themed"` (which reads
  // `var(--aio-…, fallback)`) stays coherent and an app can opt into a token.
  assertStringIncludes(tokens, "--aio-accent:");
  assertStringIncludes(tokens, "--aio-surface:");
  assertStringIncludes(tokens, "--aio-page:");
  // Balanced: the slice must close `@layer aio {`, or every rule after it in
  // the document is swallowed by an unterminated block.
  const opens = (tokens.match(/\{/g) ?? []).length;
  const closes = (tokens.match(/\}/g) ?? []).length;
  assert(opens === closes, `unbalanced braces: ${opens} vs ${closes}`);
  // And the full sheet still HAS the visual half — this test must fail if the
  // slice ever silently becomes the whole thing.
  const full = appThemeCss("probe");
  for (const v of VISUAL) assertStringIncludes(full, v);
});

Deno.test("theme unset → nothing that paints, with or without app CSS", () => {
  for (const hasCSS of [true, false]) {
    const doc = html({ hasCSS });
    for (const v of VISUAL) {
      assert(
        !doc.includes(v),
        `unasked-for default emitted (hasCSS=${hasCSS}): ${v}`,
      );
    }
    // The inert palette is still there — `chrome: "themed"` reads it, and an
    // app may reference a token deliberately.
    assertStringIncludes(doc, "--aio-accent:");
    // And the two-rule baseline, which predates the theme and is not it.
    assertStringIncludes(doc, "box-sizing:border-box");
  }
});

Deno.test('"tokens" is the default, spelled out', () => {
  assertEquals(
    html({ hasCSS: false, theme: "tokens" }),
    html({ hasCSS: false }),
  );
  assertEquals(html({ hasCSS: true, theme: "tokens" }), html({ hasCSS: true }));
});

Deno.test('ui.theme: "auto" + no stylesheet → the full default look', () => {
  const doc = html({ hasCSS: false, theme: "auto" });
  for (const v of VISUAL) assertStringIncludes(doc, v);
});

Deno.test('ui.theme: "auto" + style.css → every visual default steps aside', () => {
  const doc = html({ hasCSS: true, theme: "auto" });
  for (const v of VISUAL) {
    assert(
      !doc.includes(v),
      `the app owns the stage; aio still emitted: ${v}`,
    );
  }
  // The inert palette remains, and so does the app's own sheet.
  assertStringIncludes(doc, "--aio-accent:");
  assertStringIncludes(doc, '<link rel="stylesheet" href="/style.css">');
});

Deno.test('ui.theme: "full" keeps the look alongside the app CSS', () => {
  const doc = html({ hasCSS: true, theme: "full" });
  for (const v of VISUAL) assertStringIncludes(doc, v);
  assertStringIncludes(doc, '<link rel="stylesheet" href="/style.css">');
});

Deno.test('ui.theme: "none" emits neither half, with or without app CSS', () => {
  for (const hasCSS of [true, false]) {
    const doc = html({ hasCSS, theme: "none" });
    for (const v of VISUAL) assert(!doc.includes(v), `${v} with none`);
    assert(!doc.includes("--aio-accent:"), "none must not emit tokens either");
    // …and not the baseline. This test used to assert the opposite, pinning a
    // `"none"` that documented "nothing at all" and shipped two rules anyway.
    // The word is the off switch or it is nothing.
    assert(!doc.includes("box-sizing:border-box"), "not even the baseline");
  }
});

// ── the boot line the upgrade guides promise ─────────────────────────────
//
// "Boot says so, once, when that combination is in effect" is documented in
// docs/upgrade/from-alpha61-to-alpha62.md, and nothing asserted it. It was also
// WRONG in every compiled binary: the stylesheet probe behind it read only
// `baseDir`, which in a compiled app is `<cwd>/src` — usually absent — while
// the stylesheet ships in the embedded `dist/`. So an app whose shell correctly
// stepped aside was told "the default look is in effect (no style.css)".
Deno.test("boot: what the framework says about ui.theme", () => {
  // Silence for an app that never opted in — nothing to explain.
  assertEquals(_themeBootNote(undefined, false), null);
  assertEquals(_themeBootNote("tokens", false), null);
  assertEquals(_themeBootNote("none", true), null);

  // "auto" + no stylesheet: the look IS applied — say which rules arrived.
  const auto = _themeBootNote("auto", false);
  assert(auto && auto.level === "info");
  assertStringIncludes(auto!.message, 'ui.theme "auto"');
  assertStringIncludes(auto!.message, "style.css");

  // "auto" + a stylesheet: the app owns the stage, nothing to report.
  assertEquals(_themeBootNote("auto", true), null);

  // "full" + a stylesheet: the one case worth a warning.
  const full = _themeBootNote("full", true);
  assert(full && full.level === "warn");
  assertStringIncludes(full!.message, "ALONGSIDE");
  assertStringIncludes(full!.message, "am theme adopt");

  // "full" without one is just the look — info, not a warning.
  assertEquals(_themeBootNote("full", false)?.level, "info");
});

// The probe behind that line and the probe behind the SHELL must be the same
// function — the two-deciders bug is what made the line lie.
Deno.test("boot: the stylesheet probe is THE decider (both dirs)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-style-probe-" });
  const app = `${dir}/app`, dist = `${dir}/dist`;
  await Deno.mkdir(app);
  await Deno.mkdir(dist);
  try {
    assertEquals(appHasStylesheet(app, dist), false);
    // A compiled binary: nothing at baseDir, the stylesheet in the embedded dist.
    await Deno.writeTextFile(`${dist}/style.css`, "body{}");
    assertEquals(
      appHasStylesheet(app, dist),
      true,
      "dist/ counts — compiled apps have only that",
    );
    assertEquals(appHasStylesheet(app, null), false);
    await Deno.writeTextFile(`${app}/style.css`, "body{}");
    assertEquals(appHasStylesheet(app, null), true);
    assertEquals(appHasStylesheet(null, null), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// `theme: "none"` has to mean NONE.
//
// It documented "nothing at all, not even the variables" and still shipped the
// two-rule box-model baseline — so the one word that looked like "aio, hands
// off my CSS" quietly was not. `*{box-sizing:border-box}` is a real layout
// change to a stylesheet written against content-box, which is exactly the
// stylesheet someone porting an app arrives with.
Deno.test('theme "none": no aio CSS reaches the page at all', () => {
  const page = html({ hasCSS: false, theme: "none" });
  const styles = [...page.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1]!).join("");
  assertEquals(styles, "", `no aio <style> content at all:\n${styles}`);
  assert(!page.includes("box-sizing"), "not even the baseline");
  assert(!page.includes("--aio-"), "and not the variables");
});

// …while every other setting still carries the baseline, which is what keeps a
// new app out of the browser's 8px white frame.
Deno.test('theme: the baseline ships for every setting except "none"', () => {
  for (const theme of [undefined, "tokens", "auto", "full"] as const) {
    const page = html({ hasCSS: false, ...(theme ? { theme } : {}) });
    assert(
      page.includes("*,*::before,*::after{box-sizing:border-box}") &&
        page.includes("body{margin:0}"),
      `theme=${String(theme)} must keep the two-rule baseline`,
    );
  }
});
