// Three auth-route verdicts that disagreed with the store or with siblings:
//
// - A password reset (or change) racing an account REMOVAL answered 200: the
//   account was deleted while the new hash was computed, `setPassword`
//   returned false, and the route ignored it — `/reset` said ok and logged
//   "reset completed", `/password` minted a fresh session for an account that
//   no longer exists.
// - `totp/disable` answered `401 invalid_credentials` once the per-address
//   fail budget was spent, where every sibling answers `429`.
import { assert, assertEquals } from "@std/assert";
import { type AuthFlows, handleAuthFlow } from "../src/server/auth-flows.ts";
import { openSessionStore } from "../src/server/sessions.ts";
import { openUserStore, type UserStore } from "../src/server/auth-users.ts";
import { _resetAuthFails, recordAuthFail } from "../src/server/server-auth.ts";

const KEY = "10.0.0.9";
const PW = "correct horse battery";

function flows() {
  const sessions = openSessionStore(":memory:");
  const users = openUserStore(":memory:", { sessions: () => sessions });
  // The race, made deterministic: the account is removed while the new
  // password is being hashed.
  const racing: UserStore = {
    ...users,
    setPassword: async (id, pw) => {
      const p = users.setPassword(id, pw);
      users.remove(id);
      return await p;
    },
  };
  const cfg = {
    users: racing,
    sessions,
    signup: true,
    cookie: false,
    secure: false,
    appTitle: "t",
    sendMail: () => {},
  } as AuthFlows;
  const post = async (path: string, body: unknown, bearer?: string) => {
    const req = new Request(`http://127.0.0.1:1/__aio/auth/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const r = (await handleAuthFlow(req, new URL(req.url), cfg, KEY))!;
    return { status: r.status, j: await r.json() };
  };
  return {
    users,
    sessions,
    post,
    close: () => (users.close(), sessions.close()),
  };
}

Deno.test("auth: a reset racing an account removal is refused, not 200", async () => {
  _resetAuthFails();
  const { users, post, close } = flows();
  try {
    await users.create("rita", PW);
    const token = users.issueToken("reset", "rita", 60_000);
    const r = await post("reset", { token, password: "a new password" });
    assertEquals(r.status, 401, JSON.stringify(r.j));
    assertEquals(r.j.error, "invalid_or_expired_token");
    assertEquals(users.get("rita"), null);
  } finally {
    close();
    _resetAuthFails();
  }
});

Deno.test("auth: a password change racing an account removal mints no session", async () => {
  _resetAuthFails();
  const { users, sessions, post, close } = flows();
  try {
    await users.create("paul", PW);
    const tok = sessions.issue({ id: "paul", role: "user" });
    const r = await post("password", { old: PW, new: "a new password" }, tok);
    assertEquals(r.status, 401, JSON.stringify(r.j));
    assert(!r.j.token, "no session for a removed account");
    assertEquals(sessions.count(), 0, "no session survives the removal");
  } finally {
    close();
    _resetAuthFails();
  }
});

Deno.test("auth: totp/disable answers 429 once the fail budget is spent", async () => {
  _resetAuthFails();
  const { users, sessions, post, close } = flows();
  try {
    await users.create("tom", PW);
    const tok = sessions.issue({ id: "tom", role: "user" });
    for (let i = 0; i < 10; i++) recordAuthFail(KEY, "prior failures");
    const r = await post("totp/disable", { password: "wrong password" }, tok);
    assertEquals(r.status, 429, JSON.stringify(r.j));
    assertEquals(r.j.error, "too_many_attempts");
  } finally {
    close();
    _resetAuthFails();
  }
});

// With `requireVerified`, an account whose verification token expired was
// stuck: login is refused `403 email_unverified`, and `verify/request` needs a
// session. `verify/resend { id }` is the self-service door — shaped like
// reset/request: always 200, budgeted, nothing revealed.
Deno.test("auth: verify/resend lets an unverified account re-mail its token", async () => {
  _resetAuthFails();
  const sessions = openSessionStore(":memory:");
  const users = openUserStore(":memory:", { sessions: () => sessions });
  const mails: Array<{ to: string; text: string }> = [];
  const cfg = {
    users,
    sessions,
    signup: true,
    cookie: false,
    secure: false,
    appTitle: "t",
    requireVerified: true,
    sendMail: (m: { to: string; text: string }) => void mails.push(m),
  } as AuthFlows;
  const post = async (path: string, body: unknown) => {
    const req = new Request(`http://127.0.0.1:1/__aio/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const r = (await handleAuthFlow(req, new URL(req.url), cfg, KEY))!;
    return { status: r.status, j: await r.json() };
  };
  const settle = () => new Promise((r) => setTimeout(r, 10));
  try {
    await users.create("vic", PW, { email: "vic@example.com" });
    assertEquals(
      (await post("login", { id: "vic", password: PW })).status,
      403,
    );

    // A miss and a verified account answer the same 200 and mail nothing.
    assertEquals((await post("verify/resend", { id: "nobody" })).status, 200);
    await users.create("val", PW, { email: "val@example.com" });
    users.markVerified("val");
    assertEquals((await post("verify/resend", { id: "val" })).status, 200);
    await settle();
    assertEquals(mails.length, 0);

    assertEquals((await post("verify/resend", { id: "vic" })).status, 200);
    await settle();
    assertEquals(mails.length, 1);
    assertEquals(mails[0]!.to, "vic@example.com");
    const token = mails[0]!.text.match(/aiot_[0-9a-f]+/)![0];
    assertEquals((await post("verify", { token })).status, 200);
    assertEquals(
      (await post("login", { id: "vic", password: PW })).status,
      200,
    );

    // Budgeted: a burst mails at most the cap, and still answers 200.
    await users.create("bo", PW, { email: "bo@example.com" });
    mails.length = 0;
    for (let i = 0; i < 20; i++) {
      assertEquals((await post("verify/resend", { id: "bo" })).status, 200);
    }
    await settle();
    assert(mails.length >= 1 && mails.length <= 10, `mailed ${mails.length}`);
  } finally {
    users.close();
    sessions.close();
    _resetAuthFails();
  }
});
