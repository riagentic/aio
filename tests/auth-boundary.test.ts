// Auth/session boundary regressions — each test pins a demonstrated exploit
// closed. Every one FAILS against the pre-fix code.
import { assert, assertEquals } from "@std/assert";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";

const PORT_TROJAN = freePort();
const PORT_REVOKE = freePort();
const PORT_COOKIE = freePort();
const PORT_ORIGIN = freePort();

/** Raw WS handshake so the Origin header can be set (the DOM WebSocket API
 *  cannot). Returns the HTTP status line's code. */
async function wsHandshakeStatus(
  port: number,
  headers: Record<string, string>,
  query = "",
): Promise<number> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(
      new Uint8Array(16),
    )));
    const lines = [
      `GET /ws${query} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${key}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      "",
      "",
    ].join("\r\n");
    await conn.write(new TextEncoder().encode(lines));
    const buf = new Uint8Array(256);
    const n = await conn.read(buf) ?? 0;
    const status = new TextDecoder().decode(buf.subarray(0, n));
    return Number(status.split(" ")[1]);
  } finally {
    try {
      conn.close();
    } catch { /* already closed by the server */ }
  }
}

/** Pin AIO_APPS_DIR at a temp dir so auth.db/app.key never touch the real
 *  home, and restore whatever was there. */
async function withAppsDir<T>(fn: () => Promise<T>): Promise<T> {
  const prev = Deno.env.get("AIO_APPS_DIR");
  const dir = await Deno.makeTempDir();
  Deno.env.set("AIO_APPS_DIR", dir);
  try {
    return await fn();
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
  }
}

async function bootAuthApp(port: number, appId: string) {
  const { cell, aio } = await import("../mod.ts");
  const vault = cell("vault", {
    state: { secret: "top-secret", hits: 0 },
    methods: {
      bump(s: { hits: number }) {
        s.hits += 1;
      },
    },
  });
  const app = await aio.run({
    cells: [vault],
    appId,
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: true,
    port,
    baseDir: await Deno.makeTempDir(),
  });
  return app;
}

Deno.test("trojan: anonymous local caller cannot read raw state under auth: true", async () => {
  _resetAuthFails();
  await withAppsDir(async () => {
    const app = await bootAuthApp(PORT_TROJAN, `test-trojan-${Deno.pid}`);
    const BASE = `http://127.0.0.1:${PORT_TROJAN}`;
    const hits = () =>
      (app.getState() as unknown as { vault: { hits: number } }).vault.hits;
    try {
      // Reads: raw state and any named user's filtered view.
      for (const route of ["state", "ui?user=alice", "cells", "config"]) {
        const r = await fetch(`${BASE}/__aio/trojan/${route}`);
        const body = await r.text();
        assertEquals(
          r.status,
          401,
          `anon trojan/${route} must be 401, got ${r.status}: ${
            body.slice(0, 120)
          }`,
        );
        assert(!body.includes("top-secret"), `raw state leaked via ${route}`);
      }

      // Writes: dispatch, whole-state overwrite, arbitrary SQL.
      const post = (route: string, body: unknown) =>
        fetch(`${BASE}/__aio/trojan/${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-AIO": "1" },
          body: JSON.stringify(body),
        });
      const before = hits();
      for (
        const [route, payload] of [
          ["dispatch", { type: "vault:bump", payload: {} }],
          ["snapshot", { vault: { secret: "pwned", hits: 99 } }],
          ["sql", { sql: "SELECT 1" }],
        ] as const
      ) {
        const r = await post(route, payload);
        await r.body?.cancel();
        assertEquals(r.status, 401, `anon trojan/${route} must be 401`);
      }
      await new Promise((res) => setTimeout(res, 100));
      assertEquals(hits(), before, "anon dispatch must not mutate state");
      assertEquals(
        (app.getState() as unknown as { vault: { secret: string } }).vault
          .secret,
        "top-secret",
        "anon snapshot must not replace state",
      );

      // An AUTHENTICATED non-admin is no better off — the control plane is
      // /__aio/snapshot's power and more, so it carries the same admin bar.
      const su = await fetch(`${BASE}/__aio/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "mallory", password: "password123" }),
      });
      const { token } = await su.json() as { token: string };
      const asUser = await fetch(`${BASE}/__aio/trojan/state`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const userBody = await asUser.text();
      assertEquals(asUser.status, 403, "a non-admin must not read raw state");
      assert(!userBody.includes("top-secret"), "raw state leaked to non-admin");

      // …and the gate is a GATE, not a wall: an admin still gets through, so
      // the operator path (`am auth role <id> admin`) stays usable.
      const { openUserStore } = await import("../src/server/auth-users.ts");
      const { appDirs } = await import("../src/server/app-dirs.ts");
      const store = openUserStore(appDirs(`test-trojan-${Deno.pid}`).authDb);
      assert(store.setRole("mallory", "admin"), "promote to admin");
      store.close();
      // A session carries the role it was issued with — log in again.
      const li = await fetch(`${BASE}/__aio/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "mallory", password: "password123" }),
      });
      const { token: adminToken } = await li.json() as { token: string };
      const asAdmin = await fetch(`${BASE}/__aio/trojan/state`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const adminBody = await asAdmin.text();
      assertEquals(asAdmin.status, 200, "an admin must still reach the trojan");
      assert(adminBody.includes("top-secret"), "admin sees raw state");
    } finally {
      _resetAuthFails();
      await app.close();
    }
  });
});

Deno.test("sessions: revoking a session disarms its live WebSocket", async () => {
  _resetAuthFails();
  await withAppsDir(async () => {
    const app = await bootAuthApp(PORT_REVOKE, `test-revoke-${Deno.pid}`);
    const BASE = `http://127.0.0.1:${PORT_REVOKE}`;
    const hits = () =>
      (app.getState() as unknown as { vault: { hits: number } }).vault.hits;
    try {
      const su = await fetch(`${BASE}/__aio/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "alice", password: "password123" }),
      });
      const { token } = await su.json() as { token: string };

      const ws = await new Promise<WebSocket>((res, rej) => {
        const s = new WebSocket(
          `ws://127.0.0.1:${PORT_REVOKE}/ws?token=${token}`,
        );
        const t = setTimeout(() => rej(new Error("ws timeout")), 3000);
        s.onmessage = () => (clearTimeout(t), res(s));
        s.onerror = () => (clearTimeout(t), rej(new Error("ws error")));
      });

      const before = hits();
      // Log out — the server revokes this exact session.
      const lo = await fetch(`${BASE}/__aio/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      await lo.body?.cancel();
      // HTTP with the dead token is already refused.
      const probe = await fetch(`${BASE}/__aio/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assertEquals((await probe.json()).user, null, "HTTP token must be dead");

      await new Promise((r) => setTimeout(r, 150));
      const stillOpen = ws.readyState === WebSocket.OPEN;
      if (stillOpen) {
        ws.send(JSON.stringify({
          v: 2,
          t: "action",
          d: { type: "vault:bump", payload: {} },
        }));
        await new Promise((r) => setTimeout(r, 150));
      }
      try {
        ws.close();
      } catch { /* already closed */ }
      assertEquals(
        hits(),
        before,
        "a revoked session's socket must not be able to dispatch",
      );
      assert(!stillOpen, "a revoked session's socket must be closed");
    } finally {
      _resetAuthFails();
      await app.close();
    }
  });
});

Deno.test("auth budget: an ambient stale cookie cannot lock a user out of login", async () => {
  _resetAuthFails();
  await withAppsDir(async () => {
    const app = await bootAuthApp(PORT_COOKIE, `test-cookie-${Deno.pid}`);
    const BASE = `http://127.0.0.1:${PORT_COOKIE}`;
    try {
      const su = await fetch(`${BASE}/__aio/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "bob", password: "password123" }),
      });
      await su.body?.cancel();

      // A browser reload after the session died: every subresource carries the
      // dead cookie automatically. 12 > AUTH_FAIL_MAX (10).
      for (let i = 0; i < 12; i++) {
        const r = await fetch(`${BASE}/__aio/health`, {
          headers: { Cookie: "aio_session=aios_deadbeef" },
        });
        await r.body?.cancel();
      }

      const login = await fetch(`${BASE}/__aio/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "bob", password: "password123" }),
      });
      const body = await login.json();
      assertEquals(
        login.status,
        200,
        `correct password must log in, got ${login.status} ${
          JSON.stringify(body)
        }`,
      );
    } finally {
      _resetAuthFails();
      await app.close();
    }
  });
});

Deno.test("ws origin: another loopback port cannot self-certify as trusted", async () => {
  _resetAuthFails();
  await withAppsDir(async () => {
    const app = await bootAuthApp(PORT_ORIGIN, `test-origin-${Deno.pid}`);
    const BASE = `http://127.0.0.1:${PORT_ORIGIN}`;
    try {
      // The victim's credential rides along exactly as the ambient
      // SameSite=Strict cookie would (ports are not part of a "site").
      const su = await fetch(`${BASE}/__aio/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "carol", password: "password123" }),
      });
      const { token } = await su.json() as { token: string };
      const q = `?token=${token}`;

      // A page served by some OTHER local tool on port 1234.
      const evil = await wsHandshakeStatus(PORT_ORIGIN, {
        Origin: "http://localhost:1234",
      }, q);
      assertEquals(evil, 403, "a foreign loopback origin must be refused");

      // The app's own page still connects (Origin === Host).
      const own = await wsHandshakeStatus(PORT_ORIGIN, {
        Origin: `http://127.0.0.1:${PORT_ORIGIN}`,
      }, q);
      assertEquals(own, 101, "the app's own origin must still upgrade");

      // Header-less clients (curl, native) are unaffected.
      const none = await wsHandshakeStatus(PORT_ORIGIN, {}, q);
      assertEquals(none, 101, "an origin-less client must still upgrade");
    } finally {
      _resetAuthFails();
      await app.close();
    }
  });
});

Deno.test("cookie clamp: the session cookie carries a session and nothing else", async () => {
  _resetAuthFails();
  const PORT = freePort();
  await withAppsDir(async () => {
    const { cell, aio } = await import("../mod.ts");
    const c = cell("box", { state: { n: 0 }, methods: {} });
    const app = await aio.run({
      cells: [c],
      appId: `test-clamp-${Deno.pid}`,
      appVersion: "0.0.0",
      client: "server-only",
      persist: false,
      libraryMode: true,
      port: PORT,
      baseDir: await Deno.makeTempDir(),
      users: { "tok-admin": { id: "root", role: "admin" } },
    });
    const BASE = `http://127.0.0.1:${PORT}`;
    try {
      // A static `users:` token is a header/URL credential. Smuggling it into
      // the session cookie must not authenticate — that channel is exempt from
      // the failure budget, so it must not be able to guess a short token.
      const viaCookie = await fetch(`${BASE}/__aio/health`, {
        headers: { Cookie: "aio_session=tok-admin" },
      });
      await viaCookie.body?.cancel();
      assertEquals(
        viaCookie.status,
        401,
        "a users: token in a cookie is not a session",
      );
      // The same token in the header still works.
      const viaHeader = await fetch(`${BASE}/__aio/health`, {
        headers: { Authorization: "Bearer tok-admin" },
      });
      await viaHeader.body?.cancel();
      assertEquals(viaHeader.status, 200, "the header credential still works");
    } finally {
      _resetAuthFails();
      await app.close();
    }
  });
});

Deno.test("cookie: a real session cookie still authenticates (no regression)", async () => {
  _resetAuthFails();
  const PORT = freePort();
  await withAppsDir(async () => {
    const app = await bootAuthApp(PORT, `test-cookie-ok-${Deno.pid}`);
    const BASE = `http://127.0.0.1:${PORT}`;
    try {
      const su = await fetch(`${BASE}/__aio/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "dave", password: "password123" }),
      });
      const setCookie = su.headers.get("set-cookie") ?? "";
      await su.body?.cancel();
      const cookie = setCookie.split(";")[0] ?? "";
      assert(cookie.startsWith("aio_session="), "login must set the cookie");

      const me = await fetch(`${BASE}/__aio/auth/me`, {
        headers: { Cookie: cookie },
      });
      assertEquals((await me.json()).user?.id, "dave");

      const health = await fetch(`${BASE}/__aio/health`, {
        headers: { Cookie: cookie },
      });
      await health.body?.cancel();
      assertEquals(health.status, 200, "the session cookie authenticates HTTP");
    } finally {
      _resetAuthFails();
      await app.close();
    }
  });
});

Deno.test("totp: verification is length-checked and timing-safe", async () => {
  const { generateTotpSecret, totpCode, verifyTotp, _resetTotpReplay } =
    await import("../src/server/auth-totp.ts");
  _resetTotpReplay();
  const secret = generateTotpSecret();
  const code = await totpCode(secret);
  // A wrong code that shares every leading digit must be refused just like one
  // that differs in the first — `_timingSafeEqual` compares the full length.
  const near = code.slice(0, 5) + String((Number(code[5]) + 1) % 10);
  assertEquals(await verifyTotp(secret, near), false, "near-miss must fail");
  assertEquals(await verifyTotp(secret, "abcdef"), false, "non-digits fail");
  assertEquals(await verifyTotp(secret, code), true, "the real code passes");
  assertEquals(await verifyTotp(secret, code), false, "…exactly once");
  _resetTotpReplay();
});

Deno.test("expose: a shared key and the login flows refuse to coexist", async () => {
  const { cell, aio } = await import("../mod.ts");
  const c = cell("keyed", { state: { n: 0 }, methods: {} });
  await withAppsDir(async () => {
    // Before: the key was resolved, advertised in the boot banner and handed
    // out by /__aio/pair — and gated NOTHING (the per-user path always returns
    // first), so an anonymous LAN client got the shell and every file under
    // baseDir. A gate that gates nothing must not boot.
    let err: unknown;
    try {
      await aio.run({
        cells: [c],
        appId: `test-key-auth-${Deno.pid}`,
        appVersion: "0.0.0",
        client: "server-only",
        persist: false,
        libraryMode: true,
        auth: true,
        key: true,
        expose: true,
        port: freePort(),
        baseDir: await Deno.makeTempDir(),
      });
    } catch (e) {
      err = e;
    }
    assert(err instanceof Error, "key + auth + expose must refuse to boot");
    assert(
      (err as Error).message.includes("config conflict"),
      `message must name the conflict, got: ${(err as Error).message}`,
    );
  });
});

Deno.test("sessions: the sweep disarms an IDLE socket when its session expires", async () => {
  // The revocation event covers deliberate logout/kick. Expiry has no event —
  // and an idle socket sends nothing to trigger the per-frame check — so the
  // periodic sweep is the universal backstop. Without it a socket kept
  // receiving that identity's `forUser` state after the session was gone.
  _resetAuthFails();
  const PORT = freePort();
  await withAppsDir(async () => {
    const { cell, aio } = await import("../mod.ts");
    const c = cell("idle", { state: { n: 0 }, methods: {} });
    const app = await aio.run({
      cells: [c],
      appId: `test-expiry-${Deno.pid}`,
      appVersion: "0.0.0",
      client: "server-only",
      persist: false,
      libraryMode: true,
      auth: { ttlMs: 500 },
      port: PORT,
      baseDir: await Deno.makeTempDir(),
    });
    try {
      const su = await fetch(`http://127.0.0.1:${PORT}/__aio/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "erin", password: "password123" }),
      });
      const { token } = await su.json() as { token: string };
      const ws = await new Promise<WebSocket>((res, rej) => {
        const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
        const t = setTimeout(() => rej(new Error("ws timeout")), 3000);
        s.onmessage = () => (clearTimeout(t), res(s));
        s.onerror = () => (clearTimeout(t), rej(new Error("ws error")));
      });
      // The socket stays completely idle — only the sweep can notice.
      const closed = await new Promise<boolean>((res) => {
        const t = setTimeout(() => res(false), 8000);
        ws.onclose = () => (clearTimeout(t), res(true));
      });
      try {
        ws.close();
      } catch { /* already closed */ }
      assert(closed, "an expired session's idle socket must be closed");
    } finally {
      _resetAuthFails();
      await app.close();
    }
  });
});

Deno.test("totp: the code compare is timing-safe in the source, not just in the docstring", async () => {
  // A behavioral test cannot tell `!==` from a constant-time compare — the
  // observable results are identical. The property is structural, so the gate
  // is structural: the one thing this file must never do is short-circuit on
  // the submitted code.
  const src = await Deno.readTextFile(
    new URL("../src/server/auth-totp.ts", import.meta.url),
  );
  assert(
    src.includes("_timingSafeEqual(await totpCode("),
    "verifyTotp must compare through _timingSafeEqual",
  );
  assert(
    !/[!=]==\s*submitted/.test(src),
    "no direct string compare against the submitted code",
  );
});
