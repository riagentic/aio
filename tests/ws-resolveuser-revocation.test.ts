// A socket opened with a `resolveUser` token stops receiving state once the
// app stops accepting that token.
//
// Only session-store tokens were re-checked on live sockets, on the stated
// grounds that "nothing can revoke" a `users:`/`resolveUser` token. An API key
// is deleted from its table; a JWT expires. Measured before the fix: after the
// hook began returning null for `key-1`, HTTP answered 401 for it while the
// socket it opened stayed OPEN and took every later `forUser` private frame.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";

type S = { n: number; secret: string };

Deno.test("ws: a revoked resolveUser token's socket is closed; a still-valid one stays", async () => {
  _resetAuthFails();
  const vault = cell("rv_vault", {
    state: { n: 0, secret: "" },
    visible: {
      forUser: (s: S, u: unknown) => u ? s : { n: s.n, secret: "" },
    },
    access: true,
    methods: {
      bump(s: S) {
        s.n++;
        s.secret = "PRIVATE-" + s.n;
      },
    },
  });
  const revoked = new Set<string>();
  await using srv = await testServer({
    cells: [vault],
    resolveUser: (tok: string) =>
      tok.startsWith("key-") && !revoked.has(tok)
        ? { id: tok, role: "user" }
        : null,
  });
  const open = async (tok: string) => {
    const frames: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?token=${tok}`);
    let closed: number | null = null;
    const closedP = new Promise<void>((r) =>
      ws.onclose = (e) => {
        closed = e.code;
        r();
      }
    );
    ws.onmessage = (e) => frames.push(String(e.data));
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    return { ws, frames, closedP, closed: () => closed };
  };
  const one = await open("key-1");
  const two = await open("key-2");
  try {
    await vault.bump();
    revoked.add("key-1");
    const http = await srv.fetch("/__aio/health", {
      headers: { authorization: "Bearer key-1" },
    });
    await http.body?.cancel();
    assertEquals(http.status, 401, "the key is dead for HTTP");

    // One sweep period (5s) plus slack.
    const deadline = Date.now() + 8_000;
    while (one.closed() === null && Date.now() < deadline) {
      await vault.bump();
      await new Promise((r) => setTimeout(r, 250));
    }
    assertEquals(
      one.closed(),
      1008,
      "a socket whose resolveUser token was revoked must be closed",
    );
    const mark = two.frames.length;
    await vault.bump();
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(two.closed(), null, "a still-accepted token keeps its socket");
    assert(
      two.frames.slice(mark).some((f) => f.includes("PRIVATE-")),
      "…and keeps receiving its state",
    );
  } finally {
    one.ws.close();
    two.ws.close();
    // The fallback timer is cleared either way: when the sockets close first
    // it is otherwise still pending at test end, and the leak sanitizer fails
    // the test — only under load, where the close outruns the second.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([one.closedP, two.closedP]),
      new Promise((r) => timer = setTimeout(r, 1000)),
    ]);
    clearTimeout(timer);
    _resetAuthFails();
  }
});
