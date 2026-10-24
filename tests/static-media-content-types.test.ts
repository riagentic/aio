// Media and data types `FILE_EXT` already called files went out as
// `application/octet-stream`: a `<track src="captions.vtt">` is refused under
// any type but `text/vtt`, Safari (the iOS web target) will not play media it
// is not told is media, and a blob named `photo.avif` downloaded instead of
// showing although the blob allowlist passes `image/avif`.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createStaticHandler } from "../src/server/server-static.ts";
import { blobContentType } from "../src/server/serve-file.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const WANT: Record<string, string> = {
  "captions.vtt": "text/vtt; charset=utf-8",
  "data.csv": "text/csv; charset=utf-8",
  "song.m4a": "audio/mp4",
  "song.ogg": "audio/ogg",
  "song.opus": "audio/ogg",
  "song.flac": "audio/flac",
  "song.aac": "audio/aac",
  "clip.mov": "video/quicktime",
  "clip.m4v": "video/mp4",
  "clip.ogv": "video/ogg",
  "photo.avif": "image/avif",
  "photo.heic": "image/heic",
  "photo.bmp": "image/bmp",
  "anim.apng": "image/apng",
  "app.webmanifest": "application/manifest+json",
};

for (const prod of [false, true]) {
  Deno.test(`static (${prod ? "prod" : "dev"}): media and data files carry their real type`, async () => {
    const base = await tempDir("aio-media-types-");
    try {
      for (const name of Object.keys(WANT)) {
        await Deno.writeTextFile(join(base, name), "x");
      }
      const { serveStatic } = createStaticHandler({
        prod,
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
      for (const name of Object.keys(WANT)) {
        const r = await serveStatic(`/${name}`);
        await r.body?.cancel();
        got[name] = r.headers.get("content-type");
      }
      assertEquals(got, WANT);
    } finally {
      await dropTempDir(base);
    }
  });
}

Deno.test("blobs: an avif / m4a upload is served inline as what it is", () => {
  assertEquals(blobContentType("photo.avif"), "image/avif");
  assertEquals(blobContentType("memo.m4a"), "audio/mp4");
  assertEquals(blobContentType("clip.mov"), "video/quicktime");
});
