// A protocol version gap is TERMINAL: the two sides cannot read each other's
// frames and no reconnect can change what either side is running.
//
// `_protoMismatch` stopped the retry loop with `_closed = true` — and
// `_tryConnect` reset that flag for every new subscriber (`client.subscribe`,
// `_waitForState`). Each one re-opened a socket the server refused again, and
// each refusal re-ran the mismatch: the queue emptied and every pending call
// was rejected once per subscriber, for a page whose only remedy is a reload.
// Meanwhile an action dispatched after the gap went into the offline queue —
// which nothing will ever flush — with a promise that never settled.
import { assert, assertEquals } from "@std/assert";
import { enc } from "../src/protocol/envelope.ts";

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
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(d);
  }
  close() {
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("air transport: a protocol mismatch is terminal — no subscriber reopens it", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWS = g.WebSocket;
  const prevLoc = g.location;
  g.WebSocket = FakeWS;
  if (!prevLoc) {
    g.location = {
      protocol: "http:",
      host: "localhost:1234",
      search: "",
      origin: "http://localhost:1234",
    };
  }
  const warns: string[] = [];
  const origWarn = console.warn;
  const origErr = console.error;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  console.error = () => {};
  try {
    await import("../src/browser/browser-air-transport.ts");
    const { client, ensureConnected, _waitForState } = await import(
      "../src/browser/browser-protocol.ts"
    );
    const { _registerAck, _pendingAckCount } = await import(
      "../src/browser/browser-ack.ts"
    );
    ensureConnected();
    const ws1 = FakeWS.instances[0]!;
    ws1.open();

    // A call in flight when the gap is diagnosed.
    let rejections = 0;
    const inflight = _registerAck("c1", { methodKey: "x:y" });
    inflight.catch(() => rejections++);
    client.send({ type: "x:y", cid: "c1" } as { type: string });
    assert(ws1.sent.some((f) => f.includes("c1")), "c1 went out on ws1");

    // The server refuses our version.
    ws1.onmessage?.({ data: enc("proto-err", { reason: "client too old" }) });
    ws1.onclose?.(); // the close it asked for lands
    await sleep(5);
    assertEquals(rejections, 1, "the in-flight call rejected");
    assertEquals(_pendingAckCount(), 0);

    // Subscribers arrive — the paths that used to reset `_closed`.
    const unsub = client.subscribe(() => {});
    void _waitForState();
    await sleep(1300); // past the longest first-retry backoff
    assertEquals(
      FakeWS.instances.length,
      1,
      "no socket is reopened after a terminal mismatch",
    );
    assertEquals(rejections, 1, "…and nothing rejected the call a second time");
    assertEquals(
      warns.filter((w) => w.includes("discarded")).length <= 1,
      true,
      `the queue is dropped at most once: ${JSON.stringify(warns)}`,
    );

    // A call made AFTER the gap fails now, by name — not a silent queue.
    let lateErr: Error | null = null;
    const late = _registerAck("c2", { methodKey: "x:y", deferTimer: true });
    late.catch((e) => (lateErr = e));
    client.send({ type: "x:y", cid: "c2" } as { type: string });
    await sleep(5);
    assert(lateErr !== null, "a post-mismatch call rejects immediately");
    assert(
      String((lateErr as unknown as Error).message).includes("mismatch"),
      `…naming the cause: ${(lateErr as unknown as Error).message}`,
    );
    assertEquals(_pendingAckCount(), 0, "nothing is left waiting forever");
    unsub();
  } finally {
    console.warn = origWarn;
    console.error = origErr;
    if (prevWS === undefined) delete g.WebSocket;
    else g.WebSocket = prevWS;
    if (!prevLoc) delete g.location;
  }
});
