// Client render vitals are WIRED into the current AIR transport.
//
// From alpha48 to alpha69 `renderBudget` was accepted, validated, bridged —
// and read by nothing: the transport swap deleted the only caller of
// `createRenderMeter()`, so no client measured staleness, `vitals-ping` had
// no sender, and `/__aio/vitals` reported `clients: []` for every app. Boot
// printed a "declared, and NOT honoured yet" line. This file pins the wiring
// through the LIVE transport module with a fake socket:
//
//   • a WS open starts the heartbeat; `vitals-ping {t1, ms}` frames leave;
//   • an applied patch starts the staleness clock — `ms` reflects it;
//   • `__aioConfig.renderBudget` reaches the meter (the config-key-to-reader
//     gate for this key): a 5ms budget classifies a 20ms-stale render as
//     degraded and a diagnostic with the hint engine's line is emitted;
//   • close pauses the heartbeat, reopen resumes it, teardown destroys.
import { assert, assertEquals } from "@std/assert";
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
g.WebSocket = FakeWS;
if (!prevLoc) {
  g.location = {
    protocol: "http:",
    host: "localhost:1234",
    search: "",
    origin: "http://localhost:1234",
  };
}
// The budget an app declares — via the shell (`__aioConfig`) or the `cfg`
// frame — must be the meter's threshold. 5ms so a fake-clock tick trips it.
g.__aioConfig = { renderBudget: { staleness: 5, pendingPatches: 3 } };

await import("../src/browser/browser-air-transport.ts");
const { ensureConnected } = await import(
  "../src/browser/browser-protocol.ts"
);
const { _setVitalsHeartbeatForTest, _renderBudget } = await import(
  "../src/browser/browser-vitals.ts"
);
const sub = await import("../src/browser/protocol-subscription.ts");
const _vitalsRenderMeter = () => sub._vitalsRenderMeter;
const { diagSubscribe, initDiagnosticBus } = await import(
  "../src/diagnostics/diagnostic-bus.ts"
);
// The harness is dev-strict: the bus is open, as the dev shell opens it.
initDiagnosticBus(true);
const { dec, enc } = await import("../src/protocol/envelope.ts");

function pings(): { t1: number; ms: number }[] {
  const out: { t1: number; ms: number }[] = [];
  for (const raw of FakeWS.sent) {
    const f = dec(raw);
    if (f?.t === "vitals-ping") out.push(f.d as { t1: number; ms: number });
  }
  return out;
}

Deno.test("client vitals: WS open → heartbeat pings with staleness; budget reaches the meter; close/reopen/teardown", async () => {
  using time = new FakeTime();
  _setVitalsHeartbeatForTest(100);
  FakeWS.sent.length = 0;
  const events: { type: string; message: string; hint?: string }[] = [];
  const unsub = diagSubscribe((e) => {
    if (e.source === "browser-vitals") {
      events.push({ type: e.type, message: e.message, hint: e.hint });
    }
  });
  try {
    ensureConnected();
    const ws = FakeWS.last!;
    ws.open();
    assertEquals(pings().length, 0, "nothing before the first beat");

    // Beat 1: no patch yet — staleness 0.
    await time.tickAsync(100);
    assertEquals(pings().length, 1, "one ping per heartbeat");
    assertEquals(pings()[0]!.ms, 0);
    assertEquals(typeof pings()[0]!.t1, "number");

    // A state frame is APPLIED 20ms into the interval and nothing paints
    // before the next beat — 80ms stale against a 5ms budget.
    await time.tickAsync(20);
    ws.onmessage?.({ data: enc("state", { probe: { n: 1 } }) });
    const meter = _vitalsRenderMeter();
    assert(meter, "the meter exists once the socket opened");
    await time.tickAsync(80);
    const last = pings().at(-1)!;
    assertEquals(pings().length, 2);
    assert(
      last.ms >= 20 && last.ms <= 100,
      `ms carries the render staleness, got ${last.ms}`,
    );

    // The budget REACHED the meter: capacity is the declared 5ms, and the
    // stale render was classified against it — a diagnostic fired with the
    // hint engine's line.
    assertEquals(meter.getGauges().staleness.capacity, 5);
    assertEquals(meter.getGauges().pendingPatches.capacity, 3);
    assert(
      events.some((e) =>
        e.type === "vitals:render-stale" || e.type === "vitals:render-frozen"
      ),
      `a threshold crossing is reported on the diagnostic bus, got ${
        JSON.stringify(events)
      }`,
    );
    assert(
      events.every((e) => typeof e.hint === "string" && e.hint.length > 0),
      "every vitals diagnostic carries a hint",
    );

    // Close pauses the heartbeat; nothing leaves on a dead socket.
    const before = pings().length;
    ws.onclose?.();
    await time.tickAsync(500);
    assertEquals(pings().length, before, "no pings while closed");

    // Reconnect (the backoff timer fires under the fake clock) resumes it.
    await time.tickAsync(10_000);
    const ws2 = FakeWS.last!;
    assert(ws2 !== ws, "a new socket after the backoff");
    ws2.open();
    await time.tickAsync(250);
    assert(pings().length > before, "pings resume on the new connection");
    assert(_vitalsRenderMeter() === meter, "the meter is per page, kept");

    // Teardown — what the protocol layer runs once the last listener has
    // been gone for its 300ms grace — destroys everything.
    sub._subscribe(() => {})();
    await time.tickAsync(400);
    const after = pings().length;
    await time.tickAsync(1000);
    assertEquals(pings().length, after, "no heartbeat after teardown");
    assertEquals(_vitalsRenderMeter(), null, "meter destroyed");
    assertEquals(sub._vitalsPingTimer, null, "timer cleared");
  } finally {
    unsub();
    _setVitalsHeartbeatForTest(null);
  }
});

Deno.test("client vitals: the budget reader is the page config, and absence means defaults", () => {
  assertEquals(_renderBudget(), { staleness: 5, pendingPatches: 3 });
  const saved = g.__aioConfig;
  try {
    g.__aioConfig = {};
    assertEquals(_renderBudget(), undefined);
    g.__aioConfig = { renderBudget: "nonsense" };
    assertEquals(_renderBudget(), undefined, "a non-object budget is ignored");
  } finally {
    g.__aioConfig = saved;
  }
});

addEventListener("unload", () => {
  if (prevWS === undefined) delete g.WebSocket;
  else g.WebSocket = prevWS;
  if (!prevLoc) delete g.location;
});
