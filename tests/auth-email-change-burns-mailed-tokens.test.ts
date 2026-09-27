// r7 lead (f): verify/reset tokens are bound to the ACCOUNT id, not to the
// address they were mailed to — and `setEmail` neither burns them nor clears
// `verified`.
//
// A verify token is proof of control of ONE mailbox. `/verify` consumes it and
// calls `markVerified(stored.subject)` — whatever address the account holds
// NOW. So: alice signs up as old@…, is mailed a verify token, her address is
// changed to new@… (`app.auth.setEmail`, the public UserStore API), and the
// OLD token — which only proves control of old@… — marks new@… verified and
// passes `requireVerified`. The reset twin is worse: a reset token mailed to
// the previous address still sets the password after the address changed, so
// whoever holds the old mailbox takes over the account.
import { assertEquals } from "@std/assert";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function rig() {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const c = cell(`r7mail${crypto.randomUUID().slice(0, 6)}`, {
    state: { n: 0 },
    methods: {},
  });
  const outbox: { to: string; text: string }[] = [];
  const port = freePort();
  const dir = await tempDir("r7-auth-mail");
  const app = await aio.run({
    cells: [c],
    appId: `test-r7-mail-${crypto.randomUUID().slice(0, 8)}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: {
      requireVerified: true,
      sendMail: (m) => {
        outbox.push(m);
      },
    },
    port,
    baseDir: dir,
  });
  const post = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}/__aio/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const tokenFrom = (text: string): string => /aiot_[0-9a-f]+/.exec(text)![0];
  return {
    app,
    outbox,
    post,
    tokenFrom,
    close: async () => {
      await app.close();
      await dropTempDir(dir);
    },
  };
}

Deno.test("auth: a verify token mailed to the OLD address does not verify the NEW one", async () => {
  const r = await rig();
  try {
    const su = await r.post("signup", {
      id: "alice",
      password: "password123",
      email: "old@example.com",
    });
    assertEquals(su.status, 201);
    await su.body?.cancel();
    assertEquals(r.outbox.length, 1);
    assertEquals(r.outbox[0]!.to, "old@example.com");
    const oldToken = r.tokenFrom(r.outbox[0]!.text);

    // The address changes (operator / app code, public UserStore API).
    assertEquals(r.app.auth!.setEmail("alice", "new@example.com"), true);

    // The token only proves control of old@… — it must not vouch for new@….
    const vr = await r.post("verify", { token: oldToken });
    await vr.body?.cancel();
    assertEquals(
      r.app.auth!.get("alice")?.verified,
      false,
      `a token mailed to old@example.com marked new@example.com verified ` +
        `(/verify answered ${vr.status})`,
    );
  } finally {
    await r.close();
  }
});

Deno.test("auth: a reset token mailed to the OLD address cannot take the account after the email changed", async () => {
  const r = await rig();
  try {
    const su = await r.post("signup", {
      id: "bob",
      password: "password123",
      email: "old@example.com",
    });
    assertEquals(su.status, 201);
    await su.body?.cancel();
    const rr = await r.post("reset/request", { id: "bob" });
    await rr.body?.cancel();
    const mail = r.outbox.find((m) => m.text.includes("reset"));
    assertEquals(mail?.to, "old@example.com", "precondition: reset mailed");
    const oldReset = r.tokenFrom(mail!.text);

    assertEquals(r.app.auth!.setEmail("bob", "new@example.com"), true);

    const res = await r.post("reset", {
      token: oldReset,
      password: "attacker-pass-9",
    });
    await res.body?.cancel();
    assertEquals(
      res.status,
      401,
      "the previous mailbox's reset token still set the password after the " +
        "account's address changed",
    );
  } finally {
    await r.close();
  }
});
