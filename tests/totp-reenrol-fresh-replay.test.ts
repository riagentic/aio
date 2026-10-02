// The persisted one-code-one-use record (`totp_step`) is per ACCOUNT, but it
// is only meaningful for the secret that consumed it. Disabling 2FA and
// enrolling a NEW authenticator within the same 30-second step refused the new
// secret's first, valid code as a "replay" of the old secret's — once, with
// `invalid_code`, to a user who typed exactly what their app showed.
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
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
    // …and the SAME secret in another SPELLING is the same secret. base32 is
    // decoded case-insensitively and tolerates `=` padding, so a lower-cased
    // (or padded) re-stage maps to the identical HMAC key — but the guard is
    // textual (`totp IS ?1`, and `_lastStep` is keyed by the raw string), so
    // it used to be judged a NEW secret: `totp_step` was zeroed and the spent
    // code was accepted again.
    users.setTotpSecret("alice", b.body.secret.toLowerCase() + "=");
    assertEquals(
      totpReplayOf(users)!.accept("alice", step),
      false,
      "a differently-spelled re-stage of the same secret reopened a spent code",
    );
  } finally {
    sessions.close();
    users.close();
    _resetTotpReplay();
    _resetAuthFails();
  }
});

// A row written BEFORE secrets were normalised at the write holds whatever
// spelling the app passed. Re-staging that same secret now stores the
// normalised text — and the guard compared it with the stored raw one as
// strings, so the first re-stage after an upgrade was "a new secret": the
// replay record was zeroed and a code already spent in this step was good
// again, once.
Deno.test("totp: re-staging a secret stored in a pre-normalisation spelling keeps its replay record", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await tempDir("aio-totp-legacy-");
  const path = `${dir}/auth.db`;
  const SECRET = "JBSWY3DPEHPK3PXP";
  const legacy = SECRET.toLowerCase() + "=="; // what an old build stored
  try {
    {
      const users = openUserStore(path);
      await users.create("alice", "correct horse battery");
      users.setTotpSecret("alice", SECRET);
      users.enableTotp("alice");
      assertEquals(totpReplayOf(users)!.accept("alice", 77), true);
      users.close();
    }
    {
      const db = new DatabaseSync(path);
      db.prepare("UPDATE users SET totp = ? WHERE id = 'alice'").run(legacy);
      db.close();
    }
    const users = openUserStore(path);
    try {
      assertEquals(users.totpSecret("alice")?.secret, legacy, "precondition");
      users.setTotpSecret("alice", legacy);
      assertEquals(
        totpReplayOf(users)!.accept("alice", 77),
        false,
        "the same secret, re-staged from its old spelling, reopened step 77",
      );
      // A DIFFERENT secret still starts a fresh record.
      users.setTotpSecret("alice", "KRSXG5CTMVRXEZLU");
      assertEquals(totpReplayOf(users)!.accept("alice", 77), true);
    } finally {
      users.close();
    }
  } finally {
    await dropTempDir(dir);
  }
});
