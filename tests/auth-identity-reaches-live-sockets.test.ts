// An identity change must reach an ALREADY-OPEN socket, not wait for the
// 5-second sweep.
//
// The WS manager subscribed through `authFlows.sessions.onRevoked`, and
// `authFlows` is only built when a user store AND a session store both exist
// — that is, under `auth: true`. Two halves were missing:
//
//   • `aio.run({ sessions: true })` — the config `sessions.ts`'s own header
//     documents, issue and revoke yourself — subscribed to NOTHING. Measured:
//     a revoked token's socket stayed open 4.8s and took ten more frames of
//     that user's private state with it, while the same token was already
//     dead over HTTP.
//   • A ROLE change emitted nothing at all, under EITHER config. Measured:
//     ten frames of admin-only state to a demoted user's open tab — and
//     unlike revocation, nothing ever closes that socket. Three docstrings
//     and `docs/auth/auth.md` all said a role change "lands here too".
//
// Both now go through ONE seam (`onIdentityChange`) that the boot wires to
// every source it has: the session store's revocations and the user store's
// row changes.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Open a socket and count the private-state frames it receives. */
function watch(port: number, token: string) {
  const frames: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  ws.onmessage = (e) => frames.push(String(e.data));
  const open = new Promise<boolean>((res) => {
    // Cleared on the path that wins. Left running it outlives the test, and
    // the run fails with a leak report about the harness rather than about
    // anything this test asserts — which is what it did in the file this was
    // copied from. Passing today is timing luck: the guard happens to fire
    // before the suite finishes, and stops doing so the day the test speeds
    // up.
    const bail = setTimeout(() => res(false), 5000);
    const settle = (v: boolean) => {
      clearTimeout(bail);
      res(v);
    };
    ws.onopen = () => settle(true);
    ws.onerror = () => settle(false);
  });
  let closedAt = 0;
  ws.onclose = () => closedAt = Date.now();
  return { ws, frames, open, closedAt: () => closedAt };
}

Deno.test({
  name:
    "sessions:true (no auth:true) — a revoked token's socket stops immediately",
  sanitizeOps: false, // aio-ok: a live server + socket, both closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const vault = cell("vault", {
      state: { n: 0, secret: "" },
      visible: { forUser: (s, u) => u ? s : { n: s.n, secret: "" } },
      methods: {
        bump(s: { n: number; secret: string }) {
          s.n++;
          s.secret = "PRIVATE-FIXTURE";
        },
      },
    });
    const port = freePort();
    const dir = await tempDir("aio-ident-sess");
    const app = await aio.run({
      cells: [vault],
      appId: `ident-sess-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      sessions: true,
      baseDir: dir,
      port,
    });
    try {
      // deno-lint-ignore no-explicit-any
      const sessions = (app as any).sessions;
      const token = sessions.issue({ id: "alice", role: "user" });
      const w = watch(port, token);
      assert(await w.open, "the socket opened with a live token");
      await vault.bump();
      await sleep(150);
      const mark = w.frames.length;

      const revokedAt = Date.now();
      sessions.revoke(token);
      // Well inside the 5s sweep, and long enough for several broadcasts.
      for (let i = 0; i < 4; i++) {
        await vault.bump();
        await sleep(120);
      }
      await sleep(200);

      const leaked = w.frames.slice(mark).filter((f) =>
        f.includes("PRIVATE-FIXTURE")
      );
      assertEquals(
        leaked.length,
        0,
        `a revoked session kept receiving private state for ` +
          `${Date.now() - revokedAt}ms — ${leaked.length} frame(s). ` +
          `Nothing was subscribed to revocation under \`sessions: true\`.`,
      );
      try {
        w.ws.close();
      } catch { /* aio-ok: already closed by the server, which is the point */ }
    } finally {
      await app.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "auth:true — a DEMOTED user's open socket stops getting admin state",
  sanitizeOps: false, // aio-ok: a live server + socket, both closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const payroll = cell("payroll", {
      state: { n: 0, admin: "" },
      visible: {
        forUser: (s, u) => u?.role === "admin" ? s : { n: s.n, admin: "" },
      },
      methods: {
        bump(s: { n: number; admin: string }) {
          s.n++;
          s.admin = "ADMIN-ONLY-FIXTURE";
        },
      },
    });
    const port = freePort();
    const dir = await tempDir("aio-ident-role");
    const app = await aio.run({
      cells: [payroll],
      appId: `ident-role-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      auth: true,
      baseDir: dir,
      port,
    });
    try {
      // Sign up over HTTP, the way a real client gets a token — a token minted
      // straight from the session store carries a role the users row does not
      // know about, which is not the shape this is about.
      const signup = await fetch(
        `http://127.0.0.1:${port}/__aio/auth/signup`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "carol", password: "password123" }),
        },
      );
      const { token } = await signup.json() as { token: string };
      // deno-lint-ignore no-explicit-any
      const authApi = (app as any).auth;
      assertEquals(authApi.setRole("carol", "admin"), true, "carol promoted");
      const w = watch(port, token);
      assert(await w.open, "carol's socket opened as an admin");
      await payroll.bump();
      await sleep(150);
      assert(
        w.frames.some((f) => f.includes("ADMIN-ONLY-FIXTURE")),
        "…and an admin really did receive the admin-only field",
      );
      const mark = w.frames.length;

      assertEquals(authApi.setRole("carol", "user"), true, "carol is demoted");
      for (let i = 0; i < 4; i++) {
        await payroll.bump();
        await sleep(120);
      }
      await sleep(200);

      const leaked = w.frames.slice(mark).filter((f) =>
        f.includes("ADMIN-ONLY-FIXTURE")
      );
      assertEquals(
        leaked.length,
        0,
        `a demoted user's OPEN socket kept receiving admin-only state — ` +
          `${leaked.length} frame(s). HTTP honours the demotion at once; ` +
          `nothing told the socket.`,
      );
      try {
        w.ws.close();
      } catch { /* aio-ok: the server may have closed it, which is fine */ }
    } finally {
      await app.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
