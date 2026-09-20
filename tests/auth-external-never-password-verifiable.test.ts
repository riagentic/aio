// AN EXTERNAL IDENTITY IS NEVER PASSWORD-VERIFIABLE — BY CONSTRUCTION, NOT
// BY CONVENTION.
//
// That sentence is written in three places (`EXTERNAL_ID_PREFIX`,
// `isExternalId`, the OIDC callback) and was true only because ONE caller
// happened to mint a random 24-byte password nobody could know. Nothing
// enforced it at the password door, and the door is where it matters:
//
//  · THE UPGRADE CASE. The reservation that refuses `oidc:<issuer>:<sub>` at
//    signup is new. An app that ran the version before it can hold a row an
//    anonymous caller created, with a password of their choosing, under the
//    victim's SSO id — the pre-hijack that fix was written for. Refusing new
//    ones does nothing for the ones already there: `POST /auth/login` with
//    that id and that password still answered 200 and a session for the SSO
//    identity. `reset` already refuses "a token that predates that rule";
//    login had no such line.
//  · AND THE INVARIANT ITSELF. One caller mistake — an `externalCreatorOf`
//    handed a known password — turns an IdP-owned identity into a password
//    account, silently. Better a property that cannot be violated than a
//    convention that has to be remembered.
//
// The refusal costs one real PBKDF2 like every other, so it is the same
// generic `null` a wrong password gets, with the same timing. There is no
// oracle to protect: the namespace is a PREFIX of the id the caller supplied.
import { assert, assertEquals } from "@std/assert";
import { externalCreatorOf, openUserStore } from "../src/server/auth-users.ts";

Deno.test("auth: a password never opens an external identity, whatever its hash", async () => {
  const store = openUserStore(":memory:");
  const external = externalCreatorOf(store);
  assert(external !== null, "openUserStore must expose the external door");

  // Exactly the shape a pre-reservation signup left behind: a row in the
  // IdP-owned namespace whose password someone else chose.
  const id = "oidc:idp.example:victim-sub";
  const rec = await external(id, "attacker-pw-123", {});
  assertEquals(rec.id, id);

  assertEquals(
    await store.verify(id, "attacker-pw-123"),
    null,
    "the RIGHT password must not open an IdP-owned account — this is the " +
      "row a signup could claim before the namespace was reserved",
  );
  assertEquals(await store.verify(id, "wrong-pw-9999"), null);

  // The account is still there, still resolvable, still the IdP's — only the
  // password door is shut.
  assertEquals(store.get(id)?.id, id);

  // …and an ordinary local account is untouched.
  await store.create("alice", "alice-pw-123");
  assertEquals(await store.verify("alice", "alice-pw-123"), {
    id: "alice",
    role: "user",
  });
  assertEquals(await store.verify("alice", "nope-nope-nope"), null);
  store.close();
});
