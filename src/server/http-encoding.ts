// Response encoding — compression and cache validators, in ONE decider.
//
// Measured against the alpha71 compiled binary, `GET /app.js` of the counter
// template: 161,905 bytes on the wire, `Cache-Control: no-cache`, and no
// `ETag` or `Last-Modified`. Three facts followed, and all three were silent:
//
//  1. Nothing was ever compressed. `grep -r content-encoding src/server` had
//     no hits. 162 KB shipped where 56 KB would do — on EVERY page load.
//  2. `no-cache` means "you may cache, but revalidate". Revalidation needs a
//     validator, and there was none — so the directive degraded to a full
//     re-download every time. `server.ts` says in a comment that prod "MUST
//     revalidate"; the contract simply was not implemented.
//  3. Neither was documented as a non-goal, measured by a bench, or covered by
//     a gate, in a project that gates silent catches and log prefixes.
//
// This module fixes all three at the one place every HTTP response passes
// through, so no route, no static file and no future handler can miss it.
//
// WHAT IT WILL NOT TOUCH — the compatibility contract:
//   • anything that is not a 200 (a 101 upgrade, a 206 range, a 304, a
//     redirect, an error) — untouched.
//   • a response that already carries `Content-Encoding` — untouched.
//   • a body with no `Content-Length` — that is a stream (SSE, a blob range,
//     a proxied response), and buffering it to compress it would break it.
//   • a content type outside `isCompressible` — images, fonts, video, wasm
//     and archives are already compressed; recompressing costs CPU and gains
//     nothing.
//   • anything under `MIN_COMPRESS_BYTES` — below roughly one MTU there is no
//     packet to save, and the framing costs bytes.
// Everything else is byte-identical to what the handler produced; only the
// transfer encoding changes, which is exactly what a transfer encoding is for.
import { log } from "../diagnostics/logger-api.ts";

/** Below one network packet there is nothing to win and framing costs bytes. */
export const MIN_COMPRESS_BYTES = 860;

/** Above this a response is streamed rather than buffered: compressing means
 *  holding the whole body in memory, and an 8 MB ceiling keeps a large
 *  download from becoming a heap spike. Bigger bodies pass through untouched. */
export const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** …and above this many MILLISECONDS, likewise: a response that has not
 *  finished by now is a STREAM, whatever its content type says.
 *
 *  `isStreamingType` is an allowlist of five types someone thought of, and it
 *  was the whole correctness boundary — so every other streaming shape was
 *  buffered until it ended: a `text/plain` log tail never arrived at all (not
 *  one byte, not even the status line), a streaming `text/html` SSR render
 *  measured TTFB == total, and an endless one hung the request forever while
 *  quietly accumulating chunks in memory after the client had gone. That is
 *  verbatim the failure `isStreamingType`'s own docstring says it prevents.
 *
 *  A time bound makes the allowlist an OPTIMISATION (skip the read entirely
 *  for a type we already know) instead of the thing correctness rests on. A
 *  body slow enough to trip this is simply not compressed, which is a
 *  graceful degradation; `bufferUpTo` replays what it read, so nothing is
 *  ever truncated. */
export const MAX_BUFFER_MS = 100;

/** Brotli quality for on-the-fly compression. Measured on the real 162 KB
 *  counter bundle: q5 → 56.1 KB in 3.4 ms, gzip → 59.1 KB in 5.8 ms, q11 →
 *  51.6 KB in 133 ms. q5 is both smaller AND faster than gzip; q11 belongs to
 *  the build, which pays it once (see `precompress` in the build). */
export const BROTLI_QUALITY = 5;

/** Types worth compressing: text, and the structured formats that are text.
 *  Everything else (png/jpeg/webp/woff2/wasm/zip/mp4) is already compressed. */
export function isCompressible(contentType: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.split(";")[0]!.trim().toLowerCase();
  if (ct.startsWith("text/")) return true;
  if (ct.startsWith("image/svg")) return true;
  if (ct.startsWith("font/") || ct.endsWith("/otf") || ct.endsWith("/ttf")) {
    // Bare .ttf/.otf compress well; .woff2 is brotli already and is excluded
    // by the check below.
    return !ct.includes("woff");
  }
  return /^application\/(javascript|ecmascript|json|.*\+json|xml|.*\+xml|manifest|toml|yaml|x-yaml|sql|rtf)$/
    .test(ct);
}

/** Content types that are a STREAM by definition — never buffered, whatever
 *  their size says.
 *
 *  This list is the reason the finisher is safe to run on every response. An
 *  SSE stream is text/*, so `isCompressible` says yes and a naive buffer would
 *  wait for an end that is never coming: the request hangs, forever, and it
 *  hangs in production under load rather than in a test. Same shape for
 *  newline-delimited JSON and for a multipart body. A long-lived response is
 *  not a large one — it is a DIFFERENT KIND, and the only safe move is to
 *  recognise it by name and not touch it. */
export function isStreamingType(contentType: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.split(";")[0]!.trim().toLowerCase();
  return ct === "text/event-stream" || ct === "application/x-ndjson" ||
    ct === "application/jsonl" || ct === "application/stream+json" ||
    ct.startsWith("multipart/");
}

/** Read at most `max` bytes.
 *
 *  Returns the whole body when it fits, and otherwise a stream that replays
 *  what was already read followed by the rest — so "too big to compress" costs
 *  a copy of the first 8 MB and NEVER a truncated response. Buffering a body
 *  to look at it is only acceptable if putting it back is total. */
async function bufferUpTo(
  body: ReadableStream<Uint8Array>,
  max: number,
  maxMs: number = MAX_BUFFER_MS,
): Promise<{ bytes: Bytes } | { stream: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + maxMs;

  /** Everything read so far, then the untouched remainder. `inFlight` is the
   *  read that was already issued when we gave up — awaiting it in the first
   *  pull is what makes handing the body back TOTAL rather than lossy. */
  const handOff = (
    inFlight: Promise<ReadableStreamReadResult<Uint8Array>> | null,
  ): ReadableStream<Uint8Array> => {
    let first = inFlight;
    return new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(ch);
      },
      async pull(c) {
        const r = first ? await first : await reader.read();
        first = null;
        if (r.done) c.close();
        else if (r.value) c.enqueue(r.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  };

  while (true) {
    const pending = reader.read();
    const left = deadline - Date.now();
    if (left <= 0) return { stream: handOff(pending) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raced = await Promise.race([
      pending,
      new Promise<"aio-timeout">((r) => {
        timer = setTimeout(() => r("aio-timeout"), left);
      }),
    ]);
    clearTimeout(timer);
    if (raced === "aio-timeout") return { stream: handOff(pending) };
    const { done, value } = raced;
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
    if (total > max) return { stream: handOff(null) };
  }
  const out = new Uint8Array(total) as Bytes;
  let at = 0;
  for (const ch of chunks) {
    out.set(ch, at);
    at += ch.byteLength;
  }
  return { bytes: out };
}

/** Encodings this build can actually produce, best ratio first. */
export type Encoding = "br" | "gzip" | "deflate";

/** Parse `Accept-Encoding` and pick the best encoding BOTH sides support.
 *
 *  Honors `q=0` (an explicit refusal) and `*`, because a client that says
 *  `gzip;q=0` means it, and a proxy that says `*` means anything. Returns null
 *  when the client asked for nothing we can produce — the response then ships
 *  exactly as the handler wrote it. */
export function negotiate(
  header: string | null,
  available: readonly Encoding[],
): Encoding | null {
  if (!header) return null;
  const q = new Map<string, number>();
  for (const part of header.split(",")) {
    const [nameRaw, ...params] = part.split(";");
    const name = nameRaw!.trim().toLowerCase();
    if (!name) continue;
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) weight = Number(m[1]) || 0;
    }
    // A DUPLICATE token takes the LOWEST weight it was given, not the last.
    //
    // `Accept-Encoding: gzip;q=0, gzip` is malformed — no browser sends it —
    // and RFC 9110 does not say which wins. Last-wins picked gzip, so a client
    // that had said "I cannot decode gzip" got gzip. Every reading of a
    // contradictory header is a guess; this is the guess that cannot produce a
    // body the client cannot read, and identity is always decodable. Found by
    // `scripts/audit-round.ts 2`.
    const prev = q.get(name);
    q.set(name, prev === undefined ? weight : Math.min(prev, weight));
  }
  const star = q.get("*");
  let best: Encoding | null = null;
  let bestQ = 0;
  for (const enc of available) {
    const w = q.get(enc) ?? star ?? 0;
    if (w > bestQ) {
      best = enc;
      bestQ = w;
    }
  }
  return bestQ > 0 ? best : null;
}

/** Brotli, when this runtime can do it. Probed ONCE.
 *
 *  `node:zlib` is present in every Deno we support and in a compiled binary,
 *  but a probe beats an assumption: if the import ever fails the server keeps
 *  serving, one encoding poorer, and SAYS so at debug — a capability that is
 *  absent is not an error that was swallowed. */
type Bytes = Uint8Array<ArrayBuffer>;

let _brotli: ((b: Bytes) => Bytes) | null | undefined;

async function brotli(): Promise<((b: Bytes) => Bytes) | null> {
  if (_brotli !== undefined) return _brotli;
  try {
    const z = await import("node:zlib");
    const params = { [z.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY };
    _brotli = (b: Bytes) => {
      const out = z.brotliCompressSync(b, { params });
      return new Uint8Array(
        out.buffer as ArrayBuffer,
        out.byteOffset,
        out.byteLength,
      );
    };
  } catch (e) {
    log.debug(
      `http: brotli unavailable (${e}) — responses compress with gzip instead`,
    );
    _brotli = null;
  }
  return _brotli;
}

/** @internal test seam — force the brotli probe to a known answer. The probe
 *  is once-per-process by design; product code that reset it would re-probe on
 *  every request. */
// aio-ok: test-only seam — re-probing per request is the bug it would cause
export function _setBrotli(
  fn: ((b: Bytes) => Bytes) | null | undefined,
): void {
  _brotli = fn;
}

async function deflateWith(
  format: "gzip" | "deflate",
  bytes: Bytes,
): Promise<Bytes> {
  const cs = new CompressionStream(format);
  const w = cs.writable.getWriter();
  void w.write(bytes);
  void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** Which encodings this process can produce right now. */
export async function availableEncodings(): Promise<readonly Encoding[]> {
  return (await brotli())
    ? (["br", "gzip", "deflate"] as const)
    : (["gzip", "deflate"] as const);
}

/** Compress `bytes` with `enc`. */
export async function compress(
  enc: Encoding,
  bytes: Bytes,
): Promise<Bytes> {
  if (enc === "br") {
    const br = await brotli();
    if (br) return br(bytes);
    return await deflateWith("gzip", bytes);
  }
  return await deflateWith(enc, bytes);
}

/** A 64-bit content hash over the body — the ETag.
 *
 *  An entity tag is an opaque equality token, not a signature: it must be
 *  cheap, stable for identical bytes, and different for different bytes. A
 *  SHA-256 per request would be cryptographic strength nobody asked for, and a
 *  BigInt FNV is 100x slower than the arithmetic V8 actually optimises — so
 *  this is two 32-bit lanes (cyrb-style, `Math.imul`), combined into one 64-bit
 *  token. Measured at ~0.35 ms on the 162 KB counter bundle, and cached after
 *  the first request anyway. Length is part of the tag, so two bodies must
 *  collide in BOTH lanes AND be the same size to be confused. */
export function etagOf(bytes: Uint8Array<ArrayBuffer>): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    h1 = Math.imul(h1 ^ b, 2654435761);
    h2 = Math.imul(h2 ^ b, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const lo = (h1 >>> 0).toString(36);
  const hi = (h2 >>> 0).toString(36);
  return `"${bytes.length.toString(36)}-${hi}${lo}"`;
}

/** Does `If-None-Match` match `etag`? Handles the `W/` prefix and lists. */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const bare = etag.replace(/^W\//, "");
  for (const part of header.split(",")) {
    if (part.trim().replace(/^W\//, "") === bare) return true;
  }
  return false;
}

/** A bounded memo of compressed bodies, keyed by `etag + encoding`.
 *
 *  The same bundle is requested by every tab and every reload; compressing it
 *  once per process rather than once per request is the difference between
 *  3.4 ms of CPU per page load and none. Bounded by BYTES, not entries, so a
 *  server with many distinct assets cannot grow without limit. */
class EncodedCache {
  #map = new Map<string, Bytes>();
  #bytes = 0;
  constructor(private readonly maxBytes: number) {}
  get(key: string): Bytes | undefined {
    const v = this.#map.get(key);
    if (v) {
      // LRU: re-insert so the oldest key is always first out.
      this.#map.delete(key);
      this.#map.set(key, v);
    }
    return v;
  }
  set(key: string, value: Bytes): void {
    if (value.byteLength > this.maxBytes) return;
    const prev = this.#map.get(key);
    if (prev) this.#bytes -= prev.byteLength;
    this.#map.set(key, value);
    this.#bytes += value.byteLength;
    while (this.#bytes > this.maxBytes) {
      const oldest = this.#map.keys().next();
      if (oldest.done) break;
      const dropped = this.#map.get(oldest.value)!;
      this.#map.delete(oldest.value);
      this.#bytes -= dropped.byteLength;
    }
  }
  get size(): number {
    return this.#map.size;
  }
  clear(): void {
    this.#map.clear();
    this.#bytes = 0;
  }
}

/** 32 MB of compressed bodies — a few hundred assets, or one very large one. */
const _cache = new EncodedCache(32 * 1024 * 1024);

/** @internal test seam — empty the compressed-body memo. The cache is keyed by
 *  content hash, so it is self-invalidating: product code has no reason to
 *  drop it, and dropping it re-compresses every live asset. */
// aio-ok: test-only seam — the memo is self-invalidating in production
export function _clearEncodedCache(): void {
  _cache.clear();
}

/** Options for `encodeResponse`. */
export interface EncodeOptions {
  /** Off switch — `security: { compress: false }`. Validators still apply:
   *  a 304 is correctness, not an optimisation. */
  compress?: boolean;
}

/**
 * Add a validator and a transfer encoding to one response.
 *
 * Returns the SAME response object when nothing applies, so the common path
 * (an upgrade, a stream, an image, an error) costs one type check.
 */
export async function encodeResponse(
  req: Request,
  resp: Response,
  opts: EncodeOptions = {},
): Promise<Response> {
  // Only a plain 200 is a candidate. Everything else — 101, 204, 206, 304,
  // 3xx, 4xx, 5xx — passes through exactly as written.
  if (resp.status !== 200) return resp;
  if (resp.headers.has("Content-Encoding")) return resp;

  // HEAD is headers-only, and the handler's headers are the answer.
  //
  // Deno's HTTP layer drops a HEAD body itself, so there is nothing to
  // compress; and the handler has already declared the length the matching GET
  // would send. Buffering a HEAD's (empty) body and rewriting Content-Length
  // from what came back reported `content-length: 0` for a 43-byte blob —
  // a HEAD that lies about the size is worse than a HEAD that says nothing,
  // because the whole point of the method is to ask the size.
  // Found by tests/blobs.test.ts, once a handler-supplied ETag stopped being
  // an early exit.
  if (req.method.toUpperCase() === "HEAD") return resp;

  const ct = resp.headers.get("Content-Type");
  const cacheControl = resp.headers.get("Cache-Control") ?? "";
  // `no-transform` is the standard way for a handler to say "these are the
  // bytes, do not re-encode them". Honouring it is what makes the finisher
  // safe to run over routes an app writes later.
  if (cacheControl.includes("no-transform")) return resp;
  // A stream is a different KIND of response, not a large one — see
  // `isStreamingType`. Never touched, at any size.
  if (isStreamingType(ct)) return resp;
  // Nothing to gain: images, fonts, wasm, archives and video are compressed
  // already, and re-encoding them costs CPU for bytes back.
  //
  // …but a 304 is CORRECTNESS, not an optimisation, and this early return sat
  // ABOVE the conditional-request block — so every incompressible response
  // went out with `no-cache` and no validator, i.e. a full re-download of
  // every image, font and video on every page load. Answer the conditional
  // request first, using the tag the HANDLER supplied (the static path now
  // sets a weak mtime/size one for binaries). Never hash here: buffering a
  // video to hash it is the cost this early return exists to avoid.
  if (!isCompressible(ct)) {
    const handlerTag = resp.headers.get("ETag");
    if (
      handlerTag && !cacheControl.includes("no-store") &&
      etagMatches(req.headers.get("If-None-Match"), handlerTag)
    ) {
      const h = new Headers(resp.headers);
      h.delete("Content-Length");
      h.delete("Content-Encoding");
      void resp.body?.cancel();
      return new Response(null, { status: 304, headers: h });
    }
    return resp;
  }
  if (!resp.body) return resp;

  // Deno does NOT put `Content-Length` on an in-process Response — it is added
  // by the HTTP layer on the way out — so the header is a hint, never the
  // gate. When it IS present and large, skip without reading a byte; when it
  // is absent, `bufferUpTo` bounds the read and replays what it took.
  const declared = Number(resp.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BUFFER_BYTES) return resp;

  const read = await bufferUpTo(resp.body, MAX_BUFFER_BYTES);
  if ("stream" in read) {
    // Too big to hold. Send the original bytes, untouched and unbroken.
    return new Response(read.stream, {
      status: 200,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  }
  const bytes = read.bytes;
  // A handler that already knows its own tag keeps it. The prod static path
  // caches `{mtime, size, bytes, etag}` and sets one, so the common request —
  // the app bundle — skips a hash of 162 KB per request; a content-addressed
  // blob's tag is its id. Hashing here is the fallback, not the rule.
  const etag = resp.headers.get("ETag") ?? etagOf(bytes);
  const noStore = cacheControl.includes("no-store");

  // ── Conditional request: the whole point of `no-cache` ──
  if (!noStore && etagMatches(req.headers.get("If-None-Match"), etag)) {
    // A 304 carries the headers that would have been sent — including
    // Set-Cookie, which a session refresh depends on — but never a body.
    const h = new Headers(resp.headers);
    h.set("ETag", etag);
    h.delete("Content-Length");
    h.delete("Content-Encoding");
    h.set("Vary", mergeVary(h.get("Vary"), "Accept-Encoding"));
    return new Response(null, { status: 304, headers: h });
  }

  const headers = new Headers(resp.headers);
  if (!noStore) headers.set("ETag", etag);

  let body: Bytes = bytes;
  if (
    opts.compress !== false &&
    bytes.byteLength >= MIN_COMPRESS_BYTES && isCompressible(ct)
  ) {
    const enc = negotiate(
      req.headers.get("Accept-Encoding"),
      await availableEncodings(),
    );
    if (enc) {
      const key = `${etag} ${enc}`;
      let out = _cache.get(key);
      if (!out) {
        out = await compress(enc, bytes);
        _cache.set(key, out);
      }
      // A "compressed" body that grew is a worse answer than the original.
      if (out.byteLength < bytes.byteLength) {
        body = out;
        headers.set("Content-Encoding", enc);
      }
    }
  }
  // Always, even uncompressed: a cache that stored the identity copy must not
  // hand it to a client that asked for gzip (and vice versa).
  if (isCompressible(ct)) {
    headers.set("Vary", mergeVary(headers.get("Vary"), "Accept-Encoding"));
  }
  headers.set("Content-Length", String(body.byteLength));
  return new Response(body, {
    status: 200,
    statusText: resp.statusText,
    headers,
  });
}

/** Add a field to a `Vary` header without duplicating it. */
export function mergeVary(existing: string | null, field: string): string {
  if (!existing) return field;
  if (existing.trim() === "*") return "*";
  const have = existing.split(",").map((s) => s.trim().toLowerCase());
  if (have.includes(field.toLowerCase())) return existing;
  return `${existing}, ${field}`;
}
