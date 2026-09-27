// The app icon is `icon.png` in dev exactly as in the build.
//
// The dev `/__aio/icon` route also took an `icon.svg` from the app dir, but
// the build reads only `icon.png` (every target's icon slot rasterizes) and
// otherwise ships the generated monogram. So an app that drew an `icon.svg`
// saw it in the dev tab while every built target, the browser tab included,
// carried the monogram: dev showing what prod never does.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { appIconPng } from "../src/build/app-icon.ts";
import { svgIconHint } from "../src/server/app-files.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MINE = `<svg xmlns="http://www.w3.org/2000/svg" id="the-apps-own-art"/>`;

Deno.test({
  name:
    "icon: an app's icon.svg is not the dev icon (the build never ships it); icon.png is",
  sanitizeOps: false, // aio-ok: a live server, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const c = cell("iconsvg", { state: { n: 0 }, methods: {} });
    const port = freePort();
    const dir = await tempDir("aio-icon-svg-");
    await Deno.writeTextFile(join(dir, "icon.svg"), MINE);
    const warned: string[] = [];
    const origWarn = console.warn;
    const origErr = console.error;
    const origLog = console.log;
    const grab = (...a: unknown[]) => void warned.push(a.join(" "));
    console.warn = grab;
    console.error = grab;
    console.log = grab;
    let app: { close(): Promise<void> } | undefined;
    try {
      app = await aio.run({
        cells: [c],
        appId: "icon-svg-app",
        client: "server-only",
        persist: false,
        libraryMode: true,
        singleton: false,
        port,
        baseDir: dir,
        // deno-lint-ignore no-explicit-any
      } as any);
      const r1 = await fetch(`http://127.0.0.1:${port}/__aio/icon`);
      const b1 = await r1.text();
      assertEquals(r1.headers.get("content-type"), "image/svg+xml");
      assert(!b1.includes("the-apps-own-art"), "served the app's icon.svg");
      assertStringIncludes(b1, "hsl("); // the generated monogram
      const said = svgIconHint(join(dir, "icon.svg"), join(dir, "icon.png"));
      assert(
        warned.some((w) => w.includes(said)),
        `no unread-icon.svg warning:\n${warned.join("\n")}`,
      );
      // The file the build reads is the file dev reads.
      const png = await appIconPng("Z", 64);
      await Deno.writeFile(join(dir, "icon.png"), png);
      const r2 = await fetch(`http://127.0.0.1:${port}/__aio/icon`);
      assertEquals(r2.headers.get("content-type"), "image/png");
      assertEquals(new Uint8Array(await r2.arrayBuffer()), png);
    } finally {
      console.warn = origWarn;
      console.error = origErr;
      console.log = origLog;
      await app?.close();
      await dropTempDir(dir);
    }
  },
});
