// The auth POST flows kept a CSRF floor of their own (`sameOrigin`: Origin
// host === Host) that ignored `allowedOrigins` and aio's own Electron origin.
// The server-wide Origin gate (`crossOriginRefusal` → `originVerdict`) admits
// both — docs/auth/auth.md: "allowedOrigins … may connect, POST AND embed",
// and the auth flows are listed among the surfaces that gate covers. So a
// dashboard named in `allowedOrigins` could open a socket and POST to app
// routes, then got `403 cross_origin` from /__aio/auth/login; and the
// forced-protocol Electron dev window (`Origin: aio://app`) could not sign in
// at all. Two deciders for one fact; the flows now ask the same one.
import { assertEquals } from "@std/assert";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function withApp(
  fn: (base: string) => Promise<void>,
): Promise<void> {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const dir = await tempDir("aio-auth-origin-");
  const app = await aio.run({
    cells: [cell("originpanel", { state: { x: 0 }, methods: {} })],
    appId: `test-auth-origin-${Deno.pid}-${port}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: true,
    allowedOrigins: ["https://dash.corp"],
    port,
    baseDir: dir,
  });
  try {
    await app.auth!.create("alice", "password123");
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    _resetAuthFails();
    await app.close();
    await dropTempDir(dir);
  }
}

const login = (base: string, origin: string): Promise<Response> =>
  fetch(`${base}/__aio/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin },
    body: JSON.stringify({ id: "alice", password: "password123" }),
  });

Deno.test("auth flows: an Origin named in allowedOrigins may sign in", async () => {
  await withApp(async (base) => {
    const r = await login(base, "https://dash.corp");
    const body = await r.json();
    assertEquals(r.status, 200, JSON.stringify(body));
    assertEquals(body.user?.id, "alice");
  });
});

Deno.test("auth flows: aio's own Electron origin (aio://app) may sign in", async () => {
  await withApp(async (base) => {
    const r = await login(base, "aio://app");
    const body = await r.json();
    assertEquals(r.status, 200, JSON.stringify(body));
  });
});

Deno.test("auth flows: a foreign Origin is still refused", async () => {
  await withApp(async (base) => {
    // (Refused by whichever gate meets it first — the server-wide one on a
    // loopback app — so only the status is the contract here.)
    const r = await login(base, "https://evil.example");
    assertEquals(r.status, 403);
    await r.body?.cancel();
    // …and an allowlisted HOST on the wrong scheme is not the same origin.
    const r2 = await login(base, "http://dash.corp");
    assertEquals(r2.status, 403);
    await r2.body?.cancel();
  });
});
