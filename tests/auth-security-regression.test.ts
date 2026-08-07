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
    visible: "all", // alpha52: the read side must be decided on a multi-user app
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

// ── alpha50: two doors into raw-state control that answered to nobody ────────

// DELETING AN ACCOUNT MUST END IT.
//
// `sessions.get` re-reads the live role from the users row, so a demotion
// reaches an open session — but a MISSING users row is indistinguishable from
// "this app has no user table at all" (`sessions: true` without `auth: true`),
// so it fell back to the role cached at login. `app.auth.remove(id)` — the
// documented programmatic door for offboarding, a ban, breach response —
// therefore deleted the account while its existing token kept authenticating,
// with the old role, over HTTP and on already-open sockets, for up to the
// 30-day TTL. `am auth rm` had always remembered to revoke; the programmatic
// door had not — the same shape as `am auth passwd` forgetting it.
Deno.test({
  name: "regression: a deleted user's session stops authenticating at once",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const app = await aio.run({
    cells: [cell("vaultrm", { state: { n: 0 }, methods: {} })],
    appId: `test-authrm-${Deno.pid}`,
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
      body: JSON.stringify({ id: "carol", password: "password123" }),
    });
    const token = (await su.json()).token as string;
    // Promote, so the surviving credential would be an ADMIN one — the worst
    // case, and the one the role cache hands back.
    assert(app.auth!.setRole("carol", "admin"), "promote for the test");

    const me = async () =>
      (await (await fetch(`${base}/__aio/auth/me`, {
        headers: { authorization: `Bearer ${token}` },
      })).json()).user;
    assertEquals((await me())?.id, "carol", "precondition: the token works");

    // A live socket, opened while the account still exists.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const closed = new Promise<void>((r) => {
      ws.onclose = () => r();
    });
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("ws timeout")), 3000);
      ws.onmessage = () => {
        clearTimeout(t);
        res();
      };
      ws.onerror = () => {
        clearTimeout(t);
        rej(new Error("ws error"));
      };
    });

    // A one-shot token in flight (a mailed reset, a TOTP pending) MINTS
    // sessions — deleting the account has to burn it too.
    app.auth!.issueToken("reset", "carol", 60_000);
    assertEquals(app.auth!.purgeTokens("__none__"), 0, "sanity: purge counts");

    assert(app.auth!.remove("carol"), "the account is deleted");

    assertEquals(
      await me(),
      null,
      "a deleted user's token must not authenticate — it resolved as the " +
        "role cached at login for up to the session TTL",
    );
    // …and the socket that was already open is disarmed, not left running
    // until it happens to reconnect.
    await Promise.race([
      closed,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("socket survived the deletion")), 4000)
      ),
    ]);
    // The reset token issued above must be GONE — 0 left to purge. Without
    // the burn this is 1: a token that mints a session for a deleted account.
    assertEquals(
      app.auth!.purgeTokens("carol"),
      0,
      "a one-shot token outlived the account it belongs to",
    );
  } finally {
    _resetAuthFails();
    await app.close();
  }
});

// A `tt-cmd` FRAME IS RAW-STATE CONTROL, AND IT ANSWERED TO NOBODY.
//
// `/__aio/snapshot` and `/__aio/trojan/*` both require role "admin" in
// per-user mode because they replace raw state. The `tt-cmd` frame on a live
// WebSocket does the same thing through a different door and had NO check at
// all: `handleTTCommand` assigns `state` directly, so one frame from the
// lowest-privilege authenticated account rewound the WHOLE app (every
// connected client) to an earlier action — and `pause` makes `dispatch`
// REJECT every action from every user, with persistence stopped, until
// someone resumes. Destruction and a whole-app write freeze, from `role:
// "user"`, with nothing in the way.
Deno.test({
  name: "regression: a non-admin cannot rewind or freeze the app with tt-cmd",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  _resetAuthFails();
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const app = await aio.run({
    cells: [
      cell("ttvault", {
        state: { reads: 0 },
        methods: {
          read(s: { reads: number }) {
            s.reads += 1;
          },
        },
      }),
    ],
    appId: `test-ttgate-${Deno.pid}`,
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    auth: true,
    port,
    baseDir: await Deno.makeTempDir(),
  });
  const settle = () => new Promise((r) => setTimeout(r, 120));
  const reads = () =>
    (app.getState() as unknown as { ttvault: { reads: number } }).ttvault.reads;
  const login = async (id: string): Promise<WebSocket> => {
    const su = await fetch(`${base}/__aio/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, password: "password123" }),
    });
    const token = (await su.json()).token as string;
    return await new Promise<WebSocket>((res, rej) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      const t = setTimeout(() => rej(new Error("ws timeout")), 3000);
      s.onmessage = () => {
        clearTimeout(t);
        res(s);
      };
      s.onerror = () => {
        clearTimeout(t);
        rej(new Error("ws error"));
      };
    });
  };
  const read = (ws: WebSocket) =>
    ws.send(JSON.stringify({
      v: 2,
      t: "action",
      d: { type: "ttvault:read", payload: { args: [] } },
    }));
  const tt = (ws: WebSocket, cmd: string) =>
    ws.send(JSON.stringify({ v: 2, t: "tt-cmd", d: { cmd } }));

  try {
    const mallory = await login("mallory"); // signup default role: "user"
    read(mallory);
    read(mallory);
    read(mallory);
    await settle();
    const before = reads();
    assert(before >= 1, "precondition: history exists to rewind");

    // ① the rewind: the whole app back to its first action, for everyone.
    tt(mallory, "goto:0");
    await settle();
    assertEquals(
      reads(),
      before,
      "a non-admin rewound every client's state with one frame",
    );

    // ② the freeze: `pause` makes dispatch reject for EVERY user.
    tt(mallory, "pause");
    await settle();
    read(mallory);
    await settle();
    assertEquals(
      reads(),
      before + 1,
      "a non-admin froze the whole app's dispatch with one frame",
    );
    mallory.close();

    // …and an ADMIN still drives it — the gate is a role bar, not a ban.
    assert(app.auth!.setRole("root", "admin") === false, "no root yet");
    const admin = await login("root");
    assert(app.auth!.setRole("root", "admin"), "promote");
    admin.close();
    const admin2 = await login2(base, port, "root", "password123");
    const now = reads();
    tt(admin2, "goto:0");
    await settle();
    assert(
      reads() < now,
      `an admin must still be able to time-travel (reads stayed ${reads()})`,
    );
    admin2.close();
  } finally {
    _resetAuthFails();
    await app.close();
  }
});

/** Log in an EXISTING account and open its socket (signup would 409). */
async function login2(
  base: string,
  port: number,
  id: string,
  password: string,
): Promise<WebSocket> {
  const r = await fetch(`${base}/__aio/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, password }),
  });
  const token = (await r.json()).token as string;
  return await new Promise<WebSocket>((res, rej) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const t = setTimeout(() => rej(new Error("ws timeout")), 3000);
    s.onmessage = () => {
      clearTimeout(t);
      res(s);
    };
    s.onerror = () => {
      clearTimeout(t);
      rej(new Error("ws error"));
    };
  });
}

// The gate is per-user-mode only: a PUBLIC dev app has no identity to check,
// and the time-travel panel (Ctrl+.) is the whole point of the frame there.
Deno.test({
  name: "tt-cmd still works for an anonymous client on a public dev app",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const { cell, aio } = await import("../mod.ts");
  const port = freePort();
  const app = await aio.run({
    cells: [
      cell("ttpub", {
        state: { reads: 0 },
        methods: {
          read(s: { reads: number }) {
            s.reads += 1;
          },
        },
      }),
    ],
    appId: `test-ttpub-${Deno.pid}`,
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await Deno.makeTempDir(),
  });
  const settle = () => new Promise((r) => setTimeout(r, 120));
  const reads = () =>
    (app.getState() as unknown as { ttpub: { reads: number } }).ttpub.reads;
  try {
    const ws = await new Promise<WebSocket>((res, rej) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const t = setTimeout(() => rej(new Error("ws timeout")), 3000);
      s.onmessage = () => {
        clearTimeout(t);
        res(s);
      };
      s.onerror = () => {
        clearTimeout(t);
        rej(new Error("ws error"));
      };
    });
    ws.send(JSON.stringify({
      v: 2,
      t: "action",
      d: { type: "ttpub:read", payload: { args: [] } },
    }));
    await settle();
    assertEquals(reads(), 1);
    ws.send(JSON.stringify({ v: 2, t: "tt-cmd", d: { cmd: "goto:0" } }));
    await settle();
    assertEquals(reads(), 0, "the dev panel must keep working in public mode");
    ws.close();
  } finally {
    await app.close();
  }
});
