// Wrong TOTP codes lock the account, exactly like wrong passwords.
//
// The per-account lockout (5 failures → 15 minutes) is the one defence a
// botnet's rotating addresses do not sidestep, and only the PASSWORD fed it.
// Wrong second-factor codes were charged to the per-IP budget alone, so behind
// the documented reverse proxy (`trustProxyHeader`) an attacker who already had
// the password guessed codes forever: measured, 40 wrong codes from 40
// addresses, then the right one → a session. The factor that exists for the
// leaked-password case was the one outside the lockout.
//
// Two holes, both pinned: the code counter itself, and the correct PASSWORD
// resetting that counter on every guess cycle (login → pending → wrong code).
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { _resetTotpReplay, totpCode } from "../src/server/auth-totp.ts";
import { awaitStableTotpWindow } from "./totp-window-helper.ts";

Deno.test("totp: wrong codes from rotating addresses lock the account and burn pending tokens", async () => {
  _resetAuthFails();
  _resetTotpReplay();
  const c = cell("totp_lock", { state: { n: 0 }, methods: {} });
  await using srv = await testServer({
    cells: [c],
    auth: true,
    trustProxyHeader: "x-forwarded-for",
  });
  let ip = 0;
  // A fresh address for every request: the per-IP budget never sees two.
  const post = async (path: string, body: unknown, bearer?: string) => {
    const r = await srv.fetch(`/__aio/auth/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `10.9.${ip >> 8}.${(ip++ & 255) + 1}`,
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
    });
    return { status: r.status, j: await r.json().catch(() => null) };
  };
  try {
    const pw = "correct horse battery";
    const su = await post("signup", { id: "tina", password: pw });
    assertEquals(su.status, 201);
    const { secret } = (await post("totp/setup", {}, su.j.token)).j;
    await awaitStableTotpWindow(5_000);
    const en = await post("totp/enable", {
      code: await totpCode(secret),
      password: pw,
    }, su.j.token);
    assertEquals(en.status, 200);

    // A pending token minted BEFORE the lock, held back for later.
    const held = (await post("login", { id: "tina", password: pw })).j.pending;
    assert(held, "login must ask for the second factor");

    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const l = await post("login", { id: "tina", password: pw });
      if (!l.j?.pending) {
        statuses.push(l.status);
        continue;
      }
      // Never a real code: 000000 + i is off by the whole window.
      const t = await post("totp", {
        pending: l.j.pending,
        code: String(i).padStart(6, "0"),
      });
      statuses.push(t.status);
    }
    assert(
      statuses.includes(423),
      `12 wrong codes must lock the account — got ${statuses.join(",")}`,
    );

    // Locked: the RIGHT password is refused, and so is the right code on a
    // pending token that predates the lock.
    const after = await post("login", { id: "tina", password: pw });
    assertEquals(after.status, 423);
    await awaitStableTotpWindow(5_000);
    const right = await post("totp", {
      pending: held,
      code: await totpCode(secret),
    });
    assert(
      right.status === 401 || right.status === 423,
      `a pre-lock pending token must not complete a login (got ${right.status})`,
    );
    assertEquals(right.j?.token, undefined);

    // Operator rescue clears it, and a correct code completes the login.
    assert(srv.app.auth!.unlock("tina"));
    const l2 = await post("login", { id: "tina", password: pw });
    await awaitStableTotpWindow(5_000);
    _resetTotpReplay();
    const ok = await post("totp", {
      pending: l2.j.pending,
      code: await totpCode(secret),
    });
    assertEquals(ok.status, 200);
    assert(ok.j.token);
  } finally {
    _resetAuthFails();
    _resetTotpReplay();
  }
});

Deno.test("totp: a completed second factor clears the counter; the password alone does not", async () => {
  const { openUserStore, accountLockoutOf } = await import(
    "../src/server/auth-users.ts"
  );
  const s = openUserStore(":memory:");
  try {
    await s.create("ann", "password123");
    s.setTotpSecret("ann", "JBSWY3DPEHPK3PXP");
    s.enableTotp("ann");
    const lock = accountLockoutOf(s)!;
    for (let i = 0; i < 4; i++) {
      assertEquals(lock.fail("ann"), false);
      // The guess cycle: a right password between wrong codes must not reset.
      assert((await s.verify("ann", "password123")) !== null);
    }
    assertEquals(lock.fail("ann"), true, "the fifth wrong code locks");
    assertEquals(lock.locked("ann"), true);
    assertEquals(await s.verify("ann", "password123"), "locked");
    assert(s.unlock("ann"));
    lock.fail("ann");
    lock.clear("ann");
    for (let i = 0; i < 4; i++) lock.fail("ann");
    assertEquals(lock.locked("ann"), false, "clear() started the count over");
  } finally {
    s.close();
  }
});
