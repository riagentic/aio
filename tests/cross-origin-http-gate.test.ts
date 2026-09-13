// A state-changing HTTP request from ANOTHER ORIGIN is refused — real servers.
//
// The WebSocket upgrade always checked `Origin`; plain HTTP never did. So an
// app route took a cross-origin POST (a form, or a `text/plain` fetch — no
// CORS preflight needed) from any page the user visited: anonymously on a
// public app, and AS the signed-in user on an `auth: true` or shared-key app,
// whose cookie the browser attaches. A sibling loopback port is the same
// "site", so SameSite=Strict does not stop it. docs/basics/positioning.md has
// long promised a 403 unless the origin is in `allowedOrigins`.
//
// Requests with NO Origin (webhook senders, curl, native clients) carry no
// ambient cookie a page could borrow and are NOT affected — pinned below too.
//
// Also: an `allowedOrigins` entry written as a full origin means THAT origin —
// scheme, host and port — not every port and scheme on its host.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { freePort, testServer } from "../src/testing/server-test.ts";
import type { RouteMatch } from "../src/server/route.ts";

const EVIL = "https://evil.example";

function mkRoutes(hits: string[]) {
  const handler = (req: Request, m?: RouteMatch) => {
    hits.push(`${req.method} user=${m?.user?.id ?? "-"}`);
    return new Response("done");
  };
  return { "/api/wipe": handler };
}

async function post(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "text/plain", ...headers },
    body: "x",
  });
  return { status: r.status, text: await r.text() };
}

Deno.test("cross-origin: a PUBLIC app's route refuses a foreign Origin, keeps no-Origin and same-origin callers", async () => {
  const hits: string[] = [];
  await using srv = await testServer({
    cells: [cell("xo_pub", { state: { n: 0 }, methods: {} })],
    routes: mkRoutes(hits),
  });
  const u = `${srv.url}/api/wipe`;

  const evil = await post(u, { origin: EVIL });
  assertEquals(evil.status, 403, "a page on another site must not wipe it");
  assertStringIncludes(evil.text, "allowedOrigins");

  const sibling = await post(u, { origin: `http://127.0.0.1:${freePort()}` });
  assertEquals(sibling.status, 403, "another loopback port is another origin");

  const opaque = await post(u, { origin: "null" });
  assertEquals(opaque.status, 403, "an opaque origin is not this origin");

  const sameHostOtherScheme = await post(u, {
    origin: srv.url.replace("http:", "https:"),
  });
  assertEquals(sameHostOtherScheme.status, 403, "the scheme is part of it");

  assertEquals(hits, [], "no refused request may reach the handler");

  assertEquals((await post(u, {})).status, 200, "no Origin (webhook) passes");
  assertEquals(
    (await post(u, { origin: srv.url })).status,
    200,
    "the app's own page passes",
  );
  // A safe method is never Origin-gated.
  const get = await fetch(u, { headers: { origin: EVIL } });
  await get.body?.cancel();
  assertEquals(get.status, 200);
  assertEquals(hits, ["POST user=-", "POST user=-", "GET user=-"]);
});

Deno.test("cross-origin: an auth:true app refuses a foreign POST that carries the victim's session cookie", async () => {
  const hits: string[] = [];
  await using srv = await testServer({
    cells: [cell("xo_auth", { state: { n: 0 }, methods: {} })],
    auth: true,
    routes: mkRoutes(hits),
  });
  const signup = await fetch(`${srv.url}/__aio/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: srv.url },
    body: JSON.stringify({ id: "victim", password: "correct horse battery" }),
  });
  const cookie = signup.headers.getSetCookie()[0]!.split(";")[0]!;
  await signup.body?.cancel();
  assertEquals(signup.status, 201);

  const u = `${srv.url}/api/wipe`;
  const sibling = `http://127.0.0.1:${freePort()}`;
  assertEquals((await post(u, { cookie, origin: sibling })).status, 403);
  assertEquals((await post(u, { cookie, origin: EVIL })).status, 403);
  assertEquals(hits, [], "the handler must not run as the victim");
  assertEquals((await post(u, { cookie, origin: srv.url })).status, 200);
  assertEquals(hits, ["POST user=victim"]);
});

Deno.test("cross-origin: a shared-key app refuses a foreign POST riding the key cookie", async () => {
  const hits: string[] = [];
  const key = `xo-key-${crypto.randomUUID()}`;
  await using srv = await testServer({
    cells: [cell("xo_key", { state: { n: 0 }, methods: {} })],
    expose: true,
    host: "127.0.0.1",
    tls: false,
    key,
    routes: mkRoutes(hits),
  });
  // The shell load with ?token= is what hands a browser the key cookie.
  const shell = await fetch(`${srv.url}/?token=${key}`);
  const cookie = shell.headers.getSetCookie().find((c) =>
    c.startsWith("aio_key_")
  )!.split(";")[0]!;
  await shell.body?.cancel();

  const u = `${srv.url}/api/wipe`;
  assertEquals((await post(u, { cookie, origin: EVIL })).status, 403);
  assertEquals(hits, []);
  assertEquals((await post(u, { cookie, origin: srv.url })).status, 200);
  assertEquals(hits, ["POST user=-"]);
});

Deno.test("cross-origin: every other POST surface meets the same gate (trojan, snapshot)", async () => {
  await using srv = await testServer({
    cells: [cell("xo_ctl", { state: { n: 0 }, methods: {} })],
  });
  for (const path of ["/__aio/trojan/dispatch", "/__aio/snapshot"]) {
    const r = await post(`${srv.url}${path}`, { origin: EVIL, "x-aio": "1" });
    assertEquals(r.status, 403, path);
  }
});

/** Raw WS handshake, so Origin can be set; returns the status code. */
async function wsStatus(port: number, origin: string): Promise<number> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const key = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
    );
    await conn.write(
      new TextEncoder().encode(
        [
          "GET /ws HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${key}`,
          `Origin: ${origin}`,
          "",
          "",
        ].join("\r\n"),
      ),
    );
    const buf = new Uint8Array(256);
    const n = await conn.read(buf) ?? 0;
    return Number(new TextDecoder().decode(buf.subarray(0, n)).split(" ")[1]);
  } finally {
    try {
      conn.close();
    } catch { /* already closed by the server */ }
  }
}

Deno.test("allowedOrigins: a full-origin entry admits exactly that origin; a bare hostname any port", async () => {
  const hits: string[] = [];
  await using srv = await testServer({
    cells: [cell("xo_allow", { state: { n: 0 }, methods: {} })],
    allowedOrigins: ["https://dash.corp:8443", "lan.corp"],
    routes: mkRoutes(hits),
  });
  const cases: Array<[string, boolean]> = [
    ["https://dash.corp:8443", true],
    ["https://dash.corp:9999", false],
    ["http://dash.corp:8443", false],
    ["http://dash.corp", false],
    ["https://dash.corp", false],
    // A bare hostname keeps its documented meaning: that host, any port/scheme.
    ["http://lan.corp:1234", true],
    ["https://lan.corp", true],
    ["https://evil.corp:8443", false],
  ];
  for (const [origin, admitted] of cases) {
    const ws = await wsStatus(srv.port, origin);
    assertEquals(ws === 101, admitted, `WS ${origin} → ${ws}`);
    const http = await post(`${srv.url}/api/wipe`, { origin });
    assertEquals(
      http.status === 200,
      admitted,
      `POST ${origin} → ${http.status}`,
    );
  }
  assert(hits.length === cases.filter(([, a]) => a).length);
});

// The gate refuses only where CSRF GRANTS something: an ambient cookie, or
// authority that comes from network position (a loopback-bound app, or an
// open app reached from this machine). An exposed app's public route is a
// public endpoint — a cross-site browser form POST to it (a payment return
// URL, a SAML / OIDC `form_post`) grants nothing curl could not, and must keep
// arriving exactly as before.
Deno.test("cross-origin: an EXPOSED app's route takes a cookieless cross-site POST; a cookie or a local peer is refused", async () => {
  const hits: string[] = [];
  await using open = await testServer({
    cells: [cell("xo_exp_open", { state: { n: 0 }, methods: {} })],
    expose: true,
    host: "127.0.0.1",
    tls: false,
    key: false,
    routes: mkRoutes(hits),
  });
  const u = `${open.url}/api/wipe`;
  // Reached through a proxy — the documented exposed deployment — so the peer
  // is remote, whatever the TCP address says.
  const remote = { "x-forwarded-for": "203.0.113.7" };

  assertEquals(
    (await post(u, { ...remote, origin: "https://pay.example" })).status,
    200,
    "a payment provider's return POST reaches a public route",
  );
  assertEquals(
    (await post(u, { ...remote, origin: "null" })).status,
    200,
    "a form_post after a cross-site redirect (Origin: null) reaches it too",
  );
  assertEquals(
    (await post(u, { ...remote, origin: EVIL, cookie: "sid=abc" })).status,
    403,
    "a cookie on a foreign-Origin request is the CSRF case",
  );
  assertEquals(
    (await post(u, { origin: EVIL })).status,
    403,
    "an OPEN app reached from this machine: the authority is the position",
  );
  assertEquals(hits, ["POST user=-", "POST user=-"]);

  // A credentialed exposed app: the authority is the credential a page cannot
  // attach cross-site — a header passes, a cookie does not, even locally.
  const khits: string[] = [];
  const key = `xo-exp-key-${crypto.randomUUID()}`;
  await using keyed = await testServer({
    cells: [cell("xo_exp_key", { state: { n: 0 }, methods: {} })],
    expose: true,
    host: "127.0.0.1",
    tls: false,
    key,
    routes: mkRoutes(khits),
  });
  const ku = `${keyed.url}/api/wipe`;
  assertEquals(
    (await post(ku, { origin: EVIL, authorization: `Bearer ${key}` })).status,
    200,
    "a header credential is not ambient — no CSRF to refuse",
  );
  assertEquals(khits, ["POST user=-"]);
});

Deno.test("cross-origin: an exposed auth:true app refuses a sibling-port POST riding the session cookie", async () => {
  const hits: string[] = [];
  await using srv = await testServer({
    cells: [cell("xo_exp_auth", { state: { n: 0 }, methods: {} })],
    expose: true,
    host: "127.0.0.1",
    tls: false,
    auth: true,
    routes: mkRoutes(hits),
  });
  const signup = await fetch(`${srv.url}/__aio/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: srv.url },
    body: JSON.stringify({ id: "victim", password: "correct horse battery" }),
  });
  const cookie = signup.headers.getSetCookie()[0]!.split(";")[0]!;
  await signup.body?.cancel();
  assertEquals(signup.status, 201);
  const u = `${srv.url}/api/wipe`;
  const remote = { "x-forwarded-for": "203.0.113.8" };
  const sibling = `http://127.0.0.1:${freePort()}`;
  assertEquals(
    (await post(u, { ...remote, cookie, origin: sibling })).status,
    403,
  );
  assertEquals(hits, [], "the handler must not run as the victim");
  // Its own page, cookie and all, still passes.
  assertEquals(
    (await post(u, { ...remote, cookie, origin: srv.url })).status,
    200,
  );
  assertEquals(hits, ["POST user=victim"]);
});
