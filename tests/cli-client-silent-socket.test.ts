// A WebSocket can go silent without a close: the network under it goes away
// and TCP says nothing for minutes. The page has judged that since 1.0.19
// (browser-vitals.ts, the silent-socket watchdog); `connectCli` only sent its
// heartbeat, so a remote CLI client's `watch()` sat on a dead socket, stale,
// until TCP gave up. It now applies the page's ceiling: a connection that has
// answered a ping before and then hears nothing for `SILENT_BEATS_DEAD`
// written heartbeats is dead, and reconnects.
import { assert, assertEquals } from "@std/assert";
import { connectCli } from "../src/server/cli-client.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { cell } from "../src/state/cell-create.ts";
import type { CellDef } from "../src/state/cell-types.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test({
  name:
    "connectCli: a socket that answered pings and then hears nothing is dead after the page's ceiling, and reconnects",
  async fn() {
    const port = freePort();
    const opened: number[] = [];
    const sockets: WebSocket[] = [];
    const started = Date.now();
    const server = Deno.serve(
      { port, hostname: "127.0.0.1", onListen: () => {} },
      (req) => {
        if (new URL(req.url).pathname !== "/ws") {
          return new Response("not here", { status: 404 });
        }
        const { socket, response } = Deno.upgradeWebSocket(req);
        sockets.push(socket);
        let pongs = 0;
        socket.onopen = () => opened.push(Date.now() - started);
        socket.onmessage = (e) => {
          const f = dec(String(e.data));
          // The first connection answers two pings, then goes silent — open,
          // never closed, as a socket over a vanished network looks.
          if (f?.t !== "vitals-ping" || (sockets.length === 1 && pongs >= 2)) {
            return;
          }
          pongs++;
          socket.send(enc("vitals-pong", { t1: (f.d as { t1: number }).t1 }));
        };
        return response;
      },
    );
    const cli = connectCli(`http://127.0.0.1:${port}`);
    cli.ready.catch(() => {});
    try {
      for (let i = 0; i < 300 && opened.length < 2; i++) await sleep(100);
      assertEquals(opened.length, 2, "the silent socket was never given up");
      // Two answered beats, then twenty silent ones at 1 s each.
      assert(opened[1]! >= 20_000, `gave up after ${opened[1]} ms`);
    } finally {
      cli.close();
      for (const s of sockets) {
        try {
          s.close();
        } catch { /* aio-ok: already closed */ }
      }
      await server.shutdown();
    }
  },
});

// A call whose own ceiling outlives the silence window (ackTimeoutMs: 0 =
// "wait for ever", or > 20 s) is the client's word that the server may be busy
// that long: a server inside a long sync method answers no ping. Judging the
// socket dead there rejected the call while the server went on to commit it.
for (const ackTimeoutMs of [0, 60_000]) {
  Deno.test({
    name:
      `connectCli: a call with ackTimeoutMs ${ackTimeoutMs} outlives a server silent past the heartbeat ceiling`,
    async fn() {
      const port = freePort();
      const sockets: WebSocket[] = [];
      const server = Deno.serve(
        { port, hostname: "127.0.0.1", onListen: () => {} },
        (req) => {
          if (new URL(req.url).pathname !== "/ws") {
            return new Response("not here", { status: 404 });
          }
          const { socket, response } = Deno.upgradeWebSocket(req);
          sockets.push(socket);
          let busy = false;
          socket.onopen = () => {
            socket.send(enc("proto", protoHello()));
            socket.send(
              enc("state", { [`slowcall${ackTimeoutMs}`]: { n: 0 } }),
            );
          };
          socket.onmessage = (e) => {
            const f = dec(String(e.data));
            if (busy) return; // inside the long method: silent
            if (f?.t === "vitals-ping") {
              socket.send(
                enc("vitals-pong", { t1: (f.d as { t1: number }).t1 }),
              );
            } else if (f?.t === "action") {
              busy = true;
              const cid = (f.d as { cid: string }).cid;
              setTimeout(() => {
                busy = false;
                socket.send(enc("ack", { cid, ok: true, value: "done" }));
              }, 23_000);
            }
          };
          return response;
        },
      );
      const slow = cell(`slowcall${ackTimeoutMs}`, {
        state: { n: 0 },
        methods: {
          go(s: { n: number }) {
            s.n++;
          },
        },
      });
      const cli = connectCli<Record<string, { n: number }>>(
        `http://127.0.0.1:${port}`,
        { readyTimeoutMs: 10_000, ackTimeoutMs },
      );
      try {
        await cli.ready;
        cli.bind(slow as unknown as CellDef);
        await sleep(2_500); // a pong or two: the rule is armed
        const value = await (slow as unknown as { go(): Promise<unknown> })
          .go();
        assertEquals(value, "done");
        assertEquals(sockets.length, 1, "the busy socket was given up");
      } finally {
        cli.close();
        for (const s of sockets) {
          try {
            s.close();
          } catch { /* aio-ok: already closed */ }
        }
        await sleep(200);
        await server.shutdown();
      }
    },
  });
}
