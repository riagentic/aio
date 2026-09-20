// THE ACCOUNT BUDGET IS FOR ATTEMPTS THAT COULD CREATE AN ACCOUNT.
//
// `chargeSignup` is a 10-per-HOUR cap, charged before the body was even
// parsed — so ten `POST /__aio/auth/signup` with `{}` (no id, no password,
// nothing to create and nothing to enumerate) answered `400
// id_and_password_required` and left signup `429 too_many_accounts` for the
// next hour. Measured, exactly that.
//
// Per IP that is only self-harm; behind the reverse proxy `docs/auth/auth.md`
// prescribes WITHOUT `trustProxyHeader`, every client shares one bucket, so
// ten junk requests take the app's signup offline for an hour for everyone.
// That is the outage the login route already refuses to have ("the budget
// throttles failed authentication, never service"), with a window twelve times
// longer.
//
// A request that cannot create an account is not charged for one. What the
// budget still caps is unchanged: real creations, and the id-collision probe
// that is the enumeration channel — both reach `users.create`.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";

const signup = (url: string, body: unknown) =>
  fetch(`${url}/__aio/auth/signup`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

Deno.test("auth: a signup that cannot create an account does not spend the account budget", async () => {
  await using srv = await testServer({
    cells: [
      cell("r5c_budget1", { state: { n: 0 }, visible: "all", methods: {} }),
    ],
    auth: true,
  });

  // Every shape that is refused before a row could exist, twice over the cap.
  const junk: unknown[] = [
    {},
    "{",
    "null",
    { id: "x" },
    { password: "just-a-password" },
    { id: 7, password: 8 },
    { id: "", password: "abcdefgh12" },
    { id: "   ", password: "abcdefgh12" },
    { id: "ok", password: "abcdefgh12", email: "not-an-email" },
    { id: null, password: null },
    {},
    {},
  ];
  for (const body of junk) {
    const r = await signup(srv.url, body);
    const status = r.status;
    await r.body?.cancel();
    assertEquals(
      status >= 400 && status < 429,
      true,
      `a malformed signup must be a 4xx refusal, not a budget verdict (${status} for ${
        JSON.stringify(body)
      })`,
    );
  }

  // …and a real signer-up is still served.
  const real = await signup(srv.url, { id: "alice", password: "alice-pw-123" });
  assertEquals(real.status, 201, await real.clone().text());
  await real.body?.cancel();
  assertEquals(srv.app.auth!.get("alice")?.id, "alice");

  // The cap itself still holds for attempts that DO reach account creation —
  // ten more (collisions count, which is what bounds id enumeration).
  let refused = 0;
  for (let i = 0; i < 12; i++) {
    const r = await signup(srv.url, { id: "alice", password: "alice-pw-123" });
    if (r.status === 429) refused++;
    await r.body?.cancel();
  }
  assertEquals(
    refused > 0,
    true,
    "the account budget must still cap real creation attempts",
  );
});

// …AND "COULD CREATE AN ACCOUNT" IS THE STORE'S QUESTION, NOT THE ROUTE'S.
//
// The charges moved past the ROUTE's shape check, and stopped there. Three
// more refusals live in `users.create` itself — `invalid_id`, `reserved_id`,
// `password_too_short` — and every one of them is decided before a hash is
// computed or a row is touched, one line PAST both charges. So the same
// outage came back with one more field in the body:
//
//   `{"id":"a","password":"1"}` — 25 bytes, no hashing, no row, nothing to
//   enumerate — answered `400 password_too_short`, and ten of them left
//   signup `429 too_many_accounts` for the next HOUR for everyone sharing
//   the bucket.
//
// And because `chargeAuthWork` (30/min) is shared with LOGIN and is charged
// even when `chargeSignup` is the thing that refuses, thirty-one junk
// signups answered `429 too_many_attempts` to a correct password —
// `docs/auth/auth.md`: "The budget throttles failed authentication, never
// service. A request that presents a valid credential is served regardless
// of the budget."
//
// So the route asks the store's own policy (`signupPolicyRefusal` — the rule
// `createRow` throws, one decider, two readers) BEFORE it spends anything,
// and a request refused by the ACCOUNT cap hands its work unit back.
Deno.test("auth: a signup the STORE would refuse spends neither budget", async () => {
  _resetAuthFails();
  await using srv = await testServer({
    cells: [
      cell("r6a_budget2", { state: { n: 0 }, visible: "all", methods: {} }),
    ],
    auth: true,
  });

  // Well-formed to the route, refused by the store's policy — twice the
  // account cap of them, so a single charged one would be visible below.
  const junk: [unknown, string][] = [
    [{ id: "a", password: "1" }, "password_too_short"],
    [{ id: "bb", password: "short" }, "password_too_short"],
    [{ id: "   ", password: "abcdefgh12" }, "invalid_id"],
    [{ id: "a‍b", password: "abcdefgh12" }, "invalid_id"],
    [{ id: "x".repeat(257), password: "abcdefgh12" }, "invalid_id"],
    [{ id: "oidc:idp:victim", password: "abcdefgh12" }, "reserved_id"],
    [{ id: "OIDC:idp:victim", password: "abcdefgh12" }, "reserved_id"],
  ];
  for (let round = 0; round < 3; round++) {
    for (const [body, want] of junk) {
      const r = await signup(srv.url, body);
      const got = await r.json();
      assertEquals(
        r.status,
        400,
        `a policy refusal is a 400, not a budget verdict: ${
          JSON.stringify(got)
        }`,
      );
      assertEquals(got.error, want, `for ${JSON.stringify(body)}`);
    }
  }

  // 21 of them. If any had been charged, both of these would be 429.
  const real = await signup(srv.url, { id: "bob", password: "bob-pw-12345" });
  assertEquals(
    real.status,
    201,
    `the account budget must be untouched: ${await real.clone().text()}`,
  );
  await real.body?.cancel();
  const li = await fetch(`${srv.url}/__aio/auth/login`, {
    method: "POST",
    body: JSON.stringify({ id: "bob", password: "bob-pw-12345" }),
  });
  assertEquals(
    li.status,
    200,
    `…and so must the WORK budget login shares: ${await li.clone().text()}`,
  );
  await li.body?.cancel();
});

Deno.test("auth: the account cap refusing does not spend the login budget", async () => {
  _resetAuthFails();
  await using srv = await testServer({
    cells: [
      cell("r6a_budget3", { state: { n: 0 }, visible: "all", methods: {} }),
    ],
    auth: true,
  });
  const real = await signup(srv.url, { id: "carol", password: "carol-pw-123" });
  assertEquals(real.status, 201);
  await real.body?.cancel();

  // Exhaust the ACCOUNT cap (10/hour) with collisions, then keep going well
  // past the WORK cap (30/min) that login shares. Every request past the
  // account cap is refused by `chargeSignup` and does no work at all.
  let tooManyAccounts = 0;
  let tooManyAttempts = 0;
  for (let i = 0; i < 45; i++) {
    const r = await signup(srv.url, { id: "carol", password: "carol-pw-123" });
    const err = r.status === 429 ? (await r.clone().json()).error : "";
    if (err === "too_many_accounts") tooManyAccounts++;
    if (err === "too_many_attempts") tooManyAttempts++;
    await r.body?.cancel();
  }
  assertEquals(
    tooManyAttempts,
    0,
    `a signup the ACCOUNT cap refused did no work at all — it must not ` +
      `exhaust the per-minute meter LOGIN shares`,
  );
  assertEquals(
    tooManyAccounts > 30,
    true,
    `the account cap must still hold (saw ${tooManyAccounts} refusals)`,
  );

  const li = await fetch(`${srv.url}/__aio/auth/login`, {
    method: "POST",
    body: JSON.stringify({ id: "carol", password: "carol-pw-123" }),
  });
  assertEquals(
    li.status,
    200,
    `a valid credential is served regardless of the budget — an account-cap ` +
      `refusal must not double-spend the login meter: ${await li.clone()
        .text()}`,
  );
  await li.body?.cancel();
});
