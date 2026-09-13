// The browser twin of tests/cli-client-blip-keeps-paced-calls.test.ts: frames
// still waiting on a socket's pacer when it closes were ACCEPTED, and the
// offline queue's cap must never evict them — or a blip rejects the page's
// EARLIEST calls ("offline queue full") while later ones apply.
//
// A scripted server: the first connection advertises a tiny budget so a burst
// piles up in the pacer, then drops; the second advertises a huge one and acks
// everything, so every accepted call can land.
import { assertEquals } from "@std/assert";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { freePort } from "../src/testing/server-test.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const QUEUE_MAX = 1000; // browser-air-transport.ts

Deno.test("browser transport: a blip with more paced calls than the offline cap rejects none as 'queue full'", async () => {
  const port = freePort();
  let conn = 0;
  const sockets: WebSocket[] = [];
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      if (new URL(req.url).pathname !== "/ws") {
        return new Response("not here", { status: 404 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      const n = ++conn;
      sockets.push(socket);
      socket.onopen = () =>
        socket.send(
          enc("proto", { ...protoHello(), rate: n === 1 ? 5 : 1_000_000 }),
        );
      let closing = false;
      socket.onmessage = (e) => {
        const f = dec(String(e.data));
        if (f?.t !== "action") return;
        const cid = (f.d as { cid?: string }).cid;
        if (n === 1) {
          // The blip: the first connection goes away with the burst unsent.
          if (!closing) {
            closing = true;
            setTimeout(() => socket.close(), 150);
          }
          return;
        }
        if (typeof cid === "string") socket.send(enc("ack", { cid, ok: true }));
      };
      return response;
    },
  );
  const g = globalThis as Record<string, unknown>;
  g.location = {
    protocol: "http:",
    host: `127.0.0.1:${port}`,
    search: "",
    origin: `http://127.0.0.1:${port}`,
  };
  await import("../src/browser/browser-air-transport.ts");
  const { client, ensureConnected } = await import(
    "../src/browser/browser-protocol.ts"
  );
  const { _registerAck } = await import("../src/browser/browser-ack.ts");
  const sub = await import("../src/browser/protocol-subscription.ts");
  const unsub = sub._subscribe(() => {});
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    ensureConnected();
    for (let i = 0; i < 100 && sockets.length === 0; i++) await sleep(20);
    await sleep(100);
    const N = QUEUE_MAX + 50;
    const outcome: string[] = new Array(N).fill("pending");
    const calls = Array.from({ length: N }, (_, i) => {
      const cid = crypto.randomUUID();
      const p = _registerAck(cid, { deferTimer: true, methodKey: "blip:inc" })
        .then(() => {
          outcome[i] = "ok";
        }, (e) => {
          outcome[i] = String(e instanceof Error ? e.message : e);
        });
      client.send({ type: "blip:inc", payload: {}, cid } as { type: string });
      return p;
    });
    await Promise.race([
      Promise.all(calls),
      new Promise((r) => {
        guard = setTimeout(r, 30_000);
      }),
    ]).finally(() => clearTimeout(guard));
    const full = outcome.flatMap((o, i) => /queue full/.test(o) ? [i] : []);
    assertEquals(
      full.length,
      0,
      `accepted calls evicted by the offline cap, earliest first: ${
        full.slice(0, 5)
      }…`,
    );
    const other = outcome.filter((o) =>
      o !== "ok" && !/connection lost|never confirmed/.test(o)
    );
    assertEquals(other.slice(0, 3), [], "every call applied or was in flight");
  } finally {
    clearTimeout(guard);
    unsub();
    for (const s of sockets) {
      try {
        s.close();
      } catch { /* closed */ }
    }
    await sleep(400);
    await server.shutdown();
  }
});
