// A 304 answers a conditional GET — never a POST whose handler already ran.
//
// `encodeResponse` is the finisher every response passes through, AFTER the
// route handler. It honoured `If-None-Match` on every method, so a POST that
// sent `If-None-Match: *` (or replayed the ETag a previous POST returned) got
// an empty 304 back while its handler had already created the row: the write
// happened and the client was told nothing, with no body to read the result
// from. RFC 9110 §13.1.2: on a non-GET/HEAD method the header is a
// precondition, not a cache hit.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { encodeResponse } from "../src/server/http-encoding.ts";

const PAD = "y".repeat(2000);
const json = () =>
  new Response(JSON.stringify({ created: true, pad: PAD }), {
    headers: { "content-type": "application/json" },
  });

Deno.test("encoding: If-None-Match never turns a non-GET 200 into a 304", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const first = await encodeResponse(
      new Request("http://x/api", { method, body: "{}" }),
      json(),
    );
    const tag = first.headers.get("ETag") ?? "*";
    await first.body?.cancel();
    for (const inm of ["*", tag]) {
      const r = await encodeResponse(
        new Request("http://x/api", {
          method,
          body: "{}",
          headers: { "If-None-Match": inm },
        }),
        json(),
      );
      assertEquals(r.status, 200, `${method} If-None-Match: ${inm}`);
      assertEquals((await r.json()).created, true);
    }
  }
  // …and GET still revalidates — the fix narrows the method, not the feature.
  const g = await encodeResponse(new Request("http://x/a"), json());
  const tag = g.headers.get("ETag")!;
  await g.body?.cancel();
  const again = await encodeResponse(
    new Request("http://x/a", { headers: { "If-None-Match": tag } }),
    json(),
  );
  assertEquals(again.status, 304);
});

Deno.test("server: a POST route with If-None-Match returns its body, not an empty 304", async () => {
  let runs = 0;
  const c = cell("inm_post", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });
  await using srv = await testServer({
    cells: [c],
    routes: {
      "/api/create": async (req: Request) => {
        runs++;
        await req.text();
        return json();
      },
    },
  });
  const plain = await srv.fetch("/api/create", { method: "POST", body: "{}" });
  const tag = plain.headers.get("etag") ?? "*";
  await plain.body?.cancel();
  for (const inm of ["*", tag]) {
    const r = await srv.fetch("/api/create", {
      method: "POST",
      body: "{}",
      headers: { "If-None-Match": inm },
    });
    assertEquals(r.status, 200, `POST If-None-Match: ${inm}`);
    assertEquals((await r.json()).created, true);
  }
  assertEquals(runs, 3);
});
