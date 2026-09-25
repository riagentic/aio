// "Dark OS, light page": under ui.theme "tokens"/"none" (and "auto" with the
// app's own style.css) the --aio-* tokens go dark on a dark OS while nothing
// paints the page, so kit text lands light-on-white (measured 1.15:1). The
// dev chunk warns once. These pin the decision on the computed values a real
// Chromium reports for each case, and the dev-only / once-only contract.
import { assert, assertEquals } from "@std/assert";
import {
  _resetDarkOsLightPage,
  checkDarkOsLightPage,
  DARK_OS_LIGHT_PAGE_WARNING,
  isDarkOsLightPage,
} from "../src/air/dark-os-light-page.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";

const DARK_INK = "hsl(220 10% 94%)"; // --aio-text, dark variant
const LIGHT_INK = "hsl(220 14% 12%)"; // --aio-text, light variant
const NONE = "rgba(0, 0, 0, 0)";

Deno.test("dark OS + dark tokens + unpainted page (tokens default) warns", () => {
  assert(isDarkOsLightPage({
    prefersDark: true,
    ink: DARK_INK,
    backgrounds: [NONE, NONE],
    colorScheme: "normal",
  }));
  // "none": the kit's own fallback ink
  assert(isDarkOsLightPage({
    prefersDark: true,
    ink: "#e7eaf1",
    backgrounds: ["", ""],
    colorScheme: "",
  }));
  // an app that painted its page light by hand
  assert(isDarkOsLightPage({
    prefersDark: true,
    ink: DARK_INK,
    backgrounds: ["rgb(255, 255, 255)", NONE],
    colorScheme: "normal",
  }));
});

Deno.test("dark OS: an app that painted its own dark page stays silent", () => {
  for (const bgs of [["rgb(17, 17, 17)", NONE], [NONE, "rgb(17, 17, 17)"]]) {
    assertEquals(
      isDarkOsLightPage({
        prefersDark: true,
        ink: DARK_INK,
        backgrounds: bgs,
        colorScheme: "normal",
      }),
      false,
    );
  }
});

Deno.test("dark OS: color-scheme dark / light dark canvas stays silent", () => {
  for (const cs of ["dark", "light dark"]) {
    assertEquals(
      isDarkOsLightPage({
        prefersDark: true,
        ink: DARK_INK,
        backgrounds: [NONE, NONE],
        colorScheme: cs,
      }),
      false,
    );
  }
});

Deno.test("dark OS: silent when the OS is light, the tokens are light, or unreadable", () => {
  const base = {
    prefersDark: true,
    ink: DARK_INK,
    backgrounds: [NONE, NONE],
    colorScheme: "normal",
  };
  assertEquals(isDarkOsLightPage({ ...base, prefersDark: false }), false);
  assertEquals(isDarkOsLightPage({ ...base, ink: LIGHT_INK }), false);
  assertEquals(isDarkOsLightPage({ ...base, ink: "" }), false); // no aio CSS
  assertEquals(
    isDarkOsLightPage({ ...base, backgrounds: ["oklch(0.2 0 0)", NONE] }),
    false,
  );
});

Deno.test("dark OS light page: warns once, dev only, naming the three fixes", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    document: g.document,
    matchMedia: g.matchMedia,
    getComputedStyle: g.getComputedStyle,
  };
  const html = {}, body = {};
  const styles = new Map<object, Record<string, string>>([
    [html, {
      "--aio-text": DARK_INK,
      "background-color": NONE,
      "color-scheme": "normal",
    }],
    [body, { "background-color": NONE }],
  ]);
  g.document = { documentElement: html, body };
  g.matchMedia = () => ({ matches: true });
  g.getComputedStyle = (e: object) => ({
    getPropertyValue: (p: string) => styles.get(e)?.[p] ?? "",
  });
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => warns.push(m);
  try {
    _resetDarkOsLightPage();
    setDevModeOverride(false);
    assertEquals(checkDarkOsLightPage(), false);
    assertEquals(warns.length, 0);
    setDevModeOverride(true);
    assert(checkDarkOsLightPage());
    assertEquals(checkDarkOsLightPage(), false); // once
    assertEquals(warns, [DARK_OS_LIGHT_PAGE_WARNING]);
    for (
      const fix of ['ui.theme: "auto"', "color-scheme: light dark", "[aio]"]
    ) assert(warns[0]!.includes(fix), fix);
  } finally {
    console.warn = warn;
    setDevModeOverride(null);
    _resetDarkOsLightPage();
    Object.assign(g, saved);
  }
});
