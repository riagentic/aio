// Login CSRF, said out loud. With no session cookie, a `/ws` handshake that
// authenticates from a `?token=` SESSION link is honored (the documented
// `sessions: true` channel) — but a link anyone can craft then decides whose
// account a signed-out browser is in. A BROWSER socket (it sends `Origin`)
// signed in that way gets (a) one server warning per app and (b) a `diag`
// frame naming the account, so the tab can show "signed in via a link as <id>".
// A cookie sign-in, a non-browser client, and a static `users:` share link stay
// silent.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LINK_WARN = "signed in from a ?token= session link";

Deno.test({
  name:
    "/ws: a ?token= session link alone warns once and tells the tab whose account",
  sanitizeOps: false, // aio-ok: a live server + sockets, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    _resetAuthFails();
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
    const port = freePort();
    const dir = await tempDir("aio-ws-sesslink-");
    const app = await aio.run({
      cells: [cell("wssesslink", { state: {}, visible: "all", methods: {} })],
      appId: `test-ws-sesslink-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      auth: true,
      users: { "share-link-token-0123456789": { id: "guest", role: "user" } },
      port,
      baseDir: dir,
    });
    const base = `http://127.0.0.1:${port}`;
    const signup = async (id: string) => {
      const r = await fetch(`${base}/__aio/auth/signup`, {
        method: "POST",
        body: JSON.stringify({ id, password: `${id}-password` }),
      });
      return {
        token: (await r.json()).token as string,
        cookie: r.headers.getSetCookie()[0]!.split(";")[0]!,
      };
    };
    /** The `diag` frames this socket was sent, plus who `proto` says it is. */
    const connect = async (
      token: string | null,
      opts: { cookie?: string; origin?: boolean } = {},
    ) => {
      const diags: Record<string, unknown>[] = [];
      let user: unknown;
      // deno-lint-ignore no-explicit-any
      const ws = new (WebSocket as any)(
        `ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ""}`,
        {
          headers: {
            ...(opts.origin === false ? {} : { origin: base }),
            ...(opts.cookie ? { cookie: opts.cookie } : {}),
          },
        },
      ) as WebSocket;
      ws.onmessage = (e) => {
        const f = JSON.parse(String(e.data));
        if (f.t === "diag") diags.push(f.d);
        if (f.t === "proto") user = f.d.user;
      };
      await new Promise((r) => {
        ws.onopen = r;
        ws.onerror = r;
      });
      await sleep(150);
      ws.close();
      await sleep(50);
      return {
        user,
        link: diags.filter((d) => d.type === "ws-session-link"),
      };
    };
    const linkWarns = () => warns.filter((w) => w.includes(LINK_WARN)).length;
    try {
      const victim = await signup("victim");
      const attacker = await signup("attacker");

      // Cookie sign-ins: silent.
      let r = await connect(null, { cookie: victim.cookie });
      assertEquals([r.user, r.link.length], ["victim", 0]);
      r = await connect(attacker.token, { cookie: victim.cookie });
      assertEquals([r.user, r.link.length], ["victim", 0], "cookie wins");
      // A static `users:` share link is a credential the URL was meant to
      // carry: silent.
      r = await connect("share-link-token-0123456789");
      assertEquals([r.user, r.link.length], ["guest", 0]);
      // Not a browser (no Origin): nobody was lured, silent.
      r = await connect(attacker.token, { origin: false });
      assertEquals([r.user, r.link.length], ["attacker", 0]);
      assertEquals(linkWarns(), 0, "nothing so far is a session link");

      // A browser socket on a URL session alone: still signed in (compat),
      // told whose account, warned once per app.
      r = await connect(attacker.token);
      assertEquals(r.user, "attacker", "compat: the link still authenticates");
      assertEquals(r.link.length, 1, "the tab is told");
      assertEquals(r.link[0]!.user, "attacker");
      assert(
        String(r.link[0]!.message).includes("signed in via a link as attacker"),
      );
      assertEquals(linkWarns(), 1);
      const w = warns.find((x) => x.includes(LINK_WARN))!;
      assert(/WARN|warn/.test(w), `levelled: ${w}`);
      assert(w.includes("sign in normally"), "names the fix");
      r = await connect(attacker.token);
      assertEquals(r.link.length, 1, "every such tab is told");
      assertEquals(linkWarns(), 1, "one warning per app");
    } finally {
      console.warn = origWarn;
      await app.close();
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "/ws: a sessions-only app (no login flow) stays silent on ?token= sessions",
  sanitizeOps: false, // aio-ok: a live server + sockets, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    _resetAuthFails();
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
    const port = freePort();
    const dir = await tempDir("aio-ws-sessonly-");
    const app = await aio.run({
      cells: [cell("wssessonly", { state: {}, visible: "all", methods: {} })],
      appId: `test-ws-sessonly-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      sessions: true,
      port,
      baseDir: dir,
    });
    try {
      // The documented channel: issue() + connect with ?token=.
      const token = app.sessions!.issue({ id: "alice", role: "user" });
      const diags: string[] = [];
      let user: unknown;
      // deno-lint-ignore no-explicit-any
      const ws = new (WebSocket as any)(
        `ws://127.0.0.1:${port}/ws?token=${token}`,
        { headers: { origin: `http://127.0.0.1:${port}` } },
      ) as WebSocket;
      ws.onmessage = (e) => {
        const f = JSON.parse(String(e.data));
        if (f.t === "diag") diags.push(f.d.type);
        if (f.t === "proto") user = f.d.user;
      };
      await new Promise((r) => {
        ws.onopen = r;
        ws.onerror = r;
      });
      await sleep(150);
      ws.close();
      await sleep(50);
      assertEquals(user, "alice", "the session link authenticates");
      assertEquals(diags.includes("ws-session-link"), false, "no tab notice");
      assertEquals(
        warns.filter((w) => w.includes(LINK_WARN)).length,
        0,
        "no warning: there is no cookie sign-in to recommend",
      );
    } finally {
      console.warn = origWarn;
      await app.close();
      await dropTempDir(dir);
    }
  },
});
