// A server restart must not throw away the calls the page queued while it was
// down.
//
// The server sends `boot {id}` on every connection, and a client that sees a
// DIFFERENT id than last time reloads the page — a new build may be behind it.
// But the reconnect that carries that frame is the same one the offline queue
// replays on: `onopen` hands every queued call to the socket's pacer, the
// pacer writes a burst and keeps the rest for later, and the `boot` frame
// arrived a moment afterwards and reloaded the page on the spot. Everything
// still paced died with the page, silently — the user clicked, saw it queue,
// saw the server come back, and the clicks were simply gone.
//
// Driven through the REAL client runtime against a REAL server behind a proxy
// that plays the restart: it goes down, comes back, and from then on stamps
// the server's `boot` frame with a new id — exactly what a restarted process
// sends. (Two in-process servers would share one cell registry.)
import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort, testServer } from "../src/testing/server-test.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const g = globalThis as Record<string, unknown>;

Deno.test("boot reload after a server restart waits until the replayed offline queue has landed", async () => {
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
  const live: WebSocket[] = [];
  const port = freePort();
  const proxy = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const u = new URL(req.url);
      if (u.pathname !== "/ws" || !up) {
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
    for (let i = 0; i < 100 && n() < N; i++) await sleep(20);
    assertEquals(
      n(),
      N,
      "every call queued while the server was down reached it before the page reloaded",
    );
  } finally {
    unsub();
    await sleep(400);
    await proxy.shutdown();
  }
});
