// `ui.theme: "auto"` — an app that ships its own stylesheet owns the visual
// stage. The default look used to apply regardless, and a cascade LAYER does
// not prevent that: `@layer aio` wins only where the app's CSS *disagrees*.
// Where it says nothing — `max-width` on `<main>`, `display`/`gap` on a class
// the app happens to call `.row` — aio's declaration applied unopposed and
// silently re-laid-out the page. Reported from the field after alpha61.
import { assert, assertStringIncludes } from "@std/assert";
import { appThemeCss, appThemeTokensCss } from "../src/build/app-theme.ts";
import { generateHTML } from "../src/server/server-html-gen.ts";

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
];

function html(opts: { hasCSS: boolean; theme?: "auto" | "full" | "none" }) {
  return generateHTML(
    "probe",
    /* prod */ true,
    opts.hasCSS,
    /* importMap */ "{}",
    /* showStatus */ undefined,
    /* width */ undefined,
    /* height */ undefined,
    /* renderBudget */ undefined,
    /* uiEntry */ undefined,
    /* viewport */ undefined,
    /* headExtra */ undefined,
    /* syncCells */ undefined,
    /* callTimeouts */ undefined,
    /* chrome */ undefined,
    opts.theme,
    /* themeName */ "probe",
  );
}

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

Deno.test("no app stylesheet → the full default look", () => {
  const doc = html({ hasCSS: false });
  for (const v of VISUAL) assertStringIncludes(doc, v);
});

Deno.test("app ships style.css → every visual default steps aside", () => {
  const doc = html({ hasCSS: true });
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
    // The box-model baseline is NOT the theme — it survives, as documented.
    assertStringIncludes(doc, "box-sizing:border-box");
  }
});
