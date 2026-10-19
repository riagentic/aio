// The dev reload socket's handshake must be bounded.
//
// Measured in headless Chromium behind a fault-injecting proxy: the network
// dropped while the dev socket was reconnecting, so its upgrade was accepted
// and then black-holed — it stayed CONNECTING forever. Chromium opens ONE
// WebSocket handshake per host at a time, so every later socket to the app,
// the bundle's own transport included, queued behind it: after the network
// came back the page said "Reconnecting…" for good and its calls stayed
// pending. Bounded like the transport's (WS_OPEN_TIMEOUT_MS), the stuck
// attempt is dropped and retried.
import { assert, assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { devWsScript } from "../src/server/server-html-scripts.ts";
import { WS_OPEN_TIMEOUT_MS } from "../src/protocol/transport-shared.ts";

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  close() {
    this.closeCalls++;
    this.readyState = 2; // and no `onclose`: the network is gone
  }
}

Deno.test("dev reload socket: a handshake that never answers is dropped and retried", async () => {
  using time = new FakeTime();
  const g = globalThis as Record<string, unknown>;
  const prev = { location: g.location, window: g.window };
  g.location = {
    protocol: "http:",
    host: "localhost:1234",
    search: "",
    origin: "http://localhost:1234",
  };
  g.window = globalThis;
  const origDebug = console.debug;
  console.debug = () => {};
  try {
    new Function("WebSocket", devWsScript())(FakeWS);
    assertEquals(FakeWS.instances.length, 1);
    await time.tickAsync(WS_OPEN_TIMEOUT_MS + 1);
    assertEquals(
      FakeWS.instances[0]!.closeCalls,
      1,
      "the stuck attempt let go",
    );
    await time.tickAsync(2_100);
    assertEquals(FakeWS.instances.length, 2, "…and retried");
    // An attempt that opens is never cut.
    const ws = FakeWS.instances[1]!;
    ws.readyState = 1;
    ws.onopen?.();
    await time.tickAsync(WS_OPEN_TIMEOUT_MS * 2);
    assertEquals(ws.closeCalls, 0);
    assert(FakeWS.instances.length === 2, "no runaway loop");
  } finally {
    console.debug = origDebug;
    g.location = prev.location;
    g.window = prev.window;
  }
});
