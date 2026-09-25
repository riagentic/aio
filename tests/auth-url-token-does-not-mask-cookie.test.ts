// A `?token=` query parameter on an `auth: true` app is not a credential on
// any HTTP path: a login SESSION is refused from the URL everywhere but the
// `/ws` handshake, and without `users:`/`resolveUser` there is nothing else it
// could resolve against. It still WON over the session cookie, because the
// extractor takes the query first. So a signed-in user following an ordinary
// app link that happens to carry a `token` parameter — an invite, an email
// confirmation, a share code — was answered as ANONYMOUS: an app route
// replied 401 "routes run for signed-in users only" to a valid session, and
// each such request was charged to the address's failed-auth budget, so the
// eleventh one answered 429.
import { assertEquals } from "@std/assert";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { RouteMatch } from "../src/server/route.ts";

Deno.test("auth: a ?token= app parameter does not mask a valid session cookie", async () => {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const dir = await tempDir("aio-auth-urltok-");
  const app = await aio.run({
    cells: [cell("urltok", { state: { x: 0 }, methods: {} })],
    appId: `test-auth-urltok-${Deno.pid}-${port}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: true,
    port,
    baseDir: dir,
    routes: {
      "/api/accept": (_req: Request, m?: RouteMatch) =>
        new Response(m?.user?.id ?? "anonymous"),
    },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await app.auth!.create("alice", "password123");
    const li = await fetch(`${base}/__aio/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "alice", password: "password123" }),
    });
    assertEquals(li.status, 200);
    const cookie = (li.headers.get("set-cookie") ?? "").split(";")[0]!;
    await li.body?.cancel();

    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${base}/api/accept?token=invite-${i}`, {
        headers: { cookie },
      });
      const text = await r.text();
      assertEquals(r.status, 200, `request ${i}: ${text.slice(0, 120)}`);
      assertEquals(text, "alice", `request ${i}`);
    }
  } finally {
    _resetAuthFails();
    await app.close();
    await dropTempDir(dir);
  }
});
