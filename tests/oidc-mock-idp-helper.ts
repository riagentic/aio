// A mock OpenID provider on a loopback port, and one full login through it.
//
// Discovery, JWKS and a token endpoint that signs whatever claims the test sets
// (RS256, echoing the nonce the /start redirect carried), so a test drives the
// REAL callback — state, binder cookie, PKCE, signature and all — and asserts
// on what the server did with the claims.

import { freePort } from "../src/testing/server-test.ts";

const b64u = (b: Uint8Array | string) =>
  btoa(typeof b === "string" ? b : String.fromCharCode(...b))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Start a mock IdP. `state.claims` is merged into every ID token it signs. */
export async function mockIdp() {
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
          issuer,
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

export type MockIdp = Awaited<ReturnType<typeof mockIdp>>;

/** The account id the callback mints for `sub` at this mock provider. */
export const mockIdpAccountId = (idp: MockIdp, sub: string): string =>
  `oidc:127.0.0.1:${idp.port}:${sub}`;

/** One SSO login: /start → (provider) → /callback with `claims`, then /me with
 *  the session cookie the callback set, if any. `user` is null when no session
 *  was issued; `body` is the callback's response text. */
export async function oidcLogin(
  url: string,
  idp: MockIdp,
  claims: Record<string, unknown>,
): Promise<{
  status: number;
  body: string;
  user: { id: string; role: string } | null;
}> {
  idp.state.claims = claims;
  const s = await fetch(`${url}/__aio/auth/oidc/start`, { redirect: "manual" });
  await s.body?.cancel();
  const loc = new URL(s.headers.get("location")!);
  const binder = s.headers.getSetCookie()[0]!.split(";")[0]!;
  idp.state.nonce = loc.searchParams.get("nonce")!;
  const cb = await fetch(
    `${url}/__aio/auth/oidc/callback?code=x&state=${
      encodeURIComponent(loc.searchParams.get("state")!)
    }`,
    { redirect: "manual", headers: { cookie: binder } },
  );
  const body = await cb.text();
  const sess = cb.headers.getSetCookie().find((c) =>
    c.startsWith("aio_session")
  )?.split(";")[0];
  if (!sess) return { status: cb.status, body, user: null };
  const me = await fetch(`${url}/__aio/auth/me`, { headers: { cookie: sess } });
  return { status: cb.status, body, user: (await me.json()).user };
}
