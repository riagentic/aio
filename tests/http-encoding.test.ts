// The response finisher — compression, validators, and what it must NOT touch.
//
// Measured against the alpha71 compiled binary: `GET /app.js` shipped 161,905
// bytes with `Cache-Control: no-cache` and no validator, so `no-cache`'s
// "revalidate" degraded to a full re-download every page load, and nothing was
// ever compressed. This file pins the fix AND the compatibility contract: the
// list of responses that must come back byte-identical is longer than the list
// that changes, and it is the more important half.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _clearEncodedCache,
  _setBrotli,
  availableEncodings,
  compress,
  encodeResponse,
  etagMatches,
  etagOf,
  isCompressible,
  isStreamingType,
  MAX_BUFFER_BYTES,
  mergeVary,
  MIN_COMPRESS_BYTES,
  negotiate,
} from "../src/server/http-encoding.ts";

const BIG = "aio ".repeat(2000); // ~8 KB of very compressible text
const enc = new TextEncoder();

function jsResponse(body = BIG): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/javascript",
      "Content-Length": String(enc.encode(body).byteLength),
      "Cache-Control": "no-cache",
    },
  });
}

function get(headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request("http://localhost/app.js", { method, headers });
}

Deno.test("encoding: a compressible body is compressed and shrinks", async () => {
  _clearEncodedCache();
  const raw = enc.encode(BIG).byteLength;
  const out = await encodeResponse(
    get({ "Accept-Encoding": "gzip" }),
    jsResponse(),
  );
  assertEquals(out.headers.get("Content-Encoding"), "gzip");
  const sent = Number(out.headers.get("Content-Length"));
  assert(sent < raw / 2, `${sent} bytes is not a win over ${raw}`);
  // The bytes must still be the bytes.
  const back = await new Response(
    out.body!.pipeThrough(new DecompressionStream("gzip")),
  ).text();
  assertEquals(
    back,
    BIG,
    "a compressed response must decompress to the same body",
  );
});

Deno.test("encoding: brotli wins when the client offers it", async () => {
  _clearEncodedCache();
  const out = await encodeResponse(
    get({ "Accept-Encoding": "gzip, deflate, br" }),
    jsResponse(),
  );
  assertEquals(out.headers.get("Content-Encoding"), "br");
});

Deno.test("encoding: a client that asks for nothing gets exactly what it asked for", async () => {
  _clearEncodedCache();
  const out = await encodeResponse(get(), jsResponse());
  assertEquals(out.headers.get("Content-Encoding"), null);
  assertEquals(await out.text(), BIG);
});

Deno.test("encoding: q=0 is a refusal, not a preference", async () => {
  _clearEncodedCache();
  const out = await encodeResponse(
    get({ "Accept-Encoding": "gzip;q=0, br;q=0" }),
    jsResponse(),
  );
  assertEquals(
    out.headers.get("Content-Encoding"),
    null,
    "`gzip;q=0` means the client cannot decode gzip — sending it anyway is a " +
      "broken page, not an optimisation",
  );
});

Deno.test("encoding: `no-cache` finally revalidates — 304, no body", async () => {
  _clearEncodedCache();
  const first = await encodeResponse(
    get({ "Accept-Encoding": "gzip" }),
    jsResponse(),
  );
  const etag = first.headers.get("ETag");
  assert(
    etag,
    "a `no-cache` response with no validator can never be revalidated",
  );
  const second = await encodeResponse(
    get({ "Accept-Encoding": "gzip", "If-None-Match": etag }),
    jsResponse(),
  );
  assertEquals(second.status, 304);
  assertEquals(second.body, null, "a 304 carries no body — that is the point");
});

Deno.test("encoding: a 304 still carries Set-Cookie", async () => {
  _clearEncodedCache();
  const make = () => {
    const r = jsResponse();
    r.headers.set("Set-Cookie", "sid=abc; Path=/; HttpOnly");
    return r;
  };
  const etag = (await encodeResponse(get(), make())).headers.get("ETag")!;
  const notMod = await encodeResponse(get({ "If-None-Match": etag }), make());
  assertEquals(notMod.status, 304);
  assertStringIncludes(
    notMod.headers.get("Set-Cookie") ?? "",
    "sid=abc",
    "dropping Set-Cookie on a 304 silently logs the user out on every reload",
  );
});

Deno.test("encoding: a changed body changes the ETag", async () => {
  _clearEncodedCache();
  const a = (await encodeResponse(get(), jsResponse("one".repeat(400))))
    .headers.get("ETag");
  const b = (await encodeResponse(get(), jsResponse("two".repeat(400))))
    .headers.get("ETag");
  assert(
    a && b && a !== b,
    "a redeploy that reuses an ETag serves a stale app",
  );
});

Deno.test("encoding: Vary: Accept-Encoding, always, compressed or not", async () => {
  _clearEncodedCache();
  for (const ae of ["gzip", ""]) {
    const out = await encodeResponse(
      get(ae ? { "Accept-Encoding": ae } : {}),
      jsResponse(),
    );
    assertStringIncludes(
      out.headers.get("Vary") ?? "",
      "Accept-Encoding",
      "without Vary a shared cache hands a gzip body to a client that cannot " +
        "decode it",
    );
  }
});

Deno.test("encoding: an existing Vary is added to, never replaced", () => {
  assertEquals(
    mergeVary("Cookie", "Accept-Encoding"),
    "Cookie, Accept-Encoding",
  );
  assertEquals(
    mergeVary("Accept-Encoding", "Accept-Encoding"),
    "Accept-Encoding",
  );
  assertEquals(
    mergeVary("accept-encoding", "Accept-Encoding"),
    "accept-encoding",
  );
  assertEquals(mergeVary("*", "Accept-Encoding"), "*");
  assertEquals(mergeVary(null, "Accept-Encoding"), "Accept-Encoding");
});

// ── The compatibility contract: what must come back untouched ──

Deno.test("encoding: HEAD is the handler's headers, untouched", async () => {
  _clearEncodedCache();
  // Deno's HTTP layer drops a HEAD body itself, so there is nothing to
  // compress — and the handler has already declared the length its GET would
  // send. Buffering the (empty) HEAD body and rewriting Content-Length from
  // what came back reported `content-length: 0` for a 43-byte blob. A HEAD
  // that lies about the size is worse than one that says nothing: asking the
  // size is the whole point of the method.
  const declared = new Response(null, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": "43",
      "ETag": '"blob-id"',
    },
  });
  const out = await encodeResponse(
    get({ "Accept-Encoding": "gzip" }, "HEAD"),
    declared,
  );
  assertEquals(out, declared, "identity — the handler already answered");
  assertEquals(out.headers.get("Content-Length"), "43");
  assertEquals(out.headers.get("Content-Encoding"), null);

  // …and a compressible one is equally untouched.
  const js = await encodeResponse(
    get({ "Accept-Encoding": "br" }, "HEAD"),
    jsResponse(),
  );
  assertEquals(js.headers.get("Content-Encoding"), null);
});

Deno.test("encoding: non-200 responses are never touched", async () => {
  const NULL_BODY = new Set([101, 204, 205, 304]);
  for (const status of [101, 204, 206, 301, 304, 403, 404, 500]) {
    const r = new Response(NULL_BODY.has(status) ? null : BIG, {
      status,
      headers: { "Content-Type": "application/javascript" },
    });
    const out = await encodeResponse(get({ "Accept-Encoding": "br" }), r);
    assertEquals(out, r, `status ${status} must pass through by identity`);
  }
});

Deno.test("encoding: a long-lived stream is recognised by KIND, not by size", async () => {
  // The failure this prevents is the worst kind: an SSE body is text/*, so a
  // size-based rule says "small enough, buffer it" and then waits for an end
  // that is never coming. The request hangs — in production, under load.
  for (
    const ct of [
      "text/event-stream",
      "application/x-ndjson",
      "multipart/mixed; boundary=x",
    ]
  ) {
    assert(isStreamingType(ct), ct);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("data: hi\n\n"));
        // ...and never closes, exactly like a real event source.
      },
      cancel() {
        cancelled = true;
      },
    });
    const r = new Response(stream, { headers: { "Content-Type": ct } });
    // If this ever starts buffering, this line never returns.
    const out = await encodeResponse(get({ "Accept-Encoding": "br" }), r);
    assertEquals(out, r, `${ct} must pass through by identity`);
    assert(!cancelled);
    await out.body?.cancel();
  }
});

Deno.test("encoding: `no-transform` is honoured", async () => {
  const r = new Response(BIG, {
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "public, max-age=60, no-transform",
    },
  });
  assertEquals(
    await encodeResponse(get({ "Accept-Encoding": "br" }), r),
    r,
    "`no-transform` is how a handler says: these are the bytes",
  );
});

Deno.test("encoding: a body over the cap is replayed WHOLE, never truncated", async () => {
  // Buffering to look at a body is only acceptable if putting it back is
  // total. A truncated 200 is the worst possible outcome: it looks like it
  // worked.
  const chunk = new Uint8Array(1024 * 1024).fill(65); // 1 MB of "A"
  const chunks = 10; // 10 MB > MAX_BUFFER_BYTES
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent++ >= chunks) c.close();
      else c.enqueue(chunk.slice());
    },
  });
  const r = new Response(stream, {
    headers: { "Content-Type": "application/json" },
  });
  const out = await encodeResponse(get({ "Accept-Encoding": "br" }), r);
  assertEquals(out.headers.get("Content-Encoding"), null);
  const back = new Uint8Array(await out.arrayBuffer());
  assertEquals(
    back.byteLength,
    chunks * chunk.byteLength,
    "every byte of an over-cap body must still arrive",
  );
  assert(back.every((b) => b === 65));
});

Deno.test("encoding: an already-encoded body is left alone", async () => {
  const r = new Response("x", {
    headers: {
      "Content-Type": "application/javascript",
      "Content-Encoding": "gzip",
      "Content-Length": "1",
    },
  });
  assertEquals(await encodeResponse(get({ "Accept-Encoding": "br" }), r), r);
});

Deno.test("encoding: a handler's own ETag is USED, not recomputed", async () => {
  _clearEncodedCache();
  // The prod static path caches `{mtime, size, bytes, etag}` and sets the tag
  // itself, so the commonest request in the system — the app bundle — skips a
  // content hash of 162 KB per request. Hashing here is the fallback.
  const make = () =>
    new Response(BIG, {
      headers: {
        "Content-Type": "application/javascript",
        "ETag": '"handler-owns-this"',
      },
    });
  const out = await encodeResponse(get({ "Accept-Encoding": "br" }), make());
  assertEquals(out.headers.get("ETag"), '"handler-owns-this"');
  assertEquals(
    out.headers.get("Content-Encoding"),
    "br",
    "knowing its own tag must not cost the handler compression",
  );
  // …and it revalidates on that tag.
  const notMod = await encodeResponse(
    get({ "If-None-Match": '"handler-owns-this"' }),
    make(),
  );
  assertEquals(notMod.status, 304);
});

Deno.test("encoding: incompressible types are not recompressed", () => {
  for (
    const ct of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "font/woff2",
      "application/wasm",
      "application/zip",
      "video/mp4",
      "application/octet-stream",
    ]
  ) {
    assertEquals(isCompressible(ct), false, ct);
  }
  for (
    const ct of [
      "text/html; charset=utf-8",
      "text/css",
      "application/javascript",
      "application/json",
      "application/manifest+json",
      "image/svg+xml",
      "application/xml",
    ]
  ) {
    assertEquals(isCompressible(ct), true, ct);
  }
});

Deno.test("encoding: a tiny body is not worth a header", async () => {
  _clearEncodedCache();
  const tiny = "ok";
  const r = new Response(tiny, {
    headers: {
      "Content-Type": "text/plain",
      "Content-Length": String(tiny.length),
    },
  });
  const out = await encodeResponse(get({ "Accept-Encoding": "br" }), r);
  assertEquals(out.headers.get("Content-Encoding"), null);
  assert(MIN_COMPRESS_BYTES > tiny.length);
});

Deno.test("encoding: a body too large to buffer streams as-is", async () => {
  const r = new Response("x", {
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(MAX_BUFFER_BYTES + 1),
    },
  });
  assertEquals(await encodeResponse(get({ "Accept-Encoding": "br" }), r), r);
});

Deno.test("encoding: `no-store` gets no validator (but still compresses)", async () => {
  _clearEncodedCache();
  const r = new Response(BIG, {
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(enc.encode(BIG).byteLength),
      "Cache-Control": "no-store",
    },
  });
  const out = await encodeResponse(get({ "Accept-Encoding": "gzip" }), r);
  assertEquals(
    out.headers.get("ETag"),
    null,
    "handing a validator for a body nobody may store invites a cache to try",
  );
  assertEquals(out.headers.get("Content-Encoding"), "gzip");
});

Deno.test("encoding: `compress: false` keeps the validator, drops the encoding", async () => {
  _clearEncodedCache();
  const out = await encodeResponse(
    get({ "Accept-Encoding": "br" }),
    jsResponse(),
    { compress: false },
  );
  assertEquals(out.headers.get("Content-Encoding"), null);
  assert(out.headers.get("ETag"), "a 304 is correctness, not an optimisation");
});

Deno.test("encoding: a body that would GROW is sent as-is", async () => {
  _clearEncodedCache();
  // Random bytes do not compress; the encoder adds framing and the result is
  // larger. Sending that would be a pessimisation dressed as an optimisation.
  const rnd = new Uint8Array(4096);
  crypto.getRandomValues(rnd);
  const body = Array.from(rnd, (b) => String.fromCharCode(32 + (b % 95))).join(
    "",
  );
  const r = new Response(body, {
    headers: {
      "Content-Type": "text/plain",
      "Content-Length": String(body.length),
    },
  });
  const out = await encodeResponse(get({ "Accept-Encoding": "gzip" }), r);
  const sent = Number(out.headers.get("Content-Length"));
  assert(sent <= body.length, `sent ${sent} for a ${body.length}-byte body`);
});

// ── Negotiation ──

Deno.test("encoding: negotiation picks the best MUTUALLY supported encoding", () => {
  const all = ["br", "gzip", "deflate"] as const;
  assertEquals(negotiate("gzip, deflate, br", all), "br");
  assertEquals(negotiate("gzip, deflate", all), "gzip");
  assertEquals(negotiate("deflate", all), "deflate");
  assertEquals(negotiate("br", ["gzip", "deflate"]), null);
  assertEquals(negotiate("*", all), "br");
  assertEquals(negotiate("*;q=0, gzip", all), "gzip");
  assertEquals(negotiate("identity", all), null);
  assertEquals(negotiate(null, all), null);
  assertEquals(negotiate("", all), null);
  // Weights decide, not order.
  assertEquals(negotiate("br;q=0.1, gzip;q=0.9", all), "gzip");
});

Deno.test("encoding: no brotli is a degraded capability, never a failed request", async () => {
  _clearEncodedCache();
  _setBrotli(null);
  try {
    assertEquals(await availableEncodings(), ["gzip", "deflate"]);
    const out = await encodeResponse(
      get({ "Accept-Encoding": "br, gzip" }),
      jsResponse(),
    );
    assertEquals(
      out.headers.get("Content-Encoding"),
      "gzip",
      "a runtime without brotli still serves — one encoding poorer",
    );
  } finally {
    _setBrotli(undefined);
    _clearEncodedCache();
  }
});

Deno.test("encoding: every encoding round-trips", async () => {
  const bytes = enc.encode(BIG) as Uint8Array<ArrayBuffer>;
  const encodings = await availableEncodings();
  // This runtime has node:zlib, so brotli must be one of them. An empty or
  // short list would make every assertion below unreachable.
  assertEquals(encodings, ["br", "gzip", "deflate"]);
  let roundTripped = 0;
  for (const e of encodings) {
    const out = await compress(e, bytes);
    assert(out.byteLength < bytes.byteLength, `${e} did not shrink`);
    if (e === "br") continue; // no DecompressionStream for brotli
    const back = await new Response(
      new Response(out).body!.pipeThrough(new DecompressionStream(e)),
    ).text();
    assertEquals(back, BIG, `${e} did not round-trip`);
    roundTripped++;
  }
  assertEquals(
    roundTripped,
    2,
    "gzip and deflate must both have round-tripped",
  );
});

// ── ETag ──

Deno.test("etag: same bytes same tag, different bytes different tag", () => {
  const a = etagOf(enc.encode("hello world") as Uint8Array<ArrayBuffer>);
  const b = etagOf(enc.encode("hello world") as Uint8Array<ArrayBuffer>);
  const c = etagOf(enc.encode("hello worlD") as Uint8Array<ArrayBuffer>);
  assertEquals(a, b);
  assert(a !== c);
  assert(a.startsWith('"') && a.endsWith('"'), "an ETag is a quoted-string");
});

Deno.test("etag: 20k random bodies produce 20k distinct tags", () => {
  // A collision here serves a stale bundle after a redeploy — the failure this
  // whole mechanism exists to prevent. Length is part of the tag, so this is
  // the hard case: same length, one byte different.
  const seen = new Set<string>();
  const buf = new Uint8Array(256) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < 20_000; i++) {
    crypto.getRandomValues(buf);
    seen.add(etagOf(buf));
  }
  assertEquals(seen.size, 20_000, "content hash collided");
});

Deno.test("etag: If-None-Match handles lists, weak tags and `*`", () => {
  const tag = '"abc"';
  assert(etagMatches('"abc"', tag));
  assert(etagMatches('W/"abc"', tag));
  assert(etagMatches('"zzz", "abc"', tag));
  assert(etagMatches("*", tag));
  assert(!etagMatches('"zzz"', tag));
  assert(!etagMatches(null, tag));
});

Deno.test("encoding: a duplicated token takes its LOWEST weight", () => {
  // `Accept-Encoding: gzip;q=0, gzip` is malformed — no browser sends it — and
  // RFC 9110 does not say which occurrence wins. Last-wins picked gzip, so a
  // client that had said "I cannot decode gzip" got gzip. Every reading of a
  // contradictory header is a guess; this is the guess that cannot produce a
  // body the client cannot read. Found by `scripts/audit-round.ts 2`.
  const all = ["br", "gzip", "deflate"] as const;
  assertEquals(negotiate("gzip;q=0, gzip", all), null);
  assertEquals(negotiate("gzip, gzip;q=0", all), null);
  assertEquals(negotiate("br;q=0.0, Br", all), null, "…case-insensitively");
  assertEquals(negotiate("*;q=0, *", all), null);
  // A well-formed header is unaffected — there are no duplicates in one.
  assertEquals(negotiate("gzip, deflate, br", all), "br");
  assertEquals(negotiate("br;q=0, gzip", all), "gzip");
});
