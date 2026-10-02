// Child of tests/local-peer-conn-gc.test.ts — run with --v8-flags=--expose-gc.
//
// Opens N connections to the peer-credential listener (`node:net`) and ends
// each one a given way, then reports how many of the accepted sockets the
// collector could take. A socket that is not collected is held by the
// runtime's own handle table, with everything hanging off it.
//
// The sockets are seen through `net.Server`'s `connection` event — nothing in
// the listener is there for this probe.
import net from "node:net";
import { serveHttpOverLocal } from "../../../src/server/http-over-conn.ts";
import {
  listenLocal,
  type LocalConn,
} from "../../../src/server/local-listen.ts";
import { requireLocalPeer } from "../../../src/server/local-peer.ts";

const N = Number(Deno.args[0] ?? 200);
const dir = Deno.args[1]!;
const only = Deno.args[2];
const gc = (globalThis as unknown as { gc: () => void }).gc;
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
requireLocalPeer();

let accepted = 0, finalized = 0;
const fr = new FinalizationRegistry<number>(() => finalized++);
const emit = net.Server.prototype.emit;
net.Server.prototype.emit = function (name: string, ...args: unknown[]) {
  if (name === "connection") {
    accepted++;
    fr.register(args[0] as object, 0);
  }
  // deno-lint-ignore no-explicit-any
  return (emit as any).call(this, name, ...args);
};

async function bound(path: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    try {
      if (Deno.lstatSync(path).isSocket) return;
    } catch { /* not yet */ }
    await sleep(5);
  }
  throw new Error(`never bound ${path}`);
}

const big = new Uint8Array(1 << 20);
const handler = async (req: Request): Promise<Response> => {
  const p = new URL(req.url).pathname;
  if (p === "/echo") return new Response(await req.text());
  if (p === "/big") return new Response(big);
  if (p === "/drip") {
    let t: ReturnType<typeof setInterval> | undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          t = setInterval(() => c.enqueue(enc.encode("tick\n")), 5);
        },
        cancel() {
          clearInterval(t);
        },
      }),
    );
  }
  return new Response("hello");
};

type Client = (c: Deno.Conn) => Promise<void>;
const G = "GET /hello HTTP/1.1\r\nHost: x\r\n\r\n";
const send = (c: Deno.Conn, s: string) => c.write(enc.encode(s));
const readUntil = async (c: Deno.Conn, what: string) => {
  const b = new Uint8Array(65536);
  let got = "";
  while (!got.includes(what)) {
    const n = await c.read(b);
    if (n === null) break;
    got += new TextDecoder().decode(b.subarray(0, n));
  }
};

/** How a connection ends: [name, the peer is refused, what the client does]. */
const HTTP: [string, boolean, Client][] = [
  ["connect and leave", false, async () => {}],
  ["half a head and leave", false, (c) => send(c, "GET /hel").then(() => {})],
  ["request, answer, client closes", false, async (c) => {
    await send(c, G);
    await readUntil(c, "hello");
  }],
  ["five requests, client closes", false, async (c) => {
    for (let i = 0; i < 5; i++) {
      await send(c, G);
      await readUntil(c, "hello");
    }
  }],
  ["Connection: close — the server ends it", false, async (c) => {
    await send(
      c,
      "GET /hello HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    while ((await c.read(new Uint8Array(4096))) !== null) { /* to its end */ }
  }],
  ["left mid-body", false, async (c) => {
    await send(
      c,
      "POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nabc",
    );
  }],
  ["left mid-response (a stream)", false, async (c) => {
    await send(c, "GET /drip HTTP/1.1\r\nHost: x\r\n\r\n");
    await readUntil(c, "tick");
  }],
  ["left before reading 1 MB — the write fails", false, async (c) => {
    await send(c, "GET /big HTTP/1.1\r\nHost: x\r\n\r\n");
  }],
  ["half-closed after the request", false, async (c) => {
    await send(c, G);
    await (c as Deno.UnixConn).closeWrite();
    while ((await c.read(new Uint8Array(4096))) !== null) { /* to its end */ }
  }],
  ["garbage — 400", false, async (c) => {
    await send(c, "NOT HTTP\r\n\r\n");
    await readUntil(c, "\r\n\r\n");
  }],
  ["silent until the head deadline — 408", false, async (c) => {
    await readUntil(c, "\r\n\r\n");
  }],
  ["refused: request, reads the 403", true, async (c) => {
    await send(c, G);
    await readUntil(c, "Forbidden");
  }],
  ["refused: connect and leave", true, async () => {}],
  [
    "refused: half a head and leave",
    true,
    (c) => send(c, "GET /hel").then(() => {}),
  ],
];

const results: Record<
  string,
  { n: number; kept: number; heapPerConn: number }
> = {};

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await sleep(60);
    gc();
  }
}

async function measure(
  name: string,
  run: () => Promise<void>,
): Promise<void> {
  if (only && !name.includes(only)) return;
  await settle();
  const a0 = accepted, f0 = finalized, h0 = Deno.memoryUsage().heapUsed;
  await run();
  await settle();
  const n = accepted - a0;
  results[name] = {
    n,
    kept: n - (finalized - f0),
    heapPerConn: Math.round((Deno.memoryUsage().heapUsed - h0) / n),
  };
}

let seq = 0;
for (const [name, refused, client] of HTTP) {
  await measure(name, async () => {
    const path = `${dir}/h${seq++}.sock`;
    const server = serveHttpOverLocal(
      listenLocal(path, { peer: true }),
      handler,
      refused ? () => "this probe refuses everyone" : undefined,
      { headDeadlineMs: 150, refusedHeadMs: 150 },
    );
    await bound(path);
    for (let i = 0; i < N; i += 20) {
      await Promise.all(Array.from({ length: 20 }, async () => {
        const c = await Deno.connect({ transport: "unix", path });
        await client(c).catch(() => {});
        c.close();
      }));
    }
    await sleep(300);
    await server.close();
  });
}

// The server ends them: `close()` and `dropConnections()` with connections
// idle, kept alive, and mid-request.
for (const how of ["close()", "dropConnections()"] as const) {
  await measure(`ended by the server's ${how}`, async () => {
    const path = `${dir}/s${seq++}.sock`;
    const server = serveHttpOverLocal(
      listenLocal(path, { peer: true }),
      handler,
      undefined,
      { closeDrainMs: 100 },
    );
    await bound(path);
    const clients: Deno.Conn[] = [];
    for (let i = 0; i < N; i++) {
      const c = await Deno.connect({ transport: "unix", path });
      clients.push(c);
      if (i % 3 === 1) {
        await send(c, G);
        await readUntil(c, "hello");
      } else if (i % 3 === 2) {
        await send(c, "GET /drip HTTP/1.1\r\nHost: x\r\n\r\n");
      }
    }
    await sleep(100);
    if (how === "dropConnections()") server.dropConnections();
    await server.close();
    for (const c of clients) c.close();
  });
}

// The state socket's way: the connection is read and written through its
// STREAMS, and closed when the peer's end is seen.
for (const drained of [false, true]) {
  await measure(
    `read as streams, ${drained ? "drained then closed" : "closed"} at EOF`,
    async () => {
      const path = `${dir}/u${seq++}.sock`;
      const listener = listenLocal(path, { peer: true });
      const serve = async (conn: LocalConn) => {
        const w = conn.writable.getWriter();
        await w.write(enc.encode('{"hello":1}\n')).catch(() => {});
        const r = conn.readable.getReader();
        try {
          while (!(await r.read()).done) { /* frames */ }
        } catch { /* reset */ }
        if (drained) await conn.drain?.().catch(() => {});
        conn.close();
      };
      const loop = (async () => {
        for await (const conn of listener) void serve(conn);
      })();
      await bound(path);
      for (let i = 0; i < N; i += 20) {
        await Promise.all(Array.from({ length: 20 }, async (_, k) => {
          const c = await Deno.connect({ transport: "unix", path });
          if (k % 2 === 0) await send(c, '{"t":"x"}\n');
          await c.read(new Uint8Array(64));
          c.close();
        }));
      }
      await sleep(300);
      listener.close();
      await loop;
    },
  );
}

console.log("RESULT " + JSON.stringify(results));
Deno.exit(0);
