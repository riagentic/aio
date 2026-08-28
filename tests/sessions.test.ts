// AUTH-1 — session store: unit (issue/get/expiry/refresh/revoke, hashed at
// rest) + e2e (a session token authenticates a real WS connection; revocation
// cuts access; sessions alone activate per-user auth mode).
import { assert, assertEquals } from "@std/assert";
import { openSessionStore } from "../src/server/sessions.ts";
import { freePort } from "../src/testing/server-test.ts";

const PORT = freePort();

Deno.test("sessions: issue → get → refresh → revoke lifecycle", () => {
  const s = openSessionStore(":memory:");
  const token = s.issue({ id: "u1", role: "user" });
  assert(token.startsWith("aios_"), "recognizable token prefix");

  const got = s.get(token);
  assertEquals(got?.id, "u1");
  assertEquals(got?.role, "user");
  assert(got!.expiresAt > Date.now(), "future expiry");

  assert(s.refresh(token), "refresh live session");
  assert(s.revoke(token), "revoke live session");
  assertEquals(s.get(token), null, "revoked token resolves to nothing");
  assert(!s.revoke(token), "second revoke is a no-op");
  s.close();
});

Deno.test("sessions: TTL expiry removes the session on read", () => {
  const s = openSessionStore(":memory:");
  const token = s.issue({ id: "u1", role: "user" }, { ttlMs: -1 }); // born dead
  assertEquals(s.get(token), null, "expired session is gone");
  assert(!s.refresh(token), "expired session cannot be refreshed");
  assertEquals(s.count(), 0, "sweep removed it");
  s.close();
});

Deno.test("sessions: revokeUser kills every session of that user only", () => {
  const s = openSessionStore(":memory:");
  const a1 = s.issue({ id: "alice", role: "user" });
  const a2 = s.issue({ id: "alice", role: "user" });
  const b1 = s.issue({ id: "bob", role: "user" });
  assertEquals(s.revokeUser("alice"), 2);
  assertEquals(s.get(a1), null);
  assertEquals(s.get(a2), null);
  assertEquals(s.get(b1)?.id, "bob", "other users untouched");
  s.close();
});

Deno.test("sessions: tokens are stored hashed — the raw token is not in the db", () => {
  const dir = Deno.makeTempDirSync();
  const path = `${dir}/sessions.db`;
  const s = openSessionStore(path);
  const token = s.issue({ id: "u1", role: "user" });
  s.close();
  const raw = Deno.readFileSync(path);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  assert(!text.includes(token), "raw token must never touch disk");
  assert(!text.includes(token.slice(5)), "nor its hex body");
  Deno.removeSync(dir, { recursive: true });
});

/** Connect a WS with a token; resolve open+first message, reject on close. */
function tryConnect(token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    const t = setTimeout(() => {
      ws.close();
      resolve(false);
    }, 3000);
    ws.onmessage = () => {
      clearTimeout(t);
      ws.close();
      resolve(true);
    };
    ws.onerror = () => {
      clearTimeout(t);
      resolve(false);
    };
  });
}

Deno.test("sessions e2e: issued token authenticates; revoked token does not", async () => {
  const { cell, aio } = await import("../mod.ts");
  const c = cell("notes", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n += 1;
      },
    },
  });

  const app = await aio.run({
    cells: [c],
    appId: `test-sessions-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    sessions: true,
    port: PORT,
    baseDir: await Deno.makeTempDir(),
  });

  try {
    assert(app.sessions, "app.sessions surface present");
    // No token → per-user mode active (sessions alone) → rejected.
    assert(!(await tryConnect("nope")), "garbage token rejected");
    // Issue → authenticates.
    const token = app.sessions!.issue({ id: "alice", role: "admin" });
    assert(await tryConnect(token), "session token authenticates");
    // Revoke (logout) → immediately rejected.
    app.sessions!.revoke(token);
    assert(!(await tryConnect(token)), "revoked token rejected");
  } finally {
    await app.close();
  }
});
