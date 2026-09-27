// `auth: { signup: false }` closes EVERY door that creates an account — the
// SSO one included.
//
// The option is typed and documented as "admin-seeded users only", and the
// password door honoured it (`POST /signup` → 403). The OIDC callback did not
// consult it: any identity the provider would vouch for — for Google, anyone
// with a Google account — got a fresh `role: "user"` account and a session on
// its first login. So `signup: false` + `oidc` was, in effect, open signup.
//
// Now an unknown SSO identity is refused (403 `signup_disabled`, the password
// route's code) and nothing is created; an identity the operator seeded
// (`am auth create "oidc:<issuer>:<sub>"`, the external-identity door) signs in
// as before; and the default (`signup` on) still creates on first login.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetOidcCaches } from "../src/server/auth-oidc.ts";
import { externalCreatorOf } from "../src/server/auth-users.ts";
import {
  mockIdp,
  mockIdpAccountId,
  oidcLogin,
} from "./oidc-mock-idp-helper.ts";

Deno.test("auth: signup:false refuses an unseeded SSO identity — no account, no session", async () => {
  _resetOidcCaches();
  const idp = await mockIdp();
  try {
    await using srv = await testServer({
      cells: [
        cell("oidc_signup_off", {
          state: { n: 0 },
          visible: "all",
          methods: {},
        }),
      ],
      auth: { signup: false, oidc: { issuer: idp.issuer, clientId: "app1" } },
    });
    // The password door is closed…
    const r = await fetch(`${srv.url}/__aio/auth/signup`, {
      method: "POST",
      body: JSON.stringify({ id: "stranger", password: "password123" }),
    });
    assertEquals(r.status, 403);
    assertEquals((await r.json()).error, "signup_disabled");
    // …and so is the SSO one, with the same code.
    const got = await oidcLogin(srv.url, idp, {
      sub: "stranger",
      email: "stranger@example.com",
      email_verified: true,
    });
    assertEquals(got.status, 403, `got ${JSON.stringify(got)}`);
    assertStringIncludes(got.body, "signup_disabled");
    assertEquals(got.user, null, "no session for an unseeded identity");
    assertEquals(
      srv.app.auth!.get(mockIdpAccountId(idp, "stranger")),
      null,
      "no account row either",
    );
    assertEquals(srv.app.auth!.count(), 0);
  } finally {
    await idp.close();
  }
});

Deno.test("auth: signup:false admits an SSO identity the operator seeded, with the seeded role", async () => {
  _resetOidcCaches();
  const idp = await mockIdp();
  try {
    await using srv = await testServer({
      cells: [
        cell("oidc_signup_seed", {
          state: { n: 0 },
          visible: "all",
          methods: {},
        }),
      ],
      auth: { signup: false, oidc: { issuer: idp.issuer, clientId: "app1" } },
    });
    const id = mockIdpAccountId(idp, "alice-sub");
    // What `am auth create "oidc:…"` does: the external-identity door, with a
    // random password that can never verify.
    const createExternal = externalCreatorOf(srv.app.auth!);
    assert(createExternal, "the built-in store has an external door");
    await createExternal(id, crypto.randomUUID(), { role: "admin" });

    const got = await oidcLogin(srv.url, idp, { sub: "alice-sub" });
    assertEquals(got.status, 302, `got ${JSON.stringify(got)}`);
    assertEquals(got.user, { id, role: "admin" });
  } finally {
    await idp.close();
  }
});

Deno.test("auth: signup:false + oidc.signup:true keeps SSO account creation open, password signup closed", async () => {
  _resetOidcCaches();
  const idp = await mockIdp();
  try {
    await using srv = await testServer({
      cells: [
        cell("oidc_signup_optin", {
          state: { n: 0 },
          visible: "all",
          methods: {},
        }),
      ],
      auth: {
        signup: false,
        oidc: { issuer: idp.issuer, clientId: "app1", signup: true },
      },
    });
    const r = await fetch(`${srv.url}/__aio/auth/signup`, {
      method: "POST",
      body: JSON.stringify({ id: "stranger", password: "password123" }),
    });
    assertEquals(r.status, 403);
    await r.body?.cancel();
    const got = await oidcLogin(srv.url, idp, { sub: "sso-newcomer" });
    assertEquals(got.status, 302, `got ${JSON.stringify(got)}`);
    assertEquals(got.user, {
      id: mockIdpAccountId(idp, "sso-newcomer"),
      role: "user",
    });
  } finally {
    await idp.close();
  }
});

Deno.test("auth: oidc.signup:false closes the SSO door even with password signup open", async () => {
  _resetOidcCaches();
  const idp = await mockIdp();
  try {
    await using srv = await testServer({
      cells: [
        cell("oidc_signup_optout", {
          state: { n: 0 },
          visible: "all",
          methods: {},
        }),
      ],
      auth: { oidc: { issuer: idp.issuer, clientId: "app1", signup: false } },
    });
    const got = await oidcLogin(srv.url, idp, { sub: "stranger" });
    assertEquals(got.status, 403, `got ${JSON.stringify(got)}`);
    assertStringIncludes(got.body, "signup_disabled");
    assertEquals(srv.app.auth!.count(), 0);
  } finally {
    await idp.close();
  }
});

Deno.test("auth: with signup on (the default) a new SSO identity still gets an account on first login", async () => {
  _resetOidcCaches();
  const idp = await mockIdp();
  try {
    await using srv = await testServer({
      cells: [
        cell("oidc_signup_on", {
          state: { n: 0 },
          visible: "all",
          methods: {},
        }),
      ],
      auth: { oidc: { issuer: idp.issuer, clientId: "app1" } },
    });
    const got = await oidcLogin(srv.url, idp, { sub: "newcomer" });
    assertEquals(got.status, 302);
    assertEquals(got.user, {
      id: mockIdpAccountId(idp, "newcomer"),
      role: "user",
    });
  } finally {
    await idp.close();
  }
});
