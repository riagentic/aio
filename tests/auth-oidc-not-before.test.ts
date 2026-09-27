// r7 lead (e): `verifyIdToken` checks `exp` but never `nbf`.
//
// RFC 7519 §4.1.5: "The nbf (not before) claim identifies the time before
// which the JWT MUST NOT be accepted for processing." verifyIdToken verifies
// the signature, iss, aud, azp, exp and sub — and accepts a correctly signed
// token whose `nbf` is an hour in the future. (Its `iat` is never looked at
// either; OIDC Core §3.1.3.7 makes that one a MAY, so only `nbf` is pinned.)
import { assertEquals } from "@std/assert";
import { _resetOidcCaches, verifyIdToken } from "../src/server/auth-oidc.ts";
import { freePort } from "../src/testing/server-test.ts";

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");

Deno.test("oidc verifyIdToken: a token not valid before a future nbf is refused", async () => {
  _resetOidcCaches();
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
  const port = freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    () => Response.json({ keys: [jwk] }),
  );
  const sign = async (claims: Record<string, unknown>): Promise<string> => {
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
  const cfg = { issuer, clientId: "app-client" };
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: issuer, aud: "app-client", sub: "alice" };
  try {
    // Control: a currently valid token verifies (the rig is sound).
    const ok = await verifyIdToken(
      await sign({ ...base, iat: now, exp: now + 300 }),
      cfg,
      `${issuer}/jwks`,
    );
    assertEquals(ok.sub, "alice", "precondition: a valid token verifies");

    // Not yet valid: nbf (and iat) one hour in the future.
    let outcome = "accepted";
    try {
      await verifyIdToken(
        await sign({
          ...base,
          nbf: now + 3600,
          iat: now + 3600,
          exp: now + 7200,
        }),
        cfg,
        `${issuer}/jwks`,
      );
    } catch (e) {
      outcome = `refused: ${e instanceof Error ? e.message : e}`;
    }
    assertEquals(
      outcome.startsWith("refused"),
      true,
      `a token with nbf = now+1h must not be accepted (RFC 7519 §4.1.5); got ${outcome}`,
    );
  } finally {
    await server.shutdown();
    _resetOidcCaches();
  }
});
