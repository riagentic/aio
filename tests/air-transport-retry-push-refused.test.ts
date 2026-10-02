// A budget refusal's RE-SEND that the socket itself refuses must be queued,
// not lost.
//
// The server drops a call over its budget and names a wait (`retryAfterMs`).
// The transport takes the call out of the in-flight ledger and hands it to the
// pacer again — and a socket that reports OPEN while refusing the write threw
// out of that push, out of the message handler, AFTER the call had left the
// ledger: nothing was in flight, nothing was queued, so no disconnect ever
// rejected it and the caller's `await` hung for good.
//
// A scripted server and a WebSocket that can be told to refuse, so the throw
// lands exactly on the re-send.
import { assert, assertEquals } from "@std/assert";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { freePort } from "../src/testing/server-test.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FlakyWS extends WebSocket {
  static refuse = false;
  override send(d: Parameters<WebSocket["send"]>[0]): void {
    if (FlakyWS.refuse) throw new Error("send failed — socket is wedged");
    super.send(d);
  }
}

Deno.test("browser transport: a re-send the socket refuses is queued and lands on the next connection", async () => {
  const port = freePort();
  const seen = new Map<string, number>();
  const sockets: WebSocket[] = [];
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
        const n = (seen.get(cid) ?? 0) + 1;
        seen.set(cid, n);
        // First sight: over budget, come back now. Second: applied.
        socket.send(
          enc(
            "ack",
            n === 1
              ? { cid, ok: false, error: "over its budget", retryAfterMs: 0 }
              : { cid, ok: true },
          ),
        );
      };
      return response;
    },
  );
  const g = globalThis as Record<string, unknown>;
  const prevWS = g.WebSocket;
  g.WebSocket = FlakyWS;
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
  try {
    ensureConnected();
    for (let i = 0; i < 100 && sockets.length === 0; i++) await sleep(20);
    await sleep(100);
    const cid = crypto.randomUUID();
    const call = _registerAck(cid, { deferTimer: true, methodKey: "re:inc" });
    let outcome = "pending";
    call.then(() => outcome = "resolved", (e) => outcome = String(e));
    client.send({ type: "re:inc", payload: {}, cid } as { type: string });
    // The frame is on the wire; from here every write is refused — the next
    // one is the re-send the refusal asks for.
    FlakyWS.refuse = true;
    for (let i = 0; i < 50 && seen.get(cid) !== 1; i++) await sleep(20);
    assertEquals(seen.get(cid), 1, "precondition: the call was written once");
    await sleep(300); // refusal received, re-send attempted and refused
    FlakyWS.refuse = false;
    // The server restarts its end: the transport reconnects and flushes.
    for (const s of sockets.splice(0)) s.close();
    for (let i = 0; i < 300 && outcome === "pending"; i++) await sleep(20);
    assertEquals(
      seen.get(cid),
      2,
      "the refused re-send was lost — never queued, never written again",
    );
    assertEquals(outcome, "resolved");
  } finally {
    FlakyWS.refuse = false;
    unsub();
    sub._teardownNow();
    for (const s of sockets) {
      try {
        s.close();
      } catch { /* closed */ }
    }
    await sleep(300);
    await server.shutdown();
    if (prevWS === undefined) delete g.WebSocket;
    else g.WebSocket = prevWS;
  }
});
