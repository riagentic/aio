// route() — ergonomic HTTP routes (realitio): :param matching, method guard,
// cookies, and a JSON helper on top of the existing `routes: {}` config.
import { assert, assertEquals } from "@std/assert";
import {
  matchRoute,
  parseCookies,
  route,
  serializeCookie,
} from "../src/server/route.ts";

// ── matchRoute ──

Deno.test("matchRoute: literal exact match", () => {
  assertEquals(matchRoute("/a/b", "/a/b"), {});
  assertEquals(matchRoute("/a/b", "/a/c"), null);
});

Deno.test("matchRoute: :param capture + decode", () => {
  assertEquals(matchRoute("/users/:id", "/users/42"), { id: "42" });
  assertEquals(matchRoute("/u/:a/:b", "/u/x/y"), { a: "x", b: "y" });
  assertEquals(matchRoute("/users/:id", "/users/a%20b"), { id: "a b" });
});

Deno.test("matchRoute: length mismatch → null; empty param → null", () => {
  assertEquals(matchRoute("/users/:id", "/users"), null);
  assertEquals(matchRoute("/users/:id", "/users/1/2"), null);
  assertEquals(matchRoute("/users/:id", "/users/"), null);
});

Deno.test("matchRoute: trailing * captures the rest", () => {
  assertEquals(matchRoute("/files/*", "/files/a/b/c"), { "*": "a/b/c" });
  assertEquals(matchRoute("/files/:dir/*", "/files/x/y/z"), {
    dir: "x",
    "*": "y/z",
  });
});

// ── cookies ──

Deno.test("parseCookies: name=value pairs, decoded", () => {
  assertEquals(parseCookies("a=1; b=hello%20world; c="), {
    a: "1",
    b: "hello world",
    c: "",
  });
  assertEquals(parseCookies(null), {});
});

Deno.test("serializeCookie: flags + attributes", () => {
  assertEquals(
    serializeCookie("sid", "abc", {
      httpOnly: true,
      path: "/",
      sameSite: "Lax",
    }),
    "sid=abc; Path=/; HttpOnly; SameSite=Lax",
  );
  assertEquals(serializeCookie("k", "a b"), "k=a%20b");
});

// ── route() handler ──

const call = (
  h: ReturnType<typeof route>,
  init: { method?: string; url?: string; headers?: Record<string, string> },
  match?: { params?: Record<string, string> },
) =>
  h(
    new Request(init.url ?? "http://x/users/42", {
      method: init.method ?? "GET",
      headers: init.headers,
    }),
    { params: match?.params ?? {} },
  );

Deno.test("route: params + json helper", async () => {
  const h = route((ctx) =>
    ctx.json({ id: ctx.params.id, q: ctx.query.get("x") })
  );
  const res = await call(h, { url: "http://x/users/42?x=1" }, {
    params: { id: "42" },
  });
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assertEquals(await res.json(), { id: "42", q: "1" });
});

Deno.test("route: method guard → 405 with Allow", async () => {
  const h = route((ctx) => ctx.text("ok"), { method: "POST" });
  const res = await call(h, { method: "GET" });
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("Allow"), "POST");
});

Deno.test("route: setCookie is applied to the returned Response", async () => {
  const h = route((ctx) => {
    ctx.setCookie("sid", "s1", { httpOnly: true, path: "/" });
    return ctx.json({ ok: true });
  });
  const res = await call(h, {});
  assertEquals(res.headers.get("set-cookie"), "sid=s1; Path=/; HttpOnly");
  await res.body?.cancel();
});

Deno.test("route: reads request cookies", async () => {
  const h = route((ctx) => ctx.json({ sid: ctx.cookies.sid }));
  const res = await call(h, { headers: { cookie: "sid=abc; other=1" } });
  assertEquals(await res.json(), { sid: "abc" });
});

Deno.test("route: setCookie applies even when the handler returns a raw Response", async () => {
  const h = route((ctx) => {
    ctx.setCookie("x", "1");
    return new Response("raw", { status: 201 });
  });
  const res = await call(h, {});
  assertEquals(res.status, 201);
  assertEquals(res.headers.get("set-cookie"), "x=1");
  await res.body?.cancel();
});

Deno.test("route: redirect helper", async () => {
  const h = route((ctx) => ctx.redirect("/login"));
  const res = await call(h, {});
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("Location"), "/login");
  await res.body?.cancel();
});

// ── end to end: a booted server serves a :param route ──

/** A guaranteed-free port (bind :0, read it, release) — avoids cross-file
 *  collisions under parallel test load. */
function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const p = (l.addr as Deno.NetAddr).port;
  l.close();
  return p;
}

Deno.test("route e2e: a :param route with a cookie is served by a real app", async () => {
  const { aio, cell, route: routeFn } = await import("../mod.ts");
  const port = freePort();
  const counter = cell("counter", { state: { n: 0 }, methods: {} });
  const app = await aio.run({
    cells: [counter],
    appId: "route-e2e",
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await Deno.makeTempDir(),
    routes: {
      "/api/items/:id": routeFn((ctx) => {
        ctx.setCookie("seen", ctx.params.id!, { path: "/" });
        return ctx.json({ id: ctx.params.id, method: ctx.req.method });
      }),
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/items/abc`);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { id: "abc", method: "GET" });
    assert(res.headers.get("set-cookie")?.includes("seen=abc"), "cookie set");
  } finally {
    await app.close();
  }
});

// ── Hardening: attacker-controlled input on the request path ──

Deno.test("matchRoute + parseCookies: a malformed %-escape stays literal, never throws", () => {
  // `decodeURIComponent("%zz")` raises URIError. Both of these run on every
  // request (cookies now also feed serverRequest()), so a bad escape must not
  // be able to 500 a route — or take a WS upgrade down.
  assertEquals(matchRoute("/users/:id", "/users/%zz"), { id: "%zz" });
  assertEquals(parseCookies("sid=%zz; ok=a%20b"), { sid: "%zz", ok: "a b" });
  assertEquals(parseCookies("bare=%E0%A4%A"), { bare: "%E0%A4%A" });
});

Deno.test("serializeCookie: a name that would inject attributes is refused", () => {
  // Only the VALUE is percent-encoded; a name goes in verbatim, so an
  // untrusted name could otherwise append `; Path=/; HttpOnly` or a second
  // cookie entirely.
  for (
    const bad of ["sid; Path=/", "a=b", "sid\nSet-Cookie: x=y", "s id", ""]
  ) {
    let threw = false;
    try {
      serializeCookie(bad, "v");
    } catch {
      threw = true;
    }
    assert(threw, `invalid cookie name accepted: ${JSON.stringify(bad)}`);
  }
  // Legitimate token names still work, values are still encoded.
  assertEquals(serializeCookie("sid", "a b;c"), "sid=a%20b%3Bc");
  assertEquals(
    serializeCookie("__Host-x", "1", { path: "/" }),
    "__Host-x=1; Path=/",
  );
});
