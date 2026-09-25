// One app is one colour: the theme tints on the appId, and so does every
// packaged icon. The dev Electron window icon hashed the runtime TITLE instead
// — the "AIO App" fallback for an app that set only an appId — so every such
// app drew one shared dev icon hue, unrelated to its buttons. The hue now
// comes from the appId; the letter still comes from the title.
import { assertEquals, assertNotEquals } from "@std/assert";
import { appHue, appIconPixels, appIconPng } from "../src/build/app-icon.ts";
import { devWindowIcon } from "../src/server/aio-lifecycle.ts";
import { appThemeCss } from "../src/build/app-theme.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("dev window icon: hue is the appId's, not the title's", async () => {
  const cases: Array<[string, string]> = [
    ["AIO App", "notekeeper"], // no title → the runtime fallback title
    ["My Notes", "inventory"], // an explicit appId that differs from the title
  ];
  assertEquals(cases.length, 2);
  for (const [title, appId] of cases) {
    assertNotEquals(appHue(title), appHue(appId), "the two keys must differ");
    // The pixels really differ by key (first 40 rows: gradient, no glyph).
    const band = 4 * 256 * 40;
    assertNotEquals(
      appIconPixels(title, 256, appId).slice(0, band),
      appIconPixels(title, 256).slice(0, band),
    );
    const png = Uint8Array.from(
      atob(await devWindowIcon(title, appId)),
      (c) => c.charCodeAt(0),
    );
    assertEquals(png, await appIconPng(title, 256, appId), `${title}/${appId}`);
    assertEquals(
      appThemeCss(appId).includes(`--aio-hue:${appHue(appId)};`),
      true,
    );
  }
});

Deno.test("packaged default icon: hue is the appId's, not the title's", async () => {
  const { writeDefaultIcon } = await import("../src/build/build-helpers.ts");
  const { icnsFromName } = await import("../src/build/macos-app.ts");
  const dir = await tempDir("aio-icon-hue-");
  try {
    await writeDefaultIcon(`${dir}/app`, "My Notes", "inventory");
    const png = await Deno.readFile(`${dir}/app.png`);
    assertEquals(png, await appIconPng("My Notes", 512, "inventory"));
    assertNotEquals(png, await appIconPng("My Notes", 512));
    assertNotEquals(
      await icnsFromName("My Notes", "inventory"),
      await icnsFromName("My Notes"),
    );
  } finally {
    await dropTempDir(dir);
  }
});
