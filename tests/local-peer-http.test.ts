// The app's OTHER local door — the HTTP handler on a socket — behind the same
// gate as the NDJSON socket.
//
// `<app>.http.sock` (and its Windows `-http` pipe twin) serves the page, the
// app's own `routes` and `/__aio/*`. It was a plain `Deno.serve({ path })`:
// no connection to ask "who is this", so a foreign process of the same user
// was served everything the socket beside it refused — the WebSocket upgrade
// included, which is a whole session. Under the lockdown it is served by
// `serveHttpOverLocal` over a peer-credential listener, and every connection
// is put to the app's ONE gate before the handler sees its request.
//
// Proven here over a real unix listener with the kernel's own answer; the
// pipe twin takes the same `refusal` argument (not run here — Windows).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import net from "node:net";
import { serveHttpOverLocal } from "../src/server/http-over-conn.ts";
import { listenLocal } from "../src/server/local-listen.ts";
import {
  createLocalPeerGate,
  requireLocalPeer,
} from "../src/server/local-peer.ts";
import { processStartToken } from "../src/server/single-instance-lock.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

// Opened before any case — the sanitizer counts an FFI library per test.
requireLocalPeer();

async function waitBound(p: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    try {
      if (Deno.lstatSync(p).isSocket) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`listener never bound ${p}`);
}

/** One raw request (it says `Connection: close`); everything the server wrote
 *  until it closed. */
async function request(path: string, head: string): Promise<string> {
  const c = await Deno.connect({ transport: "unix", path });
  let out = "";
  const timer = setTimeout(() => c.close(), 5000);
  try {
    await c.write(
      new TextEncoder().encode(head + "\r\nConnection: close\r\n\r\n"),
    );
    const b = new Uint8Array(1 << 16);
    while (true) {
      const n = await c.read(b);
      if (n === null) break;
      out += new TextDecoder().decode(b.subarray(0, n));
    }
  } catch { /* closed by the deadline */ }
  clearTimeout(timer);
  try {
    c.close();
  } catch { /* already closed */ }
  return out;
}

function setup(
  dir: string,
  opts: { headDeadlineMs?: number; refusedHeadMs?: number } = {},
) {
  const said: string[] = [];
  const gate = createLocalPeerGate({
    selfUid: Deno.uid(),
    startOf: processStartToken,
    warn: (m) => said.push(m),
    error: (m) => said.push(m),
  });
  const seen: string[] = [];
  const sock = `${dir}/app.http.sock`;
  const server = serveHttpOverLocal(
    listenLocal(sock, { peer: true }),
    (req) => {
      seen.push(new URL(req.url).pathname);
      return new Response("PAGE-BODY");
    },
    (conn) => gate.refusal(conn, sock),
    opts,
  );
  // As server.ts wires it: the window's connections end with the window.
  gate.onDisarm(() => server.dropConnections());
  return { gate, said, seen, sock, server };
}

Deno.test({
  name:
    "http door: a foreign process is answered 403 and the handler never sees its request",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("peer-http-");
    const { gate, said, seen, sock, server } = setup(dir);
    try {
      await waitBound(sock);
      // Unarmed: nobody is the window yet.
      const early = await request(sock, "GET / HTTP/1.1\r\nHost: app");
      assertStringIncludes(early, "HTTP/1.1 403");
      // Armed to another process: this one is foreign.
      gate.arm(1);
      for (
        const head of [
          "GET / HTTP/1.1\r\nHost: app",
          "GET /api/hello HTTP/1.1\r\nHost: app",
          "POST /api/hello HTTP/1.1\r\nHost: app\r\nContent-Length: 0",
          "GET /__aio/health HTTP/1.1\r\nHost: app",
          "GET /ws HTTP/1.1\r\nHost: app\r\nUpgrade: websocket\r\n" +
          "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ]
      ) {
        const res = await request(sock, head);
        assertStringIncludes(res, "HTTP/1.1 403", head);
        assertStringIncludes(res, "local-peer lockdown");
        assertEquals(res.includes("PAGE-BODY"), false);
      }
      assertEquals(
        seen,
        [],
        "the handler ran for a process that is not the window",
      );
      assert(
        said.some((m) => m.includes(sock) && m.includes(`pid ${Deno.pid}`)),
        `the refusal was not logged with its door and reason: ${said}`,
      );
    } finally {
      await server.close();
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "http door: the armed window is served; an Upgrade is refused by name",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("peer-http-");
    const { gate, seen, sock, server } = setup(dir);
    try {
      await waitBound(sock);
      gate.arm(Deno.pid); // this process stands in for the window
      const page = await request(sock, "GET /page HTTP/1.1\r\nHost: app");
      assertStringIncludes(page, "HTTP/1.1 200");
      assertStringIncludes(page, "PAGE-BODY");
      assertEquals(seen, ["/page"]);
      // This server answers one request and closes — it cannot switch
      // protocols, and says so instead of handing the request to a handler
      // whose upgrade attempt would throw.
      const ws = await request(
        sock,
        "GET /ws HTTP/1.1\r\nHost: app\r\nUpgrade: websocket\r\n" +
          "Connection: Upgrade",
      );
      assertStringIncludes(ws, "HTTP/1.1 501");
      assertEquals(seen, ["/page"], "an upgrade request reached the handler");
      // The window is gone: its pid is nobody's.
      gate.disarm(Deno.pid);
      assertStringIncludes(
        await request(sock, "GET /page HTTP/1.1\r\nHost: app"),
        "HTTP/1.1 403",
      );
    } finally {
      await server.close();
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "http door: a window that goes away mid-stream cancels the route's body",
  ignore: Deno.build.os === "windows",
  async fn() {
    // Under the lockdown this server replaces `Deno.serve` for the app's
    // routes on every OS, so it owes a streaming route what `Deno.serve`
    // gives it: the stream's `cancel` when the client is gone.
    const dir = await tempDir("peer-http-");
    const sock = `${dir}/app.http.sock`;
    let cancelled!: () => void;
    const wasCancelled = new Promise<void>((r) => cancelled = r);
    let tick: ReturnType<typeof setInterval> | undefined;
    const server = serveHttpOverLocal(
      listenLocal(sock, { peer: true }),
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              tick = setInterval(
                () => ctrl.enqueue(new TextEncoder().encode("data: x\n\n")),
                20,
              );
            },
            cancel() {
              clearInterval(tick);
              cancelled();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    try {
      await waitBound(sock);
      const c = await Deno.connect({ transport: "unix", path: sock });
      await c.write(
        new TextEncoder().encode("GET /events HTTP/1.1\r\nHost: app\r\n\r\n"),
      );
      await c.read(new Uint8Array(4096)); // the stream is flowing…
      c.close(); // …and the window is gone.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ok = await Promise.race([
        wasCancelled.then(() => true),
        new Promise<false>((r) => timer = setTimeout(() => r(false), 5000)),
      ]);
      clearTimeout(timer);
      assert(ok, "the route's stream was never cancelled — it runs forever");
    } finally {
      clearInterval(tick);
      await server.close();
      await dropTempDir(dir);
    }
  },
});

/** Open a connection, write `bytes` (maybe none), and read until the server
 *  closes it or `ms` pass. `closedAfter` is null when it was still open. */
async function hold(
  path: string,
  bytes: string,
  ms: number,
): Promise<
  {
    got: string;
    closedAfter: number | null;
    answeredAfter: number | null;
    /** `performance.now()` at the close — for a test that must compare it
     *  with ITS OWN event (a disarm). `closedAfter` counts from after the
     *  connect resolved, which a loaded machine delays: a cut made on time
     *  then reads as "closed before the disarm". */
    closedAt: number | null;
  }
> {
  const c = await Deno.connect({ transport: "unix", path });
  const t0 = performance.now();
  let closedAfter: number | null = null;
  let closedAt: number | null = null;
  let answeredAfter: number | null = null;
  let got = "";
  const timer = setTimeout(() => c.close(), ms);
  try {
    if (bytes) await c.write(new TextEncoder().encode(bytes));
    const b = new Uint8Array(1 << 16);
    while (true) {
      const n = await c.read(b);
      if (n === null) {
        closedAt = performance.now();
        closedAfter = closedAt - t0;
        break;
      }
      answeredAfter ??= performance.now() - t0;
      got += new TextDecoder().decode(b.subarray(0, n));
    }
  } catch { /* closed by the deadline: still open on the server's side */ }
  clearTimeout(timer);
  try {
    c.close();
  } catch { /* already closed */ }
  return { got, closedAfter, answeredAfter, closedAt };
}

Deno.test({
  name:
    "http door: the gate is asked at ACCEPT — a foreign process that never finishes its request is logged, told 403 and closed",
  ignore: Deno.build.os === "windows",
  async fn() {
    // A peer that connects and never completes a request head used to be
    // held for as long as it liked, unlogged: the gate was only asked once a
    // whole head had arrived. 20,000 of them cost the app half a gigabyte.
    const dir = await tempDir("peer-http-");
    const { gate, said, seen, sock, server } = setup(dir, {
      refusedHeadMs: 200,
    });
    try {
      await waitBound(sock);
      gate.arm(1);
      for (const partial of ["", "GET / HTTP/1.1\r\nHost: app\r\nX-Slow: "]) {
        said.length = 0;
        const c = await Deno.connect({ transport: "unix", path: sock });
        if (partial) await c.write(new TextEncoder().encode(partial));
        // Logged while the connection is still open and its head unfinished.
        for (let i = 0; i < 100 && said.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        c.close();
        assert(
          said.some((m) => m.includes(sock) && m.includes(`pid ${Deno.pid}`)),
          `no refusal was logged before a request head arrived: ${said}`,
        );
        gate.arm(1 + said.length); // a new reason, so the next one logs too
      }
      // Never a head: told, and closed, within the bound — not held.
      for (const partial of ["GET / HTTP/1.1\r\nHost: app\r\nX-Slow: ", "G"]) {
        const r = await hold(sock, partial, 5000);
        assertStringIncludes(r.got, "HTTP/1.1 403", partial);
        assertStringIncludes(r.got, "local-peer lockdown");
        assert(
          r.closedAfter !== null && r.closedAfter < 4000,
          `a refused peer was held open: ${JSON.stringify(r)}`,
        );
      }
      // What a refused peer sent is not looked at: bytes that are no request
      // at all — a session frame, a head written with bare LFs, which a
      // SERVED connection is answered 400 for at once — get the same 403 at
      // the same moment as silence does. Nothing about the answer, or its
      // timing, tells a foreign process how its bytes were read.
      const blind = [];
      for (
        const noise of [
          '{"v":2,"t":"proto","d":{"v":3}}\n{"v":2,"t":"resync","d":{}}\n',
          "GET / HTTP/1.1\nHost: app\n\n",
        ]
      ) {
        const r = await hold(sock, noise, 5000);
        blind.push({
          status: r.got.slice(0, 12),
          notBeforeTheBound: r.answeredAfter !== null && r.answeredAfter >= 190,
        });
      }
      assertEquals(blind, [
        { status: "HTTP/1.1 403", notBeforeTheBound: true },
        { status: "HTTP/1.1 403", notBeforeTheBound: true },
      ]);
      // An oversized head is refused like any other — never parsed.
      const big = await hold(
        sock,
        "GET / HTTP/1.1\r\nX: " + "a".repeat(200_000) + "\r\n\r\n",
        5000,
      );
      assertStringIncludes(big.got, "HTTP/1.1 403");
      assertEquals(seen, []);
    } finally {
      await server.close();
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "http door: every connection has a head deadline — the window's own included",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("peer-http-");
    const { gate, seen, sock, server } = setup(dir, { headDeadlineMs: 300 });
    try {
      await waitBound(sock);
      gate.arm(Deno.pid);
      const r = await hold(sock, "GET /page HTTP/1.1\r\nHost: app\r\n", 5000);
      assertStringIncludes(r.got, "HTTP/1.1 408");
      assert(r.closedAfter !== null, "the connection was left open");
      assertEquals(seen, []);
      // A request that arrives in time is not touched by it.
      assertStringIncludes(
        await request(sock, "GET /page HTTP/1.1\r\nHost: app"),
        "PAGE-BODY",
      );
    } finally {
      await server.close();
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "http door: when the window exits, the connections it was trusted for are closed",
  ignore: Deno.build.os === "windows",
  async fn() {
    // Refusing NEW connections is half of a disarm: one accepted while the
    // window lived stays open for whoever holds its descriptor — a child the
    // window forked — until it is closed from this side.
    const dir = await tempDir("peer-http-");
    const { gate, sock, server } = setup(dir);
    try {
      await waitBound(sock);
      gate.arm(Deno.pid);
      // A connection the window opened and has not used yet.
      const idle = hold(sock, "GET /page HTTP/1.1\r\nHost: app\r\n", 5000);
      await new Promise((r) => setTimeout(r, 100));
      // A late exit of some OTHER process changes nothing…
      gate.disarm(1);
      await new Promise((r) => setTimeout(r, 100));
      // …the window's own closes it.
      const disarmedAt = performance.now();
      gate.disarm(Deno.pid);
      const r = await idle;
      assert(
        r.closedAt !== null && r.closedAt >= disarmedAt &&
          r.closedAt - disarmedAt < 3000,
        `the window's open connection outlived it: ${JSON.stringify(r)}`,
      );
      assertEquals(r.got.includes("PAGE-BODY"), false);
    } finally {
      await server.close();
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "http door: when the window exits, a request STILL being answered is cut — a stream mid-flight, a handler still working",
  ignore: Deno.build.os === "windows",
  async fn() {
    // The connection with no request yet is the easy half. One whose answer
    // is under way is the one a forked child would go on reading.
    const dir = await tempDir("peer-http-");
    const sock = `${dir}/app.http.sock`;
    const gate = createLocalPeerGate({
      selfUid: Deno.uid(),
      startOf: processStartToken,
      warn: () => {},
      error: () => {},
    });
    const told: string[] = [];
    const server = serveHttpOverLocal(
      listenLocal(sock, { peer: true }),
      async (req) => {
        if (new URL(req.url).pathname === "/wait") {
          await new Promise((r) => req.signal.addEventListener("abort", r));
          told.push("handler aborted");
          return new Response("LATE-BODY");
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(new TextEncoder().encode("data: 1\n\n"));
            },
            cancel() {
              told.push("stream cancelled");
            },
          }),
        );
      },
      (conn) => gate.refusal(conn, sock),
    );
    gate.onDisarm(() => server.dropConnections());
    try {
      await waitBound(sock);
      gate.arm(Deno.pid);
      const stream = hold(sock, "GET /sse HTTP/1.1\r\nHost: app\r\n\r\n", 5000);
      const wait = hold(sock, "GET /wait HTTP/1.1\r\nHost: app\r\n\r\n", 5000);
      await new Promise((r) => setTimeout(r, 200));
      const disarmedAt = performance.now();
      gate.disarm(Deno.pid);
      const [s, w] = await Promise.all([stream, wait]);
      for (const r of [s, w]) {
        // Measured from the disarm itself, not from a connect a loaded
        // machine may have finished late.
        assert(
          r.closedAt !== null && r.closedAt >= disarmedAt &&
            r.closedAt - disarmedAt < 3000,
          `a request in flight outlived the window: ${JSON.stringify(r)}`,
        );
      }
      assertStringIncludes(s.got, "data: 1");
      assertEquals(w.got.includes("LATE-BODY"), false);
      assertEquals(told.sort(), ["handler aborted", "stream cancelled"]);
    } finally {
      await server.close();
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "http door: a gate that throws has allowed no one — refused, and said",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("peer-http-");
    const sock = `${dir}/app.http.sock`;
    let ran = false;
    const server = serveHttpOverLocal(
      listenLocal(sock, { peer: true }),
      () => {
        ran = true;
        return new Response("PAGE-BODY");
      },
      () => {
        throw new Error("gate broke");
      },
    );
    try {
      await waitBound(sock);
      const res = await request(sock, "GET / HTTP/1.1\r\nHost: app");
      assertStringIncludes(res, "HTTP/1.1 403");
      assertStringIncludes(res, "could not be checked");
      assertEquals(ran, false, "a failed gate let the request through");
    } finally {
      await server.close();
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "peer listener: close() wakes an accept loop parked on an empty queue",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("peer-http-");
    const { sock, server } = setup(dir);
    try {
      await waitBound(sock);
      // No connection ever arrives. `close()` awaits the accept loop's end;
      // the loop used to wait for a connection that could no longer come.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const closed = await Promise.race([
        server.close().then(() => true),
        new Promise<false>((r) => timer = setTimeout(() => r(false), 3000)),
      ]);
      clearTimeout(timer);
      assert(closed, "close() never resolved — the accept loop was not woken");
    } finally {
      await dropTempDir(dir);
    }
  },
});

for (const peer of [false, true]) {
  Deno.test({
    name: `local connection (${
      peer ? "peer-credential" : "plain"
    } listener), read raw: never more than the buffer holds, nothing lost or reordered, null at the end`,
    ignore: Deno.build.os === "windows",
    async fn() {
      const dir = await tempDir("peer-http-");
      const sock = `${dir}/raw.sock`;
      const listener = listenLocal(sock, peer ? { peer: true } : undefined);
      try {
        await waitBound(sock);
        const accepted = (async () => {
          for await (const c of listener) return c;
          throw new Error("no connection");
        })();
        const client = await Deno.connect({ transport: "unix", path: sock });
        const conn = await accepted;
        const sent = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
        await client.write(sent);
        client.close();
        // A buffer far smaller than what has arrived: what does not fit one
        // read is there for the next.
        const got: number[] = [];
        const into = new Uint8Array(64);
        let reads = 0;
        while (true) {
          const n = await conn.read!(into);
          if (n === null) break;
          assert(n > 0 && n <= into.length, `a read of ${n} bytes`);
          got.push(...into.subarray(0, n));
          reads++;
        }
        assertEquals(got, [...sent]);
        assert(reads >= 16, `${reads} reads for 1000 bytes, 64 at a time`);
        assertEquals(await conn.read!(into), null);
        conn.close();
      } finally {
        listener.close();
        await dropTempDir(dir);
      }
    },
  });
}

for (const peer of [false, true]) {
  Deno.test({
    name: `local listener (${
      peer ? "peer-credential" : "plain"
    }): a process this one spawns inherits neither the listening socket nor an accepted connection`,
    // Read from `/proc`: Linux. (macOS has the same fix and no `/proc`.)
    ignore: Deno.build.os !== "linux",
    async fn() {
      /** The sockets a process holds, by inode. */
      const sockets = (pid: number | "self"): string[] => {
        const out: string[] = [];
        for (const e of Deno.readDirSync(`/proc/${pid}/fd`)) {
          try {
            const link = Deno.readLinkSync(`/proc/${pid}/fd/${e.name}`);
            if (link.startsWith("socket:")) out.push(link);
          } catch { /* the descriptor used to list the directory itself */ }
        }
        return out;
      };
      const dir = await tempDir("peer-http-");
      const sock = `${dir}/inherit.sock`;
      const before = new Set(sockets("self"));
      const listener = listenLocal(sock, peer ? { peer: true } : undefined);
      let child: Deno.ChildProcess | undefined;
      try {
        // (Not `for await … return`: leaving that loop closes the listener.)
        const accepted = listener[Symbol.asyncIterator]().next();
        await waitBound(sock);
        const client = await Deno.connect({ transport: "unix", path: sock });
        const conn = (await accepted).value!;
        // The listener, the accepted connection and this test's own client.
        const mine = sockets("self").filter((s) => !before.has(s));
        assertEquals(mine.length, 3, mine.join(" "));
        child = new Deno.Command("sleep", {
          args: ["30"],
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).spawn();
        // `sleep` has been exec'd once its own name is on its command line.
        for (let i = 0; i < 300; i++) {
          const cmd = Deno.readTextFileSync(`/proc/${child.pid}/cmdline`);
          if (cmd.split("\0")[0]!.endsWith("sleep")) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        const held = sockets(child.pid).filter((s) => mine.includes(s));
        assertEquals(held, [], "the child holds this process's sockets");
        client.close();
        conn.close();
      } finally {
        if (child) {
          child.kill();
          await child.status;
        }
        listener.close();
        await dropTempDir(dir);
      }
    },
  });
}

Deno.test({
  name:
    "local listener (peer-credential): bound, but with no descriptor to keep from child processes — it is not handed out",
  ignore: Deno.build.os === "windows",
  async fn() {
    // The descriptor is read from the runtime's own `_handle.fd`. A runtime
    // that moved it would bring the inherited listener back with nothing
    // said — so "nothing to mark" is a failed bind, not a skipped step.
    // Seam: every server's handle is shown without its `fd`.
    const real = Symbol("handle");
    const proto = net.Server.prototype as unknown as Record<symbol, unknown>;
    Object.defineProperty(proto, "_handle", {
      configurable: true,
      get(this: Record<symbol, object | null>) {
        const h = this[real];
        return h && new Proxy(h, {
          get(t, k) {
            if (k === "fd") return undefined;
            const v = Reflect.get(t, k, t);
            return typeof v === "function" ? v.bind(t) : v;
          },
        });
      },
      set(this: Record<symbol, unknown>, h: unknown) {
        this[real] = h;
      },
    });
    const dir = await tempDir("peer-http-");
    const sock = `${dir}/nofd.sock`;
    const listener = listenLocal(sock, { peer: true });
    try {
      let settled = false;
      let err: Error | null = null;
      void listener[Symbol.asyncIterator]().next().then(
        () => settled = true,
        (e) => {
          err = e as Error;
          settled = true;
        },
      );
      // (A listener that WAS handed out is given a connection to accept, so
      // that failure is an assertion below and not a test that never ends.)
      for (let i = 0; i < 300 && !settled; i++) {
        await Deno.connect({ transport: "unix", path: sock })
          .then((c) => c.close(), () => {/* not bound: yet, or any more */});
        if (!settled) await new Promise((r) => setTimeout(r, 10));
      }
      assertStringIncludes(
        `${(err as Error | null)?.message}`,
        "could not be kept from child processes — the runtime gives no " +
          "descriptor for it",
      );
      // …and nothing is left listening behind the refusal.
      const reached = await Deno.connect({ transport: "unix", path: sock })
        .then((c) => (c.close(), true), () => false);
      assertEquals(reached, false, "a listener nobody was given still accepts");
    } finally {
      delete (proto as Record<string, unknown>)._handle;
      listener.close();
      await dropTempDir(dir);
    }
  },
});
