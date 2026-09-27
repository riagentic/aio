// POST /__aio/auth/verify/request mailed a fresh token on EVERY call, with no
// budget at all — while its sibling reset/request is capped per client key
// precisely "so a known-id attacker can't mail-bomb an inbox / run up send
// costs". Sign up with someone else's address, loop verify/request, and the
// app's own mail transport bombs that inbox without limit.
import { assert, assertEquals } from "@std/assert";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("verify/request is budgeted like reset/request (no mail bomb)", async () => {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = await tempDir("aio-verify-req-");
  let sent = 0;
  const app = await aio.run({
    cells: [cell("vr", { state: { n: 0 }, access: true, visible: "all" })],
    appId: `test-verify-req-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: { sendMail: () => void sent++ },
    port,
    baseDir: dir,
  });
  try {
    const signup = await fetch(`${base}/__aio/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "mallory",
        password: "password123",
        email: "victim@example.com",
      }),
    });
    assertEquals(signup.status, 201);
    const { token } = await signup.json();
    sent = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await fetch(`${base}/__aio/auth/verify/request`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      statuses.push(r.status);
      await r.body?.cancel();
    }
    assert(sent <= 10, `mailed ${sent} verification tokens in a burst`);
    assert(statuses.includes(429), "the burst is refused once over budget");
    assertEquals(statuses[0], 200, "the first request is served");
  } finally {
    _resetAuthFails();
    await app.close();
    await dropTempDir(dir);
  }
});

// reset/request is capped per client+id (one inbox) AND per client: with only
// the first, one address could mail a reset to every account it can name.
Deno.test("reset/request: one client cannot spray reset mail across accounts", async () => {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = await tempDir("aio-reset-spray-");
  let sent = 0;
  const app = await aio.run({
    cells: [cell("rs", { state: { n: 0 }, access: true, visible: "all" })],
    appId: `test-reset-spray-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: { sendMail: () => void sent++ },
    port,
    baseDir: dir,
  });
  try {
    for (let i = 0; i < 15; i++) {
      await app.auth!.create(`u${i}`, "password123", {
        email: `u${i}@example.com`,
      });
    }
    for (let i = 0; i < 15; i++) {
      const r = await fetch(`${base}/__aio/auth/reset/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: `u${i}` }),
      });
      assertEquals(r.status, 200, "always 200 — reveal nothing");
      await r.body?.cancel();
    }
    await new Promise((r) => setTimeout(r, 50)); // mail is fire-and-forget
    assert(sent >= 1, "the first resets are mailed");
    assert(sent <= 10, `one client mailed ${sent} resets to distinct accounts`);
  } finally {
    _resetAuthFails();
    await app.close();
    await dropTempDir(dir);
  }
});

// …but a mail trigger is NOT a failed authentication. Both triggers used to
// charge the failed-login ledger, so a user who clicked "resend" ten times (or
// asked for ten resets) then got `429` for ONE mistyped password instead of
// `401` — and behind a proxy without `trustProxyHeader`, every user did.
Deno.test("mail triggers never spend the failed-login budget", async () => {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = await tempDir("aio-verify-req-");
  const app = await aio.run({
    cells: [cell("vr2", { state: { n: 0 }, access: true, visible: "all" })],
    appId: `test-verify-req2-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: { sendMail: () => {} },
    port,
    baseDir: dir,
  });
  const post = (path: string, body?: unknown, token?: string) =>
    fetch(`${base}/__aio/auth/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => {
      await r.body?.cancel();
      return r.status;
    });
  try {
    const signup = await fetch(`${base}/__aio/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "alice",
        password: "password123",
        email: "alice@example.com",
      }),
    });
    assertEquals(signup.status, 201);
    const { token } = await signup.json();
    for (let i = 0; i < 10; i++) {
      assertEquals(await post("verify/request", undefined, token), 200);
    }
    for (let i = 0; i < 10; i++) {
      assertEquals(await post("reset/request", { id: "alice" }), 200);
    }
    assertEquals(
      await post("login", { id: "alice", password: "wrong-password" }),
      401,
      "one wrong password after resends is a 401, not a 429",
    );
    assertEquals(
      await post("login", { id: "alice", password: "password123" }),
      200,
    );
  } finally {
    _resetAuthFails();
    await app.close();
    await dropTempDir(dir);
  }
});

// The anonymous resend door must not spend the signed-in user's own budget:
// it charged the same `verify:<id>` key as verify/request, so anyone who could
// name an account blocked its owner's verify/request with a burst of resends.
Deno.test("verify/resend cannot exhaust the account's own verify/request", async () => {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = await tempDir("aio-verify-resend-");
  const app = await aio.run({
    cells: [cell("vr3", { state: { n: 0 }, access: true, visible: "all" })],
    appId: `test-verify-resend-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: { sendMail: () => {} },
    port,
    baseDir: dir,
  });
  try {
    const signup = await fetch(`${base}/__aio/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "alice",
        password: "password123",
        email: "alice@example.com",
      }),
    });
    assertEquals(signup.status, 201);
    const { token } = await signup.json();
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${base}/__aio/auth/verify/resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "alice" }),
      });
      await r.body?.cancel();
    }
    const r = await fetch(`${base}/__aio/auth/verify/request`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    await r.body?.cancel();
    assertEquals(r.status, 200, "the owner's own verify/request is served");
  } finally {
    _resetAuthFails();
    await app.close();
    await dropTempDir(dir);
  }
});
