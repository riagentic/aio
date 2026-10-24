// deno.json `"neutral": "soft"` — the rest of a field report's ask: a warm or
// magenta hue tinted every neutral at up to 40% saturation, and on large dark
// surfaces it showed (purple-brown cards). Soft keeps every neutral at most
// 4% saturated, everywhere `hue` reaches; the accent keeps the hue.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  appHue,
  declaredNeutral,
  declaredThemeHue,
  hueKey,
} from "../src/build/app-icon.ts";
import { appIdentityColors, appThemeCss } from "../src/build/app-theme.ts";
import { DENO_JSON_READ_KEYS } from "../src/server/config.ts";

/** The saturation of every NEUTRAL token (light and dark) in `css`. */
const sats = (css: string, hue: number) =>
  [
    ...css.matchAll(
      new RegExp(
        `--aio-(?:bg|surface|surface-2|text|muted|border):hsl\\(${hue} ([\\d.]+)% `,
        "g",
      ),
    ),
  ].map((m) => Number(m[1]));

Deno.test('neutral: "soft" or "tinted" (the default); anything else refused', () => {
  assertEquals(declaredNeutral(undefined), undefined);
  assertEquals(declaredNeutral({ neutral: "tinted" }), undefined);
  assertEquals(declaredNeutral({ neutral: "soft" }), "soft");
  for (const bad of ["grey", true, 1, null]) {
    assertThrows(() => declaredNeutral({ neutral: bad }), Error, '"neutral"');
  }
  assert(
    DENO_JSON_READ_KEYS.has("neutral"),
    "a key aio reads, not a misplaced one",
  );
});

Deno.test("neutral: soft caps every neutral at 4% — the theme and the identity colours; the accent is untouched", () => {
  const id = "aio-launcher"; // hashes to magenta
  const hue = appHue(id);
  const soft = hueKey({ neutral: "soft" }, id);
  assertEquals(appHue(soft), hue, "the same hue");
  const tinted = sats(appThemeCss(id), hue);
  assert(Math.max(...tinted) >= 30, `fixture: today's tint ${tinted}`);
  const capped = sats(appThemeCss(soft), hue);
  assertEquals(capped.length, tinted.length);
  assert(Math.max(...capped) <= 4, `soft neutrals: ${capped}`);
  // The accent line is not a neutral.
  const accent = (css: string) => css.match(/--aio-accent:([^;]+);/)?.[1];
  assertEquals(accent(appThemeCss(soft)), accent(appThemeCss(id)));
  // Window background / splash: the same table, the same cap.
  const a = appIdentityColors(id), b = appIdentityColors(soft);
  assert(a.dark.background !== b.dark.background);
  assertEquals(a.dark.accent, b.dark.accent);
});

Deno.test("neutral: declaredThemeHue — undefined when deno.json sets neither, the soft key over hue or appId", () => {
  assertEquals(declaredThemeHue({}, "x"), undefined);
  assertEquals(declaredThemeHue({ hue: 210 }, "x"), 210);
  assertEquals(declaredThemeHue({ neutral: "soft" }, "x"), {
    key: "x",
    neutral: "soft",
  });
  assertEquals(declaredThemeHue({ hue: 210, neutral: "soft" }, "x"), {
    key: 210,
    neutral: "soft",
  });
});
