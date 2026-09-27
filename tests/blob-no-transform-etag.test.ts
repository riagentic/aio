// a compressible blob (text/plain) served gzip-encoded keeps the
// blob's STRONG ETag `"<id>"` and `Accept-Ranges: bytes` — while a Range
// request on the same URL answers from the IDENTITY bytes (206 is never
// encoded). One strong validator for two different byte sequences (RFC 9110
// §8.8.3: a strong tag changes whenever the representation data changes,
// content-coding included), so a resumed download (`If-Range: "<id>"`,
// `Range: bytes=N-`) splices identity bytes onto a gzip prefix.
import { assert } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { cell } from "../mod.ts";

Deno.test("hunt r12-a: an encoded blob response must not reuse the identity strong ETag", async () => {
  const c = cell(`hr12blob-${crypto.randomUUID().slice(0, 6)}`, {
    state: { n: 0 },
    methods: {},
  });
  await using srv = await testServer({ cells: [c] });
  const bytes = new TextEncoder().encode("all work and no play. ".repeat(400));
  const info = await srv.app.blobs!.put(bytes, { name: "log.txt" });
  const url = srv.app.blobs!.url(info.id);

  const gz = await srv.fetch(url, { headers: { "Accept-Encoding": "gzip" } });
  await gz.arrayBuffer();
  const encoding = gz.headers.get("content-encoding");
  const etag = gz.headers.get("etag");
  const ranges = gz.headers.get("accept-ranges");

  const part = await srv.fetch(url, {
    headers: { "Accept-Encoding": "gzip", Range: "bytes=100-199" },
  });
  await part.arrayBuffer();

  if (encoding) {
    // The 206 is identity bytes under the same strong tag the gzip 200 had.
    assert(
      etag !== `"${info.id}"` || ranges !== "bytes",
      `200 was Content-Encoding: ${encoding} with strong ETag ${etag} and ` +
        `Accept-Ranges: ${ranges}; the 206 (status ${part.status}, ` +
        `encoding ${part.headers.get("content-encoding")}) carries ETag ` +
        `${part.headers.get("etag")} — one strong validator, two byte streams`,
    );
  }
});
