// A same-host reverse proxy does not make internet clients "local".
//
// `/__aio/snapshot` (raw state, `visible.exclude` bypassed) and the trojan
// control plane are same-machine-only, and "same machine" was decided from the
// TCP peer alone. Behind nginx/Caddy on the same host — the deployment the auth
// docs prescribe, with `trustProxyHeader` — every remote client's peer IS
// 127.0.0.1. Measured: a forwarded remote client read `apiSecret` out of GET
// /__aio/snapshot and overwrote the whole state with POST ?force=1.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _isLocalRequest } from "../src/server/server.ts";

const loop: Deno.Addr = { transport: "tcp", hostname: "127.0.0.1", port: 1 };

Deno.test("_isLocalRequest: a relayed request is never local", () => {
  const plain = new Request("http://127.0.0.1/");
  assert(_isLocalRequest(loop, plain), "a direct loopback request is local");
  for (
    const h of ["x-forwarded-for", "forwarded", "x-real-ip", "x-client-ip"]
  ) {
    const r = new Request("http://127.0.0.1/", {
      headers: { [h]: "203.0.113.9" },
    });
    assertEquals(
      _isLocalRequest(loop, r, "x-client-ip"),
      false,
      `${h}: a proxy relayed this request`,
    );
  }
  // The configured header counts even when it is not a well-known one.
  assertEquals(
    _isLocalRequest(
      loop,
      new Request("http://x/", { headers: { "x-client-ip": "1.2.3.4" } }),
      "x-client-ip",
    ),
    false,
  );
});

Deno.test("snapshot + trojan: a forwarded remote client behind a local proxy is refused", async () => {
  const acct = cell("proxy_acct", {
    state: { name: "shop", apiSecret: "sk_live_TOP_SECRET" },
    visible: { exclude: ["apiSecret"] },
    methods: {
      rename(s: { name: string }, n: string) {
        s.name = n;
      },
    },
  });
  await using srv = await testServer({
    cells: [acct],
    trustProxyHeader: "x-forwarded-for",
  });
  const remote = { "x-forwarded-for": "203.0.113.9" };

  const get = await srv.fetch("/__aio/snapshot", { headers: remote });
  const body = await get.text();
  assertEquals(get.status, 403);
  assert(!body.includes("sk_live_TOP_SECRET"), body);

  const post = await srv.fetch("/__aio/snapshot?force=1", {
    method: "POST",
    headers: { ...remote, "x-aio": "1", "content-type": "application/json" },
    body: JSON.stringify({ proxy_acct: { name: "pwned", apiSecret: "x" } }),
  });
  await post.body?.cancel();
  assertEquals(post.status, 403);
  assertEquals(
    (srv.state() as { proxy_acct: { name: string } }).proxy_acct.name,
    "shop",
  );

  const trojan = await srv.fetch("/__aio/trojan/state", { headers: remote });
  await trojan.body?.cancel();
  assertEquals(trojan.status, 404);

  // The machine owner, connecting directly, is still local.
  const own = await srv.fetch("/__aio/snapshot");
  assertEquals(own.status, 200);
  await own.body?.cancel();
});
