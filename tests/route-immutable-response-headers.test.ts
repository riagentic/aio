// A raw route returning `Response.redirect()` (or a proxied `fetch()` response)
// must reach the client. Both carry IMMUTABLE headers per the fetch spec, and
// the response finisher in server.ts (`handleRequest`) calls
// `resp.headers.set(...)` to add the security headers — which throws, so the
// request dies with a 500 instead of the 302 the app returned.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

Deno.test("a raw route returning Response.redirect() is a 302, not a 500", async () => {
  const c = cell("r8_redir", { state: { n: 0 }, methods: {} });
  await using srv = await testServer({
    cells: [c],
    routes: {
      "/go": () => Response.redirect("http://127.0.0.1/elsewhere", 302),
    },
  });
  const r = await srv.fetch("/go", { redirect: "manual" });
  await r.body?.cancel();
  assertEquals(r.status, 302);
  assertEquals(r.headers.get("location"), "http://127.0.0.1/elsewhere");
  assert(r.headers.get("x-content-type-options") === "nosniff");
});

Deno.test("a raw route proxying a fetch() response is served", async () => {
  const c = cell("r8_proxy", { state: { n: 0 }, methods: {} });
  const upstream = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    () => new Response("upstream-body", { headers: { "x-up": "1" } }),
  );
  try {
    const port = upstream.addr.port;
    await using srv = await testServer({
      cells: [c],
      routes: {
        "/proxy": () => fetch(`http://127.0.0.1:${port}/`),
      },
    });
    const r = await srv.fetch("/proxy");
    assertEquals(r.status, 200);
    assertEquals(await r.text(), "upstream-body");
  } finally {
    await upstream.shutdown();
  }
});

// Shared-key mode: the request that proves the key with `?token=` (the share
// link `aio` prints) gets the key cookie APPENDED to whatever answers it — and
// that append threw on an immutable response, so a redirect route reached by
// the share link answered 500 instead of its 302.
Deno.test("shared key: ?token= into a Response.redirect() route is a 302 that carries the key cookie", async () => {
  const { join } = await import("@std/path");
  const baseDir = await Deno.makeTempDir({ prefix: "aio-key-redir-" });
  const srv = await testServer({
    appId: "keyredir",
    cells: [cell("keyredir", { state: { n: 0 }, methods: {} })],
    expose: true,
    key: "secret-key-123",
    baseDir,
    routes: {
      "/go": () => Response.redirect("https://127.0.0.1/elsewhere", 302),
    },
  } as never);
  const cert = await Deno.readTextFile(
    join(baseDir, ".aio", "data", "tls", "tls-cert.pem"),
  );
  const client = Deno.createHttpClient({ caCerts: [cert] });
  try {
    const r = await fetch(
      `https://127.0.0.1:${srv.port}/go?token=secret-key-123`,
      { client, redirect: "manual" } as RequestInit & {
        client: Deno.HttpClient;
      },
    );
    await r.body?.cancel();
    assertEquals(r.status, 302);
    assertEquals(r.headers.get("location"), "https://127.0.0.1/elsewhere");
    assert(r.headers.get("set-cookie")?.startsWith("aio_key_keyredir="));
  } finally {
    client.close();
    await srv.close();
    await Deno.remove(baseDir, { recursive: true });
  }
});
