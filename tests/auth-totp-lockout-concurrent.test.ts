// The TOTP lockout holds against guesses fired AT ONCE, not only one by one.
//
// The route read the lock, awaited the code check, and only then counted the
// failure — so every request that passed the lock check before the first
// failure landed had its code checked. Measured: one leaked password, 60
// logins → 60 pending tokens, 60 wrong codes fired together → 60 ×
// `401 invalid_code` (60 codes tried; the lockout allows 5). Sequentially the
// same account got 5 tries and a lock.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { _resetTotpReplay, totpCode } from "../src/server/auth-totp.ts";
import { awaitStableTotpWindow } from "./totp-window-helper.ts";

async function enrolled() {
  _resetAuthFails();
  _resetTotpReplay();
  const srv = await testServer({
    cells: [cell("totp_conc", { state: { n: 0 }, methods: {} })],
    auth: true,
    trustProxyHeader: "x-forwarded-for",
  });
  let ip = 0;
  // A fresh address per request: the per-IP budget never sees two, so the
  // account lockout is the only thing under test.
  const post = async (path: string, body: unknown, bearer?: string) => {
    const r = await srv.fetch(`/__aio/auth/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `10.7.${ip >> 8}.${(ip++ & 255) + 1}`,
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
    });
    return { status: r.status, j: await r.json().catch(() => null) };
  };
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
  _resetTotpReplay();
  const pendings = async (n: number) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const l = await post("login", { id: "tina", password: pw });
      assert(l.j?.pending, `login ${i} must ask for the code (${l.status})`);
      out.push(l.j.pending);
    }
    return out;
  };
  return { srv, post, secret, pendings };
}

Deno.test("totp: a concurrent burst of wrong codes gets the lockout's five tries, not one per token", async () => {
  const { srv, post, pendings } = await enrolled();
  try {
    const tokens = await pendings(20);
    // Never a real code: a fixed off-window value per token.
    const results = await Promise.all(
      tokens.map((p, i) =>
        post("totp", { pending: p, code: String(i).padStart(6, "0") })
      ),
    );
    const tally: Record<string, number> = {};
    for (const r of results) {
      const k = `${r.status}:${r.j?.error}`;
      tally[k] = (tally[k] ?? 0) + 1;
    }
    assertEquals(
      tally["401:invalid_code"],
      5,
      `exactly the lockout's five codes may be checked — got ${
        JSON.stringify(tally)
      }`,
    );
    assertEquals(tally["423:account_locked"], 15, JSON.stringify(tally));
    assert(results.every((r) => !r.j?.token), "no burst guess signs in");
    const after = await post("login", {
      id: "tina",
      password: "correct horse battery",
    });
    assertEquals(after.status, 423, "the burst locked the account");
  } finally {
    await srv[Symbol.asyncDispose]();
    _resetAuthFails();
    _resetTotpReplay();
  }
});

Deno.test("totp: the owner's right code in the same burst as four wrong ones still signs in", async () => {
  const { srv, post, secret, pendings } = await enrolled();
  try {
    const tokens = await pendings(5);
    await awaitStableTotpWindow(5_000);
    const right = await totpCode(secret);
    const results = await Promise.all(
      tokens.map((p, i) =>
        post("totp", {
          pending: p,
          code: i === 4 ? right : String(i).padStart(6, "0"),
        })
      ),
    );
    assertEquals(results.slice(0, 4).map((r) => r.status), [
      401,
      401,
      401,
      401,
    ]);
    const owner = results[4]!;
    assertEquals(owner.status, 200, JSON.stringify(owner.j));
    assert(owner.j.token);
    // …and a completed login started the count over: not locked.
    const again = await post("login", {
      id: "tina",
      password: "correct horse battery",
    });
    assertEquals(again.status, 200);
  } finally {
    await srv[Symbol.asyncDispose]();
    _resetAuthFails();
    _resetTotpReplay();
  }
});
