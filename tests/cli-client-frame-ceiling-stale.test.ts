// A connectCli client that MISSED a full state never presents a state that
// never existed.
//
// A full-state frame over a Deno peer's 64 MiB ceiling is refused by the
// server, which tells the peer (`ws-frame-ceiling`) and keeps the socket open.
// The client used to print that line and carry on: still `connected`, still
// holding its OLD copy, and applying every later patch to it — the server's
// blob was 70 MB with n=2, the client showed `blob.len=0 n=2`, a state that
// never existed on any server. Now the refusal drops the copy (`state` reads
// null, `connected` false — the socket is open but carries no state), later
// patches are not applied to a base the client does not have, and it asks
// for a resync, so a state that fits again is taken as soon as there is one.
import { assert, assertEquals } from "@std/assert";
import { connectCli } from "../src/server/cli-client.ts";
import { freePort } from "../src/testing/server-test.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = (t: string, d?: unknown) => JSON.stringify({ v: 2, t, d });

Deno.test("cli client: after a refused full state it is out of sync — never a stale copy with new patches", async () => {
  const port = freePort();
  let peer: WebSocket | null = null;
  const received: string[] = [];
  /** Whether the app's state fits one message again. */
  let fits = false;
  const listener = Deno.serve({ port, onListen() {} }, (req) => {
    // Anything but the socket (the client's identity probe) is not served.
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response(null, { status: 404 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => {
      peer = socket;
      socket.send(frame("proto", { v: 2, ver: "test" }));
      socket.send(frame("state", { big: { blob: "", n: 0 } }));
    };
    socket.onmessage = (e) => {
      const t = JSON.parse(String(e.data)).t as string;
      received.push(t);
      // Still too big: refused again (the server says so once per socket).
      if (t === "resync" && fits) {
        socket.send(frame("state", { big: { blob: "small", n: 3 } }));
      }
    };
    socket.onerror = () => {};
    return response;
  });
  const errors: string[] = [];
  const prevLogger = getLogger();
  setLogger({
    // deno-lint-ignore no-explicit-any
    pub: (lvl: string, _cat: string, msg: string) => {
      if (lvl === "error") errors.push(msg);
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  const app = connectCli<{ big: { blob: string; n: number } }>(
    `ws://127.0.0.1:${port}`,
  );
  try {
    await app.ready;
    assertEquals(app.state, { big: { blob: "", n: 0 } });
    assert(app.connected);
    // The server grew the state past the ceiling: the full state was refused
    // and the peer TOLD — exactly what server-ws writes in its place.
    peer!.send(frame("diag", {
      type: "ws-frame-ceiling",
      severity: "error",
      source: "server-ws",
      message: "ws: a state frame of 70.0 MB is over the 64.0 MB ceiling",
      ts: Date.now(),
    }));
    // …and later changes arrive as patches against the state it never got.
    peer!.send(
      frame("patches", [{ op: "replace", path: ["big", "n"], value: 1 }]),
    );
    peer!.send(
      frame("patches", [{ op: "replace", path: ["big", "n"], value: 2 }]),
    );
    await sleep(300);
    assert(
      app.state === null || app.state.big.n !== 2 || app.state.big.blob !== "",
      `a state that never existed: ${JSON.stringify(app.state)}`,
    );
    assertEquals(app.state, null, "a copy the server no longer has");
    assertEquals(app.connected, false, "connected, with no current state");
    assert(
      errors.some((e) => e.includes("out of sync")),
      `said loudly: ${errors.join(" | ")}`,
    );
    // It asks for the state again…
    assert(received.includes("resync"), `no resync asked: ${received}`);
    // …on every change, and takes it once it fits: the shrink is a PATCH
    // (small against the state it replaced) — a client that waited for a
    // full state to come by itself would wait forever.
    fits = true;
    peer!.send(
      frame("patches", [{ op: "replace", path: ["big", "blob"], value: "s" }]),
    );
    for (let i = 0; i < 50 && app.state === null; i++) await sleep(100);
    assertEquals(app.state, { big: { blob: "small", n: 3 } });
    assert(app.connected);
  } finally {
    setLogger(prevLogger);
    app.close();
    await listener.shutdown();
  }
});

// The same contract on the REAL server, twice: the ceiling diagnostic used to
// be sent on a socket's FIRST refusal only (`refused++ === 0`), so a client
// that recovered (the state shrank) and then went over again was never told —
// it stayed `connected` and patched its small copy: `{len:1,n:7}` against a
// server at 70 MB, n=7. Told once per EPISODE now.
Deno.test({
  name:
    "cli client: a second trip over the frame ceiling on a real server is told again — out of sync, not a stale copy",
  sanitizeOps: false, // aio-ok: libraryMode app — closed below
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const { aio, cell } = await import("../mod.ts");
    const { dropTempDir, tempDir } = await import(
      "../src/testing/temp-dir.ts"
    );
    const dir = await tempDir("ceiling-twice-");
    type S = { blob: string; n: number };
    const big = cell("big", {
      state: { blob: "", n: 0 },
      methods: {
        grow(s: S) {
          s.blob = "x".repeat(70 * 1024 * 1024);
          s.n++;
        },
        shrink(s: S) {
          s.blob = "s";
          s.n++;
        },
        bump(s: S) {
          s.n++;
        },
      },
    });
    const port = freePort();
    const app = await aio.run({
      cells: [big],
      appId: "ceiling-twice",
      appDir: dir,
      client: "server-only",
      libraryMode: true,
      singleton: false,
      persist: false,
      port,
    } as never) as unknown as {
      close(): Promise<void>;
      getState(): { big: S };
    };
    const prevLogger = getLogger();
    setLogger({ pub: () => {} } as never);
    const cli = connectCli<{ big: S }>(`ws://127.0.0.1:${port}`);
    const act = async (type: string) => {
      const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-aio": "1" },
        body: JSON.stringify({ type }),
      });
      await r.body?.cancel();
      await sleep(2_000);
    };
    /** Never a state the server does not have: either in sync, or saying so. */
    const honest = (step: string) => {
      const srv = app.getState().big;
      const mine = cli.state?.big;
      if (mine) {
        assert(cli.connected, `${step}: a state, but not connected`);
        assertEquals(
          [mine.blob.length, mine.n],
          [srv.blob.length, srv.n],
          `${step}: a state that never existed`,
        );
      } else assertEquals(cli.connected, false, `${step}: null, "connected"`);
      return mine ? "in sync" : "out of sync";
    };
    try {
      await cli.ready;
      const seen = [];
      for (
        const t of [
          "big:grow",
          "big:bump",
          "big:shrink",
          "big:grow",
          "big:bump",
          "big:bump",
          "big:shrink",
        ]
      ) {
        await act(t);
        seen.push(`${t} → ${honest(t)}`);
      }
      assertEquals(seen, [
        "big:grow → out of sync",
        "big:bump → out of sync",
        "big:shrink → in sync",
        "big:grow → out of sync",
        "big:bump → out of sync",
        "big:bump → out of sync",
        "big:shrink → in sync",
      ]);
    } finally {
      setLogger(prevLogger);
      cli.close();
      await app.close();
      await dropTempDir(dir);
    }
  },
});
