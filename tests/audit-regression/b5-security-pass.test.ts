// Regression: B5 security pass (2026-07-08).
//
// 1. /__aio/snapshot returns/accepts RAW state — it bypasses ui
//    include/exclude and forUser filtering, so in per-user auth mode only
//    role:"admin" may reach it (both on the main server and the localhost
//    trojan helper).
// 2. WS origin check: a page served by this very server (Origin === Host
//    header) must be accepted in --expose mode without manual allowedOrigins;
//    foreign origins stay rejected.
// 3. allowedOrigins/strictOrigin are real user config (were dead code —
//    declared on ServerConfig but never plumbed from aio.run config).
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { createServer } from "../../src/server/server.ts";
import { createWsManager } from "../../src/server/server-ws.ts";

function wsRequest(origin: string | undefined, host: string): Request {
  const headers = new Headers({
    "upgrade": "websocket",
    "connection": "upgrade",
    "sec-websocket-key": btoa(crypto.randomUUID().slice(0, 16)),
    "sec-websocket-version": "13",
    "host": host,
  });
  if (origin) headers.set("origin", origin);
  return new Request(`http://${host}/ws`, { headers });
}

Deno.test("b5: own-host origin accepted in expose mode (no manual allowlist)", () => {
  const mgr = createWsManager(
    {
      dispatch: () => {},
      getUIState: () => ({}),
      debug: () => {},
      prod: false,
      clientCounter: { value: 0 },
      bootId: "b5-boot",
      expose: true,
    } as unknown as Parameters<typeof createWsManager>[0],
  );

  // page served by us: Origin host === Host header
  const own = mgr.handleWs(
    wsRequest("http://myserver.example:8000", "myserver.example:8000"),
  );
  // upgrade may still fail on the fake key deeper in — but NOT with 403
  if (own instanceof Response) {
    assert(own.status !== 403, "own-host origin must not be rejected");
  }

  // foreign origin: still rejected
  const foreign = mgr.handleWs(
    wsRequest("http://evil.example", "myserver.example:8000"),
  );
  assert(
    foreign instanceof Response && foreign.status === 403,
    "foreign origin must stay rejected",
  );
});

Deno.test("b5: snapshot endpoint requires admin role in per-user mode", async () => {
  const server = createServer(
    {
      port: 47119,
      title: "b5",
      getUIState: () => ({}),
      dispatch: () => {},
      getSnapshot: () => JSON.stringify({ secret: "raw-state" }),
      loadSnapshot: () => {},
      baseDir: await Deno.makeTempDir({ prefix: "aio-b5-" }),
      debug: () => {},
      prod: false,
      users: {
        "viewer-token": { id: "v1", role: "viewer" },
        "admin-token": { id: "a1", role: "admin" },
      },
      clientCounter: { value: 0 },
    } as unknown as Parameters<typeof createServer>[0],
  );

  const port = 47119;
  void server;
  const asViewer = await fetch(
    `http://127.0.0.1:${port}/__aio/snapshot`,
    { headers: { authorization: "Bearer viewer-token" } },
  );
  assertEquals(asViewer.status, 403);
  await asViewer.body?.cancel();

  const asAdmin = await fetch(
    `http://127.0.0.1:${port}/__aio/snapshot`,
    { headers: { authorization: "Bearer admin-token" } },
  );
  assertEquals(asAdmin.status, 200);
  assertEquals((await asAdmin.json()).secret, "raw-state");

  const noAuth = await fetch(`http://127.0.0.1:${port}/__aio/snapshot`);
  assertEquals(noAuth.status, 401);
  await noAuth.body?.cancel();

  await server.shutdown();
});
