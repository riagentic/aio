// Static text was served as `text/plain` / `text/css` / `text/html` with no
// charset, though the server decodes it as UTF-8: a browser defaulting to
// windows-1252 garbled non-ASCII in a .txt/.md/.css file. Binary types keep
// their exact Content-Type.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createStaticHandler } from "../src/server/server-static.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("static text is served with charset=utf-8; binary types unchanged", async () => {
  const base = await tempDir("aio-charset-");
  try {
    await Deno.writeTextFile(join(base, "note.txt"), "héllo — 漢");
    await Deno.writeTextFile(join(base, "readme.md"), "# ü");
    await Deno.writeFile(
      join(base, "pic.png"),
      new Uint8Array([137, 80, 78, 71]),
    );
    const { serveStatic } = createStaticHandler({
      prod: true,
      debug: () => {},
      title: "T",
      absBaseDir: base,
      absDistDir: null,
      hasCSS: false,
      importMap: "{}",
      noCache: {},
      getGraphResult: () => null,
      getVitalsExtra: () => ({
        payloadStats: new Map(),
        clientBackpressure: {},
      }),
      getTrojanDeps: () => ({}),
      // deno-lint-ignore no-explicit-any
    } as any);
    const got: Record<string, string | null> = {};
    for (const p of ["/note.txt", "/readme.md", "/pic.png"]) {
      const r = await serveStatic(p);
      await r.body?.cancel();
      got[p] = r.headers.get("content-type");
    }
    assertEquals(got, {
      "/note.txt": "text/plain; charset=utf-8",
      "/readme.md": "text/plain; charset=utf-8",
      "/pic.png": "image/png",
    });
  } finally {
    await dropTempDir(base);
  }
});
