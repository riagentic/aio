// OIDC claim checks the callback skipped — against a mock provider, real server.
//
// 1. `email_verified` was ignored. The account was marked verified, an existing
//    account's email was overwritten, and `role(claims)` saw the address — so
//    the documented `claims.email === "boss@corp.com" ? "admin" : "user"` made
//    anyone who TYPED that address at the provider an admin (the hunt's p8:
//    `{ email: "boss@corp.com", email_verified: false }` → role "admin").
// 2. `azp` was never checked: a token issued to another client that merely
//    lists this one among several audiences was accepted (OIDC Core §3.1.3.7).
// 3. The discovery document's `issuer` was never compared to the configured
//    one (OIDC Discovery §4.3).
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { freePort, testServer } from "../src/testing/server-test.ts";
import { _resetOidcCaches } from "../src/server/auth-oidc.ts";

const b64u = (b: Uint8Array | string) =>
  btoa(typeof b === "string" ? b : String.fromCharCode(...b))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function mockIdp(
  opts: { discoveryIssuer?: (iss: string) => string } = {},
) {
  const kp = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", kp.publicKey)),
    kid: "k1",
    alg: "RS256",
    use: "sig",
  };
  const port = freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const state = { claims: {} as Record<string, unknown>, nonce: "" };
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen() {} },
    async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: opts.discoveryIssuer ? opts.discoveryIssuer(issuer) : issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      }
      if (u.pathname === "/jwks") return Response.json({ keys: [jwk] });
      if (u.pathname === "/token") {
        await req.text();
        const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
        const p = b64u(JSON.stringify({
          iss: issuer,
          aud: "app1",
          exp: Math.floor(Date.now() / 1000) + 300,
          nonce: state.nonce,
          ...state.claims,
        }));
        const sig = new Uint8Array(
          await crypto.subtle.sign(
            "RSASSA-PKCS1-v1_5",
            kp.privateKey,
            new TextEncoder().encode(`${h}.${p}`),
          ),
        );
        return Response.json({ id_token: `${h}.${p}.${b64u(sig)}` });
      }
      return new Response("nf", { status: 404 });
    },
  );
  return { issuer, port, state, close: () => server.shutdown() };
}

type Idp = Awaited<ReturnType<typeof mockIdp>>;

async function login(
  url: string,
  idp: Idp,
  claims: Record<string, unknown>,
): Promise<{ status: number; user: { id: string; role: string } | null }> {
  idp.state.claims = claims;
  const s = await fetch(`${url}/__aio/auth/oidc/start`, { redirect: "manual" });
  await s.body?.cancel();
  if (s.status !== 302) return { status: s.status, user: null };
  const loc = new URL(s.headers.get("location")!);
  const binder = s.headers.getSetCookie()[0]!.split(";")[0]!;
  idp.state.nonce = loc.searchParams.get("nonce")!;
  const cb = await fetch(
    `${url}/__aio/auth/oidc/callback?code=x&state=${
      encodeURIComponent(loc.searchParams.get("state")!)
    }`,
    { redirect: "manual", headers: { cookie: binder } },
  );
  await cb.body?.cancel();
  const sess = cb.headers.getSetCookie().find((c) =>
    c.startsWith("aio_session")
  )?.split(";")[0];
  if (!sess) return { status: cb.status, user: null };
  const me = await fetch(`${url}/__aio/auth/me`, { headers: { cookie: sess } });
  return { status: cb.status, user: (await me.json()).user };
}

const bossRole = (claims: Record<string, unknown>) =>
  claims.email === "boss@corp.com" ? "admin" : "user";

Deno.test("oidc: an UNVERIFIED email grants no role, is not stored, and is not marked verified", async () => {
  _resetOidcCaches();
  const idp = await mockIdp();
  try {
    await using srv = await testServer({
      cells: [
        cell("oidc_c1", { state: { n: 0 }, visible: "all", methods: {} }),
      ],
      auth: { oidc: { issuer: idp.issuer, clientId: "app1", role: bossRole } },
    });
    const idFor = (sub: string) => `oidc:127.0.0.1:${idp.port}:${sub}`;

    const forged = await login(srv.url, idp, {
      sub: "attacker",
      email: "boss@corp.com",
      email_verified: false,
    });
    assertEquals(forged.status, 302);
    assertEquals(forged.user, { id: idFor("attacker"), role: "user" });
    const rec = srv.app.auth!.get(idFor("attacker"))!;
    assertEquals(rec.verified, false, "an unverified email is not verified");
    assertEquals(rec.email, null, "…and is not stored");

    // The string "true" is not the boolean the claim is.
    const stringy = await login(srv.url, idp, {
      sub: "stringy",
      email: "boss@corp.com",
      email_verified: "true",
    });
    assertEquals(stringy.user?.role, "user");

    // A VERIFIED email is exactly as useful as it was.
    const boss = await login(srv.url, idp, {
      sub: "boss",
      email: "boss@corp.com",
      email_verified: true,
    });
    assertEquals(boss.user, { id: idFor("boss"), role: "admin" });
    const bossRec = srv.app.auth!.get(idFor("boss"))!;
    assertEquals(bossRec.verified, true);
    assertEquals(bossRec.email, "boss@corp.com");

    // An existing account's email is not rewritten from an unverified claim.
    await login(srv.url, idp, {
      sub: "boss",
      email: "someone-else@evil.example",
      email_verified: false,
    });
    assertEquals(srv.app.auth!.get(idFor("boss"))!.email, "boss@corp.com");
  } finally {
    await idp.close();
  }
});

Deno.test("oidc: azp must be this client, and a multi-audience token must name it", async () => {
  _resetOidcCaches();
  const idp = await mockIdp();
  try {
    await using srv = await testServer({
      cells: [
        cell("oidc_c2", { state: { n: 0 }, visible: "all", methods: {} }),
      ],
      auth: { oidc: { issuer: idp.issuer, clientId: "app1" } },
    });
    const other = await login(srv.url, idp, {
      sub: "u1",
      aud: ["other-client", "app1"],
      azp: "other-client",
    });
    assertEquals(other.status, 401, "a token issued to another client");
    assertEquals(other.user, null);

    const noAzp = await login(srv.url, idp, {
      sub: "u2",
      aud: ["other-client", "app1"],
    });
    assertEquals(noAzp.status, 401, "several audiences and no azp");

    const ours = await login(srv.url, idp, {
      sub: "u3",
      aud: ["other-client", "app1"],
      azp: "app1",
    });
    assertEquals(ours.status, 302, "issued to us, extra audiences allowed");
    assert(ours.user);

    const single = await login(srv.url, idp, { sub: "u4" });
    assertEquals(single.status, 302, "a single-audience token needs no azp");
  } finally {
    await idp.close();
  }
});

Deno.test("oidc: a discovery document for a DIFFERENT issuer is refused", async () => {
  _resetOidcCaches();
  const idp = await mockIdp({ discoveryIssuer: () => "https://evil.example" });
  try {
    await using srv = await testServer({
      cells: [
        cell("oidc_c3", { state: { n: 0 }, visible: "all", methods: {} }),
      ],
      auth: { oidc: { issuer: idp.issuer, clientId: "app1" } },
    });
    const r = await login(srv.url, idp, { sub: "u1" });
    assert(r.status >= 400, `login must not proceed, got ${r.status}`);
    assertEquals(r.user, null);
  } finally {
    await idp.close();
  }
});
