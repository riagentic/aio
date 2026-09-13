// plugin-routes-app-wins.test.ts — "the app always wins" holds for PATTERNS,
// and two plugins cannot claim one route under two param names.
//
// aio.ts merged routes as `{ ...plugin, ...app }`. A key keeps its FIRST
// insertion position even when a later spread overwrites it, and the matcher
// tries patterns in insertion order — so every plugin pattern ran before every
// app pattern: a plugin's `/files/:name` answered the app's `/files/*`, and a
// plugin's `/*` answered everything, the app's `/api/:thing` included. Only an
// identical key was ever overridden. Separately, the plugin collision check
// compared pattern TEXT, so `/u/:id` and `/u/:name` — one route to the matcher
// — were two claims, and the first plugin silently answered for both.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { definePlugin, resolvePlugins } from "../src/server/plugin.ts";
import { route } from "../src/server/route.ts";

Deno.test("plugin routes: the APP's patterns match before a plugin's", async () => {
  const files = definePlugin({
    name: "files",
    routes: {
      "/files/:name": route((ctx) => ctx.text("PLUGIN files")),
      "/*": route((ctx) => ctx.text("PLUGIN catch-all")),
      "/same": () => new Response("PLUGIN same"),
    },
  });
  const marker = cell("plugin-routes-app-wins", {
    state: { n: 0 },
    methods: {},
  });
  await using server = await testServer({
    cells: [marker],
    plugins: [files],
    routes: {
      "/files/*": route((ctx) => ctx.text("APP files " + ctx.params["*"])),
      "/api/:thing": route((ctx) => ctx.text("APP api " + ctx.params.thing)),
      "/same": () => new Response("APP same"),
    },
  });
  const text = async (p: string) => await (await server.fetch(p)).text();
  assertEquals(await text("/files/a.txt"), "APP files a.txt");
  assertEquals(await text("/api/users"), "APP api users");
  assertEquals(await text("/same"), "APP same");
  // What the app did not claim is still the plugin's.
  assertEquals(await text("/elsewhere"), "PLUGIN catch-all");
});

Deno.test("plugin routes: `/u/:id` and `/u/:name` from two plugins collide, naming both spellings", async () => {
  const a = definePlugin({
    name: "a",
    routes: { "/u/:id": () => new Response("a") },
  });
  const b = definePlugin({
    name: "b",
    routes: { "/u/:name": () => new Response("b") },
  });
  let msg = "";
  try {
    await resolvePlugins([a, b], { appId: "x", dev: true });
  } catch (e) {
    msg = (e as Error).message;
  }
  assertStringIncludes(msg, 'route "/u/:name" (the same route as "/u/:id")');
  assertStringIncludes(msg, 'claimed by both "a" and "b"');

  // Different shapes are different routes.
  const c = definePlugin({
    name: "c",
    routes: { "/u/:id/posts": () => new Response("c") },
  });
  const r = await resolvePlugins([a, c], { appId: "x", dev: true });
  assertEquals(Object.keys(r.routes), ["/u/:id", "/u/:id/posts"]);
});
