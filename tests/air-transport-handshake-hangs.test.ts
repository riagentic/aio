// A WebSocket handshake that never answers must not stop the reconnect loop.
//
// Measured in headless Chromium behind a fault-injecting proxy: the network
// dropped while the page was mid-reconnect, so the upgrade's TCP connection
// was accepted and then black-holed. A browser puts no bound on a handshake —
// the socket stayed CONNECTING, no `onclose` ever came, and the page said
// "Reconnecting…" for minutes after the network was back without making a
// second attempt; every call made meanwhile stayed pending. The signed-out
// probe the close path runs (a plain GET) had the same hole.
//
// Driven through the live transport with a fake socket that never opens and
// never closes by itself, and a `fetch` that never answers.
import { assert, assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";

class FakeWS {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWS[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send() {
    if (this.readyState !== 1) throw new Error("not open");
  }
  close() {
    this.readyState = 2; // and no `onclose`: the network is gone
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
const { ensureConnected } = await import("../src/browser/browser-protocol.ts");
const { _subscribe, _teardownNow } = await import(
  "../src/browser/protocol-subscription.ts"
);
const { BACKOFF_MAX_MS, WS_OPEN_TIMEOUT_MS } = await import(
  "../src/protocol/transport-shared.ts"
);

/** Past the open bound, the abort's promise hops, and the longest backoff. */
const ATTEMPT = WS_OPEN_TIMEOUT_MS + BACKOFF_MAX_MS * 1.2 + 100;

Deno.test("handshake that never answers: the next attempt comes, bounded — first connect and reconnect alike", async () => {
  using time = new FakeTime();
  FakeWS.instances.length = 0;
  const prevFetch = globalThis.fetch;
  // A black hole: never answers, gives up only when aborted.
  globalThis.fetch =
    ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
        )
      )) as typeof fetch;
  const origWarn = console.warn;
  console.warn = () => {};
  let unsub = () => {};
  try {
    ensureConnected();
    unsub = _subscribe(() => {});
    assertEquals(FakeWS.instances.length, 1);

    // First connect hangs → a second attempt, bounded.
    for (let i = 0; i < 10 && FakeWS.instances.length < 2; i++) {
      await time.tickAsync(ATTEMPT / 10);
    }
    assertEquals(FakeWS.instances.length, 2, "a hung first handshake retried");

    // Connected, then the network drops: the reconnect's handshake hangs AND
    // the signed-out probe it runs hangs — still bounded.
    FakeWS.instances[1]!.open();
    FakeWS.instances[1]!.onclose?.();
    for (let i = 0; i < 20 && FakeWS.instances.length < 3; i++) {
      await time.tickAsync(ATTEMPT / 10);
    }
    assertEquals(FakeWS.instances.length, 3, "reconnect attempted");
    for (let i = 0; i < 30 && FakeWS.instances.length < 4; i++) {
      await time.tickAsync(ATTEMPT / 10);
    }
    assertEquals(
      FakeWS.instances.length,
      4,
      "a hung reconnect handshake (and a hung probe) retried",
    );
    assert(FakeWS.instances.length < 6, "no runaway loop");
  } finally {
    unsub();
    _teardownNow();
    console.warn = origWarn;
    globalThis.fetch = prevFetch;
  }
});
