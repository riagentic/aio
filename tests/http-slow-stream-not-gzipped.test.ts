// A SLOW body is a stream, and a stream goes out as written — also to a
// client that accepts gzip, i.e. every browser.
//
// `encodeResponse` stops buffering after MAX_BUFFER_MS and hands the body
// back, but then piped it through `CompressionStream("gzip")`, which has no
// per-chunk flush: a text/plain log tail or a streaming SSR render arrived all
// at once when the body ENDED (or ~32 KB later). Measured through a real
// route: 5 lines 200 ms apart, all five delivered together at 1 s with
// `Accept-Encoding: gzip`, one by one without it.
import { assert, assertEquals } from "@std/assert";
import { encodeResponse } from "../src/server/http-encoding.ts";

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

Deno.test("encodeResponse: a slow body reaches a gzip-accepting client chunk by chunk", async () => {
  for (const ct of ["text/plain", "text/html", "application/json"]) {
    const t0 = Date.now();
    const resp = await encodeResponse(
      new Request("http://x/s", {
        headers: { "Accept-Encoding": "gzip, deflate, br" },
      }),
      slow(5, 200, ct),
    );
    assertEquals(resp.headers.get("Content-Encoding"), null, ct);
    const reader = resp.body!.getReader();
    const first = await reader.read();
    const at = Date.now() - t0;
    assertEquals(new TextDecoder().decode(first.value), "chunk0\n", ct);
    assert(at < 600, `${ct}: the first chunk waited ${at}ms for the end`);
    await reader.cancel();
  }
});

Deno.test("encodeResponse: a LONG body that keeps producing is still compressed — only a pause makes it slow", async () => {
  // A CSV export from a DB cursor: a chunk every few ms, well past the
  // buffering deadline. It is long, not paused — sent raw it was 205× bigger.
  const row = "id,name,amount\n".repeat(400);
  const until = Date.now() + 400;
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (Date.now() > until) return c.close();
      await new Promise((r) => setTimeout(r, 5));
      c.enqueue(new TextEncoder().encode(row));
    },
  });
  const resp = await encodeResponse(
    new Request("http://x/export", { headers: { "Accept-Encoding": "gzip" } }),
    new Response(body, { headers: { "Content-Type": "text/csv" } }),
  );
  assertEquals(resp.headers.get("Content-Encoding"), "gzip");
  await resp.arrayBuffer(); // read to the end: the source's own timer ends
});

Deno.test("encodeResponse: a body that pauses AFTER the buffering deadline still reaches the client — the gzip is flushed", async () => {
  // A streaming SSR render: the shell in a burst (a chunk every 30 ms, so it
  // is "long", not paused, at the 100 ms deadline), then a slow query. It is
  // gzipped — and `CompressionStream` held every byte after the burst until
  // the end: a 10-byte gzip header was all the client had for the whole wait.
  const burst = 5, wait = 1500;
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (i > burst) return c.close();
      await new Promise((r) => setTimeout(r, i < burst ? 30 : wait));
      c.enqueue(new TextEncoder().encode(`<p>part${i++}</p>\n`));
    },
  });
  const t0 = Date.now();
  const resp = await encodeResponse(
    new Request("http://x/ssr", { headers: { "Accept-Encoding": "gzip" } }),
    new Response(body, { headers: { "Content-Type": "text/html" } }),
  );
  assertEquals(resp.headers.get("Content-Encoding"), "gzip");
  const text = resp.body!.pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream()).getReader();
  let seen = "";
  while (!seen.includes(`part${burst - 1}`)) {
    const r = await text.read();
    if (r.done) break;
    seen += r.value;
  }
  const at = Date.now() - t0;
  assert(
    at < wait,
    `the burst before the pause arrived at ${at}ms — held for the end`,
  );
  let rest = "";
  while (true) {
    const r = await text.read();
    if (r.done) break;
    rest += r.value;
  }
  assert(
    (seen + rest).includes(`part${burst}`),
    "the body after the pause is whole",
  );
});

Deno.test("encodeResponse: a feed that never pauses (a 30 ms tick) still reaches the client while it runs", async () => {
  // It never goes quiet for IDLE_MS, so an idle-only flush never fired and
  // the client decoded 0 of 100 lines in 3 s (measured). Held bytes go once
  // they have waited IDLE_MS.
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (i >= 40) return c.close();
      await new Promise((r) => setTimeout(r, 30));
      c.enqueue(new TextEncoder().encode(`line${i++} ${"x".repeat(40)}\n`));
    },
  });
  const t0 = Date.now();
  const resp = await encodeResponse(
    new Request("http://x/feed", { headers: { "Accept-Encoding": "gzip" } }),
    new Response(body, { headers: { "Content-Type": "text/plain" } }),
  );
  assertEquals(resp.headers.get("Content-Encoding"), "gzip");
  const reader = resp.body!.pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (!text.includes("line0")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
  }
  const at = Date.now() - t0;
  assert(text.includes("line0"), "line0 never arrived");
  assert(at < 800, `line0 arrived at ${at}ms — held until the feed ended`);
  while (!(await reader.read()).done) {
    /* to the end: the source's timer ends */
  }
});
