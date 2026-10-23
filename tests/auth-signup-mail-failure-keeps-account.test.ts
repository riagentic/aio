// POST /__aio/auth/signup CREATED the account and then awaited the
// verification mail. A transport that threw (SMTP down for a moment) turned
// that into `503 auth_unavailable` for a signup that had succeeded: the person
// was told it failed, retried, and got `409 user_exists` for the id they had
// just been refused — no session, no word that the account existed. The mail
// is a side effect of a committed signup: its failure is logged, and under
// `requireVerified` answered as `verificationSent: false` (never a claim that
// a mail went out when the transport refused it).
import { assert, assertEquals } from "@std/assert";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function signupWithFailingMail(
  requireVerified: boolean,
  check: (
    status: number,
    body: Record<string, unknown>,
    base: string,
  ) => Promise<void>,
): Promise<void> {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = await tempDir("aio-signup-mailfail-");
  let tried = 0;
  const app = await aio.run({
    cells: [cell("sm", { state: { n: 0 }, access: true, visible: "all" })],
    appId: `test-signup-mailfail-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: {
      ...(requireVerified ? { requireVerified: true as const } : {}),
      sendMail: () => {
        tried++;
        return Promise.reject(new Error("smtp: connection refused"));
      },
    },
    port,
    baseDir: dir,
  });
  try {
    const signup = await fetch(`${base}/__aio/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "dana",
        password: "password123",
        email: "dana@example.com",
      }),
    });
    const body = await signup.json();
    assertEquals(tried, 1, "the verification mail was attempted");
    await check(signup.status, body, base);
  } finally {
    _resetAuthFails();
    await app.close();
    await dropTempDir(dir);
  }
}

Deno.test("signup with a failing mail transport still answers 201 with a session", async () => {
  await signupWithFailingMail(false, async (status, body, base) => {
    assertEquals(
      status,
      201,
      `the account exists, so signup must say so — got ${status} ` +
        JSON.stringify(body),
    );
    assert(typeof body.token === "string", "…with the session it created");
    const me = await fetch(`${base}/__aio/auth/me`, {
      headers: { authorization: `Bearer ${body.token}` },
    });
    assertEquals((await me.json()).user?.id, "dana");
  });
});

Deno.test("requireVerified signup with a failing mail transport answers verificationSent: false", async () => {
  await signupWithFailingMail(true, async (status, body) => {
    assertEquals(status, 201, JSON.stringify(body));
    assertEquals(body.verificationSent, false, JSON.stringify(body));
    assertEquals(body.token, undefined, "no session before verification");
  });
});

// Awaiting the mail on EVERY signup let a hanging transport hold the response
// forever. Only `requireVerified` (whose `verificationSent` must be honest)
// waits; otherwise the mail goes off the response path.
Deno.test("signup without requireVerified answers while the mail transport hangs", async () => {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const dir = await tempDir("aio-signup-mailhang-");
  let release!: () => void;
  const hung = new Promise<void>((r) => release = r);
  const app = await aio.run({
    cells: [cell("sm", { state: { n: 0 }, access: true, visible: "all" })],
    appId: `test-signup-mailhang-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: { sendMail: () => hung },
    port,
    baseDir: dir,
  });
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const res = await Promise.race([
      fetch(`http://127.0.0.1:${port}/__aio/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "dana",
          password: "password123",
          email: "dana@example.com",
        }),
      }).then(async (r) => ({ status: r.status, body: await r.json() })),
      new Promise<null>((r) => timer = setTimeout(() => r(null), 5000)),
    ]);
    clearTimeout(timer);
    assert(res !== null, "signup must not wait on a hanging sendMail");
    assertEquals(res.status, 201, JSON.stringify(res.body));
    assert(typeof res.body.token === "string");
  } finally {
    release();
    _resetAuthFails();
    await app.close();
    await dropTempDir(dir);
  }
});
