// The app's HTTP handler on its local socket, as the REAL server builds it.
//
// `createServer({ socketPath })` serves the page, the app's `routes` and
// `/__aio/*` on `<app>.http.sock`. Dev and production serve it through the
// SAME HTTP server (`serveHttpOverLocal`); production puts the app's
// local-peer gate in front. The unit tests pin the parts — the server against
// `Deno.serve` (http-over-conn-differential), the door against the gate
// (local-peer-http). This pins the WIRING in server.ts: what an app route is
// handed on that socket, in both modes, and that the door is tied to the gate.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  createLocalPeerGate,
  type LocalPeerGate,
  requireLocalPeer,
} from "../src/server/local-peer.ts";
import { createServer } from "../src/server/server.ts";
import { processStartToken } from "../src/server/single-instance-lock.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

// Opened before any case — the sanitizer counts an FFI library per test.
requireLocalPeer();

const enc = new TextEncoder();

async function waitBound(p: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    try {
      if (Deno.lstatSync(p).isSocket) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`listener never bound ${p}`);
}

/** One raw exchange: everything the server wrote until it closed (or `ms`
 *  passed), and whether the client's own writes failed. */
async function exchange(
  path: string,
  parts: (string | Uint8Array)[],
  ms = 5000,
): Promise<{ got: string; closed: boolean; writeError: string | null }> {
  const c = await Deno.connect({ transport: "unix", path });
  let got = "", closed = false, writeError: string | null = null;
  const timer = setTimeout(() => c.close(), ms);
  const writing = (async () => {
    try {
      for (const p of parts) {
        const b = typeof p === "string" ? enc.encode(p) : p;
        for (let off = 0; off < b.length;) {
          off += await c.write(b.subarray(off));
        }
      }
    } catch (e) {
      writeError = (e as Error).name;
    }
  })();
  try {
    const b = new Uint8Array(1 << 16);
    while (true) {
      const n = await c.read(b);
      if (n === null) {
        closed = true;
        break;
      }
      got += new TextDecoder().decode(b.subarray(0, n));
    }
  } catch { /* closed by the deadline */ }
  await writing;
  clearTimeout(timer);
  try {
    c.close();
  } catch { /* already closed */ }
  return { got, closed, writeError };
}

/** What `/api/once` saw, and what it does the moment its request is over —
 *  after the answer is written, before the connection takes another. */
const once = { hits: 0, over: null as (() => void) | null };

async function withDoor(
  gated: boolean,
  f: (
    sock: string,
    gate: LocalPeerGate | null,
    shutdown: () => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const dir = await tempDir("peer-door-");
  await Deno.mkdir(join(dir, "dist"));
  await Deno.writeTextFile(join(dir, "dist", "app.js"), "export {};");
  const sock = join(dir, "app.http.sock");
  const gate = gated
    ? createLocalPeerGate({
      selfUid: Deno.uid(),
      startOf: processStartToken,
      warn: () => {},
      error: () => {},
    })
    : null;
  const server = createServer({
    port: freePort(),
    socketPath: sock,
    ...(gate ? { localPeerGate: gate } : {}),
    title: "door",
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: gated,
    distDir: join(dir, "dist"),
    routes: {
      "/api/url": (req: Request) => new Response(req.url),
      // Answers without reading whatever was uploaded.
      "/api/early": () => new Response("early", { status: 401 }),
      "/api/once": (req: Request) => {
        once.hits++;
        req.signal.addEventListener("abort", () => once.over?.());
        return new Response("once");
      },
    },
  });
  try {
    await waitBound(sock);
    await f(sock, gate, () => server.shutdown());
  } finally {
    await server.shutdown();
    await dropTempDir(dir);
  }
}

for (const gated of [false, true]) {
  const mode = gated ? "production (gated)" : "dev (ungated)";
  Deno.test({
    name:
      `http socket, ${mode}: a route sees the URL it always saw, and an unread upload does not cost it its answer`,
    ignore: Deno.build.os === "windows",
    async fn() {
      await withDoor(gated, async (sock, gate) => {
        gate?.arm(Deno.pid); // this process stands in for the window
        // FROZEN: what `Deno.serve({ path })` handed a route on this socket.
        const url = await exchange(sock, [
          "GET /api/url?q=1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        ]);
        assertStringIncludes(url.got, "HTTP/1.1 200");
        assertEquals(
          url.got.split("\r\n\r\n")[1]?.replace(/^[0-9a-f]+\r\n|\r\n0$/g, ""),
          "http+unix://localhost/api/url?q=1",
        );
        assert(url.closed);
        // The same server in both modes: a WebSocket upgrade on this door is
        // answered 501 (`Deno.serve` would hand `/ws` a whole session).
        const ws = await exchange(sock, [
          "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n" +
          "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        ]);
        assertStringIncludes(ws.got, "HTTP/1.1 501");
        // 4 MB the route never reads: the answer still arrives, whole, and
        // the upload is not cut off under the client.
        const early = await exchange(sock, [
          `POST /api/early HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${
            4 << 20
          }\r\n\r\n`,
          new Uint8Array(4 << 20),
        ]);
        assertStringIncludes(early.got, "HTTP/1.1 401");
        assertStringIncludes(early.got, "early");
        assertEquals(early.writeError, null);
      });
    },
  });
}

Deno.test({
  name:
    "http socket, production: a foreign process is refused, and the window's connections end when it exits",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withDoor(true, async (sock, gate) => {
      gate!.arm(1); // the window is some other process
      const foreign = await exchange(sock, [
        "GET /api/url HTTP/1.1\r\nHost: localhost\r\n\r\n",
      ]);
      assertStringIncludes(foreign.got, "HTTP/1.1 403");
      assertEquals(foreign.got.includes("http+unix://"), false);

      // The window holds a connection it has not used yet, then exits.
      gate!.arm(Deno.pid);
      const t0 = performance.now();
      const idle = exchange(sock, ["GET /api/url HTTP/1.1\r\nHost: "], 5000);
      await new Promise((r) => setTimeout(r, 150));
      gate!.disarm(Deno.pid);
      const r = await idle;
      assert(
        r.closed && performance.now() - t0 < 3000,
        "a connection the window opened outlived the window",
      );
      assertEquals(r.got.includes("http+unix://"), false);
    });
  },
});

// A connection that the server has ended starts nothing: a request the client
// had already sent behind the one being answered (pipelined, so it sits in
// this process's buffer) is NOT handed to the route — it would run, with its
// side effects, and could never be answered. The server is ended at the one
// moment that can go wrong: the answer is written, the next head is there.
for (
  const [how, gated] of [
    ["shutdown", false],
    ["shutdown", true],
    ["the window's exit", true],
  ] as const
) {
  Deno.test({
    name: `http socket, ${
      gated ? "production (gated)" : "dev (ungated)"
    }: after ${how} no request is started — not even one already pipelined behind the request just answered`,
    ignore: Deno.build.os === "windows",
    async fn() {
      await withDoor(gated, async (sock, gate, shutdown) => {
        gate?.arm(Deno.pid);
        once.hits = 0;
        let ended: Promise<void> | undefined;
        once.over = () => {
          once.over = null;
          ended = how === "shutdown"
            ? shutdown()
            : Promise.resolve(gate!.disarm(Deno.pid));
        };
        const get = "GET /api/once HTTP/1.1\r\nHost: localhost\r\n\r\n";
        const r = await exchange(sock, [get + get + get], 3000);
        await ended;
        assertEquals(
          { hits: once.hits, answers: r.got.split("HTTP/1.1 ").length - 1 },
          { hits: 1, answers: 1 },
        );
        assertEquals(r.closed, true, "the connection was left open");
        assert(ended, "the route's request never ended");
      });
    },
  });
}
