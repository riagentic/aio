// route-literal-non-ascii-key.test.ts — a route key written as text matches
// the request that asks for it.
//
// `url.pathname` arrives percent-encoded (`/café` → `/caf%C3%A9`); the matcher
// looked the raw pathname up in `config.routes`, so a literal `"/café"` route
// never matched and the request fell through to the app shell — 200 text/html,
// which a caller reads as success. The fix canonicalises KEYS with the same
// parser that produced the pathname; it never decodes the request, so an
// encoded slash still cannot reach a route written with a real one.
import { assertEquals, assertNotEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { route } from "../src/server/route.ts";

Deno.test("routes: a non-ASCII literal key and pattern match their encoded request path", async () => {
  const marker = cell("route-non-ascii", { state: { n: 0 }, methods: {} });
  await using server = await testServer({
    cells: [marker],
    routes: {
      "/café": route((ctx) => ctx.text("cafe")),
      "/menü/:item": route((ctx) => ctx.text("menu " + ctx.params.item)),
      "/with space": () => new Response("space"),
      "/a/b": () => new Response("a/b"),
    },
  });
  const res = await server.fetch("/café");
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "cafe");
  assertEquals(await (await server.fetch("/caf%C3%A9")).text(), "cafe");
  assertEquals(await (await server.fetch("/menü/tee")).text(), "menu tee");
  assertEquals(await (await server.fetch("/with%20space")).text(), "space");
  // Never by decoding the request: an encoded `/` is not a path separator.
  const slash = await server.fetch("/a%2Fb");
  assertNotEquals(await slash.text(), "a/b");
});
