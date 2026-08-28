// route() — ergonomic HTTP routes: :param matching, method guard,
// cookies, and a JSON helper on top of the existing `routes: {}` config.
import { assert, assertEquals } from "@std/assert";
import { interceptConsole } from "./console-capture.ts";
import {
  isReservedRoutePath,
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

// ── The reserved namespace is reserved against PATTERNS *and* PATHS ──

Deno.test("isReservedRoutePath: the framework's own paths, one decider", () => {
  for (const p of ["/ws", "/__aio", "/__aio/health", "/__aio/trojan/state"]) {
    assert(isReservedRoutePath(p), p);
  }
  for (const p of ["/", "/api/ws", "/wsx", "/aio", "/x/__aio"]) {
    assert(!isReservedRoutePath(p), p);
  }
});

Deno.test("route e2e: a catch-all route cannot swallow /__aio or /ws", async () => {
  // A `/*` SPA fallback is a normal thing to write. The boot reservation only
  // ever checked the pattern TEXT, so this pattern used to capture
  // /__aio/health, /__aio/metrics, /__aio/snapshot and every /__aio/**.ts
  // module the dev shell imports — the whole framework namespace, silently.
  const { aio, cell, route: routeFn } = await import("../mod.ts");
  const port = freePort();
  const counter = cell("route-reserved", { state: { n: 0 }, methods: {} });
  const app = await aio.run({
    cells: [counter],
    appId: "route-reserved",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await Deno.makeTempDir(),
    routes: { "/*": routeFn((ctx) => ctx.text("SPA:" + ctx.params["*"])) },
  });
  try {
    const health = await fetch(`http://127.0.0.1:${port}/__aio/health`);
    const healthBody = await health.text();
    assert(
      !healthBody.startsWith("SPA:"),
      `/__aio/health was captured by the app route: ${healthBody}`,
    );
    assert(healthBody.includes("route-reserved"), healthBody);

    const metrics = await fetch(`http://127.0.0.1:${port}/__aio/metrics`);
    const metricsBody = await metrics.text();
    assert(!metricsBody.startsWith("SPA:"), metricsBody);
    assert(metricsBody.includes("aio_uptime_seconds"), metricsBody);

    // A path the app really does own still reaches the handler.
    const own = await fetch(`http://127.0.0.1:${port}/deep/link`);
    assertEquals(await own.text(), "SPA:deep/link");
  } finally {
    await app.close();
  }
});

Deno.test("route e2e: a broken handler fails ONE request, loudly — never the process", async () => {
  // App routes are app code. A throw used to reach Deno.serve, which answered a
  // bare 500 naming neither route nor method; returning a NON-Response (the raw
  // `(req) => Response` form is public API — forget a `return`) escaped as an
  // UNHANDLED REJECTION at the serve boundary, which this app's crash handler
  // reports as a process-level fault. This test would fail on that rejection
  // alone.
  const { aio, cell, route: routeFn } = await import("../mod.ts");
  const port = freePort();
  const c = cell("route-broken", { state: { n: 0 }, methods: {} });
  const logged: string[] = [];
  const restoreConsole = interceptConsole(logged);
  const app = await aio.run({
    cells: [c],
    appId: "route-broken",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await Deno.makeTempDir(),
    routes: {
      "/boom": routeFn(() => {
        throw new Error("handler exploded");
      }),
      "/rej/:id": routeFn(() => Promise.reject(new Error("handler rejected"))),
      // A raw handler that forgets to return a Response.
      "/bad": (() => ({ oops: true })) as unknown as Parameters<
        typeof routeFn
      >[0] extends never ? never : never,
      "/ok": routeFn((ctx) => ctx.text("fine")),
    } as never,
  });
  try {
    for (const p of ["/boom", "/rej/7", "/bad"]) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      assertEquals(res.status, 500, p);
      assertEquals(await res.text(), "Internal Server Error");
    }
    // The server is still serving.
    const ok = await fetch(`http://127.0.0.1:${port}/ok`);
    assertEquals(await ok.text(), "fine");
  } finally {
    restoreConsole();
    await app.close();
  }
  const all = logged.join("\n");
  // Attributed: which route, which method, which path, and what went wrong.
  assert(all.includes('route "/boom" (GET /boom) threw'), all);
  assert(all.includes("handler exploded"), all);
  assert(all.includes('route "/rej/:id" (GET /rej/7) threw'), all);
  assert(all.includes('route "/bad" (GET /bad) returned object'), all);
});

// `{...init.headers}` is wrong for two of the three legal HeadersInit forms: a
// `Headers` instance has no own enumerable properties (every header the caller
// set vanished), and the tuple form spreads into `{"0": [...]}` — a header
// literally named `0`. Both type-check, because the parameter is ResponseInit.
Deno.test("route: ctx.json/text keep caller headers in every HeadersInit form", async () => {
  const req = () => new Request("http://x/y");

  const withInstance = route((ctx) =>
    ctx.json({ ok: 1 }, { headers: new Headers({ "x-total-count": "42" }) })
  );
  const a = await (withInstance as unknown as (
    r: Request,
    c: unknown,
  ) => Promise<Response>)(req(), {});
  assertEquals(a.headers.get("x-total-count"), "42");
  assertEquals(
    a.headers.get("content-type"),
    "application/json; charset=utf-8",
  );

  const withTuples = route((ctx) =>
    ctx.text("hi", { headers: [["x-a", "1"]] })
  );
  const b = await (withTuples as unknown as (
    r: Request,
    c: unknown,
  ) => Promise<Response>)(req(), {});
  assertEquals(b.headers.get("x-a"), "1");
  assertEquals(
    b.headers.get("0"),
    null,
    "no header may be named after an index",
  );
});

// The textbook login handler: queue a session cookie, return a redirect built
// by `Response.redirect()`. That response's headers are IMMUTABLE per the
// fetch spec, so appending threw out of the handler — 500, no cookie, no
// redirect — while this helper's docstring promises setCookie always lands.
Deno.test("route: setCookie survives a handler-built Response.redirect()", async () => {
  const h = route((ctx) => {
    ctx.setCookie("sid", "abc", { path: "/" });
    return Response.redirect("http://x/dashboard", 302);
  });
  const res = await (h as unknown as (
    r: Request,
    c: unknown,
  ) => Promise<Response>)(new Request("http://x/login"), {});
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "http://x/dashboard");
  assert(
    (res.headers.get("set-cookie") ?? "").includes("sid=abc"),
    "the session cookie must reach the browser",
  );
});
