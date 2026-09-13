// A static text file over the 8 MB buffer ceiling revalidates to a 304.
//
// `encodeResponse` answered If-None-Match in two places — the incompressible
// early return, and after buffering a compressible body — and a compressible
// body too large to buffer took neither: it was streamed through gzip with the
// static handler's ETag still on it. Measured: a 10 MB `.json` served with
// `W/"<mtime>-<size>"`, and a conditional GET with exactly that tag came back
// `200`, gzip, the whole file again — on every page load. A validator the
// server never honours is worse than none: the client pays for both.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  createStaticHandler,
  type StaticDeps,
} from "../src/server/server-static.ts";
import {
  encodeResponse,
  MAX_BUFFER_BYTES,
} from "../src/server/http-encoding.ts";

const BIG = "[" + "1,".repeat(Math.ceil(MAX_BUFFER_BYTES / 2) + 1000) + "1]";

Deno.test("static (prod): a >8 MB text file's ETag yields a 304", async () => {
  const base = await Deno.makeTempDir({ prefix: "aio-bigtext-" });
  try {
    await Deno.writeTextFile(join(base, "big.json"), BIG);
    // PROD: dev static responses are `no-store`, which is never revalidated
    // by design. `noCache` is exactly what server.ts hands prod.
    const { serveStatic } = createStaticHandler({
      prod: true,
      debug: () => {},
      title: "T",
      absBaseDir: base,
      absDistDir: null,
      hasCSS: false,
      importMap: "{}",
      noCache: { "Cache-Control": "no-cache" },
      getGraphResult: () => null,
      getVitalsExtra: () => ({
        payloadStats: new Map(),
        clientBackpressure: {},
      }),
      getTrojanDeps: () => ({}),
    } as StaticDeps);
    // What server.ts does with every response: the handler, then the finisher.
    const get = async (headers: Record<string, string>) => {
      const req = new Request("http://x/big.json", { headers });
      return await encodeResponse(req, await serveStatic("/big.json", req));
    };
    const full = await get({ "accept-encoding": "gzip" });
    assertEquals(full.status, 200);
    const etag = full.headers.get("etag");
    await full.body?.cancel();
    assert(etag, "the large file carries a validator");

    const again = await get({
      "if-none-match": etag,
      "accept-encoding": "gzip",
    });
    assertEquals(again.status, 304, "the tag the server sent is honoured");
    assertEquals(again.body, null);
    assertEquals(again.headers.get("etag"), etag);

    // A different tag is a miss: the whole file, compressed.
    const miss = await get({
      "if-none-match": '"other"',
      "accept-encoding": "gzip",
    });
    assertEquals(miss.status, 200);
    assertEquals(miss.headers.get("content-encoding"), "gzip");
    await miss.body?.cancel();
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("encoding: a handler tag on an unbufferable compressible body is honoured, with or without Content-Length", async () => {
  const tag = 'W/"big-1"';
  const mk = (declare: boolean, extra: Record<string, string> = {}) =>
    new Response(BIG, {
      headers: {
        "content-type": "application/json",
        etag: tag,
        ...(declare ? { "content-length": String(BIG.length) } : {}),
        ...extra,
      },
    });
  const cond = () =>
    new Request("http://x/big.json", {
      headers: { "if-none-match": tag, "accept-encoding": "gzip" },
    });
  for (const declare of [true, false]) {
    const r = await encodeResponse(cond(), mk(declare));
    assertEquals(r.status, 304, `content-length declared: ${declare}`);
    assertEquals(r.headers.get("content-encoding"), null);
    assertEquals(r.headers.get("content-length"), null);
    assert(
      (r.headers.get("vary") ?? "").includes("Accept-Encoding"),
      "the 304 names the same Vary the 200 does",
    );
  }
  // `no-store` is never revalidated, at any size.
  const ns = await encodeResponse(
    cond(),
    mk(true, { "cache-control": "no-store" }),
  );
  assertEquals(ns.status, 200);
  await ns.body?.cancel();
  // …and a POST is never a cache hit (tests/http-conditional-get-only.test.ts).
  const post = await encodeResponse(
    new Request("http://x/big.json", {
      method: "POST",
      body: "{}",
      headers: { "if-none-match": tag },
    }),
    mk(true),
  );
  assertEquals(post.status, 200);
  await post.body?.cancel();
});
