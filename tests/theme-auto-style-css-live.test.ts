// Bug hunt r10 (ui): `ui.theme: "auto"` never steps aside for a style.css
// that appears while the dev server is running.
//
// docs/ui/theme.md: `"auto"` is "the full default look" with no style.css and
// "inert --aio-* variables only" once the app has one; `am theme adopt` WRITES
// a style.css and then tells the developer `"auto"` "steps aside for an app
// with a stylesheet". But the server decides `hasCSS` ONCE, at boot
// (src/server/server.ts `const hasCSS = …appHasStylesheet(…)`), and every
// shell it serves afterwards is generated from that frozen boolean. In dev a
// style.css created after boot is served at /style.css (200) yet the page
// never links it and keeps painting the full default look — until a manual
// restart nothing says is needed. (The favicon already re-resolves per
// request in dev for exactly this reason — see handleIcon in
// server-static.ts.)
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test('ui.theme "auto" (dev): a style.css created after boot is linked and the full look steps aside', async () => {
  const dir = await tempDir("aio-autocss-");
  try {
    await using srv = await testServer({
      baseDir: dir,
      cells: [cell("r10_autocss", { state: {}, methods: {} })],
      ui: { theme: "auto" },
    });
    const before = await (await srv.fetch("/")).text();
    // Sanity: with no stylesheet, "auto" is the full look and links nothing.
    assertEquals(before.includes("── canvas"), true, "full look before");
    assertEquals(before.includes('href="/style.css"'), false);

    // The developer adds a stylesheet (or runs `am theme adopt`, which does).
    await Deno.writeTextFile(`${dir}/style.css`, "body{color:red}\n");
    const css = await srv.fetch("/style.css");
    assertEquals(css.status, 200, "the server does serve the new file");
    await css.body?.cancel();

    const after = await (await srv.fetch("/")).text();
    assertEquals(
      after.includes('href="/style.css"'),
      true,
      "the shell must link the app's style.css once it exists",
    );
    assertEquals(
      after.includes("── canvas"),
      false,
      '"auto" must step aside (tokens only) once the app ships a style.css',
    );
  } finally {
    await dropTempDir(dir);
  }
});
