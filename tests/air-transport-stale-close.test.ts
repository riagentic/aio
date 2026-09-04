// A socket that is no longer THE socket has nothing to say about the
// connection.
//
// `WebSocket.close()` is asynchronous: `onclose` lands after the closing
// handshake. The 300ms listener-gap teardown closes the socket and nulls
// `_ws`; a subscriber arriving before that handshake completes calls
// `_tryConnect`, which resets `_closed` and opens ws2. Then the OLD socket's
// `onclose` arrived and treated itself as current: it nulled `_ws` (ws2's
// only handle), tore the transport down and scheduled a reconnect — ws3 —
// while ws2 was still open. Two live sockets on one page, each receiving
// every broadcast, and a patch frame applied twice inserts twice; every
// action sent meanwhile went to the offline queue because `_ws` was null.
//
// Driven through the live module with a fake WebSocket whose `close()` does
// what a real one does: nothing synchronous.
import { assert, assertEquals } from "@std/assert";

class FakeWS {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  closeCalls = 0;
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
    this.closeCalls++;
    this.readyState = 2; // CLOSING — `onclose` comes later, from the test
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("air transport: a stale socket's onclose does not tear down its successor", async () => {
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
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  try {
    await import("../src/browser/browser-air-transport.ts");
    const { client, ensureConnected } = await import(
      "../src/browser/browser-protocol.ts"
    );
    ensureConnected();
    assertEquals(FakeWS.instances.length, 1, "ws1 opened");
    const ws1 = FakeWS.instances[0]!;
    ws1.open();

    // The last listener leaves → 300ms later the client tears down: ws1 is
    // closed (asynchronously — no onclose yet) and `_ws` is nulled.
    const unsub = client.subscribe(() => {});
    unsub();
    await sleep(400);
    assertEquals(ws1.closeCalls, 1, "teardown closed ws1");
    assert(
      warns.some((w) => w.includes("teardown")),
      `the teardown announced itself: ${JSON.stringify(warns)}`,
    );

    // A listener comes back BEFORE ws1's close handshake completes → ws2.
    client.subscribe(() => {});
    assertEquals(FakeWS.instances.length, 2, "a reconnect opened ws2");
    const ws2 = FakeWS.instances[1]!;

    // …and only now does ws1's onclose land.
    ws1.onclose?.();

    ws2.open();
    client.send({ type: "probe:ping" });
    assert(
      ws2.sent.some((f) => f.includes("probe:ping")),
      `an action sent on the live socket must go out on it, not into the ` +
        `offline queue because a dead socket's onclose nulled the handle. ` +
        `ws2 sent: ${JSON.stringify(ws2.sent)}`,
    );

    // The stale close must not have scheduled a reconnect either: past the
    // longest first-retry backoff (1000ms ±20%), ws2 is still the only socket.
    await sleep(1300);
    assertEquals(
      FakeWS.instances.length,
      2,
      "no ws3 — a stale onclose schedules no reconnect over a live socket",
    );
    assertEquals(ws2.readyState, 1, "ws2 is still open");
  } finally {
    console.warn = origWarn;
    if (prevWS === undefined) delete g.WebSocket;
    else g.WebSocket = prevWS;
    if (!prevLoc) delete g.location;
  }
});
