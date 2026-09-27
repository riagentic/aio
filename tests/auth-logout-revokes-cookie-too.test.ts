// POST /__aio/auth/logout revoked ONE session — `bearerToken(req) ?? cookie`
// — and cleared the cookie in the response. A request carrying BOTH a Bearer
// token and the session cookie (a page that also calls the API with a token)
// ended the token's session only: the cookie's session stayed valid on the
// server, so a copy of that cookie still signed in after "log out".
import { assert, assertEquals } from "@std/assert";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("logout ends the cookie's session too when a Bearer token is also sent", async () => {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = await tempDir("aio-logout-");
  const app = await aio.run({
    cells: [cell("lo", { state: { n: 0 }, access: true, visible: "all" })],
    appId: `test-logout-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: true,
    port,
    baseDir: dir,
  });
  try {
    const signup = await fetch(`${base}/__aio/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "bob", password: "password123" }),
    });
    assertEquals(signup.status, 201);
    const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
    await signup.body?.cancel();
    const login = await fetch(`${base}/__aio/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "bob", password: "password123" }),
    });
    const { token } = await login.json();
    assert(token, "a second session, held as a Bearer token");

    const me = async (headers: Record<string, string>) =>
      (await (await fetch(`${base}/__aio/auth/me`, { headers })).json()).user;
    assertEquals((await me({ cookie }))?.id, "bob", "cookie session live");

    const lo = await fetch(`${base}/__aio/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, cookie },
    });
    assertEquals(lo.status, 200);
    await lo.body?.cancel();

    assertEquals(await me({ authorization: `Bearer ${token}` }), null);
    assertEquals(await me({ cookie }), null, "the cookie's session ended too");
  } finally {
    _resetAuthFails();
    await app.close();
    await dropTempDir(dir);
  }
});
