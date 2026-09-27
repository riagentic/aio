// Bug hunt r3 (build): the generated monogram is ONE identity — "`name` draws
// the LETTER; `id` keys the HUE — pass the appId, the key the theme tints on"
// (app-icon.ts appIconSvg doc), and CLAUDE.md: "All three take the accent/hue
// from the same hash of the appId, so one app is one colour everywhere".
// dist/icon.png, the .icns, the Android launcher icon and the dev window icon
// all pass (title, appId). Two packaging paths do not.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { appIconPng, iconColors } from "../src/build/app-icon.ts";
import { writeWindowsIcon } from "../src/build/build-helpers.ts";
import { buildIos } from "../src/build/build-ios.ts";
import { resolveBuildVersion } from "../src/build/build-version.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const TITLE = "Wallet Pro";
const APP_ID = "wallet";

function firstIcoImage(ico: Uint8Array): Uint8Array {
  const v = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  const len = v.getUint32(6 + 8, true);
  const off = v.getUint32(6 + 12, true);
  return ico.subarray(off, off + len);
}

Deno.test("precondition — title and appId hash to different hues", () => {
  assertNotEquals(iconColors(TITLE).hue, iconColors(APP_ID).hue);
});

Deno.test("Windows exe .ico monogram is tinted by the appId like every other icon", async () => {
  const root = await tempDir("aio-icon-");
  try {
    // Exactly what build-compile.ts passes for a Windows desktop exe
    // (`name: cfg.appTitle ?? binaryName`) — there is no way to pass the id.
    const out = await writeWindowsIcon(join(root, "app.ico"), {
      root,
      appDir: root,
      name: TITLE,
      id: APP_ID, // what build-compile passes: the appId colours the exe
      warn: () => {},
    });
    const png256 = firstIcoImage(await Deno.readFile(out));
    // What dist/icon.png / the .icns / the window icon draw for this app.
    const expected = await appIconPng(TITLE, 256, APP_ID);
    assertEquals(
      png256.length === expected.length &&
        png256.every((b, i) => b === expected[i]),
      true,
      "the exe's file icon is a different colour from the app's window/taskbar icon",
    );
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("iOS generated icon draws the TITLE's letter, tinted by the appId", async () => {
  const root = await tempDir("aio-icon-");
  try {
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ title: "Zebra Notes", version: "0.3" }),
    );
    const version = resolveBuildVersion("0.3", {
      repo: true,
      count: 1,
      commit: "abcdef0",
      hash: null,
    });
    const cfg = {
      root,
      version,
      binaryName: "my-notes",
      appTitle: "Zebra Notes",
      appDir: root,
      doRemote: true,
      bakedServer: null,
    } as unknown as Parameters<typeof buildIos>[0];
    await buildIos(cfg);
    const png = await Deno.readFile(
      join(
        root,
        "my-notes-ios-client/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png",
      ),
    );
    // Every other target: letter from the display title ("Z"), hue from appId.
    const expected = await appIconPng("Zebra Notes", 1024, "my-notes");
    assert(
      png.length === expected.length && png.every((b, i) => b === expected[i]),
      "iOS icon differs from the monogram every other target draws " +
        "(it draws binaryName's letter 'M' instead of the title's 'Z')",
    );
  } finally {
    await dropTempDir(root);
  }
});
