// AUTH-3 — TOTP (RFC vectors), per-account lockout, one-shot tokens, email
// verify/reset flows, password rotation, TOTP login loop, and a full OIDC
// code+PKCE round trip against an in-test IdP (real RS256 JWKS verify).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  totpCode,
  totpUri,
  verifyTotp,
} from "../src/server/auth-totp.ts";
import { openUserStore } from "../src/server/auth-users.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { _resetOidcCaches } from "../src/server/auth-oidc.ts";
import { freePort } from "../src/testing/server-test.ts";

const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const IDP_PORT = freePort();

// ── TOTP unit ────────────────────────────────────────────────────────────────

Deno.test("totp: base32 roundtrip + RFC 6238 SHA-1 vector", async () => {
  const secret = new TextEncoder().encode("12345678901234567890");
  const b32 = base32Encode(secret);
  assertEquals(b32, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assertEquals(base32Decode(b32), secret);
  // RFC 6238 Appendix B: T=59s → step 1 → HOTP 94287082 → 6 digits "287082".
  assertEquals(await totpCode(b32, 1), "287082");
  // T=1111111109 → step 37037036 → "081804".
  assertEquals(await totpCode(b32, 37037036), "081804");
});

Deno.test("totp: verify window + format rejection", async () => {
  const now = Math.floor(Date.now() / 30_000);
  // A fresh secret per case: codes are one-time-use per secret, so accepting
  // `now` on one secret would (correctly) refuse the older `now - 1` on it.
  const s1 = generateTotpSecret(), s2 = generateTotpSecret();
  const s3 = generateTotpSecret(), s4 = generateTotpSecret();
  assert(await verifyTotp(s1, await totpCode(s1, now)));
  assert(await verifyTotp(s2, await totpCode(s2, now - 1)), "prev step ok");
  assert(
    !(await verifyTotp(s3, await totpCode(s3, now - 5))),
    "stale code",
  );
  assert(!(await verifyTotp(s4, "12345")), "5 digits rejected");
  assert(!(await verifyTotp(s4, "abcdef")), "non-digits rejected");
  assertStringIncludes(
    totpUri(s1, "alice", "Shop"),
    "otpauth://totp/Shop:alice?",
  );
});

// ── Lockout + one-shot tokens (store level) ──────────────────────────────────

Deno.test("lockout: 5 fails lock; 'locked' only leaks past the password gate", async () => {
  const s = openUserStore(":memory:");
  await s.create("alice", "password123");
  // Wrong passwords ALWAYS return a generic null — never the "locked" signal
  // (no enumeration / lock-state oracle for a wrong-guessing attacker).
  for (let i = 0; i < 6; i++) {
    assertEquals(
      await s.verify("alice", "wrong-wrong"),
      null,
      "wrong password is always generic null, locked or not",
    );
  }
  // The correct password, once locked, DOES reveal the lock — only the owner,
  // who proved they know the password, learns to wait it out.
  assertEquals(
    await s.verify("alice", "password123"),
    "locked",
    "correct password past the gate reveals the lock to the owner",
  );
  s.close();
});

Deno.test("lockout: a success resets the fail counter", async () => {
  const s = openUserStore(":memory:");
  await s.create("alice", "password123");
  const asUser = (v: unknown) => v as { id: string } | null;
  for (let i = 0; i < 4; i++) await s.verify("alice", "wrong-wrong");
  assertEquals(asUser(await s.verify("alice", "password123"))?.id, "alice");
  for (let i = 0; i < 4; i++) await s.verify("alice", "wrong-wrong");
  assertEquals(
    asUser(await s.verify("alice", "password123"))?.id,
    "alice",
    "counter was reset — 4 new fails don't lock",
  );
  s.close();
});

Deno.test("unlock + list: the operator rescue path", async () => {
  const s = openUserStore(":memory:");
  await s.create("alice", "password123", { email: "a@b.co" });
  for (let i = 0; i < 6; i++) await s.verify("alice", "wrong-wrong");
  assertEquals(await s.verify("alice", "password123"), "locked");
  assert(s.unlock("alice"), "unlock clears the lockout");
  assertEquals(
    (await s.verify("alice", "password123") as { id: string }).id,
    "alice",
  );
  await s.create("bob", "password123");
  const listed = s.list();
  assertEquals(listed.length, 2);
  assertEquals(listed[0]!.id, "bob", "newest first");
  assertEquals(listed[1]!.email, "a@b.co");
  s.close();
});

Deno.test("one-shot tokens: consume once, expire, kind-scoped", () => {
  const s = openUserStore(":memory:");
  const t = s.issueToken("verify", "alice", 60_000);
  assert(t.startsWith("aiot_"));
  assertEquals(s.consumeToken("reset", t), null, "wrong kind never matches");
  assertEquals(s.consumeToken("verify", t)?.subject, "alice");
  assertEquals(s.consumeToken("verify", t), null, "one-shot — second use dead");
  const dead = s.issueToken("reset", "bob", -1);
  assertEquals(s.consumeToken("reset", dead), null, "expired");
  s.close();
});

// ── E2E: verify / reset / password / TOTP / lockout over HTTP ───────────────

Deno.test("auth e2e: email verify, reset, password rotation, totp, lockout", async () => {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const c = cell("news", { state: { n: 0 }, methods: {} });
  const outbox: { to: string; subject: string; text: string }[] = [];

  const app = await aio.run({
    cells: [c],
    appId: `test-auth3-${Deno.pid}`,
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: {
      requireVerified: true,
      sendMail: (m) => {
        outbox.push(m);
      },
    },
    port: PORT,
    baseDir: await Deno.makeTempDir(),
  });

  const post = (path: string, body?: unknown, token?: string) =>
    fetch(`${BASE}/__aio/auth/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const tokenFrom = (text: string): string => /aiot_[0-9a-f]+/.exec(text)![0];

  try {
    // Signup with requireVerified: no session until the email is proven.
    const su = await post("signup", {
      id: "alice",
      password: "password123",
      email: "alice@example.com",
    });
    assertEquals(su.status, 201);
    const suBody = await su.json();
    assertEquals(suBody.verificationSent, true);
    assertEquals(suBody.token, undefined, "no session before verification");
    assertEquals(outbox.length, 1);

    // Login before verification → 403.
    const early = await post("login", { id: "alice", password: "password123" });
    assertEquals(early.status, 403);
    assertEquals((await early.json()).error, "email_unverified");

    // Verify with the mailed token → login works.
    const vr = await post("verify", { token: tokenFrom(outbox[0]!.text) });
    assertEquals(vr.status, 200);
    await vr.body?.cancel();
    const li = await post("login", { id: "alice", password: "password123" });
    assertEquals(li.status, 200);
    const session1 = (await li.json()).token as string;

    // Password change rotates every session.
    const pw = await post(
      "password",
      { old: "password123", new: "password-two-2" },
      session1,
    );
    assertEquals(pw.status, 200);
    const session2 = (await pw.json()).token as string;
    const meOld = await (await fetch(`${BASE}/__aio/auth/me`, {
      headers: { authorization: `Bearer ${session1}` },
    })).json();
    assertEquals(meOld.user, null, "pre-rotation session revoked");

    // Reset flow: request (never enumerates) → mailed token → new password,
    // all sessions revoked.
    const rr = await post("reset/request", { id: "alice" });
    assertEquals(rr.status, 200);
    await rr.body?.cancel();
    const ghost = await post("reset/request", { id: "nobody" });
    assertEquals(ghost.status, 200, "unknown id gets the same 200");
    await ghost.body?.cancel();
    assertEquals(outbox.length, 2);
    const rs = await post("reset", {
      token: tokenFrom(outbox[1]!.text),
      password: "password-three-3",
    });
    assertEquals(rs.status, 200);
    await rs.body?.cancel();
    const meRotated = await (await fetch(`${BASE}/__aio/auth/me`, {
      headers: { authorization: `Bearer ${session2}` },
    })).json();
    assertEquals(meRotated.user, null, "reset revokes every session");
    const li3 = await post("login", {
      id: "alice",
      password: "password-three-3",
    });
    assertEquals(li3.status, 200);
    const session3 = (await li3.json()).token as string;

    // TOTP: setup → enable (real code) → login now returns a challenge →
    // complete it; a wrong code burns the pending token.
    const setup = await post("totp/setup", undefined, session3);
    assertEquals(setup.status, 200);
    const { secret, uri } = await setup.json();
    assertStringIncludes(uri, "otpauth://totp/");
    // Each code is one-time-use, so this flow walks forward through steps the
    // way a real user does (enrol with the code on screen, log in with the
    // next one) instead of re-submitting the same one.
    const step = Math.floor(Date.now() / 30_000);
    const en = await post(
      "totp/enable",
      { code: await totpCode(secret, step - 1) },
      session3,
    );
    assertEquals(en.status, 200);
    await en.body?.cancel();

    const li4 = await post("login", {
      id: "alice",
      password: "password-three-3",
    });
    assertEquals(li4.status, 200);
    const challenge = await li4.json();
    assertEquals(challenge.totpRequired, true);
    const badCode = await post("totp", {
      pending: challenge.pending,
      code: "000000",
    });
    assertEquals(badCode.status, 401);
    await badCode.body?.cancel();
    const replay = await post("totp", {
      pending: challenge.pending,
      code: await totpCode(secret, step), // valid + unused: only the token is spent
    });
    assertEquals(replay.status, 401, "wrong attempt burned the pending token");
    await replay.body?.cancel();

    const li5 = await post("login", {
      id: "alice",
      password: "password-three-3",
    });
    const challenge2 = await li5.json();
    const good = await post("totp", {
      pending: challenge2.pending,
      code: await totpCode(secret, step + 1),
    });
    assertEquals(good.status, 200);
    assertEquals((await good.json()).user.id, "alice");

    // Lockout over HTTP: hammer wrong passwords → 423 (not 401) once locked.
    _resetAuthFails(); // isolate account lockout from the per-IP budget
    for (let i = 0; i < 5; i++) {
      const r = await post("login", { id: "alice", password: "hammer-hammer" });
      assertEquals(r.status, 401);
      await r.body?.cancel();
    }
    const locked = await post("login", {
      id: "alice",
      password: "password-three-3",
    });
    assertEquals(
      locked.status,
      423,
      "locked account refuses even the right password",
    );
    await locked.body?.cancel();
  } finally {
    _resetAuthFails();
    await app.close();
  }
});

// ── E2E: OIDC code + PKCE against an in-test IdP ────────────────────────────

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

Deno.test("auth e2e: OIDC login — discovery, PKCE, RS256 JWKS verify, session", async () => {
  _resetAuthFails();
  _resetOidcCaches();
  const { cell, aio } = await import("../mod.ts");
  const c = cell("portal", { state: { n: 0 }, methods: {} });

  // In-test IdP: real RSA-2048 keys, real signatures — nothing mocked away.
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
  const issuer = `http://127.0.0.1:${IDP_PORT}`;
  const signIdToken = async (
    claims: Record<string, unknown>,
  ): Promise<string> => {
    const enc = (o: unknown) =>
      b64url(new TextEncoder().encode(JSON.stringify(o)));
    const unsigned = `${enc({ alg: "RS256", kid: "k1" })}.${enc(claims)}`;
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keys.privateKey,
        new TextEncoder().encode(unsigned),
      ),
    );
    return `${unsigned}.${b64url(sig)}`;
  };
  const seenTokenReq: Record<string, string>[] = [];
  // The provider echoes the request nonce into the ID token; the test sets it
  // from the /start redirect it observes (a real provider ties it to the code).
  let pendingNonce = "";
  const idp = Deno.serve(
    { port: IDP_PORT, onListen: () => {} },
    async (req) => {
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
        const form = Object.fromEntries(
          new URLSearchParams(await req.text()).entries(),
        );
        seenTokenReq.push(form);
        return Response.json({
          id_token: await signIdToken({
            iss: issuer,
            aud: "portal-client",
            sub: "google|alice",
            email: "alice@example.com",
            nonce: pendingNonce,
            exp: Math.floor(Date.now() / 1000) + 300,
          }),
        });
      }
      return new Response("nope", { status: 404 });
    },
  );

  // Drive a full start→callback, plumbing the browser-binder cookie and the
  // nonce the way a real browser + provider would.
  const driveOidc = async (
    redirect?: string,
  ): Promise<Response> => {
    const startUrl = `${BASE}/__aio/auth/oidc/start${
      redirect ? `?redirect=${encodeURIComponent(redirect)}` : ""
    }`;
    const s = await fetch(startUrl, { redirect: "manual" });
    const loc = new URL(s.headers.get("location")!);
    const setCookie = s.headers.get("set-cookie") ?? "";
    await s.body?.cancel();
    pendingNonce = loc.searchParams.get("nonce") ?? "";
    const binder = /aio_oidc=([^;]+)/.exec(setCookie)?.[1] ?? "";
    const state = loc.searchParams.get("state")!;
    return await fetch(
      `${BASE}/__aio/auth/oidc/callback?code=authcode-1&state=${state}`,
      { redirect: "manual", headers: { cookie: `aio_oidc=${binder}` } },
    );
  };

  const app = await aio.run({
    cells: [c],
    appId: `test-oidc-${Deno.pid}`,
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: {
      oidc: { issuer, clientId: "portal-client", role: () => "reader" },
    },
    port: PORT,
    baseDir: await Deno.makeTempDir(),
  });

  try {
    // Full round trip → session, mapped role, PKCE verifier sent.
    const cb = await driveOidc();
    assertEquals(cb.status, 302);
    assertEquals(cb.headers.get("location"), "/");
    const cookie = cb.headers.get("set-cookie") ?? "";
    assertStringIncludes(cookie, "aio_session=");
    await cb.body?.cancel();
    assertEquals(seenTokenReq[0]!.code, "authcode-1");
    assert(seenTokenReq[0]!.code_verifier, "PKCE verifier was sent");

    const token = /aio_session=([^;]+)/.exec(cookie)![1]!;
    const me = await (await fetch(`${BASE}/__aio/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    assertEquals(me.user, { id: "google|alice", role: "reader" });

    // CSRF binding: a callback WITHOUT the browser binder cookie is refused,
    // even with a valid (code, state). Defeats login-CSRF / session fixation.
    const s2 = await fetch(`${BASE}/__aio/auth/oidc/start`, {
      redirect: "manual",
    });
    const loc2 = new URL(s2.headers.get("location")!);
    await s2.body?.cancel();
    pendingNonce = loc2.searchParams.get("nonce") ?? "";
    const unbound = await fetch(
      `${BASE}/__aio/auth/oidc/callback?code=x&state=${
        loc2.searchParams.get("state")
      }`,
      { redirect: "manual" }, // no cookie
    );
    assertEquals(unbound.status, 400, "callback without binder cookie refused");
    await unbound.body?.cancel();

    // Replayed state is dead (one-shot) — the consumed state above is gone.
    const replay = await fetch(
      `${BASE}/__aio/auth/oidc/callback?code=authcode-2&state=${
        loc2.searchParams.get("state")
      }`,
      { redirect: "manual" },
    );
    assertEquals(replay.status, 400);
    await replay.body?.cancel();

    // Deep-link return: ?redirect=/orders/7 survives; open-redirect payloads
    // (absolute, protocol-relative, and backslash-bypass) sanitize to "/".
    for (
      const [redirect, expected] of [
        ["/orders/7", "/orders/7"],
        ["https://evil.example/", "/"],
        ["//evil.example", "/"],
        ["/\\evil.example", "/"],
        ["/\t/evil.example", "/"], // TAB the browser strips → protocol-relative
        ["/\n//evil", "/"],
      ] as const
    ) {
      const cbr = await driveOidc(redirect);
      assertEquals(
        cbr.headers.get("location"),
        expected,
        `redirect=${redirect}`,
      );
      await cbr.body?.cancel();
    }
  } finally {
    _resetAuthFails();
    _resetOidcCaches();
    await app.close();
    await idp.shutdown();
  }
});
