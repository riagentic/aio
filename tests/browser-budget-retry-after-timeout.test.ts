// A call its caller has already been told FAILED must never be re-sent.
//
// A budget refusal (`retryAfterMs`) can reach the browser after the call's own
// ack ceiling has fired — a server whose event loop stalled reads the frame
// late, and refuses it late. The CLI client checks that the call is still
// awaited before holding it for a re-send (`_pending.isWritten(cid)`); the
// browser transport did not, so it re-sent a call whose `await` had already
// rejected, and the write could land after the app had shown the user an
// error and moved on — one intent, a rejection AND an application.
//
// A scripted server, so the late refusal is exact rather than hoped for.
import { assert, assertEquals } from "@std/assert";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { freePort } from "../src/testing/server-test.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("browser transport: a budget refusal arriving after the call timed out is not re-sent", async () => {
  const port = freePort();
  const seen = new Map<string, number>();
  const sockets: WebSocket[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      if (new URL(req.url).pathname !== "/ws") {
        return new Response("not here", { status: 404 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      sockets.push(socket);
      socket.onopen = () => socket.send(enc("proto", protoHello()));
      socket.onmessage = (e) => {
        const f = dec(String(e.data));
        if (f?.t !== "action") return;
        const cid = (f.d as { cid?: string }).cid;
        if (typeof cid !== "string") return;
        seen.set(cid, (seen.get(cid) ?? 0) + 1);
        // Refused — but only after the caller's 200 ms ceiling has fired.
        const t = setTimeout(() => {
          timers.delete(t);
          try {
            socket.send(enc("ack", {
              cid,
              ok: false,
              error: "this frame was dropped: over its budget",
              retryAfterMs: 10,
            }));
          } catch { /* closed */ }
        }, 600);
        timers.add(t);
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
  const { _registerAck, _setAckTimeoutMs } = await import(
    "../src/browser/browser-ack.ts"
  );
  const sub = await import("../src/browser/protocol-subscription.ts");
  const unsub = sub._subscribe(() => {});
  _setAckTimeoutMs(200);
  try {
    ensureConnected();
    for (let i = 0; i < 100 && sockets.length === 0; i++) await sleep(20);
    await sleep(100);
    const cid = crypto.randomUUID();
    const call = _registerAck(cid, { deferTimer: true, methodKey: "late:inc" });
    client.send({ type: "late:inc", payload: {}, cid } as { type: string });
    const outcome = await call.then(() => "resolved", (e) => String(e));
    assert(
      outcome !== "resolved",
      "precondition: the call timed out before its refusal arrived",
    );
    assertEquals(seen.get(cid), 1, "precondition: the frame was written");
    await sleep(900); // the refusal arrives at 600 ms; a re-send would follow
    assertEquals(
      seen.get(cid),
      1,
      `re-sent a call whose caller was already told: ${outcome}`,
    );
  } finally {
    _setAckTimeoutMs(8_000);
    unsub();
    for (const t of timers) clearTimeout(t);
    for (const s of sockets) {
      try {
        s.close();
      } catch { /* closed */ }
    }
    await sleep(400);
    await server.shutdown();
  }
});
