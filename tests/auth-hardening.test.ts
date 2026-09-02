// The auth hunt — one test per VERIFIED finding, each written to fail
// against the code as it stood before the fix. Every one was reproduced first
// against a real booted server, so every one is reproduced here the same way:
// HTTP over a real port, real PBKDF2, real TOTP codes, real SQLite.
//
// The invariants these pin (a valid credential is served regardless of the
// abuse budget; enabling a factor needs re-auth; a completed reset ends a
// lockout; a role change reaches live sessions) are ALSO asserted after every
// step of the state-machine fuzzer in auth-fuzz.test.ts — this file is the
// legible statement of each one, that file is the one that hunts for the next.

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { awaitStableTotpWindow } from "./totp-window-helper.ts";
import { freePort } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { _resetSecurityWarnings } from "../src/server/server.ts";
import { openUserStore } from "../src/server/auth-users.ts";
import { openSessionStore } from "../src/server/sessions.ts";
import { _resetTotpReplay, totpCode } from "../src/server/auth-totp.ts";
import { renderToString } from "../src/air/vdom-ssr.ts";
import {
  _resetAuthUi,
  _setAuthFeatures,
  SignIn,
} from "../src/browser/browser-auth-ui.ts";
import { h } from "../src/air/vdom.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

interface Booted {
  base: string;
  port: number;
  // deno-lint-ignore no-explicit-any
  app: any;
  post(path: string, body?: unknown, token?: string): Promise<Response>;
  json(path: string, body?: unknown, token?: string): Promise<Json>;
  close(): Promise<void>;
}

/** Boot a real server with the built-in auth. `appId` is unique per test so
 *  auth.db files never cross-contaminate; `dir` pins AIO_APPS_DIR. */
async function boot(
  name: string,
  auth: unknown = true,
  appsDir?: string,
): Promise<Booted> {
  _resetAuthFails();
  _resetTotpReplay();
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const app = await aio.run({
    cells: [cell(`c_${name}`, { state: { n: 0 }, methods: {} })],
    appId: `test-${name}-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    // deno-lint-ignore no-explicit-any
    auth: auth as any,
    port,
    baseDir: appsDir ?? await Deno.makeTempDir(),
  });
  const post = (path: string, body?: unknown, token?: string) =>
    fetch(`${base}/__aio/auth/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    base,
    port,
    app,
    post,
    json: async (p, b, t) => await (await post(p, b, t)).json(),
    close: async () => {
      _resetAuthFails();
      _resetTotpReplay();
      await app.close();
    },
  };
}

/** Pin AIO_APPS_DIR for one block and restore it afterwards. */
async function withAppsDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const prev = Deno.env.get("AIO_APPS_DIR");
  const dir = await Deno.makeTempDir();
  Deno.env.set("AIO_APPS_DIR", dir);
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
  }
}

/** Does a WS handshake with this token succeed? */
function tryWs(port: number, token: string | null): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ""}`,
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

/** Burn the per-IP failed-auth budget from this client key (10 in 5 min). */
async function burnBudget(b: Booted, times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    const r = await b.post("login", {
      id: `victim-${i % 3}`,
      password: `wrong-guess-${i}`,
    });
    await r.body?.cancel();
  }
}

// ── BUG 1 — the fail budget gated SERVICE, not failed authentication ────────
// 10 unauthenticated wrong-password POSTs (unknown ids count too) used to 429
// EVERY later request from that client key: the victim's shell with a valid
// session, their authenticated HTTP calls, and their WS handshake. ~2 req/min
// sustains it forever, and behind the reverse proxy the docs prescribe every
// client shares one key — one attacker took the whole app off the air.
Deno.test("budget: a VALID credential is served while the key is over budget", async () => {
  const b = await boot("budget-valid");
  try {
    const { token } = await b.json("signup", {
      id: "alice",
      password: "password123",
    });
    await burnBudget(b);

    // The attack's own channel is still throttled…
    const throttled = await b.post("login", {
      id: "alice",
      password: "password123",
    });
    assertEquals(throttled.status, 429, "credential CHECKING stays throttled");
    await throttled.body?.cancel();

    // …but nothing the victim does with a credential they already hold is.
    const shell = await fetch(`${b.base}/`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assertEquals(shell.status, 200, "valid session served while over budget");
    await shell.body?.cancel();

    const anon = await fetch(`${b.base}/`);
    assertEquals(anon.status, 200, "anonymous shell is not throttled either");
    await anon.body?.cancel();

    assert(
      await tryWs(b.port, token),
      "WS handshake with a valid session is not refused by the budget",
    );

    // And a PRESENTED-and-wrong credential still gets told to back off.
    const bad = await fetch(`${b.base}/`, {
      headers: { authorization: "Bearer aios_not-a-real-token" },
    });
    assertEquals(bad.status, 429, "a bad credential over budget → 429");
    await bad.body?.cancel();
  } finally {
    await b.close();
  }
});

Deno.test("budget: shared-key mode serves the correct key while over budget", async () => {
  // createServer directly: `expose: true` in a full aio.run() would switch on
  // TLS, and the property under test is the plain-HTTP gate order.
  _resetAuthFails();
  const { createServer } = await import("../src/server/server.ts");
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const KEY = "the-shared-app-key-1234";
  const dir = await Deno.makeTempDir();
  const server = createServer({
    port,
    title: "keyed",
    getUIState: () => ({ n: 0 }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    token: KEY,
  });
  try {
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${base}/`, {
        headers: { authorization: `Bearer wrong-key-${i}` },
      });
      await r.body?.cancel();
    }
    const wrong = await fetch(`${base}/`, {
      headers: { authorization: "Bearer still-wrong" },
    });
    assertEquals(wrong.status, 429, "wrong key over budget → 429");
    await wrong.body?.cancel();
    const right = await fetch(`${base}/`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    assertEquals(right.status, 200, "the key holder is never locked out");
    await right.body?.cancel();
  } finally {
    _resetAuthFails();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("budget: a proxied request with no trustProxyHeader warns LOUDLY", async () => {
  _resetSecurityWarnings();
  const b = await boot("proxy-warn");
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
  try {
    const r = await fetch(`${b.base}/`, {
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    await r.body?.cancel();
  } finally {
    console.warn = orig;
    await b.close();
    _resetSecurityWarnings();
  }
  const hit = warnings.find((w) => w.includes("trustProxyHeader"));
  assert(hit, `expected a bucket-collapse warning, got: ${warnings.join("|")}`);
  assertStringIncludes(hit!, "x-forwarded-for");
  assertStringIncludes(hit!, "ONE abuse bucket");
});

// ── BUG 2 — 2FA enrolled from a stolen session was a permanent takeover ─────
// totp/setup + totp/enable needed only a SESSION, while totp/disable needed
// the password: turning the factor ON was strictly easier than turning it off.
// One stolen token enrolled the attacker's authenticator, and nothing — not a
// completed email reset, not `am auth passwd` — could clear it.
Deno.test("totp: enabling a factor requires the password, exactly like disabling", async () => {
  const b = await boot("totp-enable");
  try {
    const { token } = await b.json("signup", {
      id: "alice",
      password: "password123",
    });
    const { secret } = await b.json("totp/setup", undefined, token);
    // Not near a window edge: a code computed for `step - 1` is two windows
    // stale if the boundary rolls before the server checks it, and the 401
    // that follows has nothing to do with what this test asserts.
    await awaitStableTotpWindow();
    const step = Math.floor(Date.now() / 30_000);

    // The stolen-session attacker: session only, no password.
    const noPw = await b.post(
      "totp/enable",
      { code: await totpCode(secret, step - 1) },
      token,
    );
    assertEquals(noPw.status, 400);
    assertEquals((await noPw.json()).error, "password_required");

    const wrongPw = await b.post(
      "totp/enable",
      { code: await totpCode(secret, step - 1), password: "not-the-password" },
      token,
    );
    assertEquals(wrongPw.status, 401);
    assertEquals((await wrongPw.json()).error, "invalid_credentials");

    // The factor is still OFF — a password login is still a complete login.
    const li = await b.json("login", { id: "alice", password: "password123" });
    assertEquals(li.totpRequired, undefined, "no factor was enrolled");

    // The owner, who knows the password, enrols normally.
    const ok = await b.post(
      "totp/enable",
      { code: await totpCode(secret, step), password: "password123" },
      token,
    );
    assertEquals(ok.status, 200);
    await ok.body?.cancel();
    const li2 = await b.json("login", { id: "alice", password: "password123" });
    assertEquals(li2.totpRequired, true);
  } finally {
    await b.close();
  }
});

Deno.test("totp: `am auth totp <id> off` is the operator recovery path", async () => {
  await withAppsDir(async () => {
    const { appDirs } = await import("../src/server/app-dirs.ts");
    const appId = `test-totp-rescue-${Deno.pid}`;
    const dbPath = appDirs(appId).authDb;
    await Deno.mkdir(appDirs(appId).data, { recursive: true });
    {
      const users = openUserStore(dbPath);
      await users.create("alice", "password123");
      users.setTotpSecret("alice", "JBSWY3DPEHPK3PXP");
      users.enableTotp("alice");
      users.issueToken("totp", "alice", 300_000);
      users.close();
    }
    const { cmdAuth } = await import("../src/am/am-cmd-auth.ts");
    await cmdAuth(["totp", "alice", "off"], { app: appId, json: true });
    const users = openUserStore(dbPath);
    try {
      assertEquals(users.get("alice")?.totpEnabled, false, "factor cleared");
      assertEquals(users.totpSecret("alice"), null, "secret gone with it");
    } finally {
      users.close();
    }
  });
});

// ── BUG 3 — OIDC adopted a LOCAL account by id alone ────────────────────────
// `users.get(claims.sub)` meant an IdP account whose sub equalled a local
// username WAS that user: the session skipped the local account's enrolled
// second factor entirely, and the callback rewrote its email to the
// IdP-supplied one (taking over the password-reset channel).
Deno.test("oidc: an external identity cannot land on a local account", async () => {
  const { _resetOidcCaches } = await import("../src/server/auth-oidc.ts");
  _resetOidcCaches();
  const idpPort = freePort();
  const issuer = `http://127.0.0.1:${idpPort}`;
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey) as
    & JsonWebKey
    & { kid?: string };
  jwk.kid = "k1";
  const b64url = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  let nonce = "";
  const idp = Deno.serve({ port: idpPort, onListen: () => {} }, async (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/.well-known/openid-configuration") {
      return Response.json({
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    }
    if (p === "/jwks") return Response.json({ keys: [jwk] });
    if (p === "/token") {
      const enc = (o: unknown) =>
        b64url(new TextEncoder().encode(JSON.stringify(o)));
      const unsigned = `${enc({ alg: "RS256", kid: "k1" })}.${
        enc({
          iss: issuer,
          aud: "cid",
          sub: "alice", // ← exactly the local username
          email: "attacker@evil.example",
          nonce,
          exp: Math.floor(Date.now() / 1000) + 300,
        })
      }`;
      const sig = new Uint8Array(
        await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          keys.privateKey,
          new TextEncoder().encode(unsigned),
        ),
      );
      return Response.json({ id_token: `${unsigned}.${b64url(sig)}` });
    }
    return new Response("nope", { status: 404 });
  });

  const mails: string[] = [];
  const b = await boot("oidc-ns", {
    oidc: { issuer, clientId: "cid" },
    sendMail: (m: { text: string }) => {
      mails.push(m.text);
    },
  });
  try {
    // A LOCAL alice, with an email and an enrolled second factor.
    const { token } = await b.json("signup", {
      id: "alice",
      password: "password123",
      email: "alice@example.com",
    });
    const { secret } = await b.json("totp/setup", undefined, token);
    // Not near a window edge: a code computed for `step - 1` is two windows
    // stale if the boundary rolls before the server checks it, and the 401
    // that follows has nothing to do with what this test asserts.
    await awaitStableTotpWindow();
    const step = Math.floor(Date.now() / 30_000);
    const en = await b.post("totp/enable", {
      code: await totpCode(secret, step - 1),
      password: "password123",
    }, token);
    assertEquals(en.status, 200);
    await en.body?.cancel();

    // The attacker completes an SSO login whose `sub` is "alice".
    const s = await fetch(`${b.base}/__aio/auth/oidc/start`, {
      redirect: "manual",
    });
    const loc = new URL(s.headers.get("location")!);
    const binder =
      /aio_oidc=([^;]+)/.exec(s.headers.get("set-cookie") ?? "")?.[1] ?? "";
    await s.body?.cancel();
    nonce = loc.searchParams.get("nonce") ?? "";
    const cb = await fetch(
      `${b.base}/__aio/auth/oidc/callback?code=c1&state=${
        loc.searchParams.get("state")
      }`,
      { redirect: "manual", headers: { cookie: `aio_oidc=${binder}` } },
    );
    assertEquals(cb.status, 302);
    const ssoToken = /aio_session=([^;]+)/.exec(
      cb.headers.get("set-cookie") ?? "",
    )![1]!;
    await cb.body?.cancel();

    // The session is NOT alice — it is a separate, namespaced identity.
    const me = await (await fetch(`${b.base}/__aio/auth/me`, {
      headers: { authorization: `Bearer ${ssoToken}` },
    })).json();
    assertNotEquals(me.user.id, "alice", "SSO must not become the local user");
    assertStringIncludes(me.user.id, "oidc:");
    assertStringIncludes(me.user.id, ":alice");

    // The local account is untouched: same email (the reset channel is not
    // handed over) and the second factor still governs its password login.
    const rec = b.app.auth.get("alice");
    assertEquals(rec.email, "alice@example.com", "email NOT rewritten");
    assertEquals(rec.totpEnabled, true);
    const li = await b.json("login", { id: "alice", password: "password123" });
    assertEquals(li.totpRequired, true, "the factor was not bypassed");

    // …and the IdP-owned account has no password-reset door into it: the
    // route answers identically (no enumeration) but mails nothing, so no
    // token can ever install a local password on an SSO identity.
    mails.length = 0;
    const rr = await b.post("reset/request", { id: me.user.id });
    assertEquals(rr.status, 200, "still no enumeration oracle");
    await rr.body?.cancel();
    assertEquals(mails.length, 0, "no reset token for an external identity");
  } finally {
    await b.close();
    await idp.shutdown();
    _resetOidcCaches();
  }
});

// ── BUG 4 — a completed reset left the account locked out ───────────────────
Deno.test("reset: completing a password reset ENDS the lockout", async () => {
  const mails: string[] = [];
  const b = await boot("reset-unlock", {
    sendMail: (m: { text: string }) => {
      mails.push(m.text);
    },
  });
  try {
    const su = await b.post("signup", {
      id: "alice",
      password: "password123",
      email: "alice@example.com",
    });
    await su.body?.cancel();
    // The attacker locks the account (5 consecutive wrong passwords).
    for (let i = 0; i < 5; i++) {
      const r = await b.post("login", { id: "alice", password: `wrong-${i}9` });
      await r.body?.cancel();
    }
    const locked = await b.post("login", {
      id: "alice",
      password: "password123",
    });
    assertEquals(locked.status, 423, "locked before the reset");
    await locked.body?.cancel();

    _resetAuthFails(); // the per-IP budget is a separate control
    mails.length = 0; // signup already mailed a VERIFY token — ignore it
    const rr = await b.post("reset/request", { id: "alice" });
    await rr.body?.cancel();
    const token = /aiot_[0-9a-f]+/.exec(mails.join("\n"))![0];
    const done = await b.post("reset", { token, password: "brand-new-pass-1" });
    assertEquals(done.status, 200);
    await done.body?.cancel();

    const after = await b.post("login", {
      id: "alice",
      password: "brand-new-pass-1",
    });
    assertEquals(
      after.status,
      200,
      "the rescue must actually rescue — not 423 for another 15 minutes",
    );
    await after.body?.cancel();
  } finally {
    await b.close();
  }
});

Deno.test("SignIn: the reset flow is reachable when the server can send mail", () => {
  _resetAuthUi();
  _setAuthFeatures({ signup: true, oidc: false, totp: true, mail: true });
  const html = renderToString(h(SignIn, {}));
  assertStringIncludes(html, "Forgot password?");
  _resetAuthUi();
  _setAuthFeatures({ signup: true, oidc: false, totp: true, mail: false });
  assert(
    !renderToString(h(SignIn, {})).includes("Forgot password?"),
    "no mail transport → no dead-end link",
  );
  _resetAuthUi();
});

// ── BUG 5 — a role change never reached a live session ──────────────────────
Deno.test("role: a demotion reaches a session that is already open", async () => {
  const b = await boot("role-live");
  try {
    const { token } = await b.json("signup", {
      id: "carol",
      password: "password123",
    });
    b.app.auth.setRole("carol", "admin");
    const asAdmin = await fetch(`${b.base}/__aio/snapshot`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assertEquals(asAdmin.status, 200, "promotion is live too");
    await asAdmin.body?.cancel();

    b.app.auth.setRole("carol", "user");
    const demoted = await fetch(`${b.base}/__aio/snapshot`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assertEquals(
      demoted.status,
      403,
      "the SAME token must lose admin the moment the row changes",
    );
    await demoted.body?.cancel();
    const me = await (await fetch(`${b.base}/__aio/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    assertEquals(me.user.role, "user", "resolved from the users row, live");
  } finally {
    await b.close();
  }
});

// ── BUG 6/7 — setPassword is the one decider ────────────────────────────────
Deno.test("setPassword: one decider — unlock, tokens burned, sessions revoked", async () => {
  const path = `${await Deno.makeTempDir()}/auth.db`;
  const sessions = openSessionStore(path);
  const users = openUserStore(path, { sessions: () => sessions });
  try {
    await users.create("bob", "password123");
    // Locked, with a live session and an outstanding pending token.
    for (let i = 0; i < 5; i++) await users.verify("bob", `wrong-${i}9`);
    assertEquals(await users.verify("bob", "password123"), "locked");
    const session = sessions.issue({ id: "bob", role: "user" });
    const pending = users.issueToken("totp", "bob", 300_000);
    const reset = users.issueToken("reset", "bob", 300_000);
    assert(sessions.get(session), "session live before");

    await users.setPassword("bob", "brand-new-pass-1");

    assertNotEquals(
      await users.verify("bob", "brand-new-pass-1"),
      "locked",
      "the lockout dies with the old password",
    );
    assertEquals(sessions.get(session), null, "every session revoked");
    assertEquals(users.consumeToken("totp", pending), null, "pending burned");
    assertEquals(users.consumeToken("reset", reset), null, "reset burned");
  } finally {
    users.close();
    sessions.close();
  }
});

Deno.test("reset: a pending TOTP token cannot outlive the reset that revokes everything", async () => {
  const mails: string[] = [];
  const b = await boot("pending-outlive", {
    sendMail: (m: { text: string }) => {
      mails.push(m.text);
    },
  });
  try {
    const { token } = await b.json("signup", {
      id: "alice",
      password: "password123",
      email: "alice@example.com",
    });
    const { secret } = await b.json("totp/setup", undefined, token);
    // Not near a window edge: a code computed for `step - 1` is two windows
    // stale if the boundary rolls before the server checks it, and the 401
    // that follows has nothing to do with what this test asserts.
    await awaitStableTotpWindow();
    const step = Math.floor(Date.now() / 30_000);
    const en = await b.post("totp/enable", {
      code: await totpCode(secret, step - 1),
      password: "password123",
    }, token);
    await en.body?.cancel();

    // The attacker holds a half-completed login (password known, code not yet).
    const challenge = await b.json("login", {
      id: "alice",
      password: "password123",
    });
    assertEquals(challenge.totpRequired, true);

    mails.length = 0;
    const rr = await b.post("reset/request", { id: "alice" });
    await rr.body?.cancel();
    const rtok = /aiot_[0-9a-f]+/.exec(mails.join("\n"))![0];
    const done = await b.post("reset", {
      token: rtok,
      password: "new-pass-77",
    });
    assertEquals(done.status, 200);
    await done.body?.cancel();

    const late = await b.post("totp", {
      pending: challenge.pending,
      code: await totpCode(secret, step + 1),
    });
    assertEquals(
      late.status,
      401,
      "a pending captured before the reset must not mint a session after it",
    );
    await late.body?.cancel();
  } finally {
    await b.close();
  }
});

// ── BUG 8 — unbounded body on the pre-credential routes ─────────────────────
Deno.test("auth routes: an oversized body is refused, not buffered", async () => {
  const b = await boot("body-cap");
  try {
    const big = "x".repeat(2 * 1024 * 1024);
    const r = await b.post("login", { id: "alice", password: big });
    assertEquals(r.status, 413);
    assertEquals((await r.json()).error, "body_too_large");

    // A body that declares no length at all is cut off by the reader — the
    // declared length is a claim, not a bound.
    let chunks = 0;
    const stream = new ReadableStream({
      pull(c) {
        if (chunks++ > 40) return c.close();
        c.enqueue(new TextEncoder().encode("x".repeat(64 * 1024)));
      },
    });
    const chunked = await fetch(`${b.base}/__aio/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      // @ts-ignore — required by fetch for a streaming request body
      duplex: "half",
    });
    assertEquals(
      chunked.status,
      413,
      "a length-less flood is refused by what was READ, not what was declared",
    );
    await chunked.body?.cancel();

    // A normal body still works.
    const ok = await b.post("signup", { id: "alice", password: "password123" });
    assertEquals(ok.status, 201);
    await ok.body?.cancel();
  } finally {
    await b.close();
  }
});

Deno.test("pairing: the pre-credential /__aio/pair body is bounded too", async () => {
  // Same class as the auth-route cap, same reason: reachable before any
  // credential (that is what pairing IS), so an unbounded read is an
  // anonymous memory pump.
  _resetAuthFails();
  const { createServer } = await import("../src/server/server.ts");
  const port = freePort();
  const dir = await Deno.makeTempDir();
  const server = createServer({
    port,
    title: "pairing",
    getUIState: () => ({ n: 0 }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    token: "a-shared-key",
  });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__aio/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "0".repeat(2 * 1024 * 1024) }),
    });
    assertEquals(r.status, 413);
    await r.body?.cancel();
  } finally {
    _resetAuthFails();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── BUG 9 — `totp: false` silently dropped an enrolled factor ───────────────
Deno.test("totp: `totp: false` disables enrollment, never verification", async () => {
  // A persistent auth.db that survives the restart — the exact shape of the
  // report: same store, second boot, enrollment switched off.
  const appDir = await Deno.makeTempDir();
  const secret = "JBSWY3DPEHPK3PXP";
  await Deno.mkdir(`${appDir}/data`, { recursive: true });
  {
    const users = openUserStore(`${appDir}/data/auth.db`);
    await users.create("alice", "password123");
    users.setTotpSecret("alice", secret);
    users.enableTotp("alice");
    users.close();
  }
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
  const app = await aio.run({
    cells: [cell("t9", { state: { n: 0 }, methods: {} })],
    appId: `test-totpoff-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    appDir,
    auth: { totp: false },
    port,
    baseDir: await Deno.makeTempDir(),
  });
  console.warn = origWarn;
  try {
    // Boot said so out loud rather than leaving it to be discovered.
    assert(
      warnings.some((w) => w.includes("ENROLLMENT only")),
      `boot must warn about already-enrolled accounts: ${warnings.join("|")}`,
    );
    const li = await fetch(`http://127.0.0.1:${port}/__aio/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "alice", password: "password123" }),
    });
    const body = await li.json();
    assertEquals(
      body.totpRequired,
      true,
      "a config switch must never quietly drop a factor a user relies on",
    );
    assertEquals(body.token, undefined, "and no session was issued");
    // Enrollment IS off.
    const su = await fetch(`http://127.0.0.1:${port}/__aio/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "bob", password: "password123" }),
    });
    const bob = await su.json();
    const setup = await fetch(
      `http://127.0.0.1:${port}/__aio/auth/totp/setup`,
      { method: "POST", headers: { authorization: `Bearer ${bob.token}` } },
    );
    assertEquals(setup.status, 403, "enrollment is what the flag turns off");
    await setup.body?.cancel();
  } finally {
    console.warn = origWarn;
    _resetAuthFails();
    await app.close();
  }
});

// ── BUG 10 — confusable ids ─────────────────────────────────────────────────
Deno.test("ids: confusable spellings cannot become separate accounts", async () => {
  const users = openUserStore(":memory:");
  try {
    await users.create("neighbour", "password123");
    for (const dup of ["Neighbour", "NEIGHBOUR", "  neighbour  "]) {
      await users.create(dup, "password123").then(
        () => assert(false, `"${dup}" must not create a second account`),
        (e) => assertEquals((e as Error).message, "user_exists"),
      );
    }
    // NFD spelling of "sué" collides with its NFC spelling.
    await users.create("sué", "password123");
    await users.create("sué", "password123").then(
      () => assert(false, "NFD must not create a second account"),
      (e) => assertEquals((e as Error).message, "user_exists"),
    );
    // Whitespace-only and invisible-character ids are refused outright.
    for (const bad of ["   ", "", "a‍b", "a b", "john doe"]) {
      await users.create(bad, "password123").then(
        () => assert(false, `"${bad}" must be refused`),
        (e) => assertEquals((e as Error).message, "invalid_id"),
      );
    }
    assertEquals(users.count(), 2);
    // Lookups agree with what was stored.
    assertEquals(users.get(" neighbour ")?.id, "neighbour");
  } finally {
    users.close();
  }
});

// ── BUG 11 — identity-bearing responses were cacheable ──────────────────────
Deno.test("auth responses carry Cache-Control: no-store", async () => {
  const b = await boot("no-store");
  try {
    const su = await b.post("signup", { id: "alice", password: "password123" });
    assertEquals(su.headers.get("cache-control"), "no-store");
    const { token } = await su.json();
    const li = await b.post("login", { id: "alice", password: "password123" });
    assertEquals(li.headers.get("cache-control"), "no-store");
    await li.body?.cancel();
    const me = await fetch(`${b.base}/__aio/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assertEquals(me.headers.get("cache-control"), "no-store");
    await me.body?.cancel();
  } finally {
    await b.close();
  }
});
