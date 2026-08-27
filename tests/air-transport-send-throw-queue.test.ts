// A WebSocket that reports OPEN and THROWS on send must queue like any other
// unusable transport.
//
// `_send`'s catch pushed straight onto the offline queue: no `QUEUE_MAX` cap
// (a socket erroring on every write grows it without bound — the browser tab
// swells until it dies), no drop-rejection for the evicted action (its caller
// waits out the full 15s ack ceiling for a frame discarded locally and
// instantly), no `queue-drop` diagnostic and no RAM-only offline notice. The
// no-transport branch of the SAME function did all four.
//
// Driven through the live module (not a source grep): a fake WebSocket whose
// send throws, and the diagnostic bus as the observer.
import { assert } from "@std/assert";

class ThrowingWS {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static last: ThrowingWS | null = null;
  constructor(public url: string) {
    ThrowingWS.last = this;
  }
  send(_d: string) {
    throw new Error("send failed — socket is wedged");
  }
  close() {}
}

// ORDER MATTERS: the unqueued case runs first. Its report is once per
// process (a wedged socket must not turn every forwarded console line into
// two), and the queued test below prints its own RAM-only warning, which
// console interception sends down exactly this path.
// The same socket, the UNQUEUED path.
//
// `_sendRaw` carries every frame that has no queue and no ack behind it — sync
// ops, serverFn calls, forwarded console lines, `client-state` replies. Its
// whole failure handling was `catch { /* buffer full */ }`, two functions above
// the action path that carries a paragraph about why swallowing a refused write
// is wrong. A socket that reports OPEN and throws produces no `onclose`, so no
// reconnect is scheduled either: the frame is gone and nothing in the process
// ever learns it.
//
// Driven through the live module: console interception is wired to `_sendRaw`
// at import, so a `console.log` after the fake socket is open takes exactly
// that path.
Deno.test("air transport: a refused UNQUEUED write is reported, not swallowed", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWS = g.WebSocket;
  const prevLoc = g.location;
  g.WebSocket = ThrowingWS;
  if (!prevLoc) {
    g.location = {
      protocol: "http:",
      host: "localhost:1234",
      search: "",
      origin: "http://localhost:1234",
    };
  }
  const { diagSubscribe, initDiagnosticBus } = await import(
    "../src/diagnostics/diagnostic-bus.ts"
  );
  initDiagnosticBus(true);
  const seen: string[] = [];
  const unsub = diagSubscribe((e) => seen.push(e.type));
  try {
    await import("../src/browser/browser-air-transport.ts");
    const { ensureConnected } = await import(
      "../src/browser/browser-protocol.ts"
    );
    ensureConnected();
    assert(ThrowingWS.last !== null, "the transport opened a socket");
    // A forwarded console line is an unqueued raw frame.
    console.log("[test] a line the transport will refuse");
    assert(
      seen.includes("browser-air-transport:raw-send-failed"),
      `a write the socket refused on the UNQUEUED path must be reported — ` +
        `these frames are never retried, so a silent drop is the last anyone ` +
        `hears of them. Saw: ${JSON.stringify([...new Set(seen)])}`,
    );
  } finally {
    unsub();
    if (prevWS === undefined) delete g.WebSocket;
    else g.WebSocket = prevWS;
    if (!prevLoc) delete g.location;
  }
});

Deno.test("air transport: a throwing socket queues under the SAME cap and diagnostics", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWS = g.WebSocket;
  const prevLoc = g.location;
  g.WebSocket = ThrowingWS;
  if (!prevLoc) {
    g.location = {
      protocol: "http:",
      host: "localhost:1234",
      search: "",
      origin: "http://localhost:1234",
    };
  }

  const { diagSubscribe, initDiagnosticBus } = await import(
    "../src/diagnostics/diagnostic-bus.ts"
  );
  initDiagnosticBus(true);
  const seen: string[] = [];
  const unsub = diagSubscribe((e) => seen.push(e.type));

  try {
    await import("../src/browser/browser-air-transport.ts");
    const { client, ensureConnected } = await import(
      "../src/browser/browser-protocol.ts"
    );
    // Open the (fake) socket: ensureConnected → _tryConnect → _connect.
    ensureConnected();
    assert(ThrowingWS.last !== null, "the transport opened a socket");

    // 1200 writes against a socket that reports OPEN and refuses every one.
    for (let i = 0; i < 1200; i++) client.send({ type: `thr:act${i}` });

    assert(
      seen.includes("browser-air-transport:offline-queue"),
      `queueing because the socket refused the write is still queueing — the ` +
        `RAM-only notice must fire. Saw: ${JSON.stringify([...new Set(seen)])}`,
    );
    assert(
      seen.includes("browser-air-transport:queue-drop"),
      `past QUEUE_MAX (1000) the queue must trim and SAY so — an unbounded ` +
        `push on the throw path grows the tab until it dies. Saw: ${
          JSON.stringify([...new Set(seen)])
        }`,
    );
  } finally {
    unsub();
    if (prevWS === undefined) delete g.WebSocket;
    else g.WebSocket = prevWS;
    if (!prevLoc) delete g.location;
  }
});
