// The compressed-body memo in http-encoding.ts is keyed by the HANDLER's ETag
// when one is present. A handler tag is only unique per URL (and the static
// path's weak `W/"<mtime>-<size>"` is not even that across files), so two
// DIFFERENT bodies carrying the same tag share one cache entry: the second
// response ships the first one's compressed bytes.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  _clearEncodedCache,
  encodeResponse,
} from "../src/server/http-encoding.ts";
import {
  createStaticHandler,
  type StaticDeps,
} from "../src/server/server-static.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function decode(r: Response): Promise<Uint8Array> {
  const enc = r.headers.get("content-encoding");
  if (!enc) return new Uint8Array(await r.arrayBuffer());
  const ds = new DecompressionStream(enc as "gzip" | "deflate");
  return new Uint8Array(
    await new Response(r.body!.pipeThrough(ds)).arrayBuffer(),
  );
}

Deno.test("encoding: two routes with the same handler ETag get their OWN bodies", async () => {
  _clearEncodedCache();
  const a = JSON.stringify({ route: "a", data: "A".repeat(2000) });
  const b = JSON.stringify({ route: "b", data: "B".repeat(2000) });
  const mk = (body: string) =>
    new Response(body, {
      headers: { "content-type": "application/json", etag: 'W/"1"' },
    });
  const req = (p: string) =>
    new Request(`http://x${p}`, { headers: { "accept-encoding": "gzip" } });
  const ra = await encodeResponse(req("/api/a"), mk(a));
  const rb = await encodeResponse(req("/api/b"), mk(b));
  assertEquals(
    new TextDecoder().decode(await decode(ra)).slice(0, 14),
    a.slice(0, 14),
  );
  assertEquals(
    new TextDecoder().decode(await decode(rb)).slice(0, 14),
    b.slice(0, 14),
  );
});

Deno.test("encoding: one handler ETag alternating between two bodies never serves the other's bytes", async () => {
  // The memo is keyed by the tag and verified against the source bytes (no
  // per-request hash): a -> b -> a must re-check, not replay b's entry.
  _clearEncodedCache();
  const a = JSON.stringify({ route: "a", data: "A".repeat(2000) });
  const b = JSON.stringify({ route: "b", data: "B".repeat(2000) });
  const get = async (body: string) =>
    new TextDecoder().decode(
      await decode(
        await encodeResponse(
          new Request("http://x/v", { headers: { "accept-encoding": "gzip" } }),
          new Response(body, {
            headers: { "content-type": "application/json", etag: '"v1"' },
          }),
        ),
      ),
    );
  assertEquals(await get(a), a);
  assertEquals(await get(a), a, "a memo hit is a's own bytes");
  assertEquals(await get(b), b);
  assertEquals(await get(a), a);
});

Deno.test("static (prod): two same-size .wasm files with one mtime are served their own bytes", async () => {
  _clearEncodedCache();
  const base = await tempDir("aio-hunt-etag-");
  try {
    const one = new Uint8Array(4000).fill(0x41);
    const two = new Uint8Array(4000).fill(0x42);
    await Deno.writeFile(join(base, "one.wasm"), one);
    await Deno.writeFile(join(base, "two.wasm"), two);
    // One mtime for both — what a Nix store, a tarball extraction or an npm
    // package (every file 1985-10-26) hands the server.
    const t = new Date(1_000_000_000_000);
    await Deno.utime(join(base, "one.wasm"), t, t);
    await Deno.utime(join(base, "two.wasm"), t, t);
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
    const get = async (p: string) => {
      const req = new Request(`http://x${p}`, {
        headers: { "accept-encoding": "gzip" },
      });
      return await encodeResponse(req, await serveStatic(p, req));
    };
    const r1 = await get("/one.wasm");
    assertEquals((await decode(r1))[0], 0x41);
    const r2 = await get("/two.wasm");
    assertEquals(
      (await decode(r2))[0],
      0x42,
      "two.wasm must not be served one.wasm's bytes",
    );
  } finally {
    await dropTempDir(base);
  }
});
