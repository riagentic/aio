// Browser auth-client wrapper (src/browser/auth-client.ts) — the security-
// sensitive client surface, driven against a real library-mode server (Deno
// fetch is global; no happy-dom needed). Covers the methods auth-flows.test
// doesn't: signup, changePassword, verify, me, and error mapping.
import { assert, assertEquals } from "@std/assert";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";

const PORT = freePort();
const PORT2 = freePort();
const BASE = `http://127.0.0.1:${PORT}`;

Deno.test("authClient: signup → me → changePassword → login lifecycle", async () => {
  _resetAuthFails();
  const { cell, aio, createAuthClient } = await import("../mod.ts");
  const c = cell("app", { state: { n: 0 }, methods: {} });
  const app = await aio.run({
    cells: [c],
    appId: `test-authclient-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: true,
    port: PORT,
    baseDir: await Deno.makeTempDir(),
  });
  const ac = createAuthClient(BASE);
  try {
    // Anonymous.
    assertEquals(await ac.me(), null);

    // Signup logs straight in (no requireVerified) → result carries user+token.
    const r = await ac.signup("alice", "password123");
    assert("user" in r, "signup returned a session");
    assertEquals(r.user.id, "alice");
    assertEquals((await ac.me(r.token))?.id, "alice");

    // Wrong login maps to a friendly Error, not a silent undefined — and
    // "friendly" means a SENTENCE. This assertion used to read
    // `assertEquals(msg, "invalid_credentials")` under that same comment: the
    // raw server code went into Error.message, and an app doing the obvious
    // `catch (e) => setError(e.message)` showed its users snake_case. The code
    // is still there to branch on; it is just no longer the human text.
    let msg = "", code = "";
    try {
      await ac.login("alice", "wrong-wrong-1");
    } catch (e) {
      msg = (e as Error).message;
      code = (e as { code?: string }).code ?? "";
    }
    assertEquals(msg, "Incorrect username or password.");
    assertEquals(code, "invalid_credentials");

    // changePassword rotates: the returned session works, the old dies.
    const rotated = await ac.changePassword(
      "password123",
      "password-new-9",
      r.token,
    );
    assertEquals((await ac.me(rotated.token))?.id, "alice");
    assertEquals(await ac.me(r.token), null, "old session revoked");

    // Login with the new password succeeds.
    const li = await ac.login("alice", "password-new-9");
    assert("user" in li);
    assertEquals(li.user.id, "alice");

    // logout revokes.
    await ac.logout(li.token);
    assertEquals(await ac.me(li.token), null);
  } finally {
    _resetAuthFails();
    await app.close();
  }
});

Deno.test("authClient: requestReset never throws / never enumerates", async () => {
  _resetAuthFails();
  const { cell, aio, createAuthClient } = await import("../mod.ts");
  const c = cell("app", { state: { n: 0 }, methods: {} });
  const app = await aio.run({
    cells: [c],
    appId: `test-authclient-reset-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: { sendMail: () => {} }, // mail configured so the route is live
    port: PORT2,
    baseDir: await Deno.makeTempDir(),
  });
  const ac = createAuthClient(`http://127.0.0.1:${PORT2}`);
  try {
    // Unknown id resolves (no throw, no enumeration signal).
    await ac.requestReset("ghost-user");
    await ac.requestReset("also-missing");
  } finally {
    _resetAuthFails();
    await app.close();
  }
});
