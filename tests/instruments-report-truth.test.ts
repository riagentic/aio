// VERIFY THE INSTRUMENT. Every finding here is a measurement that was wrong,
// a sink that was disconnected, or a switch nothing read — and each one looked
// perfectly healthy from the outside, which is what makes this class expensive.
import { assert, assertEquals } from "@std/assert";
import {
  diagEmit,
  diagSubscribe,
  initDiagnosticBus,
} from "../src/diagnostics/diagnostic-bus.ts";
import {
  createLoopProbe,
  REDUCE_MEASUREMENT_TTL_MS,
} from "../src/vitals/loop-probe.ts";
import { DEFAULT_THRESHOLDS } from "../src/vitals/types.ts";
import type { PerfTiming } from "../src/state/dispatch.ts";
import { createStormDetector } from "../src/diagnostics/dispatch-storm.ts";
import type { StormInfo } from "../src/diagnostics/dispatch-storm.ts";
import { createTimeline } from "../src/server/timeline.ts";
import { makeRedactor } from "../src/diagnostics/redact.ts";
import { formatPrometheus } from "../src/server/server-metrics.ts";

// ── The bridge that was unsubscribed at boot ──────────────────────────
//
// `initDiagnosticBus` does two jobs — SET THE MODE (the server, late in boot)
// and RESET THE BUS (a test, for isolation) — and did both unconditionally.
// The earliest subscriber is `initDiagnostics`'s bridge to the structured
// logger, so it was silently dropped and a vitals alert reached no log file at
// all. Every bus test called this BEFORE subscribing, the reverse of the
// product's order, so none of them could see it.
Deno.test("diagnostic bus: setting the mode does not unsubscribe the logger bridge", () => {
  initDiagnosticBus(true);
  let seen = 0;
  diagSubscribe(() => seen++);
  initDiagnosticBus(true, { keepListeners: true }); // what the server does
  diagEmit({ type: "t", severity: "warning", source: "x", message: "m" });
  assertEquals(
    seen,
    1,
    "the bridge registered before the mode was set is gone",
  );

  // …and a full reset still isolates a test.
  initDiagnosticBus(true);
  diagEmit({ type: "t2", severity: "warning", source: "x", message: "m" });
  assertEquals(seen, 1, "a plain init must still clear listeners");
});

// ── A measurement with no expiry graded forever ───────────────────────
//
// `lastReduceTime` is the last reduce EVER — never decayed, never windowed —
// so ONE slow dispatch made the loop "degraded" for the life of the process:
// the same alert every 5 s on an idle app, `onVitalAlert` running once a
// second behind the bus's dedup, and hint rule 3 (which needs a healthy loop)
// unable to fire again for any later, genuine freeze.
Deno.test("loop probe: one slow reduce does not grade an idle app forever", () => {
  const probe = createLoopProbe(DEFAULT_THRESHOLDS);
  probe.onPerf({
    actionType: "lab:slow",
    reduce: 400,
    effects: 0,
    budget: { reduce: 100, effect: 5 },
  } as PerfTiming);
  assertEquals(probe.getStatus(), "degraded", "a slow reduce must grade NOW");

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + REDUCE_MEASUREMENT_TTL_MS + 1_000;
    assertEquals(
      probe.getStatus(),
      "healthy",
      "an idle app must return to healthy once the measurement ages out",
    );
  } finally {
    Date.now = realNow;
  }
});

// ── A storm's END was reported as a new storm ─────────────────────────
Deno.test("dispatch storm: the end of a storm is marked, not guessed from the rate", () => {
  const seen: StormInfo[] = [];
  let clock = 0;
  const d = createStormDetector({
    rate: 10,
    sustain: 2,
    onStorm: (i) => seen.push({ ...i }),
    now: () => clock,
  });
  const burst = (n: number) => {
    for (let i = 0; i < n; i++) d.track("app:fsChanged");
  };
  for (let sec = 0; sec < 3; sec++) {
    burst(20);
    clock += 1000;
    d.track("app:fsChanged"); // roll the bucket
  }
  assert(seen.length >= 1, "no storm was reported");
  assertEquals(seen[0]!.ended, undefined, "the START must not be marked ended");

  // Now it stops by dropping UNDER the threshold — the ordinary way — which
  // is a non-zero rate, so `rate === 0` could never recognise it.
  for (let sec = 0; sec < 3; sec++) {
    burst(2);
    clock += 1000;
    d.track("app:fsChanged");
  }
  const end = seen.find((i) => i.ended);
  assert(
    end,
    `the end of the storm was never marked: ${JSON.stringify(seen)}`,
  );
  assert(
    end.rate < 10,
    "…and it ended below the threshold, which is why guessing from the rate " +
      "reported it as a fresh storm",
  );
});

// ── A redacted CELL's values, not just a redacted ACTION's ────────────
//
// `unlockWith(secret)` is redacted and its obvious companion `lock()` is not,
// so `lock()`'s diff printed the secret in cleartext to `am timeline`. The two
// sibling sinks (checkpoint, state-diff) already withhold by cell.
Deno.test("timeline: a redacted cell's values are withheld from every action's diff", () => {
  const t = createTimeline(50, makeRedactor(["lab:unlockWith"]));
  t.record(
    1,
    "lab:unlockWith",
    { p: "hunter2" },
    { lab: { secret: "" } },
    { lab: { secret: "TOP-SECRET" } },
    1,
    undefined,
  );
  t.record(
    2,
    "lab:lock",
    {},
    { lab: { secret: "TOP-SECRET" } },
    { lab: { secret: "" } },
    2,
    undefined,
  );
  t.record(
    3,
    "other:tick",
    {},
    { other: { n: 0 } },
    { other: { n: 1 } },
    3,
    undefined,
  );
  const dump = JSON.stringify(t.entries());
  assert(
    !dump.includes("TOP-SECRET"),
    `the secret is in the timeline: ${dump}`,
  );
  // …and an unrelated cell still reports real values, or the sink is useless.
  assert(dump.includes('"before":0'), `unrelated diffs were redacted: ${dump}`);
});

// ── A counter that resets is not a counter ────────────────────────────
//
// The Prometheus broadcast counters were summed from the per-connection
// payload map, which is DELETED on disconnect — so every browser reload was a
// counter reset and the whole series vanished with the last client. That is
// verbatim the argument in the comment above those very lines.
Deno.test("metrics: broadcast counters come from a process-lifetime total", () => {
  const withClients = formatPrometheus({
    uptimeSeconds: 1,
    memory: Deno.memoryUsage(),
    clients: 1,
    broadcastTotals: { bytes: 130, count: 2 },
    payloads: new Map([["c1", {
      lastPayloadBytes: 65,
      totalBytes: 130,
      count: 2,
    }]]),
  });
  assert(withClients.includes("aio_broadcast_bytes_total 130"), withClients);

  // The client disconnects: `payloads` is empty, the totals are not.
  const afterDisconnect = formatPrometheus({
    uptimeSeconds: 2,
    memory: Deno.memoryUsage(),
    clients: 0,
    broadcastTotals: { bytes: 130, count: 2 },
    payloads: new Map(),
  });
  assert(
    afterDisconnect.includes("aio_broadcast_bytes_total 130"),
    `the counter reset when the client left:\n${afterDisconnect}`,
  );
  assert(
    afterDisconnect.includes("aio_broadcast_messages_total 2"),
    afterDisconnect,
  );
});
