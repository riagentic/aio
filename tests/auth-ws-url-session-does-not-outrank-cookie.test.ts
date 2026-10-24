// A VALID session in the `/ws` URL must not outrank the browser's own
// sign-in cookie.
//
// The browser client builds its socket URL from the PAGE's `?token=`, and the
// handshake read the URL before the cookie. So a link
// `https://app/?token=<attacker's session>` opened by a signed-in victim gave
// the victim's socket the ATTACKER's identity: every write from that tab went
// into the attacker's account, while `/__aio/auth/me` (cookie) still named the
// victim. The cookie now wins over a URL session; a URL session on its own
// still authenticates (`sessions: true` clients connect that way).
import { assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test({
  name: "/ws: a valid ?token= session does not outrank the session cookie",
  sanitizeOps: false, // aio-ok: a live server + sockets, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    _resetAuthFails();
    const seen: (string | undefined)[] = [];
    const port = freePort();
    const dir = await tempDir("aio-ws-urlsess-");
    const app = await aio.run({
      cells: [cell("wsurlsess", { state: {}, visible: "all", methods: {} })],
      appId: `test-ws-urlsess-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      auth: true,
      port,
      baseDir: dir,
      onConnect: (u) => seen.push(u?.id),
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
    const connect = async (token: string, cookie?: string) => {
      // deno-lint-ignore no-explicit-any
      const ws = new (WebSocket as any)(
        `ws://127.0.0.1:${port}/ws?token=${token}`,
        {
          headers: { origin: base, ...(cookie ? { cookie } : {}) },
        },
      ) as WebSocket;
      await new Promise((r) => {
        ws.onopen = r;
        ws.onerror = r;
      });
      await sleep(100);
      ws.close();
      await sleep(50);
      return seen.at(-1);
    };
    try {
      const victim = await signup("victim");
      const attacker = await signup("attacker");
      assertEquals(
        await connect(attacker.token, victim.cookie),
        "victim",
        "the signed-in browser keeps its own identity on the socket",
      );
      assertEquals(
        await connect(attacker.token),
        "attacker",
        "compat: a URL session alone still authenticates the handshake",
      );
      assertEquals(
        await connect(victim.token, victim.cookie),
        "victim",
        "the same session in both places is simply that session",
      );
    } finally {
      await app.close();
      await dropTempDir(dir);
    }
  },
});
