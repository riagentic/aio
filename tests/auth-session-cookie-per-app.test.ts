// Two aio apps on one host keep separate sessions.
//
// Cookies ignore the PORT (RFC 6265 §8.5), and every app named its session
// cookie `aio_session`. A browser signed in to app A on :8080 and then app B on
// :8081 got A's cookie overwritten — A logged out — and until then B's server
// received A's HttpOnly session token on every request. The shared-key cookie
// was already per app; this pins the session cookie to the same rule, plus the
// upgrade path: a session issued under the legacy name keeps working, and a
// legacy value this app does not recognise (another app's) is never cleared.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { type TestServer, testServer } from "../src/testing/server-test.ts";
import {
  _resetAuthFails,
  sessionCookieNameFor,
} from "../src/server/server-auth.ts";

/** A browser cookie jar: keyed by host only, never by port. */
class Jar {
  readonly c = new Map<string, string>();
  header(): string {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  take(r: Response): string[] {
    const seen: string[] = [];
    for (const sc of r.headers.getSetCookie()) {
      const [kv, ...attrs] = sc.split(";");
      const i = kv!.indexOf("=");
      const k = kv!.slice(0, i).trim(), v = kv!.slice(i + 1);
      seen.push(k);
      if (/max-age=0/i.test(attrs.join(";")) || v === "") this.c.delete(k);
      else this.c.set(k, v);
    }
    return seen;
  }
}

async function send(
  jar: Jar,
  srv: TestServer,
  path: string,
  body?: unknown,
): Promise<{ status: number; j: Record<string, unknown> | null }> {
  const headers = new Headers({ origin: srv.url });
  if (jar.c.size) headers.set("cookie", jar.header());
  if (body !== undefined) headers.set("content-type", "application/json");
  const r = await srv.fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  jar.take(r);
  const text = await r.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch { /* not json */ }
  return { status: r.status, j };
}

const ids = new Map<TestServer, string>();
const boot = async (name: string) => {
  const appId = `ck-${name}-${crypto.randomUUID().slice(0, 6)}`;
  const srv = await testServer({
    cells: [cell(`ck_${name}`, { state: { n: 0 }, methods: {} })],
    auth: true,
    appId,
  });
  ids.set(srv, appId);
  return srv;
};

Deno.test("session cookie: two apps on one host do not log each other out or see each other's token", async () => {
  _resetAuthFails();
  await using A = await boot("a");
  await using B = await boot("b");
  const jar = new Jar();
  const cred = { id: "alice", password: "correct horse battery" };
  const a = await send(jar, A, "/__aio/auth/signup", cred);
  assertEquals(a.status, 201);
  const aToken = a.j!.token as string;
  const b = await send(jar, B, "/__aio/auth/signup", cred);
  assertEquals(b.status, 201);
  const bToken = b.j!.token as string;

  // Both still signed in, each as itself.
  assertEquals(
    ((await send(jar, A, "/__aio/auth/me")).j!.user as { id: string })?.id,
    "alice",
    "signing in to B must not sign A out",
  );
  assertEquals(
    ((await send(jar, B, "/__aio/auth/me")).j!.user as { id: string })?.id,
    "alice",
  );
  // What B is sent under B's own name is B's token, never A's.
  const bName = sessionCookieNameFor(ids.get(B));
  assertEquals(jar.c.get(bName), bToken);
  assertEquals(jar.c.get(sessionCookieNameFor(ids.get(A))), aToken);
  assert(!jar.c.has("aio_session"), "the shared legacy name is never written");

  // Logging out of B leaves A alone.
  await send(jar, B, "/__aio/auth/logout", {});
  assertEquals(
    ((await send(jar, A, "/__aio/auth/me")).j!.user as { id: string })?.id,
    "alice",
  );
  _resetAuthFails();
});

Deno.test("session cookie: a pre-upgrade `aio_session` still signs in, and another app's is never cleared", async () => {
  _resetAuthFails();
  await using A = await boot("legacy");
  const su = await send(new Jar(), A, "/__aio/auth/signup", {
    id: "bob",
    password: "correct horse battery",
  });
  const token = su.j!.token as string;

  // A browser that signed in before the upgrade holds only the legacy name.
  const old = new Jar();
  old.c.set("aio_session", token);
  assertEquals(
    ((await send(old, A, "/__aio/auth/me")).j!.user as { id: string })?.id,
    "bob",
    "a session issued under the legacy cookie name must survive the upgrade",
  );
  const shell = await A.fetch("/__aio/health", {
    headers: { cookie: `aio_session=${token}` },
  });
  await shell.body?.cancel();
  assertEquals(shell.status, 200, "…on the gated HTTP surface too");

  // A legacy value THIS app does not know is someone else's live session on
  // the same host: refused here, but never cleared.
  const other = await A.fetch("/__aio/health", {
    headers: { cookie: "aio_session=aios_belongs_to_another_app" },
  });
  await other.body?.cancel();
  assertEquals(other.status, 401);
  assert(
    !other.headers.getSetCookie().some((c) => c.startsWith("aio_session=")),
    "clearing another app's legacy cookie logs that app out",
  );

  // Logout of a legacy session ends it and retires the legacy cookie.
  const out = await A.fetch("/__aio/auth/logout", {
    method: "POST",
    headers: { cookie: `aio_session=${token}`, origin: A.url },
  });
  const cleared = out.headers.getSetCookie();
  await out.body?.cancel();
  assert(cleared.some((c) => c.startsWith("aio_session=;")), cleared.join());
  const after = await send(old, A, "/__aio/auth/me");
  assertEquals(after.j!.user, null);
  _resetAuthFails();
});
