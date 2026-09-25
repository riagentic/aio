// "Successful requests never consume budget" (docs/auth/auth.md) — for EVERY
// route that charges the per-address work meter, not just `login`.
//
// `login` refunds its unit when the password is right. The second-factor step,
// the password change and TOTP enable/disable charge the same meter and never
// gave a unit back, so each SUCCESSFUL one spent the budget a correct login
// shares: behind the reverse proxy the docs prescribe (one bucket for every
// client), thirty 2FA sign-ins in a minute answered the thirty-first correct
// password with `429 too_many_attempts`.
import { assert, assertEquals } from "@std/assert";
import { type AuthFlows, handleAuthFlow } from "../src/server/auth-flows.ts";
import { openSessionStore } from "../src/server/sessions.ts";
import { openUserStore } from "../src/server/auth-users.ts";
import { _resetAuthFails, chargeAuthWork } from "../src/server/server-auth.ts";
import {
  _resetTotpReplay,
  generateTotpSecret,
  totpCode,
} from "../src/server/auth-totp.ts";
import { awaitStableTotpWindow } from "./totp-window-helper.ts";

const KEY = "10.0.0.7";
const PW = "correct horse battery";

function flows() {
  const sessions = openSessionStore(":memory:");
  const users = openUserStore(":memory:", { sessions: () => sessions });
  const cfg = {
    users,
    sessions,
    signup: true,
    cookie: false,
    secure: false,
    appTitle: "t",
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
  return { cfg, post, close: () => (users.close(), sessions.close()) };
}

/** Spend the meter down to its LAST unit — the successful request under test
 *  takes it, and must hand it back. */
const spendToLast = () => {
  for (let i = 0; i < 29; i++) assert(chargeAuthWork(KEY));
};

/** True when the meter still has a unit: what a correct login next needs. */
const unitLeft = () => chargeAuthWork(KEY);

Deno.test("auth work meter: a successful second-factor step refunds its unit", async () => {
  _resetAuthFails();
  _resetTotpReplay();
  const { cfg, post, close } = flows();
  try {
    await cfg.users.create("tina", PW);
    const secret = generateTotpSecret();
    cfg.users.setTotpSecret("tina", secret);
    cfg.users.enableTotp("tina");
    spendToLast();
    const l = await post("login", { id: "tina", password: PW });
    assert(l.j.pending, "login asks for the second factor");
    await awaitStableTotpWindow();
    const t = await post("totp", {
      pending: l.j.pending,
      code: await totpCode(secret),
    });
    assertEquals(t.status, 200, JSON.stringify(t.j));
    assert(unitLeft(), "a completed 2FA sign-in must not spend the budget");
  } finally {
    close();
    _resetAuthFails();
  }
});

Deno.test("auth work meter: a successful password change refunds its unit", async () => {
  _resetAuthFails();
  const { cfg, post, close } = flows();
  try {
    await cfg.users.create("pat", PW);
    const tok = cfg.sessions.issue({ id: "pat", role: "user" });
    spendToLast();
    const r = await post("password", { old: PW, new: "another horse 9" }, tok);
    assertEquals(r.status, 200, JSON.stringify(r.j));
    assert(unitLeft(), "a correct password change must not spend the budget");
  } finally {
    close();
    _resetAuthFails();
  }
});

Deno.test("auth work meter: successful TOTP enable and disable refund their units", async () => {
  _resetAuthFails();
  _resetTotpReplay();
  const { cfg, post, close } = flows();
  try {
    await cfg.users.create("eve", PW);
    const tok = cfg.sessions.issue({ id: "eve", role: "user" });
    const { secret } = (await post("totp/setup", {}, tok)).j;
    spendToLast();
    await awaitStableTotpWindow();
    const en = await post("totp/enable", {
      code: await totpCode(secret),
      password: PW,
    }, tok);
    assertEquals(en.status, 200, JSON.stringify(en.j));
    assert(unitLeft(), "a correct TOTP enable must not spend the budget");

    _resetAuthFails();
    spendToLast();
    const dis = await post("totp/disable", { password: PW }, tok);
    assertEquals(dis.status, 200, JSON.stringify(dis.j));
    assert(unitLeft(), "a correct TOTP disable must not spend the budget");
  } finally {
    close();
    _resetAuthFails();
  }
});
