// On `/ws` a `?token=` that resolves to nobody gives way to the next
// credential the request carries (an app's own invite link must not mask the
// session cookie). That fallback must not become an unmetered oracle: an
// attacker holding their OWN valid Bearer could guess other users' static
// tokens in the URL for free — every wrong guess fell through to the Bearer
// and was never charged, and a right guess connected as the victim.
//
// The rule: a wrong URL token is charged even when another credential then
// succeeds. A VALID one is honored over budget, like every credential — the
// budget throttles failed authentication, never service.
import { assertEquals } from "@std/assert";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { AioUser } from "../src/server/aio-types.ts";

const UPGRADE = {
  connection: "Upgrade",
  upgrade: "websocket",
  "sec-websocket-version": "13",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
};

async function handshake(url: string, headers: Record<string, string>) {
  const r = await fetch(url, { headers: { ...headers, ...UPGRADE } });
  await r.body?.cancel();
  return r.status;
}

/** Open a real socket and return the user the server's onConnect saw. */
async function connectAs(
  url: string,
  headers: Record<string, string>,
  seen: (AioUser | undefined)[],
): Promise<string | undefined> {
  seen.length = 0;
  const ws = new WebSocket(url, { headers } as never);
  try {
    // Bounded: a refused handshake must fail this test, not hang it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("ws failed to open"));
      timer = setTimeout(() => rej(new Error("ws did not open in 3s")), 3000);
    }).finally(() => clearTimeout(timer));
    const t0 = Date.now();
    while (seen.length === 0 && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return seen[0]?.id;
  } finally {
    // A socket that never opened has no close to wait for.
    if (ws.readyState !== WebSocket.CLOSED) {
      const closed = new Promise((r) => ws.addEventListener("close", r));
      ws.close();
      await closed;
    }
  }
}

Deno.test({
  name: "/ws: URL-token guesses behind the caller's own Bearer are metered",
  fn: async () => {
    _resetAuthFails();
    const { cell, aio } = await import("../mod.ts");
    const port = freePort();
    const dir = await tempDir("aio-ws-urlmeter-");
    const seen: (AioUser | undefined)[] = [];
    const app = await aio.run({
      cells: [cell("wsurlmeter", { state: { x: 0 }, methods: {} })],
      appId: `test-ws-urlmeter-${Deno.pid}-${port}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      port,
      baseDir: dir,
      users: {
        "alice-token-1": { id: "alice", role: "user" },
        "b42": { id: "bob", role: "admin" },
      },
      onConnect: (u) => seen.push(u),
    });
    const base = `127.0.0.1:${port}`;
    const bearer = { authorization: "Bearer alice-token-1" };
    try {
      for (let i = 0; i < 100; i++) {
        await handshake(`http://${base}/ws?token=g${i}`, bearer);
      }
      // The guesses were charged: a bare wrong guess is now throttled.
      assertEquals(await handshake(`http://${base}/ws?token=zz`, {}), 429);
      // …while a VALID URL token is still served over budget.
      assertEquals(
        await connectAs(`ws://${base}/ws?token=b42`, {}, seen),
        "bob",
      );
    } finally {
      _resetAuthFails();
      await app.close();
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "/ws: an invite ?token= reloaded past the budget still connects as the cookie user",
  fn: async () => {
    _resetAuthFails();
    const { cell, aio } = await import("../mod.ts");
    const port = freePort();
    const dir = await tempDir("aio-ws-urlinvite-");
    const seen: (AioUser | undefined)[] = [];
    const app = await aio.run({
      cells: [cell("wsurlinvite", { state: { x: 0 }, methods: {} })],
      appId: `test-ws-urlinvite-${Deno.pid}-${port}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      auth: true,
      port,
      baseDir: dir,
      onConnect: (u) => seen.push(u),
    });
    const base = `127.0.0.1:${port}`;
    try {
      await app.auth!.create("alice", "password123");
      const li = await fetch(`http://${base}/__aio/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "alice", password: "password123" }),
      });
      const cookie = (li.headers.get("set-cookie") ?? "").split(";")[0]!;
      await li.body?.cancel();
      for (let i = 0; i < 20; i++) {
        assertEquals(
          await connectAs(`ws://${base}/ws?token=invite-1`, { cookie }, seen),
          "alice",
          `reload ${i}`,
        );
      }
    } finally {
      _resetAuthFails();
      await app.close();
      await dropTempDir(dir);
    }
  },
});
