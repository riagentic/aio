// AUTH-2 — password auth: PBKDF2 unit, user store unit, and the full e2e
// lifecycle over a booted server: public shell → signup → cookie/token →
// authenticated WS → logout → rejected. Plus signup-off and cross-origin CSRF.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  hashPassword,
  openUserStore,
  verifyPassword,
} from "../src/server/auth-users.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";

const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}`;

Deno.test("password hash: roundtrip, rejection, malformed", async () => {
  const h = await hashPassword("correct horse battery");
  assertStringIncludes(h, "pbkdf2$sha256$");
  assert(await verifyPassword("correct horse battery", h));
  assert(!(await verifyPassword("wrong", h)));
  assert(!(await verifyPassword("x", "garbage")));
  assert(!(await verifyPassword("x", "pbkdf2$sha256$abc$zz$zz")));
});

Deno.test("user store: create/verify/duplicate/short-pw/setPassword/setRole", async () => {
  const s = openUserStore(":memory:");
  const u = await s.create("alice", "password123");
  assertEquals(u.role, "user");
  const asUser = (v: unknown) => v as { id: string; role: string } | null;
  assertEquals(asUser(await s.verify("alice", "password123"))?.id, "alice");
  assertEquals(await s.verify("alice", "nope-nope-nope"), null);
  assertEquals(await s.verify("ghost", "password123"), null);
  await s.create("root", "password123", { role: "admin" });
  assertEquals(asUser(await s.verify("root", "password123"))?.role, "admin");
  // Duplicates + weak passwords fail loud.
  await s.create("alice", "password123").then(
    () => assert(false, "duplicate must throw"),
    (e) => assertEquals((e as Error).message, "user_exists"),
  );
  await s.create("bob", "short").then(
    () => assert(false, "short pw must throw"),
    (e) => assertEquals((e as Error).message, "password_too_short"),
  );
  // Password change invalidates the old one.
  assert(await s.setPassword("alice", "new-password-9"));
  assertEquals(await s.verify("alice", "password123"), null);
  assertEquals(asUser(await s.verify("alice", "new-password-9"))?.id, "alice");
  assert(s.setRole("alice", "editor"));
  assertEquals(s.get("alice")?.role, "editor");
  s.close();
});

function tryWs(token: string | null): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${PORT}/ws${token ? `?token=${token}` : ""}`,
    );
    const t = setTimeout(() => {
      ws.close();
      resolve(false);
    }, 3000);
    ws.onmessage = () => {
      clearTimeout(t);
      ws.close();
      resolve(true);
    };
    ws.onerror = () => {
      clearTimeout(t);
      resolve(false);
    };
  });
}

Deno.test("auth e2e: shell public, signup→login→ws→logout lifecycle", async () => {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const c = cell("shop", {
    state: { orders: 0 },
    access: true,
    methods: {
      order(s: { orders: number }) {
        s.orders += 1;
      },
    },
  });

  const app = await aio.run({
    cells: [c],
    appId: `test-auth-${Deno.pid}`,
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: true,
    port: PORT,
    baseDir: await Deno.makeTempDir(),
  });

  try {
    assert(app.auth, "app.auth surface present");
    assert(app.sessions, "auth implies sessions");

    // 1. The app shell is PUBLIC (login UI must load), state is not.
    const shell = await fetch(`${BASE}/`);
    assertEquals(shell.status, 200, "shell serves without a token");
    await shell.body?.cancel();
    assert(!(await tryWs(null)), "anonymous WS rejected");

    // 2. Anonymous /me.
    let me = await (await fetch(`${BASE}/__aio/auth/me`)).json();
    assertEquals(me.user, null);

    // 3. Signup → 201 + session token + cookie.
    const su = await fetch(`${BASE}/__aio/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "alice", password: "password123" }),
    });
    assertEquals(su.status, 201);
    const cookie = su.headers.get("set-cookie") ?? "";
    assertStringIncludes(cookie, "aio_session=");
    assertStringIncludes(cookie, "HttpOnly");
    assertStringIncludes(cookie, "SameSite=Strict");
    const { token, user } = await su.json();
    assertEquals(user, { id: "alice", role: "user" });

    // 4. Session token authenticates WS; duplicate signup 409.
    assert(await tryWs(token), "signup token authenticates WS");
    const dup = await fetch(`${BASE}/__aio/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "alice", password: "password123" }),
    });
    assertEquals(dup.status, 409);
    await dup.body?.cancel();

    // 5. Login: wrong password 401, right password 200.
    const bad = await fetch(`${BASE}/__aio/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "alice", password: "wrong-wrong-1" }),
    });
    assertEquals(bad.status, 401);
    await bad.body?.cancel();
    const ok = await fetch(`${BASE}/__aio/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "alice", password: "password123" }),
    });
    assertEquals(ok.status, 200);
    const login = await ok.json();

    // 6. /me via Bearer + via Cookie.
    me = await (await fetch(`${BASE}/__aio/auth/me`, {
      headers: { authorization: `Bearer ${login.token}` },
    })).json();
    assertEquals(me.user?.id, "alice");
    me = await (await fetch(`${BASE}/__aio/auth/me`, {
      headers: { cookie: `aio_session=${login.token}` },
    })).json();
    assertEquals(me.user?.id, "alice", "cookie authenticates too");

    // 7. Cross-origin POST is refused (CSRF floor).
    const csrf = await fetch(`${BASE}/__aio/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ id: "alice", password: "password123" }),
    });
    assertEquals(csrf.status, 403);
    await csrf.body?.cancel();

    // 8. The typed client wrapper drives the same flows.
    const { createAuthClient } = await import("../mod.ts");
    const ac = createAuthClient(BASE);
    const acLogin = await ac.login("alice", "password123");
    assert("user" in acLogin, "no totp on this account");
    assertEquals(acLogin.user.id, "alice");
    assertEquals((await ac.me(acLogin.token))?.id, "alice");
    await ac.login("alice", "wrong-wrong-1").then(
      () => assert(false, "must throw"),
      (e) => assertEquals((e as Error).message, "invalid_credentials"),
    );
    await ac.logout(acLogin.token);
    assertEquals(await ac.me(acLogin.token), null, "client logout revokes");

    // 9. Logout revokes + clears the cookie; the token dies immediately.
    const lo = await fetch(`${BASE}/__aio/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${login.token}` },
    });
    assertEquals(lo.status, 200);
    assertStringIncludes(lo.headers.get("set-cookie") ?? "", "Max-Age=0");
    await lo.body?.cancel();
    assert(!(await tryWs(login.token)), "logged-out token rejected");
  } finally {
    _resetAuthFails();
    await app.close();
  }
});

Deno.test("auth e2e: signup:false → admin-seeded users only", async () => {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const c = cell("panel", { state: { x: 0 }, methods: {} });
  const app = await aio.run({
    cells: [c],
    appId: `test-auth-closed-${Deno.pid}`,
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: { signup: false },
    port: PORT,
    baseDir: await Deno.makeTempDir(),
  });
  try {
    const su = await fetch(`${BASE}/__aio/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "eve", password: "password123" }),
    });
    assertEquals(su.status, 403, "open signup disabled");
    await su.body?.cancel();
    // Seeded admin logs in fine.
    await app.auth!.create("root", "password123", { role: "admin" });
    const ok = await fetch(`${BASE}/__aio/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "root", password: "password123" }),
    });
    assertEquals(ok.status, 200);
    assertEquals((await ok.json()).user.role, "admin");
  } finally {
    _resetAuthFails();
    await app.close();
  }
});
