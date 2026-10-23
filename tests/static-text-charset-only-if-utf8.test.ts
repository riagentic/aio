// `charset=utf-8` is a claim about bytes the server serves verbatim: it is
// made only when they ARE UTF-8. A Latin-1 `.txt` labelled UTF-8 showed
// U+FFFD in the browser, and the header overrode an `.html` file's own
// `<meta charset>`. A multi-byte character cut by the probe's edge is still
// UTF-8; a bad byte past the probe is not looked for (bounded check).
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createStaticHandler } from "../src/server/server-static.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("static: charset=utf-8 only on text whose bytes are UTF-8", async () => {
  const base = await tempDir("aio-charset-probe-");
  try {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n"
    await Deno.writeFile(join(base, "latin1.txt"), latin1);
    await Deno.writeFile(join(base, "latin1.html"), latin1);
    await Deno.writeTextFile(join(base, "utf8.css"), "a::after{content:'é'}");
    // "é" (2 bytes) straddles the 64 KiB probe edge.
    const cut = new Uint8Array(70 * 1024).fill(0x61);
    cut.set([0xc3, 0xa9], 64 * 1024 - 1);
    await Deno.writeFile(join(base, "cut.txt"), cut);
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
    for (const p of ["/latin1.txt", "/latin1.html", "/utf8.css", "/cut.txt"]) {
      const r = await serveStatic(p);
      const bytes = new Uint8Array(await r.arrayBuffer());
      got[p] = r.headers.get("content-type");
      if (p.startsWith("/latin1")) assertEquals(bytes, latin1, p);
      if (p === "/cut.txt") assertEquals(bytes, cut, p);
    }
    assertEquals(got, {
      "/latin1.txt": "text/plain",
      "/latin1.html": "text/html",
      "/utf8.css": "text/css; charset=utf-8",
      "/cut.txt": "text/plain; charset=utf-8",
    });
  } finally {
    await dropTempDir(base);
  }
});
