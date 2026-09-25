// The persisted one-code-one-use record (`totp_step`) is per ACCOUNT, but it
// is only meaningful for the secret that consumed it. Disabling 2FA and
// enrolling a NEW authenticator within the same 30-second step refused the new
// secret's first, valid code as a "replay" of the old secret's — once, with
// `invalid_code`, to a user who typed exactly what their app showed.
import { assert, assertEquals } from "@std/assert";
import { type AuthFlows, handleAuthFlow } from "../src/server/auth-flows.ts";
import { openSessionStore } from "../src/server/sessions.ts";
import { openUserStore, totpReplayOf } from "../src/server/auth-users.ts";
import { _resetTotpReplay, totpCode } from "../src/server/auth-totp.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";

const ORIGIN = "http://127.0.0.1:1";

Deno.test("totp: re-enrolling a new secret inside the last code's step is not refused as a replay", async () => {
  _resetTotpReplay();
  _resetAuthFails();
  const sessions = openSessionStore(":memory:");
  const users = openUserStore(":memory:");
  const cfg = {
    users,
    sessions,
    signup: true,
    cookie: false,
    secure: false,
    appTitle: "t",
  } as AuthFlows;
  let bearer = "";
  const post = async (route: string, body: Record<string, unknown>) => {
    const req = new Request(`${ORIGIN}/__aio/auth/${route}`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const r = await handleAuthFlow(req, new URL(req.url), cfg, "k");
    return { status: r!.status, body: await r!.json() };
  };
  try {
    const su = await post("signup", { id: "alice", password: "password123" });
    assert(su.body.token, JSON.stringify(su.body));
    bearer = su.body.token;
    // One step ahead of now: inside the ±1 window for the next 30–60 s, so
    // both codes below land on the SAME step however the clock ticks.
    const step = Math.floor(Date.now() / 30_000) + 1;

    const a = await post("totp/setup", {});
    const enA = await post("totp/enable", {
      password: "password123",
      code: await totpCode(a.body.secret, step),
    });
    assertEquals(enA.status, 200, JSON.stringify(enA.body));

    const dis = await post("totp/disable", { password: "password123" });
    assertEquals(dis.status, 200, JSON.stringify(dis.body));

    const b = await post("totp/setup", {});
    assert(b.body.secret !== a.body.secret, "a fresh secret");
    const enB = await post("totp/enable", {
      password: "password123",
      code: await totpCode(b.body.secret, step),
    });
    assertEquals(
      enB.status,
      200,
      `new secret's code refused: ${JSON.stringify(enB.body)}`,
    );

    // The replay guard itself still holds: the new secret's step is spent.
    assert(users.totpSecret("alice")?.enabled, "the new factor is on");
    assertEquals(totpReplayOf(users)!.accept("alice", step), false);
    // Re-staging the SAME secret keeps its record (no replay reopened).
    users.setTotpSecret("alice", b.body.secret);
    assertEquals(totpReplayOf(users)!.accept("alice", step), false);
  } finally {
    sessions.close();
    users.close();
    _resetTotpReplay();
    _resetAuthFails();
  }
});
