// A password reset refused for POLICY (new password too short) burns the
// one-shot reset token, so the user's corrected retry is told the link is
// "used up or expired" and must request (and wait for) a new mail.
import { assertEquals } from "@std/assert";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("reset: a too-short new password does not burn the reset token", async () => {
  _resetAuthFails();
  const { cell, aio } = await import("/home/dev/code/gen/aio/mod.ts");
  const c = cell(`h5rst${crypto.randomUUID().slice(0, 6)}`, {
    state: { n: 0 },
    methods: {},
  });
  const outbox: { to: string; text: string }[] = [];
  const port = freePort();
  const dir = await tempDir("h5-reset");
  const app = await aio.run({
    cells: [c],
    appId: `test-h5-reset-${crypto.randomUUID().slice(0, 8)}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: {
      sendMail: (m) => {
        outbox.push(m);
      },
    },
    port,
    baseDir: dir,
  });
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/__aio/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    const su = await post("signup", {
      id: "alice",
      password: "password123",
      email: "a@example.com",
    });
    assertEquals(su.status, 201);
    await new Promise((r) => setTimeout(r, 50));
    outbox.length = 0;
    assertEquals((await post("reset/request", { id: "alice" })).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    const token = /aiot_[0-9a-f]+/.exec(outbox.at(-1)!.text)![0];

    // User types a 7-char password — refused by policy.
    const short = await post("reset", { token, password: "short12" });
    assertEquals(short.status, 400);
    assertEquals(short.body.error, "password_too_short");

    // …and retries with a valid one, same token, seconds later.
    const retry = await post("reset", {
      token,
      password: "a-long-enough-password",
    });
    assertEquals(
      retry.status,
      200,
      `retry answered ${JSON.stringify(retry.body)}`,
    );
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
});
