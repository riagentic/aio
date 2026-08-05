// Regression tests for the alpha31 adversarial-review findings — each pins a
// concrete exploit closed, so a refactor can't silently reopen it.
import { assert, assertEquals } from "@std/assert";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";

const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}`;

/** Boot a library-mode app with a cell whose access predicate discriminates
 *  by METHOD name — the surface the `_origin` spoof attacked. */
async function bootApp() {
  const { cell, aio } = await import("../mod.ts");
  const vault = cell("vault", {
    state: { deleted: 0, reads: 0 },
    // read allowed for any user; delete allowed for admins only.
    access: (user, method) => method !== "wipe" || user?.role === "admin",
    methods: {
      read(s: { reads: number }) {
        s.reads += 1;
      },
      wipe(s: { deleted: number }) {
        s.deleted += 1;
      },
    },
  });
  const app = await aio.run({
    cells: [vault],
    appId: `test-sec-${Deno.pid}`,
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: true,
    port: PORT,
    baseDir: await Deno.makeTempDir(),
  });
  return { app };
}

function connect(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error("ws timeout"));
    }, 3000);
    ws.onmessage = () => {
      clearTimeout(t);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    };
  });
}

Deno.test("regression: forged payload._origin cannot bypass a method access rule", async () => {
  _resetAuthFails();
  const { app } = await bootApp();
  const settle = () => new Promise((r) => setTimeout(r, 80));
  type S = { vault: { deleted: number; reads: number } };
  const st = () => (app.getState() as unknown as S).vault;
  try {
    // A non-admin logs in.
    const su = await fetch(`${BASE}/__aio/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "eve", password: "password123" }),
    });
    const { token } = await su.json();
    const ws = await connect(token);

    // The attack: call `wipe` but claim `_origin: "read"` so a naive gate
    // checks the rule with method="read" (allowed) while the reducer wipes.
    ws.send(JSON.stringify({
      v: 2,
      t: "action",
      d: { type: "vault:wipe", payload: { _origin: "read" } },
    }));
    await settle();
    assertEquals(st().deleted, 0, "wipe must be denied despite forged _origin");
    ws.close();
  } finally {
    _resetAuthFails();
    await app.close();
  }
});

Deno.test("regression: signup enumeration feeds the fail budget (429 after burst)", async () => {
  _resetAuthFails();
  const { app } = await bootApp();
  try {
    // Seed a name.
    await fetch(`${BASE}/__aio/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "taken", password: "password123" }),
    }).then((r) => r.body?.cancel());
    // Hammer the existence oracle: each 409 now records a fail; after the
    // budget (10) is spent the route answers 429, not an unlimited 409 oracle.
    let saw429 = false;
    for (let i = 0; i < 14; i++) {
      const r = await fetch(`${BASE}/__aio/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "taken", password: "password123" }),
      });
      if (r.status === 429) saw429 = true;
      await r.body?.cancel();
    }
    assert(saw429, "signup enumeration must hit the 429 budget");
  } finally {
    _resetAuthFails();
    await app.close();
  }
});

Deno.test("regression: login reveals neither existence nor lock state to a guesser", async () => {
  _resetAuthFails();
  const { app } = await bootApp();
  const login = (id: string, password: string) =>
    fetch(`${BASE}/__aio/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, password }),
    });
  try {
    await fetch(`${BASE}/__aio/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "alice", password: "password123" }),
    }).then((r) => r.body?.cancel());

    // Wrong password on an EXISTING account and on a MISSING account both
    // return the same 401 — no status-code enumeration.
    const bad = await login("alice", "wrong-wrong-1");
    const ghost = await login("nobody", "wrong-wrong-1");
    assertEquals(bad.status, 401);
    assertEquals(ghost.status, 401);
    await bad.body?.cancel();
    await ghost.body?.cancel();

    // Even after enough wrong guesses to LOCK alice, a wrong-password attempt
    // still returns a generic 401 (never 423) — the lock state doesn't leak to
    // someone who can't present the password.
    _resetAuthFails(); // isolate from the per-IP budget for this assertion
    for (let i = 0; i < 5; i++) {
      await login("alice", "still-wrong").then((r) => r.body?.cancel());
    }
    const lockedGuess = await login("alice", "another-wrong");
    assertEquals(
      lockedGuess.status,
      401,
      "locked account still looks like 401 to a guesser",
    );
    await lockedGuess.body?.cancel();

    // The owner, presenting the RIGHT password, learns it's locked (423).
    const owner = await login("alice", "password123");
    assertEquals(owner.status, 423, "owner sees the lock");
    await owner.body?.cancel();
  } finally {
    _resetAuthFails();
    await app.close();
  }
});

// the per-account lockout counted failures with a read-modify-write
// straddling PBKDF2's ~100ms of yielded event loop, writing an ABSOLUTE
// `fails + 1`. Concurrent guesses all read the same stale count and all wrote
// the same number, so a burst advanced the counter by one: twenty wrong
// passwords at once left the account unlocked. The lockout is the one defence
// a botnet's rotating IPs can't sidestep, and "don't wait between guesses"
// turned it off.
Deno.test("regression: concurrent wrong passwords cannot outrun the lockout", async () => {
  const { openUserStore } = await import("../src/server/auth-users.ts");
  const dir = await Deno.makeTempDir({ prefix: "aio-lockrace-" });
  try {
    const store = openUserStore(`${dir}/users.db`);
    await store.create("alice", "correct-horse-battery");

    // The attack: no waiting, all in flight together.
    await Promise.all(
      Array.from({ length: 20 }, () => store.verify("alice", "wrong")),
    );

    assertEquals(
      await store.verify("alice", "correct-horse-battery"),
      "locked",
      "20 concurrent wrong passwords must lock the account (LOCK_AFTER=5)",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("regression: a lockout is never extended by later failures", async () => {
  const { openUserStore } = await import("../src/server/auth-users.ts");
  // @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await Deno.makeTempDir({ prefix: "aio-lockext-" });
  try {
    const path = `${dir}/users.db`;
    const store = openUserStore(path);
    for (let i = 0; i < 5; i++) await store.verify("bob", "wrong");
    await store.create("bob2", "correct-horse-battery");
    for (let i = 0; i < 5; i++) await store.verify("bob2", "wrong");
    assertEquals(await store.verify("bob2", "correct-horse-battery"), "locked");

    const read = () => {
      const db = new DatabaseSync(path);
      const row = db.prepare("SELECT locked_until FROM users WHERE id = ?")
        .get("bob2") as { locked_until: number };
      db.close();
      return row.locked_until;
    };
    const first = read();
    // Guessing at a LOCKED account must not push the expiry further out —
    // otherwise an attacker keeps the owner locked out indefinitely.
    for (let i = 0; i < 5; i++) await store.verify("bob2", "wrong");
    assertEquals(read(), first, "lock expiry unchanged by further guesses");
    assertEquals(await store.verify("bob2", "correct-horse-battery"), "locked");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// a TOTP code stayed usable for its whole ±1-step (90s) window, so one
// observed code could be replayed. RFC 6238 §5.2: remember the last accepted
// step and refuse anything at or below it.
Deno.test("regression: a TOTP code cannot be used twice", async () => {
  const { generateTotpSecret, totpCode, verifyTotp, _resetTotpReplay } =
    await import("../src/server/auth-totp.ts");
  _resetTotpReplay();
  const secret = generateTotpSecret();
  const step = Math.floor(Date.now() / 30_000);
  const code = await totpCode(secret, step);

  assert(await verifyTotp(secret, code), "first use is accepted");
  assert(
    !(await verifyTotp(secret, code)),
    "the same code must not be accepted again inside its validity window",
  );
  // An OLDER still-in-window code is dead too — it is a step below the one used.
  assert(
    !(await verifyTotp(secret, await totpCode(secret, step - 1))),
    "a previous-step code cannot be replayed after a newer one was accepted",
  );
  // The next step is a genuinely new code and still works.
  assert(
    await verifyTotp(secret, await totpCode(secret, step + 1)),
    "the next code is accepted",
  );
  // Per secret, not global: another user's code is unaffected.
  const other = generateTotpSecret();
  assert(await verifyTotp(other, await totpCode(other, step)));
  _resetTotpReplay();
});

// /totp/setup overwrote the stored secret even when TOTP was already
// enabled, so a stolen session could stage its own secret, enable it with a
// valid code, and silently take over the victim's second factor. Turning TOTP
// off requires the password; replacing it must not be easier.
Deno.test("regression: TOTP cannot be re-enrolled while it is enabled", async () => {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const { totpCode, _resetTotpReplay } = await import(
    "../src/server/auth-totp.ts"
  );
  _resetTotpReplay();
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const app = await aio.run({
    cells: [cell("t2fa", { state: { n: 0 }, methods: {} })],
    appId: `test-totp-rotate-${Deno.pid}`,
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: true,
    port,
    baseDir: await Deno.makeTempDir(),
  });
  const post = (path: string, body?: unknown, token?: string) =>
    fetch(`${base}/__aio/auth/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const su = await post("signup", { id: "alice", password: "password123" });
    const session = (await su.json()).token as string;

    const setup = await post("totp/setup", undefined, session);
    const { secret } = await setup.json();
    const step = Math.floor(Date.now() / 30_000);
    const en = await post(
      "totp/enable",
      { code: await totpCode(secret, step - 1), password: "password123" },
      session,
    );
    assertEquals(en.status, 200);
    await en.body?.cancel();

    // The attacker holds the same session and tries to stage a NEW secret.
    const again = await post("totp/setup", undefined, session);
    assertEquals(again.status, 409, "re-enrolment is refused while enabled");
    const body = await again.json();
    assertEquals(body.error, "totp_already_enabled");

    // …and the original secret still governs the account.
    const li = await post("login", { id: "alice", password: "password123" });
    const challenge = await li.json();
    assertEquals(challenge.totpRequired, true);
    const ok = await post("totp", {
      pending: challenge.pending,
      code: await totpCode(secret, step + 1),
    });
    assertEquals(ok.status, 200, "the ORIGINAL secret still works");
    await ok.body?.cancel();
  } finally {
    _resetTotpReplay();
    _resetAuthFails();
    await app.close();
  }
});

// a login SESSION token was accepted from `?token=`, so it could land in
// browser history, proxy logs and the Referer of every outbound link. The login
// flow deliberately delivers sessions as an HttpOnly cookie or a Bearer header
// (handleAuthFlow's own reader ignores the query string); only the `/ws`
// handshake, which has no header channel, still accepts one there.
Deno.test("regression: a session token in the URL does not authenticate HTTP", async () => {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const app = await aio.run({
    cells: [cell("vaultq", { state: { n: 0 }, methods: {} })],
    appId: `test-urltok-${Deno.pid}`,
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: true,
    port,
    baseDir: await Deno.makeTempDir(),
  });
  try {
    const su = await fetch(`${base}/__aio/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "alice", password: "password123" }),
    });
    const token = (await su.json()).token as string;
    assert(token, "signup issues a session token");

    // The same token in a header is accepted…
    const viaHeader = await fetch(`${base}/__aio/snapshot`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await viaHeader.body?.cancel();
    assert(
      viaHeader.status !== 401,
      `header auth must keep working (got ${viaHeader.status})`,
    );

    // …and in the URL it is not.
    const viaUrl = await fetch(`${base}/__aio/snapshot?token=${token}`);
    await viaUrl.body?.cancel();
    assertEquals(
      viaUrl.status,
      401,
      "a session token in the query string must not authenticate an HTTP request",
    );
  } finally {
    _resetAuthFails();
    await app.close();
  }
});
