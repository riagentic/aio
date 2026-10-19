// `auth: { maxSessions }` — a ceiling on the live sessions of ONE account.
//
// A correct password is never rate-limited ("a request that presents a VALID
// credential is served regardless of the budget", docs/auth/auth.md), so the
// login limiter does not bound this: 60 correct logins in a burst are 60 live
// sessions, and nothing in the store ever said stop. The first test pins that
// default (it is the documented contract of the limiter); the rest pin the
// opt-in ceiling at the one place every issue door passes — the store.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { type AuthFlows, handleAuthFlow } from "../src/server/auth-flows.ts";
import { openSessionStore } from "../src/server/sessions.ts";
import { openUserStore } from "../src/server/auth-users.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { configConflicts } from "../src/server/config.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";

const PW = "correct horse battery";

async function burst(maxPerUser: number | undefined, n: number) {
  _resetAuthFails();
  const sessions = openSessionStore(":memory:", undefined, { maxPerUser });
  const users = openUserStore(":memory:", { sessions: () => sessions });
  const cfg = {
    users,
    sessions,
    signup: true,
    cookie: false,
    secure: false,
    appTitle: "t",
  } as AuthFlows;
  await users.create("ann", PW);
  await users.create("bob", PW);
  const login = async (id: string) => {
    const req = new Request("http://127.0.0.1:1/__aio/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, password: PW }),
    });
    const r = (await handleAuthFlow(req, new URL(req.url), cfg, "10.0.0.9"))!;
    return { status: r.status, token: (await r.json()).token as string };
  };
  const bob = await login("bob");
  let revoked = 0;
  sessions.onRevoked(() => revoked++);
  // In waves of 20: the work meter holds 30 units per address and a login
  // holds one until its password is checked, so more than 30 IN FLIGHT at
  // once are refused 429 — the only bound the limiter puts on valid logins.
  const got: { status: number; token: string }[] = [];
  for (let i = 0; i < n; i += 20) {
    got.push(
      ...await Promise.all(Array.from({ length: 20 }, () => login("ann"))),
    );
  }
  return { sessions, users, got, bob, revoked: () => revoked };
}

Deno.test("auth.maxSessions unset: 60 correct logins in a burst are 60 live sessions (the limiter never refuses a valid credential)", async () => {
  const { sessions, users, got } = await burst(undefined, 60);
  try {
    assertEquals(got.filter((g) => g.status === 200).length, 60);
    assertEquals(got.filter((g) => sessions.get(g.token)).length, 60);
  } finally {
    users.close();
    sessions.close();
  }
});

Deno.test("auth.maxSessions: 60 logins leave the newest N live, the oldest revoked, another account untouched", async () => {
  const { sessions, users, got, bob, revoked } = await burst(5, 60);
  try {
    assertEquals(got.filter((g) => g.status === 200).length, 60);
    const live = got.map((g) => !!sessions.get(g.token));
    assertEquals(live.filter(Boolean).length, 5);
    assertEquals(sessions.count(), 6, "ann's five and bob's one");
    assert(sessions.get(bob.token), "the ceiling is per account");
    assertEquals(revoked(), 55, "each eviction is announced to live sockets");
  } finally {
    users.close();
    sessions.close();
  }
});

Deno.test("auth.maxSessions: the store evicts in issue order and never counts an expired row", async () => {
  const s = openSessionStore(":memory:", undefined, { maxPerUser: 2 });
  try {
    const dead = s.issue({ id: "u", role: "user" }, { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const a = s.issue({ id: "u", role: "user" });
    const b = s.issue({ id: "u", role: "user" });
    assert(s.get(a) && s.get(b), "two live under a ceiling of two");
    assertEquals(s.get(dead), null);
    const c = s.issue({ id: "u", role: "user" });
    assertEquals(s.get(a), null, "the oldest goes");
    assert(s.get(b) && s.get(c));
  } finally {
    s.close();
  }
});

Deno.test("auth.maxSessions: a value that is not a count is refused at the store and at boot", () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity]) {
    assertThrows(
      () => openSessionStore(":memory:", undefined, { maxPerUser: bad }),
      Error,
      "maxPerUser",
    );
  }
  const said = (v: unknown) =>
    configConflicts({ auth: { maxSessions: v } } as never).filter((c) =>
      c.keys.includes("auth.maxSessions")
    );
  assertEquals(said(10), []);
  for (const bad of [0, 1.5, "10", null]) {
    assertEquals(said(bad).map((c) => c.level), ["error"], String(bad));
  }
});

// The ceiling held only at `issue`: an app that set (or lowered) it and
// restarted kept every account's sessions past it live until that account's
// next login — up to the 30-day TTL. The store opens to the ceiling.
Deno.test("auth.maxSessions: a store opened under a ceiling prunes sessions already past it, newest kept", async () => {
  const dir = await tempDir("max-sessions-open-");
  const path = join(dir, "auth.db");
  try {
    const before = openSessionStore(path);
    const ann = [1, 2, 3].map(() => before.issue({ id: "ann", role: "user" }));
    const bob = before.issue({ id: "bob", role: "user" });
    before.close();
    const after = openSessionStore(path, undefined, { maxPerUser: 2 });
    try {
      assertEquals(ann.map((t) => !!after.get(t)), [false, true, true]);
      assert(after.get(bob), "another account under the ceiling is untouched");
      assertEquals(after.count(), 3);
    } finally {
      after.close();
    }
  } finally {
    await dropTempDir(dir);
  }
});
