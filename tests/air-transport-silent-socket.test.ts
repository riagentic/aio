// A socket that goes silent WITHOUT closing is a lost connection.
//
// Measured on an Android 15 WebView (the client APK, airplane mode): the
// page's socket stopped carrying frames and no close event came for 25–90 s —
// no "Reconnecting…", taps written into the void. The page said so only on
// the socket's close event, and nothing watched for the pongs the server
// stopped sending.
//
// The watchdog (browser-vitals.ts) takes the close path itself, on evidence:
// a connection that HAS answered a ping stops answering; then HTTP says the
// network is gone (dead now), or answers while the socket stays silent (dead
// at the next beat), or hangs — a busy server — and decides nothing until
// `SILENT_BEATS_DEAD`. Driven through the live transport with a fake socket
// that never fires `onclose` by itself, as a real one on a dead network.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";

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
    this.readyState = 2; // CLOSING — and no `onclose`: the network is gone
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
const { client, ensureConnected, _coreGetConnectedSignal } = await import(
  "../src/browser/browser-protocol.ts"
);
const { _registerAck } = await import("../src/browser/browser-ack.ts");
const { _setVitalsHeartbeatForTest, SILENT_BEATS_ASK, SILENT_BEATS_DEAD } =
  await import("../src/browser/browser-vitals.ts");
const { _subscribe, _teardownNow } = await import(
  "../src/browser/protocol-subscription.ts"
);
const { dec, enc } = await import("../src/protocol/envelope.ts");
const { protoHello } = await import("../src/protocol/protocol-version.ts");

const BEAT = 100;
const pong = (ws: FakeWS) =>
  ws.onmessage?.({
    data: enc("vitals-pong", { t1: Date.now(), t2: Date.now(), loop: null }),
  });
const actions = (ws: FakeWS) =>
  ws.sent.flatMap((raw) => {
    const f = dec(raw);
    return f?.t === "action" ? [(f.d as { type: string }).type] : [];
  });
const call = (type: string) => {
  const cid = crypto.randomUUID();
  const p = _registerAck(cid, { deferTimer: true, methodKey: type });
  p.catch(() => {}); // asserted by the test; never an unhandled rejection
  client.send({ type, payload: {}, cid } as { type: string });
  return p;
};

/** One scenario: a connected page whose socket has answered one ping, with
 *  `fetch` answering as `http` says ("down" rejects, "up" resolves, "hang"
 *  never settles). */
async function scenario(
  http: "down" | "up" | "hang",
  fn: (
    t: { time: FakeTime; ws: FakeWS; asked: () => number; warns: string[] },
  ) => Promise<void>,
  opts: { ponged?: boolean } = {},
) {
  using time = new FakeTime();
  _setVitalsHeartbeatForTest(BEAT);
  FakeWS.instances.length = 0;
  let asked = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    asked++;
    if (http === "down") {
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    if (http === "up") {
      return Promise.resolve(new Response(null, { status: 426 }));
    }
    return new Promise(() => {});
  }) as typeof fetch;
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  let unsub = () => {};
  try {
    ensureConnected(); // once per page; a subscriber connects after a teardown
    unsub = _subscribe(() => {});
    const ws = FakeWS.instances[0]!;
    ws.open();
    await time.tickAsync(BEAT); // beat 1: a ping leaves…
    if (opts.ponged !== false) pong(ws); // …and this connection answers it
    await fn({ time, ws, asked: () => asked, warns });
  } finally {
    unsub();
    _teardownNow();
    _setVitalsHeartbeatForTest(null);
    console.warn = origWarn;
    globalThis.fetch = prevFetch;
  }
}

Deno.test("silent socket: the network is gone → the close path runs; no call lost, none sent twice", async () => {
  await scenario("down", async ({ time, ws, asked, warns }) => {
    const inFlight = call("probe:written");
    assertEquals(actions(ws), ["probe:written"]);

    // SILENT_BEATS_ASK pings leave unanswered; the beat after them asks HTTP.
    await time.tickAsync(BEAT * SILENT_BEATS_ASK);
    assertEquals(asked(), 0, "not asked before the silence is long enough");
    assertEquals(ws.closeCalls, 0);
    await time.tickAsync(BEAT);
    await time.tickAsync(0); // the refusal is two promise hops away
    assertEquals(asked(), 1, "HTTP asked once");
    assertEquals(ws.closeCalls, 1, "the dead socket is closed");
    assertEquals(ws.onclose, null, "…and has nothing more to say");
    assert(
      warns.some((w) => w.includes("went silent without closing")),
      `said out loud: ${JSON.stringify(warns)}`,
    );
    // In flight → rejected exactly as on a close; never re-sent.
    await assertRejects(() => inFlight, Error, "connection lost");
    assertEquals(_coreGetConnectedSignal().peek(), false);

    // Called while down → queued, replayed once on the next connection.
    const queued = call("probe:queued");
    await time.tickAsync(1300); // past the first backoff (1000ms ±20%)
    assertEquals(FakeWS.instances.length, 2, "a reconnect was scheduled");
    const ws2 = FakeWS.instances[1]!;
    ws2.open();
    assertEquals(actions(ws2), ["probe:queued"]);
    assertEquals(
      actions(ws),
      ["probe:written"],
      "nothing more on the dead one",
    );
    const cid = (dec(ws2.sent.find((f) => f.includes("probe:queued"))!)!.d as {
      cid: string;
    }).cid;
    ws2.onmessage?.({ data: enc("ack", { cid, ok: true }) });
    await queued;
    assertEquals(asked(), 1);
  });
});

Deno.test("silent socket: HTTP answers and the socket still hears nothing → dead at the next beat", async () => {
  await scenario("up", async ({ time, ws, asked }) => {
    await time.tickAsync(BEAT * (SILENT_BEATS_ASK + 1));
    assertEquals(asked(), 1);
    assertEquals(ws.closeCalls, 0, "an answer alone closes nothing");
    await time.tickAsync(BEAT);
    assertEquals(ws.closeCalls, 1);
  });
});

Deno.test("silent socket: a frame after the HTTP answer → the socket lives", async () => {
  await scenario("up", async ({ time, ws, asked }) => {
    await time.tickAsync(BEAT * (SILENT_BEATS_ASK + 1));
    assertEquals(asked(), 1);
    pong(ws);
    await time.tickAsync(BEAT * SILENT_BEATS_ASK);
    assertEquals(ws.closeCalls, 0);
    assertEquals(FakeWS.instances.length, 1);
  });
});

Deno.test("silent socket: a busy server (HTTP hangs) is not dead — until SILENT_BEATS_DEAD", async () => {
  await scenario("hang", async ({ time, ws, asked }) => {
    await time.tickAsync(BEAT * (SILENT_BEATS_DEAD - 1));
    assertEquals(asked(), 1);
    assertEquals(ws.closeCalls, 0, "silent for seconds, still the socket");
    pong(ws); // the server comes back: the count starts over
    await time.tickAsync(BEAT * SILENT_BEATS_DEAD);
    assertEquals(ws.closeCalls, 0);
    assertEquals(FakeWS.instances.length, 1);
    await time.tickAsync(BEAT);
    assertEquals(ws.closeCalls, 1, "the ceiling: dead without more evidence");
  });
});

Deno.test("silent socket: a connection that never answered a ping is never judged", async () => {
  await scenario("down", async ({ time, ws, asked }) => {
    await time.tickAsync(BEAT * (SILENT_BEATS_DEAD + 5));
    assertEquals(asked(), 0);
    assertEquals(ws.closeCalls, 0);
    // Any other frame is life, but not proof that pings are answered.
    ws.onmessage?.({ data: enc("state", { probe: { n: 1 } }) });
    await time.tickAsync(BEAT * (SILENT_BEATS_DEAD + 5));
    assertEquals(ws.closeCalls, 0);
    assertEquals(FakeWS.instances.length, 1);
  }, { ponged: false });
});

Deno.test("silent socket: a reconnect that dies before its own first pong is still judged", async () => {
  // A flapping network: the page's server has answered pings, the socket
  // drops, the reconnect opens — and the network goes again inside the first
  // heartbeat. Measured in headless Chromium: that socket sat "connected"
  // through a 70 s black hole, every call timing out, no reconnect.
  await scenario("hang", async ({ time, ws }) => {
    ws.onclose?.();
    for (let i = 0; i < 100 && FakeWS.instances.length < 2; i++) {
      await time.tickAsync(BEAT);
    }
    const ws2 = FakeWS.instances[1]!;
    ws2.open(); // …and never answers anything
    await time.tickAsync(BEAT * (SILENT_BEATS_DEAD + 2));
    assertEquals(ws2.closeCalls, 1, "judged dead at the ceiling");
  });
});

Deno.test("silent socket: a network that flaps twice — each dead reconnect is judged", async () => {
  // Every server answers pings (vitals off sends a bare pong — server-ws.ts),
  // so the page's trust in pongs is never spent: the second flap is judged
  // like the first. A "spend it once" rule left the second reconnect
  // "connected" through the black hole for good.
  await scenario("hang", async ({ time, ws }) => {
    ws.onclose?.();
    const next = async (n: number) => {
      for (let i = 0; i < 100 && FakeWS.instances.length < n; i++) {
        await time.tickAsync(BEAT);
      }
      return FakeWS.instances[n - 1]!;
    };
    const ws2 = await next(2);
    ws2.open();
    await time.tickAsync(BEAT * (SILENT_BEATS_DEAD + 2));
    assertEquals(ws2.closeCalls, 1, "the first dead reconnect is judged");
    ws2.onclose?.();
    const ws3 = await next(3);
    ws3.open();
    await time.tickAsync(BEAT * (SILENT_BEATS_DEAD + 2));
    assertEquals(ws3.closeCalls, 1, "and so is the second");
  });
});

Deno.test("silent socket: a ping the pacer still holds is no evidence of silence", async () => {
  await scenario("down", async ({ time, ws, asked }) => {
    // A budget of one frame a second: at this test's 100 ms beat nearly every
    // ping waits in the pacer — unanswered because unasked.
    ws.onmessage?.({ data: enc("proto", { ...protoHello(), rate: 1 }) });
    const written = () => ws.sent.filter((f) => dec(f)?.t === "vitals-ping");
    const before = written().length;
    await time.tickAsync(BEAT * (SILENT_BEATS_ASK + 3));
    assert(
      written().length - before < SILENT_BEATS_ASK,
      "the scenario holds: fewer pings left than would be asked about",
    );
    assertEquals(asked(), 0);
    assertEquals(ws.closeCalls, 0);
  });
});
