// Five auth doors that answered wrongly.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { openSessionStore } from "../src/server/sessions.ts";
import { openUserStore } from "../src/server/auth-users.ts";
import { configConflicts } from "../src/server/config.ts";

const PW = "not-a-real-password";

async function boot(name: string) {
  const c = cell(`cell${name}`, { state: { n: 0 }, methods: {} });
  const port = freePort();
  const dir = await tempDir(`aio-${name}-`);
  const app = await aio.run({
    cells: [c],
    appId: `${name}-${crypto.randomUUID().slice(0, 8)}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    auth: true,
    baseDir: dir,
    port,
    // deno-lint-ignore no-explicit-any
  } as any);
  const base = `http://127.0.0.1:${port}/__aio/auth`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    app,
    post,
    close: async () => {
      await app.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    },
  };
}

// ── 1. a CORRECT login must never be refused for budget ──────────────────────
//
// `docs/auth/auth.md`: "Successful requests never consume budget. The budget
// throttles failed authentication, never service. A request that presents a
// valid credential is served regardless of the budget."
//
// The work meter charged every attempt and gave none back, so it was 30
// CORRECT logins a minute and then `429` for everyone. Measured: 40
// consecutive logins with the right password — 29 answered 200, the last 11
// answered 429, on an account that was never locked. The same page notes that
// behind a reverse proxy without `trustProxyHeader` every client shares ONE
// bucket, so a team of more than 30 people signing in within a minute took the
// whole app's login offline from purely legitimate traffic — which is the
// outage `chargeAuthWork` was introduced to prevent, from the other side.
Deno.test({
  name: "auth: 40 correct logins in a row are all served",
  sanitizeOps: false, // aio-ok: a live server, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const b = await boot("budget");
    try {
      const s = await b.post("signup", { id: "alice", password: PW });
      assertEquals(s.status, 201);
      await s.body?.cancel();

      const codes: number[] = [];
      for (let i = 0; i < 40; i++) {
        const r = await b.post("login", { id: "alice", password: PW });
        codes.push(r.status);
        await r.body?.cancel();
      }
      assertEquals(
        codes.filter((c) => c !== 200),
        [],
        `every correct login must be served — got ${codes.join(",")}`,
      );
    } finally {
      await b.close();
    }
  },
});

// …and the meter still does its job: wrong passwords are what it counts.
Deno.test({
  name: "auth: wrong passwords still exhaust the budget",
  sanitizeOps: false, // aio-ok: a live server, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const b = await boot("budgetbad");
    try {
      const s = await b.post("signup", { id: "bob", password: PW });
      await s.body?.cancel();
      const codes: number[] = [];
      for (let i = 0; i < 40; i++) {
        const r = await b.post("login", { id: "bob", password: "wrong-one" });
        codes.push(r.status);
        await r.body?.cancel();
      }
      assert(
        codes.includes(429),
        `a flood of WRONG passwords must still be refused: ${codes.join(",")}`,
      );
    } finally {
      await b.close();
    }
  },
});

// ── 2. a TTL that cannot become a timestamp is refused at BOOT ───────────────
//
// `now + ttlMs` goes into an INTEGER column and comes back as a JavaScript
// number. Out of range, the WRITE succeeded and every READ threw — so the app
// booted with no complaint, `/signup` answered 201 with a real-looking token,
// and every use of it was a 500 (HTTP) or a silent refusal (WebSocket).
// `Infinity` issued an immortal session no sweep can expire and put
// `Max-Age=Infinity` in the cookie; a negative one handed back a token that
// was already dead. "A config validated only when it FIRES."
Deno.test("auth: an impossible ttlMs is a boot error, not a runtime 500", () => {
  for (
    const ttl of [
      Number.MAX_SAFE_INTEGER,
      1e18,
      Infinity,
      -1,
      0,
      NaN,
    ]
  ) {
    const issues = configConflicts({ auth: { ttlMs: ttl } });
    assert(
      issues.some((i) => i.level === "error" && i.keys.includes("auth.ttlMs")),
      `auth.ttlMs = ${ttl} must be refused at boot: ${JSON.stringify(issues)}`,
    );
  }
  // …and an ordinary week is fine.
  const week = configConflicts({ auth: { ttlMs: 7 * 24 * 60 * 60_000 } });
  assertEquals(
    week.filter((i) => i.keys.includes("auth.ttlMs")),
    [],
    "a normal TTL must not be flagged",
  );
});

Deno.test("sessions.issue: an impossible ttlMs is refused at the store too", async () => {
  const dir = await tempDir("aio-ttl-store-");
  const store = openSessionStore(`${dir}/auth.db`);
  try {
    for (const ttl of [Number.MAX_SAFE_INTEGER, Infinity, NaN, -1, 0]) {
      assertThrows(
        () => store.issue({ id: "a", role: "user" }, { ttlMs: ttl }),
        Error,
        "cannot become an expiry",
        `ttlMs ${ttl} must be refused where it is written`,
      );
    }
    // A real one still works.
    const tok = store.issue({ id: "a", role: "user" }, { ttlMs: 60_000 });
    assertEquals(store.get(tok)?.id, "a");
  } finally {
    store.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── 3. a TOTP secret that is not base32 is refused where it is written ───────
//
// Every code is derived by base32-decoding it, and the decoder throws
// `invalid_base32` — uncaught, deep in the login flow, as a bare `500
// Internal Server Error`. A hex secret (the shape a migration off another
// system hands you) was accepted with `true`, and then every login attempt for
// that account answered 500 with no explanation, burning a `pending` token
// each time.
Deno.test("setTotpSecret: a non-base32 secret is refused, naming the reason", async () => {
  const dir = await tempDir("aio-totp-secret-");
  const path = `${dir}/auth.db`;
  const sessions = openSessionStore(path);
  const users = openUserStore(path, { sessions: () => sessions });
  try {
    await users.create("carol", PW);
    assertThrows(
      () => users.setTotpSecret("carol", "0123456789abcdef"),
      Error,
      "must be base32",
      "a hex secret is the shape a real migration produces",
    );
    assertThrows(() => users.setTotpSecret("carol", ""), Error, "base32");
    assertThrows(() => users.setTotpSecret("carol", "AB!CD"), Error, "base32");
    // A real base32 secret still works, padding and case included.
    assertEquals(users.setTotpSecret("carol", "JBSWY3DPEHPK3PXP"), true);
    assertEquals(users.setTotpSecret("carol", "jbswy3dpehpk3pxp="), true);
  } finally {
    users.close();
    sessions.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
