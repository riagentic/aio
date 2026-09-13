// The server's route matcher and the client router answer the same path the
// same way.
//
// They are two matchers on purpose — `matchRoute` (server `routes:`) keeps a
// `*` capture percent-ENCODED because it is a path, `matchPath` (`<Route>`)
// decodes it for display — but on the SHAPE of a path they must agree, or one
// app answers a URL from its HTTP route and renders nothing for it (or the
// reverse). Measured before this:
//
//   GET /api/get/                     → 200 text/html, the SPA shell, not the route
//   matchRoute("/users", "/users/")   → null      matchPath → {}
//   matchRoute("/files/*", "/files")  → {"*":""}  matchPath → null
//
// Decided, both sides: a trailing slash is the same path (except the root's),
// and `/x/*` matches `/x` with `*` = "". One table, both matchers.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { matchRoute, route } from "../src/server/route.ts";
import { matchPath } from "../src/air/router-core.ts";
import { testServer } from "../src/testing/server-test.ts";

const TABLE: Array<[string, string, Record<string, string> | null]> = [
  ["/users", "/users", {}],
  ["/users", "/users/", {}],
  ["/users/", "/users", {}],
  ["/users", "/users//", null],
  ["/users", "/user", null],
  ["/users", "/users/42", null],
  ["/users/:id", "/users/42", { id: "42" }],
  ["/users/:id", "/users/42/", { id: "42" }],
  ["/users/:id", "/users/", null],
  ["/users/:id", "/users", null],
  ["/users/:id", "/users/1/2", null],
  ["/users/:id", "/users/a%20b", { id: "a b" }],
  ["/a/:x/b", "/a/1/b/", { x: "1" }],
  ["/files/*", "/files", { "*": "" }],
  ["/files/*", "/files/", { "*": "" }],
  ["/files/*", "/files/a/b", { "*": "a/b" }],
  ["/files/*", "/files/a/b/", { "*": "a/b" }],
  ["/files/*", "/filesx", null],
  ["/files/*", "/other/a", null],
  ["/files/:dir/*", "/files/x", { dir: "x", "*": "" }],
  ["/files/:dir/*", "/files/x/y/z", { dir: "x", "*": "y/z" }],
  ["/*", "/", { "*": "" }],
  ["/*", "/a/b", { "*": "a/b" }],
  ["/", "/", {}],
  ["/", "/x", null],
];

Deno.test("route matching: server matchRoute and client matchPath agree on one table", () => {
  for (const [pattern, path, want] of TABLE) {
    const at = `${pattern} ← ${path}`;
    assertEquals(matchRoute(pattern, path), want, `server: ${at}`);
    assertEquals(matchPath(pattern, path), want, `client: ${at}`);
  }
});

Deno.test("routes over HTTP: a trailing slash reaches the route; /x/* answers /x", async () => {
  await using srv = await testServer({
    cells: [cell("route_parity", { state: {}, methods: {} })],
    routes: {
      "/api/get": route((ctx) => ctx.json({ route: "get" }), { method: "GET" }),
      "/api/slash/": route((ctx) => ctx.json({ route: "slash" })),
      "/files/*": route((ctx) => ctx.json(ctx.params)),
      "/both": () => new Response("bare"),
      "/both/": () => new Response("slashed"),
    },
  });
  const json = async (p: string) => {
    const r = await srv.fetch(p);
    const t = await r.text();
    assertEquals(
      r.headers.get("content-type")?.startsWith("application/json"),
      true,
      `${p}: ${t.slice(0, 60)}`,
    );
    return JSON.parse(t);
  };
  assertEquals(await json("/api/get"), { route: "get" });
  assertEquals(await json("/api/get/"), { route: "get" });
  assertEquals(await json("/api/slash"), { route: "slash" });
  assertEquals(await json("/api/slash/"), { route: "slash" });
  assertEquals(await json("/files"), { "*": "" });
  assertEquals(await json("/files/a/b/"), { "*": "a/b" });
  // An app that declared both spellings keeps both, exactly as written.
  assertEquals(await (await srv.fetch("/both")).text(), "bare");
  assertEquals(await (await srv.fetch("/both/")).text(), "slashed");
});
