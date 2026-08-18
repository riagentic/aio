// The default stylesheet — see src/build/app-theme.ts.
//
// A default that ships to every app has exactly two ways to be wrong: it can
// be UNREADABLE (a colour that fails contrast somewhere on the hue wheel), or
// it can FIGHT the app that wants to replace it. Both are asserted here as
// properties, across the whole wheel, rather than eyeballed on one app.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { appThemeCss } from "../src/build/app-theme.ts";
import { appHue } from "../src/build/app-icon.ts";
import { generateHTML } from "../src/server/server-html-gen.ts";

/** Relative luminance of an `hsl(H S% L%)` string. */
function lum(css: string): number {
  const m = /hsl\((\d+(?:\.\d+)?) ([\d.]+)% ([\d.]+)%\)/.exec(css);
  if (!m) throw new Error(`not an hsl colour: ${css}`);
  const [h, s, l] = [+m[1]!, +m[2]! / 100, +m[3]! / 100];
  const a = s * Math.min(l, 1 - l);
  const ch = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(8) + 0.0722 * ch(4);
}
const ratio = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Read a custom property out of a generated theme. `block` picks the light
 *  (`:root{…}`) or dark (`@media …{:root{…}}`) declaration. */
function token(css: string, name: string, block: "light" | "dark"): string {
  const at = css.indexOf("@media (prefers-color-scheme: dark)");
  const scope = block === "light" ? css.slice(0, at) : css.slice(at);
  const m = new RegExp(`${name}:([^;]+);`).exec(scope);
  return m ? m[1]!.trim() : token(css, name, "light");
}

Deno.test("theme: the accent is the app's own, and stable", () => {
  assertEquals(appHue("notekeeper"), appHue("notekeeper"));
  const hues = new Set(
    ["notekeeper", "atomic", "quant", "t2v", "ledger"].map(appHue),
  );
  assertEquals(hues.size, 5, "distinct apps get distinct colours");
});

Deno.test("theme: a fill carries its own label at AA, on every hue", () => {
  for (let hue = 0; hue < 360; hue += 5) {
    const css = appThemeCss(`hue-probe-${hue}`);
    for (const block of ["light", "dark"] as const) {
      const fill = token(css, "--aio-accent", block);
      const ink = token(css, "--aio-on-accent", block);
      const inkLum = ink === "#fff" ? 1 : lum(ink);
      const r = ratio(lum(fill), inkLum);
      assert(
        r >= 4.5,
        `${block}: ${fill} on ${ink} is ${r.toFixed(2)}:1 — below AA`,
      );
    }
  }
});

Deno.test("theme: accent TEXT is readable on the page, on every hue", () => {
  // The failure this rules out: one accent token used for both a button fill
  // and link text. A vivid lime button is correct; vivid lime link text on a
  // near-white page is not, and it is the standard way an accessible-looking
  // palette ships unreadable links.
  for (let hue = 0; hue < 360; hue += 5) {
    const css = appThemeCss(`ink-probe-${hue}`);
    for (const block of ["light", "dark"] as const) {
      const r = ratio(
        lum(token(css, "--aio-accent-ink", block)),
        lum(token(css, "--aio-bg", block)),
      );
      assert(
        r >= 4.5,
        `${block}: accent text is ${r.toFixed(2)}:1 on the page — below AA`,
      );
    }
  }
});

Deno.test("theme: body text is readable on the page, both schemes", () => {
  const css = appThemeCss("contrast");
  for (const block of ["light", "dark"] as const) {
    const r = ratio(
      lum(token(css, "--aio-text", block)),
      lum(token(css, "--aio-bg", block)),
    );
    assert(r >= 7, `${block}: body text is only ${r.toFixed(2)}:1`);
  }
});

Deno.test("theme: every rule is layered, so the app's CSS always wins", () => {
  // This is the whole licence to ship a default at all. An unlayered rule —
  // i.e. ANY rule in the app's own style.css — beats every layered rule
  // regardless of specificity, so `button { background: red }` works with no
  // !important, no ordering trick, and no knowledge that this file exists.
  const css = appThemeCss("layered");
  assert(css.startsWith("@layer aio {"), "the theme opens one aio layer");
  assertEquals(
    css.split("@layer").length - 1,
    1,
    "exactly one layer — a second could out-rank the first",
  );
});

Deno.test("theme: the shell emits it by default and drops it on request", () => {
  const shell = (theme?: "auto" | "none") =>
    generateHTML(
      "Demo",
      true,
      false,
      "",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      theme,
      "demo-app",
    );
  assertStringIncludes(shell(undefined), "@layer aio");
  assertStringIncludes(shell("auto"), "@layer aio");
  assertEquals(shell("none").includes("@layer aio"), false);
  // The box-model baseline is NOT the theme and survives opting out.
  assertStringIncludes(shell("none"), "box-sizing:border-box");
});

Deno.test("theme: the accent follows identity, not the window title", () => {
  // A title that changes with the route must not recolour the app mid-session.
  const a = appThemeCss("demo-app");
  const b = appThemeCss("demo-app");
  assertEquals(a, b);
  assert(
    appThemeCss("demo-app") !== appThemeCss("Demo"),
    "different identities are different themes",
  );
});
