// Vitals instruments held against a known truth. Each case is one instrument
// that answered a question WRONGLY — not crashed, not missed an edge: printed a
// plausible number or label that an operator would act on.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { createVitalsSystem } from "../src/vitals/mod.ts";
import { createServerDiagReporter } from "../src/vitals/diag-reporter.ts";
import { formatDiagEvent } from "../src/vitals/diag-formatter.ts";
import { createTransportProbeClient } from "../src/vitals/transport-probe.ts";
import { evaluateHints } from "../src/vitals/hints.ts";
import {
  DEFAULT_THRESHOLDS,
  type DiagEvent,
  type VitalAlert,
  type VitalsSnapshot,
} from "../src/vitals/types.ts";

Deno.test("vitals: a frozen heartbeat client drives the transport snapshot even when an ungraded socket has a larger gap", () => {
  using time = new FakeTime(1_000_000);
  const alerts: VitalAlert[] = [];
  const vs = createVitalsSystem({
    pressure: false,
    onVitalAlert: (a) => alerts.push(a),
  });
  try {
    // A socket that never speaks the heartbeat protocol (a CLI client, the dev
    // reload socket): registered, never graded, its gap grows forever.
    vs.serverTransport.onClientConnected("cli-no-heartbeat");
    time.tick(500);
    // A browser tab that heartbeats once, then goes silent.
    vs.serverTransport.onClientConnected("tab");
    vs.serverTransport.onClientPing("tab");
    time.tick(DEFAULT_THRESHOLDS.transport.frozen + 100);
    vs.checkAndAlert();

    const frozen = alerts.filter((a) =>
      a.layer === "transport" && a.status === "frozen"
    );
    assertEquals(frozen.length, 1);
    // Rule 3 — the rule written for exactly this alert. With the ungraded
    // socket speaking for the layer, the snapshot said transport "healthy"
    // and every client-freeze alert went out with `hint: null`.
    assert(frozen[0]!.hint, "transport-stall hint must fire");
    assertStringIncludes(frozen[0]!.hint!.cause, "Network connection stalled");
    assertStringIncludes(frozen[0]!.hint!.cause, "2100ms");
  } finally {
    vs.destroy();
  }
});

function alert(
  status: VitalAlert["status"],
  measured: number,
): VitalAlert {
  return {
    id: "x",
    layer: "transport",
    status,
    duration: measured,
    measured,
    threshold: 2000,
    hint: null,
    ts: 1,
  };
}

const LOOP = {
  status: "healthy",
  queueDepth: 0,
  drainRate: 0,
  lastReduceTime: 0,
  lastReduceAction: "",
  lastReduceCell: "",
  p95ReduceTime: 0,
  effectBacklog: 0,
  circuitBreakers: [],
  firstDegradedAt: null,
};

Deno.test("vitals: a client's recovery is reported as a recovery while another client is still frozen", () => {
  const events: DiagEvent[] = [];
  let clients = [
    { id: "a", status: "frozen", frozenFor: 2500 },
    { id: "b", status: "healthy" },
  ];
  const r = createServerDiagReporter({
    onDiagnostic: (e) => events.push(e),
    onConsole: () => {},
    getLoopSnapshot: () => LOOP,
    getTransportSnapshot: () => ({ clients }),
  });
  r.onAlert(alert("frozen", 2500));
  // b froze and came back; a is still frozen. Every freeze fires its own
  // alert (vitals/mod.ts onClientFrozen), so b's is sent too.
  clients = [
    { id: "a", status: "frozen", frozenFor: 4000 },
    { id: "b", status: "frozen", frozenFor: 2100 },
  ];
  r.onAlert(alert("frozen", 2100));
  clients = [
    { id: "a", status: "frozen", frozenFor: 9000 },
    { id: "b", status: "recovered" },
  ];
  r.onAlert(alert("recovered", 0));
  assertEquals(events.map((e) => e.kind), [
    "disconnect",
    "disconnect",
    "recovered",
  ]);
  // …and then a comes back too: its own recovery, not swallowed as a repeat.
  clients = [
    { id: "a", status: "recovered" },
    { id: "b", status: "healthy" },
  ];
  r.onAlert(alert("recovered", 0));
  assertEquals(events.map((e) => e.kind), [
    "disconnect",
    "disconnect",
    "recovered",
    "recovered",
  ]);
});

Deno.test("vitals: a disconnect reports the gap of the client that froze, not of whichever frozen client is listed first", () => {
  const events: DiagEvent[] = [];
  const r = createServerDiagReporter({
    onDiagnostic: (e) => events.push(e),
    onConsole: () => {},
    getLoopSnapshot: () => LOOP,
    // `a` has been frozen for a minute; `b` has just crossed the threshold.
    getTransportSnapshot: () => ({
      clients: [
        { id: "a", status: "frozen", frozenFor: 60_000 },
        { id: "b", status: "frozen", frozenFor: 2_100 },
      ],
    }),
  });
  r.onAlert(alert("frozen", 2_100));
  assertEquals(events.length, 1);
  assertEquals(events[0]!.detail.frozenFor, 2_100);
  assertStringIncludes(events[0]!.summary, "unreachable for 2.1s");
});

Deno.test("vitals: the formatter grades an RTT on the transport tiers (degraded below warning)", () => {
  const line = (rtt: number) =>
    formatDiagEvent({
      kind: "stale",
      severity: "likely",
      summary: "s",
      detail: { rtt, p95Ms: 1 },
      timestamp: 0,
    }).find((l) => l.includes("transport:"));
  const t = DEFAULT_THRESHOLDS.transport;
  assertStringIncludes(line(t.degraded - 1)!, "healthy");
  assertStringIncludes(line(t.degraded)!, "degraded");
  assertStringIncludes(line(t.degraded + 200)!, "degraded");
  assertStringIncludes(line(t.warning)!, "warning");
  assertStringIncludes(line(t.frozen)!, "frozen");
});

Deno.test("vitals: client transport firstDegradedAt clears when RTT is healthy again", () => {
  using time = new FakeTime(5_000_000);
  const p = createTransportProbeClient({
    thresholds: DEFAULT_THRESHOLDS,
    interval: 1000,
  });
  // One slow round trip at boot…
  const ping = p.createPing();
  time.tick(300);
  p.processPong({ t1: ping.t1, t2: 0, loop: null });
  assertEquals(p.getStatus(), "degraded");
  assertEquals(p.getFirstDegradedAt(), 5_000_300);
  // …and a healthy one.
  const ping2 = p.createPing();
  time.tick(10);
  p.processPong({ t1: ping2.t1, t2: 0, loop: null });
  assertEquals(p.getStatus(), "healthy");
  assertEquals(p.getFirstDegradedAt(), null);
});

Deno.test("vitals: the queue-saturation hint prints a readable drain rate", () => {
  const snap: VitalsSnapshot = {
    render: {
      status: "healthy",
      measured: 0,
      lastActionBefore: null,
      firstDegradedAt: null,
    },
    transport: { status: "healthy", measured: 0, firstDegradedAt: null },
    loop: {
      ...LOOP,
      status: "frozen",
      queueDepth: 1500,
      drainRate: 5 / 3,
      firstDegradedAt: 1,
    },
  };
  const hint = evaluateHints(snap, DEFAULT_THRESHOLDS);
  assert(hint);
  assertStringIncludes(hint.cause, "drain rate: 1.7/s");
});

Deno.test("vitals: a threshold nothing reads is said out loud, not accepted and dropped", async () => {
  const { getLogger, setLogger } = await import(
    "../src/diagnostics/logger-api.ts"
  );
  const warned: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") warned.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    createVitalsSystem({
      pressure: false,
      thresholds: {
        render: { degraded: 10, warning: 20, frozen: 30 },
        transport: { degraded: 300, warning: 900, frozen: 5000 },
      },
    }).destroy();
    const before = warned.length;
    // Only transport.frozen (read by the server) — nothing to say.
    createVitalsSystem({
      pressure: false,
      thresholds: {
        transport: { ...DEFAULT_THRESHOLDS.transport, frozen: 5000 },
      },
    }).destroy();
    assertEquals(warned.length, before);
  } finally {
    setLogger(prev);
  }
  assertEquals(warned.length, 2);
  assertStringIncludes(warned[0]!, "vitals.thresholds.render");
  assertStringIncludes(warned[0]!, "renderBudget");
  assertStringIncludes(warned[1]!, "transport.degraded/.warning");
});

Deno.test("vitals: am cost does not claim dropped samples for a window its wrapped ring still covers", async () => {
  const { createCostMeter } = await import("../src/vitals/cost-meter.ts");
  let t = 1_000_000;
  const m = createCostMeter({ sends: 4, now: () => t });
  // Wrap the ring at boot: 6 sends into 4 slots.
  for (let i = 0; i < 6; i++) {
    m.recordSend(100, "c0", "patch");
    t += 1000;
  }
  // Ten minutes on, two sends in the last minute. The ring still holds two
  // boot samples older than the window, so nothing inside it was dropped.
  t += 600_000;
  m.recordSend(100, "c0", "patch");
  t += 5_000;
  m.recordSend(100, "c0", "patch");
  const r = m.report({ windowSec: 60, now: t });
  assertEquals(r.wire.frames, 2);
  assertEquals(r.truncated, false);
  // …while a window reaching back past the oldest retained sample IS cut.
  assertEquals(m.report({ windowSec: 3600, now: t }).truncated, true);
});

Deno.test("vitals: a queue-driven slow alert names its numbers in actions, not ms", () => {
  // The loop layer's queue driver measures an ACTION COUNT against the queue
  // thresholds. The reporter printed it as "took <last reduce>ms (budget:
  // 50ms)" — 50 being the queue limit in actions, read as a time budget.
  const events: DiagEvent[] = [];
  const v = createVitalsSystem({
    pressure: false,
    onDiagnostic: (e) => events.push(e),
  });
  try {
    v.loopProbe.updateQueueDepth(60);
    v.checkAndAlert();
    const slow = events.filter((e) => e.kind === "slow");
    assertEquals(slow.length, 1, "one queue-driven slow event");
    const summary = slow[0]!.summary;
    assertStringIncludes(summary, "60 actions");
    assertStringIncludes(summary, "limit: 50 actions");
    assert(
      !/budget: \d+ms/.test(summary),
      `queue limit read as ms: ${summary}`,
    );
  } finally {
    v.destroy();
  }
});
