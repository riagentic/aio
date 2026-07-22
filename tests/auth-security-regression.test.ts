// Regression tests for the alpha31 adversarial-review findings — each pins a
// concrete exploit closed, so a refactor can't silently reopen it.
import { assert, assertEquals } from "@std/assert";
import { _resetAuthFails } from "../src/server/server-auth.ts";

const PORT = 9990 + (Deno.pid % 50);
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
