// The app-facing HTTP surface — four defects, each at a boundary where one
// rule was written as an ALLOWLIST of the cases someone thought of.
import { assert, assertEquals } from "@std/assert";
import { encodeResponse, MAX_BUFFER_MS } from "../src/server/http-encoding.ts";
import { _decodePathname } from "../src/server/server-static.ts";
import { route } from "../src/server/route.ts";

/** A body that arrives in `n` chunks, `gap` ms apart. */
function slow(n: number, gap: number, contentType: string): Response {
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(c) {
        if (i >= n) return c.close();
        await new Promise((r) => setTimeout(r, gap));
        c.enqueue(new TextEncoder().encode(`chunk${i++}\n`));
      },
    }),
    { headers: { "Content-Type": contentType } },
  );
}

// ── A stream is a KIND, and the list of kinds was five entries long ────
//
// `isStreamingType` allows text/event-stream, x-ndjson, jsonl, stream+json
// and multipart/*. Everything ELSE that streams — a text/plain log tail, a
// streaming text/html SSR render, an application/json long-poll — is
// compressible, so it was buffered until the body ENDED. Measured: not one
// byte and not even the status line for an endless text/plain stream, and
// TTFB == total for a finite streaming SSR render. The chunks kept
// accumulating in memory after the client disconnected, with no log line.
//
// That is verbatim the failure the allowlist's own docstring claims to
// prevent ("the request hangs, forever, and it hangs in production under load
// rather than in a test"). A time bound makes the allowlist an optimisation
// instead of the correctness boundary.
Deno.test("encodeResponse: a slow body is streamed, whatever its content type", async () => {
  for (const ct of ["text/plain", "text/html", "application/json"]) {
    const t0 = Date.now();
    const resp = await encodeResponse(
      new Request("http://x/s"),
      slow(5, 200, ct),
    );
    const headersAt = Date.now() - t0;
    assert(
      headersAt < 200 * 4,
      `${ct}: headers waited ${headersAt}ms — the body was buffered to its end`,
    );
    const reader = resp.body!.getReader();
    const first = await reader.read();
    assertEquals(
      new TextDecoder().decode(first.value),
      "chunk0\n",
      `${ct}: the replayed body must start where the original did`,
    );
    await reader.cancel();
  }
});

Deno.test("encodeResponse: a fast body is still buffered and compressed", async () => {
  const resp = await encodeResponse(
    new Request("http://x/b", { headers: { "Accept-Encoding": "gzip" } }),
    new Response("x".repeat(4000), {
      headers: { "Content-Type": "text/plain" },
    }),
  );
  assertEquals(resp.headers.get("Content-Encoding"), "gzip");
  assert(Number(resp.headers.get("Content-Length")) < 4000);
  await resp.body?.cancel();
  assert(MAX_BUFFER_MS > 0, "the time bound must be a real bound");
});

// ── A validator is correctness, not an optimisation ────────────────────
//
// The `!isCompressible(ct) → return` early-out sat ABOVE the conditional
// block, so images, fonts, wasm and video went out under prod's
// `Cache-Control: no-cache` with NO validator — and `no-cache` without one
// degrades to a full re-download on every page load. That is bug #2 in this
// module's own header, presented there as fixed.
Deno.test("encodeResponse: an incompressible response answers a conditional request", async () => {
  const png = () =>
    new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-cache",
        ETag: 'W/"123-4"',
      },
    });
  const fresh = await encodeResponse(new Request("http://x/p.png"), png());
  assertEquals(fresh.status, 200);
  assertEquals(fresh.headers.get("ETag"), 'W/"123-4"');
  await fresh.body?.cancel();

  const cached = await encodeResponse(
    new Request("http://x/p.png", {
      headers: { "If-None-Match": 'W/"123-4"' },
    }),
    png(),
  );
  assertEquals(cached.status, 304);
  assertEquals(cached.body, null);

  const stale = await encodeResponse(
    new Request("http://x/p.png", { headers: { "If-None-Match": 'W/"old"' } }),
    png(),
  );
  assertEquals(stale.status, 200);
  await stale.body?.cancel();
});

// ── A request path is percent-encoded; the filesystem is not ───────────
//
// The path was used as a literal filesystem path, so any file with a space or
// a non-ASCII character was permanently 404 at any URL — a browser always
// sends `%20` — while a file LITERALLY named with `%20` was reachable.
Deno.test("_decodePathname: decodes a name, refuses a rewritten path", () => {
  assertEquals(_decodePathname("/my%20photo.txt"), "/my photo.txt");
  assertEquals(_decodePathname("/h%C3%A9llo.txt"), "/héllo.txt");
  assertEquals(_decodePathname("/a/b/c.js"), "/a/b/c.js");
  assertEquals(_decodePathname("/"), "/");

  // A segment that decodes into a separator or a traversal step is the client
  // rewriting the path AFTER every check above it has run.
  assertEquals(_decodePathname("/a%2Fb"), null);
  assertEquals(_decodePathname("/a%5Cb"), null);
  assertEquals(_decodePathname("/a%00b"), null);
  assertEquals(_decodePathname("/%2e%2e/etc"), null);
  assertEquals(_decodePathname("/../etc"), null);
  assertEquals(_decodePathname("/%zz"), null); // malformed escape
});

// ── HEAD rides with GET ────────────────────────────────────────────────
Deno.test("route: a GET-only route answers HEAD, and says so in Allow", async () => {
  const h = route(() => new Response("ok"), { method: "GET" });
  const head = await h(new Request("http://x/r", { method: "HEAD" }));
  assertEquals(head.status, 200, "HEAD on a GET route must not be a 405");
  await head.body?.cancel();

  const post = await h(new Request("http://x/r", { method: "POST" }));
  assertEquals(post.status, 405);
  assertEquals(post.headers.get("Allow"), "GET, HEAD");
  await post.body?.cancel();

  // A route that really only serves POST still refuses HEAD.
  const p = route(() => new Response("ok"), { method: "POST" });
  const r = await p(new Request("http://x/r", { method: "HEAD" }));
  assertEquals(r.status, 405);
  await r.body?.cancel();
});
