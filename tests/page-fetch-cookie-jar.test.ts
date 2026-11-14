// testPageFetch's jar must behave as a browser page's, in both directions:
// keep what a browser keeps (a Set-Cookie on a redirect hop — the Fetch
// spec's HTTP-redirect fetch stores cookies per response) and drop/withhold
// what a browser drops (Max-Age <= 0, a past Expires, a cookie outside its
// Path). It followed redirects inside the real fetch, so a `303 +
// Set-Cookie: session=…` login was lost; cleared only on `Max-Age=0` or an
// empty value; and sent a `Path=/admin` cookie everywhere.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { freePort, testPageFetch } from "../src/testing/server-test.ts";

async function withServer(
  handler: (req: Request) => Response | Promise<Response>,
  body: (url: string) => Promise<void>,
) {
  const port = freePort();
  const ac = new AbortController();
  const srv = Deno.serve(
    { port, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
    handler,
  );
  try {
    await body(`http://127.0.0.1:${port}`);
  } finally {
    ac.abort();
    await srv.finished;
  }
}

const echo = (req: Request) =>
  Response.json({
    path: new URL(req.url).pathname,
    method: req.method,
    cookie: req.headers.get("cookie"),
  });

Deno.test("testPageFetch: a Set-Cookie on a redirect hop is kept and sent on", async () => {
  await withServer((req) => {
    const p = new URL(req.url).pathname;
    if (p === "/login") {
      return new Response(null, {
        status: 303,
        headers: { location: "/me", "set-cookie": "sid=abc; Path=/; HttpOnly" },
      });
    }
    return echo(req);
  }, async (url) => {
    using page = testPageFetch({ url });
    const r = await page.fetch("/login", { method: "POST", body: "x" });
    assertEquals(r.redirected, true);
    assertEquals(await r.json(), {
      path: "/me",
      method: "GET",
      cookie: "sid=abc",
    });
    assertEquals(page.cookies.get("sid"), "abc");
  });
});

Deno.test("testPageFetch: 307 resends method and body; 302 on POST becomes GET", async () => {
  await withServer(async (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/a") return Response.redirect(new URL("/b", req.url), 307);
    if (p === "/c") return Response.redirect(new URL("/b", req.url), 302);
    return Response.json({ method: req.method, body: await req.text() });
  }, async (url) => {
    using page = testPageFetch({ url });
    assertEquals(
      await (await page.fetch("/a", { method: "POST", body: "hi" })).json(),
      { method: "POST", body: "hi" },
    );
    assertEquals(
      await (await page.fetch(
        new Request(`${url}/a`, { method: "PUT", body: "r" }),
      ))
        .json(),
      { method: "PUT", body: "r" },
    );
    assertEquals(
      await (await page.fetch("/c", { method: "POST", body: "hi" })).json(),
      { method: "GET", body: "" },
    );
  });
});

Deno.test("testPageFetch: a redirect loop fails loud; redirect modes are honoured", async () => {
  await withServer((req) => {
    const p = new URL(req.url).pathname;
    if (p === "/loop") return Response.redirect(new URL("/loop", req.url), 302);
    if (p === "/once") {
      return new Response(null, {
        status: 302,
        headers: { location: "/x", "set-cookie": "m=1" },
      });
    }
    return echo(req);
  }, async (url) => {
    using page = testPageFetch({ url });
    await assertRejects(
      () => page.fetch("/loop"),
      TypeError,
      "more than 20 redirects",
    );
    const manual = await page.fetch("/once", { redirect: "manual" });
    assertEquals(manual.status, 302);
    assertEquals(page.cookies.get("m"), "1", "a manual hop still sets cookies");
    await assertRejects(
      () => page.fetch("/once", { redirect: "error" }),
      TypeError,
    );
  });
});

for (
  const clear of [
    "sid=gone; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "sid=gone; Path=/; Max-Age=-1",
    "sid=gone; Path=/; Max-Age=0",
    // Max-Age wins over Expires (RFC 6265 §5.3).
    "sid=gone; Path=/; Expires=Fri, 01 Jan 2100 00:00:00 GMT; Max-Age=0",
  ]
) {
  Deno.test(`testPageFetch honours a cookie clear: ${clear}`, async () => {
    await withServer((req) => {
      const p = new URL(req.url).pathname;
      if (p === "/in") {
        return new Response("ok", {
          headers: { "set-cookie": "sid=abc; Path=/" },
        });
      }
      if (p === "/out") {
        return new Response("ok", { headers: { "set-cookie": clear } });
      }
      return echo(req);
    }, async (url) => {
      using page = testPageFetch({ url });
      await (await page.fetch("/in")).text();
      await (await page.fetch("/out")).text();
      assertEquals(
        page.cookies.has("sid"),
        false,
        "cleared cookie still in jar",
      );
      assertEquals((await (await page.fetch("/")).json()).cookie, null);
    });
  });
}

Deno.test("testPageFetch: a cookie goes only where its Path matches", async () => {
  await withServer((req) => {
    const p = new URL(req.url).pathname;
    if (p === "/admin/login") {
      return new Response("ok", {
        headers: [
          ["set-cookie", "adm=1; Path=/admin"],
          // No Path: the default-path is the request's directory, /admin.
          ["set-cookie", "dflt=2"],
          ["set-cookie", "all=3; Path=/"],
        ],
      });
    }
    return echo(req);
  }, async (url) => {
    using page = testPageFetch({ url });
    await (await page.fetch("/admin/login")).text();
    const at = async (p: string) => (await (await page.fetch(p)).json()).cookie;
    assertEquals(await at("/api/x"), "all=3");
    assertEquals(
      await at("/administrator"),
      "all=3",
      "a prefix is not a path match",
    );
    const inside = await at("/admin/users");
    assert(inside.includes("adm=1") && inside.includes("dflt=2"), inside);
    assert(inside.endsWith("all=3"), `longer paths first: ${inside}`);
    assertEquals(await at("/admin"), inside);
  });
});
