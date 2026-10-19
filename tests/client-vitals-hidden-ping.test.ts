// The page tells the server it is hidden: a `visibilitychange` sends a beat at
// once, and every ping of a hidden page carries `h: 1`, so the server stops
// grading a throttled background tab as frozen (vitals-hidden-tab-not-frozen
// pins the server half). Fake socket, fake document, fake clock.
import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";

class FakeWS {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static last: FakeWS | null = null;
  static sent: string[] = [];
  constructor(public url: string) {
    FakeWS.last = this;
  }
  send(d: string) {
    FakeWS.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

const g = globalThis as Record<string, unknown>;
const prevWS = g.WebSocket;
const prevLoc = g.location;
const prevDoc = g.document;
g.WebSocket = FakeWS;
if (!prevLoc) {
  g.location = {
    protocol: "http:",
    host: "localhost:1234",
    search: "",
    origin: "http://localhost:1234",
  };
}
const doc = new EventTarget() as EventTarget & { hidden: boolean };
doc.hidden = false;
g.document = doc;

await import("../src/browser/browser-air-transport.ts");
const { ensureConnected } = await import(
  "../src/browser/browser-protocol.ts"
);
const { _setVitalsHeartbeatForTest } = await import(
  "../src/browser/browser-vitals.ts"
);
const sub = await import("../src/browser/protocol-subscription.ts");
const { dec } = await import("../src/protocol/envelope.ts");

const pings = () =>
  FakeWS.sent.map((r) => dec(r)).filter((f) => f?.t === "vitals-ping").map(
    (f) => f!.d as { t1: number; h?: number },
  );

Deno.test("client vitals: hidden → an immediate ping with h:1; visible → one without", async () => {
  using time = new FakeTime();
  _setVitalsHeartbeatForTest(1000);
  FakeWS.sent.length = 0;
  try {
    ensureConnected();
    FakeWS.last!.open();
    await time.tickAsync(1000);
    assertEquals(pings().length, 1);
    assertEquals(pings()[0]!.h, undefined, "a visible page sends no h");

    doc.hidden = true;
    doc.dispatchEvent(new Event("visibilitychange"));
    assertEquals(pings().length, 2, "hiding sends a beat at once");
    assertEquals(pings()[1]!.h, 1);
    await time.tickAsync(1000);
    assertEquals(pings()[2]!.h, 1, "every hidden beat says so");

    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    assertEquals(pings().length, 4, "showing sends a beat at once");
    assertEquals(pings()[3]!.h, undefined);

    // A dead socket: a visibility flip writes nothing.
    FakeWS.last!.readyState = 3;
    const n = pings().length;
    doc.dispatchEvent(new Event("visibilitychange"));
    assertEquals(pings().length, n, "no beat while closed");
  } finally {
    sub._subscribe(() => {})();
    await time.tickAsync(400);
    _setVitalsHeartbeatForTest(null);
  }
});

addEventListener("unload", () => {
  if (prevWS === undefined) delete g.WebSocket;
  else g.WebSocket = prevWS;
  if (!prevLoc) delete g.location;
  if (prevDoc === undefined) delete g.document;
  else g.document = prevDoc;
});
