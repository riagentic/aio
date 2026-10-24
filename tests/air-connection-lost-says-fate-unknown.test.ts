// A call already written when its socket closes has an UNKNOWN fate: the
// server may have run it and lost only the ack. Measured on a real page (a
// server stopped mid-call, then restarted): the caller was told a bare
// "connection lost" — which reads as "it failed" and invites the retry that
// applies one intent twice. The message stays exactly "connection lost"
// (documented; apps compare it); the rejection now also carries
// `code: "CONNECTION_LOST"` — fate unknown, re-check state before retrying.
import { assertEquals, assertRejects } from "@std/assert";

class FakeWS {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e?: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

const g = globalThis as Record<string, unknown>;
g.WebSocket = FakeWS;
g.location ??= {
  protocol: "http:",
  host: "localhost:1234",
  search: "",
  origin: "http://localhost:1234",
};

await import("../src/browser/browser-air-transport.ts");
const { client, ensureConnected } = await import(
  "../src/browser/browser-protocol.ts"
);
const { _registerAck } = await import("../src/browser/browser-ack.ts");
const { _subscribe, _teardownNow } = await import(
  "../src/browser/protocol-subscription.ts"
);
const { dec, errorCode } = await import("../src/protocol/envelope.ts");

Deno.test({
  name:
    "connection lost: a call written before the close is rejected saying its fate is unknown",
  async fn() {
    const origWarn = console.warn;
    console.warn = () => {};
    const unsub = _subscribe(() => {});
    try {
      ensureConnected();
      const ws = FakeWS.instances.at(-1)!;
      ws.open();
      const cid = crypto.randomUUID();
      const p = _registerAck(cid, { deferTimer: true, methodKey: "c:inc" });
      p.catch(() => {});
      client.send({ type: "c:inc", payload: { args: [] }, cid } as {
        type: string;
      });
      assertEquals(
        ws.sent.map((f) => dec(f)?.t).filter((t) => t === "action").length,
        1,
        "the call was written",
      );
      ws.close();
      const err = await assertRejects(() => p, Error);
      assertEquals(err.message, "connection lost", "the documented message");
      assertEquals(errorCode(err), "CONNECTION_LOST");
    } finally {
      unsub();
      _teardownNow();
      console.warn = origWarn;
    }
  },
});
