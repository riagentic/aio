// The provider ROTATES its signing key — and the JWKS was cached for an hour
// with no way back in. A token naming a `kid` the cached set did not have was
// refused `oidc_unknown_kid`, so after a rotation (Keycloak's "rotate keys",
// an Auth0/Entra rollover — the new key signs from the moment it is
// published) every SSO login failed for up to an hour, while the provider was
// serving the very key that would have verified it. The set is re-read once
// on an unknown `kid`, throttled so a stream of foreign kids cannot turn the
// callback into a JWKS-fetch pump.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { freePort, testServer } from "../src/testing/server-test.ts";
import { _resetOidcCaches } from "../src/server/auth-oidc.ts";

const b64u = (b: Uint8Array | string) =>
  btoa(typeof b === "string" ? b : String.fromCharCode(...b))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const rsa = () =>
  crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;

async function rotatingIdp() {
  const keys = { k1: await rsa(), k2: await rsa() };
  const pub = async (kid: "k1" | "k2") => ({
    ...(await crypto.subtle.exportKey("jwk", keys[kid].publicKey)),
    kid,
    alg: "RS256",
    use: "sig",
  });
  const state = {
    published: ["k1"] as ("k1" | "k2")[],
    signWith: "k1" as "k1" | "k2",
    nonce: "",
    jwksFetches: 0,
  };
  const port = freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen() {} },
    async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      }
      if (u.pathname === "/jwks") {
        state.jwksFetches++;
        return Response.json({
          keys: await Promise.all(state.published.map(pub)),
        });
      }
      if (u.pathname === "/token") {
        await req.text();
        const h = b64u(
          JSON.stringify({ alg: "RS256", kid: state.signWith, typ: "JWT" }),
        );
        const p = b64u(JSON.stringify({
          iss: issuer,
          aud: "app1",
          sub: "u1",
          exp: Math.floor(Date.now() / 1000) + 300,
          nonce: state.nonce,
        }));
        const sig = new Uint8Array(
          await crypto.subtle.sign(
            "RSASSA-PKCS1-v1_5",
            keys[state.signWith].privateKey,
            new TextEncoder().encode(`${h}.${p}`),
          ),
        );
        return Response.json({ id_token: `${h}.${p}.${b64u(sig)}` });
      }
      return new Response("nf", { status: 404 });
    },
  );
  return { issuer, state, close: () => server.shutdown() };
}

type Idp = Awaited<ReturnType<typeof rotatingIdp>>;

/** One full start → callback round; the callback's status. */
async function ssoLogin(url: string, idp: Idp): Promise<number> {
  const s = await fetch(`${url}/__aio/auth/oidc/start`, { redirect: "manual" });
  await s.body?.cancel();
  assertEquals(s.status, 302);
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
  return cb.status;
}

Deno.test("oidc: a login signed with a freshly ROTATED key succeeds without waiting out the JWKS cache", async () => {
  _resetOidcCaches();
  const idp = await rotatingIdp();
  try {
    await using srv = await testServer({
      cells: [
        cell("oidc_rot", { state: { n: 0 }, visible: "all", methods: {} }),
      ],
      auth: { oidc: { issuer: idp.issuer, clientId: "app1" } },
    });
    assertEquals(await ssoLogin(srv.url, idp), 302, "k1 login");
    assertEquals(idp.state.jwksFetches, 1);

    // The provider rotates: k2 published and signing from now on.
    idp.state.published = ["k1", "k2"];
    idp.state.signWith = "k2";
    assertEquals(await ssoLogin(srv.url, idp), 302, "k2 login after rotation");
    assertEquals(idp.state.jwksFetches, 2, "the set was re-read once");

    // A kid the provider does NOT publish is still refused — and cannot make
    // every callback a JWKS fetch (throttled re-read).
    idp.state.signWith = "k1";
    idp.state.published = ["k2"];
    // k1 is still in the cached set, so this verifies from cache — no fetch.
    assertEquals(await ssoLogin(srv.url, idp), 302);
    assert(idp.state.jwksFetches <= 2, `fetches: ${idp.state.jwksFetches}`);
  } finally {
    await idp.close();
  }
});

Deno.test("oidc: an unknown kid re-reads the JWKS at most once per throttle window", async () => {
  _resetOidcCaches();
  const idp = await rotatingIdp();
  try {
    await using srv = await testServer({
      cells: [
        cell("oidc_rot2", { state: { n: 0 }, visible: "all", methods: {} }),
      ],
      auth: { oidc: { issuer: idp.issuer, clientId: "app1" } },
    });
    assertEquals(await ssoLogin(srv.url, idp), 302);
    // Signs with k2, which is never published: refused every time.
    idp.state.signWith = "k2";
    for (let i = 0; i < 4; i++) {
      assertEquals(await ssoLogin(srv.url, idp), 401, `attempt ${i}`);
    }
    assert(
      idp.state.jwksFetches <= 2,
      `an unknown kid must not force a JWKS fetch per login (${idp.state.jwksFetches})`,
    );
  } finally {
    await idp.close();
  }
});
