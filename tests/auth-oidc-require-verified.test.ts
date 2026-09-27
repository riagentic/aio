// `auth.requireVerified: true` holds for an SSO login too.
//
// The option reads "Block login until the account's email is verified", and
// the password login route enforces it (`403 email_unverified`). The OIDC
// callback minted a session regardless — so an account whose provider did NOT
// vouch for the address (`email_verified` absent or false, which is exactly
// the account `requireVerified` exists to keep out) signed straight in.
//
// Now the callback asks the same question at the same point — after the
// identity is established, before a session exists — and answers with the
// same code. An account the provider DID vouch for (new or existing) is
// verified by that, and signs in.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetOidcCaches } from "../src/server/auth-oidc.ts";
import {
  mockIdp,
  mockIdpAccountId,
  oidcLogin,
} from "./oidc-mock-idp-helper.ts";

const authCfg = (issuer: string) => ({
  requireVerified: true as const,
  sendMail: () => {},
  oidc: { issuer, clientId: "app1" },
});

Deno.test("auth: requireVerified refuses an SSO login whose email the provider did not verify", async () => {
  _resetOidcCaches();
  const idp = await mockIdp();
  try {
    await using srv = await testServer({
      cells: [
        cell("oidc_rv_refuse", {
          state: { n: 0 },
          visible: "all",
          methods: {},
        }),
      ],
      auth: authCfg(idp.issuer),
    });
    for (
      const claims of [
        { sub: "u1", email: "u1@example.com", email_verified: false },
        { sub: "u2" }, // no email at all — nothing could ever verify it
      ]
    ) {
      const got = await oidcLogin(srv.url, idp, claims);
      const rec = srv.app.auth!.get(mockIdpAccountId(idp, claims.sub));
      assertEquals(rec?.verified, false, "the account is unverified");
      assertEquals(got.status, 403, `got ${JSON.stringify(got)}`);
      assertStringIncludes(got.body, "email_unverified");
      assertEquals(got.user, null, "…and no session was issued");
    }
  } finally {
    await idp.close();
  }
});

Deno.test("auth: requireVerified admits an SSO login the provider vouched for — new or existing account", async () => {
  _resetOidcCaches();
  const idp = await mockIdp();
  try {
    await using srv = await testServer({
      cells: [
        cell("oidc_rv_admit", { state: { n: 0 }, visible: "all", methods: {} }),
      ],
      auth: authCfg(idp.issuer),
    });
    // New account, verified address → verified account, signed in.
    const fresh = await oidcLogin(srv.url, idp, {
      sub: "v1",
      email: "v1@example.com",
      email_verified: true,
    });
    assertEquals(fresh.status, 302, `got ${JSON.stringify(fresh)}`);
    assertEquals(fresh.user?.id, mockIdpAccountId(idp, "v1"));

    // Existing unverified account: refused until the provider vouches for an
    // address, and admitted the login it does.
    const id = mockIdpAccountId(idp, "v2");
    const first = await oidcLogin(srv.url, idp, { sub: "v2" });
    assertEquals(first.status, 403);
    assertEquals(srv.app.auth!.get(id)?.verified, false);
    const later = await oidcLogin(srv.url, idp, {
      sub: "v2",
      email: "v2@example.com",
      email_verified: true,
    });
    assertEquals(later.status, 302, `got ${JSON.stringify(later)}`);
    assertEquals(later.user?.id, id);
    const rec = srv.app.auth!.get(id);
    assertEquals(rec?.email, "v2@example.com");
    assertEquals(rec?.verified, true);
  } finally {
    await idp.close();
  }
});

// `setEmail` clears `verified`; the vouch that follows must read the NEW
// state, not the pre-change record — else a verified user whose provider email
// changes is refused on that login (and admitted only on the next).
Deno.test("auth: requireVerified admits a verified SSO user whose provider email changed — same login", async () => {
  _resetOidcCaches();
  const idp = await mockIdp();
  try {
    await using srv = await testServer({
      cells: [
        cell("oidc_rv_change", {
          state: { n: 0 },
          visible: "all",
          methods: {},
        }),
      ],
      auth: authCfg(idp.issuer),
    });
    const id = mockIdpAccountId(idp, "v3");
    const first = await oidcLogin(srv.url, idp, {
      sub: "v3",
      email: "old@example.com",
      email_verified: true,
    });
    assertEquals(first.status, 302, `got ${JSON.stringify(first)}`);
    const got = await oidcLogin(srv.url, idp, {
      sub: "v3",
      email: "new@example.com",
      email_verified: true,
    });
    assertEquals(got.status, 302, `got ${JSON.stringify(got)}`);
    assertEquals(got.user?.id, id);
    const rec = srv.app.auth!.get(id);
    assertEquals(rec?.email, "new@example.com");
    assertEquals(rec?.verified, true);
  } finally {
    await idp.close();
  }
});
