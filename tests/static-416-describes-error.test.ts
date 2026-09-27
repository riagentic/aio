// RFC 9110 §15.5.17: a 416 for a static file described the FILE ("image/png"
// and its ETag) over the plain-text error body. It now describes the error:
// text/plain, with the Content-Range naming the size.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createStaticHandler } from "../src/server/server-static.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

function handler(base: string) {
  return createStaticHandler({
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
}

Deno.test("static: a 416 describes its error body, not the file", async () => {
  const base = await tempDir("aio-range-");
  try {
    await Deno.writeFile(join(base, "pic.png"), new Uint8Array(100));
    const { serveStatic } = handler(base);

    const bad = await serveStatic(
      "/pic.png",
      new Request("http://x/pic.png", { headers: { range: "bytes=500-600" } }),
    );
    await bad.body?.cancel();
    assertEquals(bad.status, 416);
    assertEquals(bad.headers.get("content-range"), "bytes */100");
    assertEquals(bad.headers.get("content-type"), "text/plain; charset=utf-8");
    assertEquals(bad.headers.get("etag"), null);

    // GET with a satisfiable range still gets its 206.
    const part = await serveStatic(
      "/pic.png",
      new Request("http://x/pic.png", { headers: { range: "bytes=0-9" } }),
    );
    await part.body?.cancel();
    assertEquals(part.status, 206);
  } finally {
    await dropTempDir(base);
  }
});
