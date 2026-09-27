// An OIDC `sub` is CASE-SENSITIVE (OIDC Core §2), so two subjects that differ
// only by case are two people — and two accounts.
//
// The account id is `oidc:<issuer>:<sub>` ("stable identity = (issuer, sub)"),
// but the store refused, at create time, any id that collided with an existing
// one case-INSENSITIVELY — a rule meant for local usernames (`Neighbour` must
// not join `neighbour`). Applied to external ids it locked the second subject
// out for good: its first login missed the exact lookup, `create` threw
// `user_exists`, and the callback answered 401 — on every attempt, forever.
// Okta ids are mixed-case base62; LDAP/Keycloak mappers mint username-shaped
// subs. Now the confusable refusal covers local ids only; the reservation of
// the `oidc:` namespace (every case of it) is unchanged.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetOidcCaches } from "../src/server/auth-oidc.ts";
import {
  mockIdp,
  mockIdpAccountId,
  oidcLogin,
} from "./oidc-mock-idp-helper.ts";

Deno.test("auth: two OIDC subjects differing only by case are two accounts, both able to sign in", async () => {
  _resetOidcCaches();
  const idp = await mockIdp();
  try {
    await using srv = await testServer({
      cells: [
        cell("oidc_sub_case", { state: { n: 0 }, visible: "all", methods: {} }),
      ],
      auth: { oidc: { issuer: idp.issuer, clientId: "app1" } },
    });
    const first = await oidcLogin(srv.url, idp, { sub: "00uAbCdEf" });
    assertEquals(first.status, 302);
    assertEquals(first.user, {
      id: mockIdpAccountId(idp, "00uAbCdEf"),
      role: "user",
    });
    const second = await oidcLogin(srv.url, idp, { sub: "00uabcdef" });
    assertEquals(
      { status: second.status, user: second.user },
      {
        status: 302,
        user: { id: mockIdpAccountId(idp, "00uabcdef"), role: "user" },
      },
      "a different IdP subject must get its own account",
    );
    // …and each login keeps landing on its OWN account.
    const again = await oidcLogin(srv.url, idp, { sub: "00uAbCdEf" });
    assertEquals(again.user?.id, mockIdpAccountId(idp, "00uAbCdEf"));
    assertEquals(srv.app.auth!.count(), 2);
  } finally {
    await idp.close();
  }
});

Deno.test("auth: local ids stay unique case-insensitively (the confusable refusal is unchanged)", async () => {
  _resetOidcCaches();
  await using srv = await testServer({
    cells: [
      cell("oidc_sub_case_local", {
        state: { n: 0 },
        visible: "all",
        methods: {},
      }),
    ],
    auth: true,
  });
  await srv.app.auth!.create("neighbour", "password-123");
  const thrown = await srv.app.auth!
    .create("Neighbour", "password-123")
    .then(() => null, (e: unknown) => String(e));
  assertEquals(thrown, "Error: user_exists");
});
