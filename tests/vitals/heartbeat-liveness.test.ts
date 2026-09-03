// The server watchdog grades a HEARTBEAT AGE, not a round trip — and those are
// different measurements with different scales.
//
// It used to grade `now - lastPing` through the RTT tiers (transport
// degraded 100ms / warning 500ms / frozen 2000ms). The gap it feeds them is the
// age of the last beat of a 1s heartbeat, sampled by an independent ~1s grading
// tick, so for a perfectly healthy client it is uniform over ~0–1000ms. Measured
// on a real chromium tab (580 samples over 60s): degraded 83.3%, warning 16.0%,
// healthy 0.7%; gap p50 495ms, p95 948ms. `/__aio/vitals`, `am metrics` and amui
// all surface that field, so an operator saw a fleet of permanently degraded
// clients — a status nobody can act on.
//
// These tests pin both halves of the contract:
//   • a client beating at the normal interval NEVER reports a tier that implies
//     trouble, at ANY phase relationship between beat and grading tick;
//   • a client that stops beating still reaches `frozen` at the same threshold
//     (`server-broadcast.ts` skips frozen clients — that behaviour is untouched),
//     including one that never beat at all;
//   • the client-side RTT probe keeps the RTT tiers, so the two signals stay
//     unconflated.
import { assert, assertEquals } from "@std/assert";
import { createServerDiagReporter } from "../../src/vitals/diag-reporter.ts";
import {
  createTransportProbeClient,
  createTransportProbeServer,
} from "../../src/vitals/transport-probe.ts";
import {
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_THRESHOLDS,
  type DiagEvent,
  type VitalStatus,
} from "../../src/vitals/types.ts";

const HB = DEFAULT_HEARTBEAT_INTERVAL;

/** Run a live client through `beats` heartbeats with the grading tick offset by
 *  `phase`, and return every status the probe published. Ties resolve
 *  tick-BEFORE-beat: the adversarial order, where the tick sees the oldest
 *  possible gap. */
function statusesOverPhase(
  phase: number,
  beats: number,
  jitter: (k: number, kind: "beat" | "tick") => number = () => 0,
): Set<VitalStatus> {
  let clock = 0;
  const probe = createTransportProbeServer({
    thresholds: DEFAULT_THRESHOLDS,
    now: () => clock,
  });
  probe.onClientConnected("c1");
  const events: Array<[number, "beat" | "tick"]> = [];
  for (let k = 0; k < beats; k++) {
    events.push([k * HB + jitter(k, "beat"), "beat"]);
    events.push([k * HB + phase + jitter(k, "tick"), "tick"]);
  }
  events.sort((a, b) =>
    a[0] - b[0] || (a[1] === "tick" ? -1 : 1) - (b[1] === "tick" ? -1 : 1)
  );
  const seen = new Set<VitalStatus>();
  for (const [at, kind] of events) {
    clock = at;
    if (kind === "beat") probe.onClientPing("c1");
    else {
      probe.checkAllClients();
      seen.add(probe.getClientLiveness("c1")!.status);
    }
  }
  probe.destroy();
  return seen;
}

Deno.test("liveness: a client beating at the normal interval is healthy at EVERY phase", () => {
  for (let phase = 0; phase < HB; phase++) {
    const seen = statusesOverPhase(phase, 40);
    assertEquals(
      [...seen].sort(),
      ["healthy"],
      `phase ${phase}ms: a live client reported ${[...seen].join("/")}`,
    );
  }
});

Deno.test("liveness: jittered beats and jittered ticks are still healthy", () => {
  // Beats and grading ticks both drift in the real world (timer coalescing, a
  // busy loop). ±120ms on each, deterministic PRNG so a failure reproduces.
  let seed = 0x5eed;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const seen = new Set<VitalStatus>();
  for (let phase = 0; phase < HB; phase += 37) {
    for (const s of statusesOverPhase(phase, 60, () => (rnd() - 0.5) * 240)) {
      seen.add(s);
    }
  }
  assertEquals([...seen].sort(), ["healthy"]);
});

Deno.test("liveness: a client that stops beating still reaches frozen", () => {
  let clock = 1_000_000;
  let frozenFor: number | null = null;
  const probe = createTransportProbeServer({
    thresholds: DEFAULT_THRESHOLDS,
    now: () => clock,
    onClientFrozen: (_id, unreachableFor) => frozenFor = unreachableFor,
  });
  probe.onClientConnected("c1");
  probe.onClientPing("c1");

  // One beat short of the threshold: still healthy, still fed by broadcast.
  clock += DEFAULT_THRESHOLDS.transport.frozen - 1;
  probe.checkAllClients();
  assertEquals(probe.isFrozen("c1"), false);
  assertEquals(probe.getClientLiveness("c1")!.status, "healthy");

  // At the threshold: frozen, with the gap that triggered it.
  clock += 1;
  probe.checkAllClients();
  assertEquals(probe.isFrozen("c1"), true);
  assertEquals(frozenFor, DEFAULT_THRESHOLDS.transport.frozen);

  // And it recovers on the next beat.
  probe.onClientPing("c1");
  probe.checkAllClients();
  assertEquals(probe.isFrozen("c1"), false);
  assertEquals(probe.getClientLiveness("c1")!.status, "recovered");
  probe.destroy();
});

Deno.test("liveness: a peer that never beats is not graded at all", () => {
  // It used to freeze: the clock started at CONNECT, so "how long since the
  // last beat" was answered for a client that never beats — and
  // `server-broadcast.ts` skips a frozen client, so `connectCli`, the dev
  // reload socket and any third-party client written against the documented
  // wire went silently dark two seconds in, permanently.
  //
  // The heap-growth case that motivated grading-from-connect is answered by
  // the `bufferedAmount` high-water check beside the frozen check in
  // server-broadcast.ts — "is this peer draining", which is the actual
  // question about a silent socket (tests/ws-write-backlog.test.ts).
  let clock = 0;
  const probe = createTransportProbeServer({
    thresholds: DEFAULT_THRESHOLDS,
    now: () => clock,
  });
  probe.onClientConnected("silent");
  clock += DEFAULT_THRESHOLDS.transport.frozen * 10;
  probe.checkAllClients();
  assertEquals(probe.isFrozen("silent"), false);
  assertEquals(probe.getClientLiveness("silent")?.status, "healthy");
  probe.destroy();
});

Deno.test("liveness: the vocabulary is healthy/frozen/recovered — no RTT tiers", () => {
  // Sweep every gap the watchdog can ever see, from 0 to well past frozen.
  const seen = new Set<VitalStatus>();
  for (let gap = 0; gap <= DEFAULT_THRESHOLDS.transport.frozen * 2; gap += 7) {
    let clock = 0;
    const probe = createTransportProbeServer({
      thresholds: DEFAULT_THRESHOLDS,
      now: () => clock,
    });
    probe.onClientPing("c1");
    clock = gap;
    probe.checkAllClients();
    seen.add(probe.getClientLiveness("c1")!.status);
    probe.destroy();
  }
  assertEquals([...seen].sort(), ["frozen", "healthy"]);
  assert(!seen.has("degraded"), "a heartbeat age is not a latency");
  assert(!seen.has("warning"), "a heartbeat age is not a latency");
});

Deno.test("liveness: RTT keeps the RTT tiers (the signals stay unconflated)", () => {
  const probe = createTransportProbeClient({
    thresholds: DEFAULT_THRESHOLDS,
    interval: HB,
  });
  const t = DEFAULT_THRESHOLDS.transport;
  const at = (rtt: number) => {
    probe.processPong({ t1: Date.now() - rtt, t2: Date.now(), loop: null });
    return probe.getStatus();
  };
  assertEquals(at(0), "healthy");
  assertEquals(at(t.degraded + 20), "degraded");
  assertEquals(at(t.warning + 20), "warning");
  assertEquals(at(t.frozen + 20), "frozen");
  probe.destroy();
});

Deno.test("liveness: a recovery is reported as recovered, not as staleness", () => {
  // A downstream consequence of grading heartbeat ages through RTT tiers. The
  // server reporter's priority is disconnect > stale > slow > recovered, and
  // "stale" fires on a transport alert while ANY client row reads degraded or
  // warning. Every other live client read degraded ~90% of the time, so the
  // recovery of a frozen client — the event the fail-loud ethos most needs to
  // surface — was reported as staleness whenever a second tab was open. A
  // liveness vocabulary has no such rows.
  let clock = 0;
  const probe = createTransportProbeServer({
    thresholds: DEFAULT_THRESHOLDS,
    now: () => clock,
  });
  probe.onClientConnected("a");
  probe.onClientConnected("b");
  probe.onClientPing("a");
  probe.onClientPing("b");

  const events: DiagEvent[] = [];
  const reporter = createServerDiagReporter({
    onDiagnostic: (e) => events.push(e),
    onConsole: () => {},
    getLoopSnapshot: () => ({
      status: "healthy",
      queueDepth: 0,
      drainRate: 50,
      lastReduceTime: 5,
      lastReduceAction: "",
      lastReduceCell: "",
      p95ReduceTime: 8,
      effectBacklog: 0,
      circuitBreakers: [],
      firstDegradedAt: null,
    }),
    getTransportSnapshot: () => ({
      clients: probe.getAllClients().map((c) => ({
        id: c.clientId,
        status: c.status,
      })),
    }),
  });
  const alert = (status: "frozen" | "recovered", measured: number) => ({
    id: `t-${status}`,
    layer: "transport" as const,
    status,
    duration: measured,
    measured,
    threshold: DEFAULT_THRESHOLDS.transport.frozen,
    hint: null,
    ts: Date.now(),
  });

  // `a` goes silent past the threshold while `b` keeps beating — the freeze
  // alert the real system raises from `onClientFrozen`.
  clock = DEFAULT_THRESHOLDS.transport.frozen;
  probe.onClientPing("b");
  probe.checkAllClients();
  assertEquals(probe.isFrozen("a"), true);
  reporter.onAlert(alert("frozen", DEFAULT_THRESHOLDS.transport.frozen));

  // `a` comes back. The grading tick lands 300ms after both beats — `b` is
  // mid-heartbeat, which is what a live client looks like at any given moment.
  clock += 500;
  probe.onClientPing("a");
  probe.onClientPing("b");
  clock += 300;
  probe.checkAllClients();
  assertEquals(probe.getClientLiveness("a")!.status, "recovered");
  assertEquals(probe.getClientLiveness("b")!.status, "healthy");
  reporter.onAlert(alert("recovered", 0));

  assertEquals(events.map((e) => e.kind), ["disconnect", "recovered"]);
  probe.destroy();
});
