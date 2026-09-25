// The DEV reload socket must not throw away calls queued offline either.
//
// A dev page runs two sockets: the bundle's transport (which since this round
// waits for its offline queue to drain before reloading on a new server boot
// id) and the pre-bundle dev reload socket from `devWsScript`. The dev socket
// still reloaded the page the moment it saw a new boot id — so in dev, a
// server restart lost every call queued while it was down, while prod kept
// them. dev == prod: the dev socket now reloads through the same drain.
//
// Same restart proxy as tests/air-boot-reload-waits-for-queue.test.ts, with
// the REAL dev socket script running beside the REAL client runtime.
import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort, testServer } from "../src/testing/server-test.ts";
import { devWsScript } from "../src/server/server-html-scripts.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const g = globalThis as Record<string, unknown>;

Deno.test("dev reload socket waits for the offline queue before reloading on a new boot id", async () => {
  const counter = cell("restart", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });
  await using srv = await testServer({ cells: [counter] });
  const n = () => (srv.state() as { restart: { n: number } }).restart.n;

  // The "restart": up, down, then up again as a process with a new boot id.
  let up = true;
  let generation = 0;
  let devSawNewBoot = false;
  const live: WebSocket[] = [];
  const port = freePort();
  const proxy = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const u = new URL(req.url);
      if (u.pathname !== "/ws" || !up) {
        return new Response("down", { status: 503 });
      }
      // The dev socket retries on a flat 2s, the transport on a growing
      // backoff — after a real restart either may reconnect first. Pin the
      // order that loses calls: the dev socket sees the new boot id first.
      const isDev = u.searchParams.has("devsock");
      if (generation === 1 && !isDev && !devSawNewBoot) {
        return new Response("down", { status: 503 });
      }
      const { socket: c, response } = Deno.upgradeWebSocket(req);
      const s = new WebSocket(`ws://${new URL(srv.url).host}/ws`);
      const gen = generation;
      const buf: string[] = [];
      s.onopen = () => {
        for (const m of buf.splice(0)) s.send(m);
      };
      c.onmessage = (e) => {
        if (reloaded) return; // the page is gone: nothing more leaves it
        s.readyState === WebSocket.OPEN ? s.send(e.data) : buf.push(e.data);
      };
      s.onmessage = (e) => {
        if (c.readyState !== WebSocket.OPEN) return;
        const f = dec(String(e.data));
        if (f?.t === "boot" && isDev && gen === 1) devSawNewBoot = true;
        c.send(
          f?.t === "boot"
            ? enc("boot", { id: `${(f.d as { id: string }).id}-${gen}` })
            : e.data,
        );
      };
      const kill = () => {
        if (c.readyState < WebSocket.CLOSING) c.close();
        if (s.readyState < WebSocket.CLOSING) s.close();
      };
      c.onclose = kill;
      s.onclose = kill;
      live.push(c);
      return response;
    },
  );

  // A reload ends the page: from that moment nothing more leaves it. What it
  // had flushed to the socket before then still reaches the server.
  let reloaded = false;
  g.location = {
    protocol: "http:",
    host: `127.0.0.1:${port}`,
    search: "",
    origin: `http://127.0.0.1:${port}`,
    reload: () => {
      reloaded = true;
    },
  };
  await import("../src/browser/browser-air-transport.ts");
  const { client, ensureConnected } = await import(
    "../src/browser/browser-protocol.ts"
  );
  const { _registerAck } = await import("../src/browser/browser-ack.ts");
  const sub = await import("../src/browser/protocol-subscription.ts");
  ensureConnected();
  // The dev socket, exactly as the dev shell inlines it. Its timers and
  // sockets are tracked so the test can stop its 2s reconnect loop.
  let devStopped = false;
  const devSockets: WebSocket[] = [];
  const devTimers: ReturnType<typeof setTimeout>[] = [];
  new Function("window", "WebSocket", "setTimeout", devWsScript())(
    globalThis,
    class extends WebSocket {
      constructor(u: string) {
        super(u + (u.includes("?") ? "&" : "?") + "devsock=1");
        devSockets.push(this);
      }
    },
    (fn: () => void, ms: number) => {
      if (!devStopped) devTimers.push(setTimeout(fn, ms));
    },
  );
  const unsub = sub._subscribe(() => {});
  try {
    for (let i = 0; i < 100 && live.length === 0; i++) await sleep(20);
    await sleep(300); // boot {id A} is in

    // Down: the socket drops and reconnects are refused.
    up = false;
    for (const c of live.splice(0)) c.close();
    await sleep(200);

    const N = 60;
    const inc = counter.__aio.actions.inc as () => { type: string };
    const calls = Array.from({ length: N }, () => {
      const cid = crypto.randomUUID();
      const p = _registerAck(cid, {
        deferTimer: true,
        methodKey: "restart:inc",
      })
        .catch(() => {}); // the reload settles nothing — only `n` is asserted
      client.send({ ...inc(), cid } as { type: string });
      return p;
    });
    assertEquals(calls.length, N);

    // Up again — a restarted process, so its boot id differs.
    assertEquals(n(), 0, "nothing landed while the server was down");
    generation = 1;
    up = true;
    for (let i = 0; i < 400 && !reloaded; i++) await sleep(25);
    assertEquals(reloaded, true, "the new boot id reloaded the page");
    assertEquals(devSawNewBoot, true, "the dev socket saw the new boot id");
    for (let i = 0; i < 100 && n() < N; i++) await sleep(20);
    assertEquals(
      n(),
      N,
      "every call queued while the server was down reached it before the page reloaded",
    );
  } finally {
    devStopped = true;
    for (const t of devTimers) clearTimeout(t);
    for (const s of devSockets) s.close();
    unsub();
    await sleep(400);
    await proxy.shutdown();
  }
});
