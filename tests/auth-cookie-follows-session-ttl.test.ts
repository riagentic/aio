// The login cookie's Max-Age came from `auth.ttlMs` (default 30 days) while the
// session token it carries took its lifetime from the store's default —
// `sessions.ttlMs`. With `sessions: { ttlMs: 90 days }` and no `auth.ttlMs`,
// the browser dropped the cookie on day 30 and logged the user out of a
// session with 60 days still to run. The cookie now lives exactly as long as
// the session it holds.
import { assert, assertEquals } from "@std/assert";
import { type AuthFlows, handleAuthFlow } from "../src/server/auth-flows.ts";
import { openSessionStore } from "../src/server/sessions.ts";
import { openUserStore } from "../src/server/auth-users.ts";

const DAY = 86_400_000;

const signup = async (
  cfg: AuthFlows,
): Promise<{ maxAge: number; exp: number }> => {
  const req = new Request("http://127.0.0.1:1/__aio/auth/signup", {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ id: "alice", password: "password123" }),
  });
  const r = await handleAuthFlow(req, new URL(req.url), cfg, undefined);
  assert(r!.ok, `signup succeeds: ${r!.status}`);
  const { token } = await r!.json();
  const cookie = r!.headers.get("set-cookie") ?? "";
  const m = /Max-Age=(\d+)/.exec(cookie);
  assert(m, `a session cookie with a Max-Age: ${cookie}`);
  const info = cfg.sessions.get(token);
  assert(info, "the issued session is live");
  return { maxAge: Number(m[1]), exp: info.expiresAt };
};

const flows = (storeTtl: number | undefined, ttlMs?: number) => {
  const sessions = openSessionStore(":memory:", storeTtl);
  const users = openUserStore(":memory:");
  const cfg = {
    users,
    sessions,
    signup: true,
    cookie: true,
    ttlMs,
    secure: false,
    appTitle: "t",
  } as AuthFlows;
  return { cfg, close: () => (sessions.close(), users.close()) };
};

Deno.test("auth cookie: Max-Age follows sessions.ttlMs when auth.ttlMs is unset", async () => {
  const { cfg, close } = flows(90 * DAY);
  try {
    const t0 = Date.now();
    const { maxAge, exp } = await signup(cfg);
    // The session runs ~90 days; the cookie must not expire before it.
    assert(
      exp - t0 > 89 * DAY,
      "the store default decides the session's lifetime",
    );
    assert(
      Math.abs(maxAge * 1000 - (exp - t0)) < 5_000,
      `cookie Max-Age ${maxAge}s must match the session's ${
        Math.round((exp - t0) / 1000)
      }s`,
    );
  } finally {
    close();
  }
});

Deno.test("auth cookie: an explicit auth.ttlMs still decides both token and cookie", async () => {
  const { cfg, close } = flows(undefined, 2 * DAY);
  try {
    const t0 = Date.now();
    const { maxAge, exp } = await signup(cfg);
    assert(Math.abs(exp - t0 - 2 * DAY) < 5_000);
    assert(Math.abs(maxAge - 2 * 86_400) <= 5, `Max-Age ${maxAge}`);
  } finally {
    close();
  }
});
