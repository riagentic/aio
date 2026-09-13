// Static files and `assets` mounts answer byte ranges, from disk.
//
// `docs/build/imports.md` promises `assets` mounts "range requests"; the static
// path ignored `Range:` and `Deno.readFile`d every binary whole on every
// request. A video element seeks with ranges, so a 300 MB mp4 cost 300 MB of
// heap per request — measured, four `Range: bytes=0-1023` requests took RSS to
// ~2.6 GB to send 4 KB. The blob route already streamed with ranges; this pins
// the same contract (206 / 416 / Content-Range / Accept-Ranges) on files.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

async function fixture() {
  const base = await Deno.makeTempDir({ prefix: "aio-range-base-" });
  const media = await Deno.makeTempDir({ prefix: "aio-range-media-" });
  const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
  await Deno.writeFile(join(media, "clip.mp4"), bytes);
  await Deno.writeFile(join(base, "pic.png"), bytes);
  return { base, media, bytes };
}

Deno.test("static: Range on an assets mount and on baseDir → 206 / 416, the right bytes", async () => {
  const f = await fixture();
  try {
    await using srv = await testServer({
      cells: [cell("range_c", { state: { n: 0 }, methods: {} })],
      baseDir: f.base,
      assets: { "/media": f.media },
    });
    for (const path of ["/media/clip.mp4", "/pic.png"]) {
      const full = await srv.fetch(path);
      assertEquals(full.status, 200);
      assertEquals(full.headers.get("accept-ranges"), "bytes");
      assertEquals(new Uint8Array(await full.arrayBuffer()), f.bytes);
      const etag = full.headers.get("etag")!;
      assert(etag, "a validator");

      const cases: Array<[string, number, number]> = [
        ["bytes=0-1023", 0, 1024],
        ["bytes=99990-", 99990, 100_000],
        ["bytes=-10", 99990, 100_000],
        ["bytes=5000-5000", 5000, 5001],
        ["bytes=90000-999999", 90000, 100_000],
      ];
      for (const [range, start, end] of cases) {
        const r = await srv.fetch(path, { headers: { range } });
        assertEquals(r.status, 206, `${path} ${range}`);
        assertEquals(
          r.headers.get("content-range"),
          `bytes ${start}-${end - 1}/100000`,
        );
        assertEquals(r.headers.get("content-length"), String(end - start));
        assertEquals(
          new Uint8Array(await r.arrayBuffer()),
          f.bytes.slice(start, end),
          `${path} ${range}: the bytes of that window`,
        );
      }

      const past = await srv.fetch(path, {
        headers: { range: "bytes=100000-" },
      });
      await past.body?.cancel();
      assertEquals(past.status, 416);
      assertEquals(past.headers.get("content-range"), "bytes */100000");

      // Malformed / multi-range → ignored, a full 200 (RFC 9110 §14.2).
      const multi = await srv.fetch(path, {
        headers: { range: "bytes=0-1,5-6" },
      });
      assertEquals(multi.status, 200);
      assertEquals((await multi.arrayBuffer()).byteLength, 100_000);

      // A weak validator never satisfies If-Range: the whole file.
      const ifRange = await srv.fetch(path, {
        headers: { range: "bytes=0-9", "if-range": etag },
      });
      assertEquals(ifRange.status, 200);
      assertEquals((await ifRange.arrayBuffer()).byteLength, 100_000);

      // Revalidation still wins over a range — where the response revalidates
      // at all (dev is `no-store`, so there the range is served).
      const inm = await srv.fetch(path, {
        headers: { range: "bytes=0-9", "if-none-match": etag },
      });
      await inm.body?.cancel();
      const noStore = (full.headers.get("cache-control") ?? "").includes(
        "no-store",
      );
      assertEquals(inm.status, noStore ? 206 : 304);

      const head = await srv.fetch(path, {
        method: "HEAD",
        headers: { range: "bytes=0-9" },
      });
      await head.body?.cancel();
      assertEquals(head.status, 206);
      assertEquals(head.headers.get("content-length"), "10");
    }
  } finally {
    await Deno.remove(f.base, { recursive: true });
    await Deno.remove(f.media, { recursive: true });
  }
});

Deno.test("static: a small range of a large file is not a whole-file read", async () => {
  const media = await Deno.makeTempDir({ prefix: "aio-range-big-" });
  const MB = 1 << 20;
  const size = 64 * MB;
  {
    const out = await Deno.open(join(media, "movie.mp4"), {
      create: true,
      write: true,
    });
    const chunk = new Uint8Array(MB).fill(7);
    for (let i = 0; i < size / MB; i++) await out.write(chunk);
    out.close();
  }
  try {
    await using srv = await testServer({
      cells: [cell("range_big", { state: { n: 0 }, methods: {} })],
      assets: { "/media": media },
    });
    // Warm the path once so module/JIT allocations are not counted.
    await (await srv.fetch("/media/movie.mp4", {
      headers: { range: "bytes=0-1" },
    })).arrayBuffer();
    let peak = Deno.memoryUsage().rss;
    const before = peak;
    const t = setInterval(() => {
      peak = Math.max(peak, Deno.memoryUsage().rss);
    }, 5);
    try {
      const got = await Promise.all(
        [0, 1, 2, 3].map(async () => {
          const r = await srv.fetch("/media/movie.mp4", {
            headers: { range: "bytes=0-1023" },
          });
          return [r.status, (await r.arrayBuffer()).byteLength];
        }),
      );
      assertEquals(got, [[206, 1024], [206, 1024], [206, 1024], [206, 1024]]);
    } finally {
      clearInterval(t);
    }
    const grew = peak - before;
    // A whole-file read is 64 MB PER request (256 MB for these four).
    assert(
      grew < 48 * MB,
      `four 1 KB ranges of a 64 MB file grew RSS by ${
        (grew / MB).toFixed(0)
      } MB — the file is being read whole`,
    );
  } finally {
    await Deno.remove(media, { recursive: true });
  }
});

Deno.test("static (prod): a matching If-None-Match beats Range → 304, not 206", async () => {
  const { createStaticHandler } = await import(
    "../src/server/server-static.ts"
  );
  const { encodeResponse } = await import("../src/server/http-encoding.ts");
  const f = await fixture();
  try {
    const h = createStaticHandler({
      prod: true,
      debug: () => {},
      title: "t",
      absBaseDir: f.base,
      absDistDir: join(f.base, "dist"),
      hasCSS: false,
      importMap: "{}",
      noCache: { "Cache-Control": "no-cache" },
      getGraphResult: () => null,
      // deno-lint-ignore no-explicit-any
    } as any);
    const full = await h.serveStatic(
      "/pic.png",
      new Request("http://x/pic.png"),
    );
    const etag = full.headers.get("etag")!;
    await full.body?.cancel();
    const req = new Request("http://x/pic.png", {
      headers: { range: "bytes=0-9", "if-none-match": etag },
    });
    const out = await encodeResponse(req, await h.serveStatic("/pic.png", req));
    await out.body?.cancel();
    assertEquals(out.status, 304);
    const ranged = new Request("http://x/pic.png", {
      headers: { range: "bytes=0-9" },
    });
    const r = await encodeResponse(
      ranged,
      await h.serveStatic("/pic.png", ranged),
    );
    assertEquals(r.status, 206);
    assertEquals(new Uint8Array(await r.arrayBuffer()), f.bytes.slice(0, 10));
  } finally {
    await Deno.remove(f.base, { recursive: true });
    await Deno.remove(f.media, { recursive: true });
  }
});
