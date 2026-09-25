// One app is one colour everywhere (theme.md: "The accent hue is a hash of the
// app's appId — the same hash that draws the default icon, so an app's taskbar
// icon, its themed title bar and its buttons are one colour").
//
// They are keyed on two spellings of one identity: the theme (and the dev
// favicon) on the appId SLUG, every packaged icon (dist/icon.png, the AppImage,
// the .icns, the APK launcher) and the dev Electron window icon on the display
// TITLE. An app whose deno.json says `title: "My Notes"` runs as appId
// `my-notes` — and its buttons were pink (hue 327) under a cyan taskbar icon
// (hue 190). The hue now comes from the slug either spelling resolves to.
import { assertEquals, assertNotEquals } from "@std/assert";
import { appHue, iconColors, monogramChar } from "../src/build/app-icon.ts";
import { appThemeCss } from "../src/build/app-theme.ts";
import { resolveAppId, slugify } from "../src/server/single-instance-lock.ts";

Deno.test("app icon: a title and the appId it resolves to draw one hue", () => {
  const titles = ["My Notes", "Inventory Tracker", "Todo App", "Über Notes"];
  assertEquals(titles.length, 4);
  for (const title of titles) {
    const appId = resolveAppId(title);
    assertEquals(appId, slugify(title), "the appId a title resolves to");
    assertNotEquals(appId, title.toLowerCase(), "the two spellings differ");
    const icon = iconColors(title).hue; // what the build draws the icon with
    assertEquals(icon, appHue(appId), `${title}: icon vs appId hue`);
    // …and the theme (keyed on the appId) carries that same hue.
    assertEquals(
      appThemeCss(appId).includes(`--aio-hue:${icon};`),
      true,
      `${title}: the theme's --aio-hue is the icon's`,
    );
  }
  // The LETTER still comes from the display name — only the hue is identity.
  assertEquals(monogramChar("Über Notes"), "U");
});
