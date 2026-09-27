// A `?token=` on the `/ws` handshake must not stand in front of a valid
// session cookie.
//
// The browser client builds its socket URL from the PAGE's `?token=` — so a
// signed-in user who opens an app link that carries its own `?token=` (an
// invite, a confirmation link) sent that value on the handshake. The server
// reads the URL before the cookie: the handshake was refused 401 although the
// cookie was a live session, and every such page load was charged to the
// failed-auth budget until the user's own login answered 429.
import { assertEquals, assertNotEquals } from "@std/assert";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test({
  name: "/ws: a stale ?token= does not mask a valid session cookie",
  fn: async () => {
    _resetAuthFails();
    const { cell, aio } = await import("../mod.ts");
    const port = freePort();
    const dir = await tempDir("aio-ws-urltoken-");
    const app = await aio.run({
      cells: [cell("wsurltok", { state: { x: 0 }, methods: {} })],
      appId: `test-ws-urltoken-${Deno.pid}-${port}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      auth: true,
      port,
      baseDir: dir,
    });
    const base = `127.0.0.1:${port}`;
    const upgrade = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    };
    try {
      await app.auth!.create("alice", "password123");
      const li = await fetch(`http://${base}/__aio/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "alice", password: "password123" }),
      });
      const cookie = (li.headers.get("set-cookie") ?? "").split(";")[0]!;
      await li.body?.cancel();
      for (let i = 0; i < 12; i++) {
        const r = await fetch(`http://${base}/ws?token=invite-${i}`, {
          headers: { cookie, ...upgrade },
        });
        await r.body?.cancel();
        assertNotEquals(r.status, 401, `handshake ${i} refused`);
        assertNotEquals(r.status, 429, `handshake ${i} throttled`);
      }
      // Without the cookie, a bad ?token= is still a presented, wrong
      // credential: refused — and the 12 wrong URL tokens above were
      // charged (else the fallback is an unmetered guessing oracle), so the
      // refusal is the throttle.
      const bad = await fetch(`http://${base}/ws?token=invite-x`, {
        headers: upgrade,
      });
      await bad.body?.cancel();
      assertEquals(bad.status, 429);
    } finally {
      _resetAuthFails();
      await app.close();
      await dropTempDir(dir);
    }
  },
});
