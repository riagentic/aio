// deno.json `hue` — a field report: the appId's hashed hue (a magenta) tinted
// every neutral, and there was no way to choose it; `--aio-hue` was emitted
// but nothing read it. A declared hue replaces the hash everywhere the hash
// was used — theme, icon, window/splash identity — and only an integer 0–359
// is accepted. An app that sets none keeps its hashed colour.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  appHue,
  appIconSvg,
  declaredHue,
  hueKey,
  iconColors,
} from "../src/build/app-icon.ts";
import {
  appIdentityColors,
  appThemeCss,
  appThemeTokensCss,
} from "../src/build/app-theme.ts";
import { androidLocalHTML } from "../src/server/server-html-gen.ts";
import { misplacedDenoJsonKeys } from "../src/server/config.ts";

Deno.test("hue: declaredHue accepts 0–359 integers, refuses the rest loudly", () => {
  assertEquals(declaredHue(undefined), undefined);
  assertEquals(declaredHue({ appId: "x" }), undefined);
  assertEquals(declaredHue({ hue: 0 }), 0);
  assertEquals(declaredHue({ hue: 359 }), 359);
  for (const bad of [360, -1, 12.5, "200", null, NaN]) {
    assertThrows(() => declaredHue({ hue: bad }), Error, '"hue"');
  }
});

Deno.test("hue: a declared hue replaces the hash in theme, icon and identity", () => {
  const id = "aio-launcher";
  assert(appHue(id) !== 210, "fixture: the hash must differ from the choice");
  const key = hueKey({ appId: id, hue: 210 }, id);
  assertEquals(key, 210);
  assert(appThemeCss(key).includes("--aio-hue:210;"));
  assert(appThemeTokensCss(key).includes("hsl(210 "));
  assertEquals(iconColors(key).hue, 210);
  assert(appIconSvg("L", 64, key).includes("hsl(210 "));
  assertEquals(appIdentityColors(key), appIdentityColors(210));
  // Unset: exactly the hashed colour as before.
  assertEquals(hueKey({ appId: id }, id), id);
  assertEquals(appThemeCss(hueKey({}, id)), appThemeCss(id));
});

Deno.test("hue: 0 is a hue, not 'unset' — the shell honours it", () => {
  const html = androidLocalHTML("App", false, { theme: "full", themeName: 0 });
  assert(html.includes("--aio-hue:0;"), "hue 0 fell back to the title hash");
});

Deno.test("hue: deno.json `hue` is a key aio reads, never 'misplaced'", () => {
  assertEquals(misplacedDenoJsonKeys({ hue: 200 }), []);
});
