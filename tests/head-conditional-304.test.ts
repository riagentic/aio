// HEAD vs GET parity on static files.
//
// RFC 9110 §9.3.2: a server SHOULD send the same header fields for HEAD as for
// GET. RFC 9110 §13.1.2: when If-None-Match matches on a GET **or HEAD**, the
// server responds 304. `encodeResponse` (src/server/http-encoding.ts) returns
// every HEAD untouched BEFORE its conditional-request block, and that block
// only considers GET (`conditional = method === "GET"`) — its own comment
// cites §13.1.2 for "non-GET/HEAD" methods. The blob route answers a matching
// HEAD with 304 (it checks If-None-Match itself), the static path does not.
//
// Results: a HEAD with a matching validator gets a 200, and a HEAD for a
// buffered text asset carries no ETag at all while the GET does — so a client
// that probes with HEAD (link checkers, caches, `curl -I`) cannot learn or
// use the validator.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function withStatic(
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const port = freePort();
  const dir = await tempDir("r8-head");
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  await Deno.writeFile(
    join(dir, "logo.png"),
    new Uint8Array(1000).map((_, i) => i % 256),
  );
  await Deno.writeTextFile(
    join(dir, "site.css"),
    "body{color:red}\n".repeat(200),
  );
  const server = createServer({
    port,
    title: "T",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 200; i++) {
      try {
        const r = await fetch(url + "/logo.png");
        await r.body?.cancel();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    await fn(url);
  } finally {
    await server.shutdown();
    await dropTempDir(dir);
  }
}

Deno.test("HEAD with a matching If-None-Match is a 304, like GET", async () => {
  await withStatic(async (url) => {
    const g = await fetch(url + "/logo.png");
    await g.body?.cancel();
    const tag = g.headers.get("etag")!;
    const cg = await fetch(url + "/logo.png", {
      headers: { "if-none-match": tag },
    });
    await cg.body?.cancel();
    assertEquals(cg.status, 304, "GET revalidates");
    const ch = await fetch(url + "/logo.png", {
      method: "HEAD",
      headers: { "if-none-match": tag },
    });
    await ch.body?.cancel();
    assertEquals(ch.status, 304, "HEAD must revalidate the same way");
  });
});

// A buffered, compressible text asset: the GET's ETag is hashed from the body
// by `encodeResponse`, and a HEAD used to skip that — no ETag, no Vary, never
// a 304.
Deno.test("HEAD on a compressible text file carries GET's validators and revalidates", async () => {
  await withStatic(async (url) => {
    const g = await fetch(url + "/site.css");
    await g.body?.cancel();
    const tag = g.headers.get("etag");
    const h = await fetch(url + "/site.css", { method: "HEAD" });
    await h.body?.cancel();
    assertEquals(h.status, 200);
    assertEquals(h.headers.get("etag"), tag, "HEAD ETag == GET ETag");
    assertEquals(h.headers.get("vary"), g.headers.get("vary"));
    assertEquals(
      h.headers.get("content-encoding"),
      g.headers.get("content-encoding"),
    );
    assertEquals(
      h.headers.get("content-length"),
      g.headers.get("content-length"),
    );
    const ch = await fetch(url + "/site.css", {
      method: "HEAD",
      headers: { "if-none-match": tag! },
    });
    await ch.body?.cancel();
    assertEquals(ch.status, 304, "HEAD must revalidate like GET");
    assertEquals(ch.headers.get("etag"), tag);
  });
});
