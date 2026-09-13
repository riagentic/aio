// A per-second rate divides by how long we WATCHED, not by the age of the
// oldest event.
//
// `am cost` and the loop probe's `drainRate` both took the span from the
// oldest sample in the window. The oldest sample marks when a burst began, not
// when observation did, so a quiet stretch followed by a burst was divided by
// the burst's own length:
//
//   · one 500 B send on a server that had been up a minute → 500000 B/s (the
//     span collapsed to the 1 ms floor);
//   · one send read half a second later, 10 s window → 200 B/s, truth 10;
//   · five actions in one burst, 5 s drain window → 625/s, truth 1/s.
//
// Only a ring that DROPPED samples has a later start — its oldest retained
// sample (the per-series rule d40db0652 set, pinned in tests/cost-meter.test.ts).
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { createCostMeter } from "../src/vitals/cost-meter.ts";
import { createLoopProbe } from "../src/vitals/loop-probe.ts";
import { DEFAULT_THRESHOLDS } from "../src/vitals/types.ts";
import type { PerfTiming } from "../src/state/dispatch.ts";

Deno.test("cost: one send on a long-running meter is not a burst rate", () => {
  let t = 1_000_000;
  const m = createCostMeter({ now: () => t });
  t += 60_000; // a minute of nothing
  m.recordSend(500, "c0", "patch");
  const r = m.report({ windowSec: 60, now: t });
  assertAlmostEquals(r.wire.bytesPerSec, 500 / 60, 0.01);
  assertAlmostEquals(r.wire.framesPerSec, 1 / 60, 0.001);
  assertAlmostEquals(r.windowSec, 60, 0.01);
});

Deno.test("cost: a send read half a second later is spread over the window watched", () => {
  let t = 1_000_000;
  const m = createCostMeter({ now: () => t });
  m.recordSend(100, "c0", "patch");
  t += 50_000;
  m.recordSend(100, "c0", "patch");
  m.recordAttribution("hw", "cpu", 100, m.beginRound());
  t += 500;
  const r = m.report({ windowSec: 10, now: t });
  assertAlmostEquals(r.wire.bytesPerSec, 10, 0.01, "100 B in a 10 s window");
  assertAlmostEquals(r.cells[0]!.bytesPerSec, 10, 0.01);
  assertAlmostEquals(r.windowSec, 10, 0.01);
});

Deno.test("cost: a young meter divides by its own age, not the requested window", () => {
  let t = 1_000_000;
  const m = createCostMeter({ now: () => t });
  t += 2000;
  m.recordSend(1000, "c0", "patch");
  const r = m.report({ windowSec: 60, now: t });
  assertAlmostEquals(r.wire.bytesPerSec, 500, 0.01, "1000 B over 2 s watched");
  assertAlmostEquals(r.windowSec, 2, 0.01);
});

Deno.test("cost: reset() restarts the observation clock", () => {
  let t = 1_000_000;
  const m = createCostMeter({ now: () => t });
  t += 30_000;
  m.reset();
  t += 4000;
  m.recordSend(400, "c0", "patch");
  const r = m.report({ windowSec: 60, now: t });
  assertAlmostEquals(
    r.wire.bytesPerSec,
    100,
    0.01,
    "400 B over the 4 s since reset",
  );
});

Deno.test("loop probe: a burst's drain rate is spread over the window watched", () => {
  using time = new FakeTime(1_000_000);
  const p = createLoopProbe(DEFAULT_THRESHOLDS);
  time.tick(60_000); // a long-running server
  for (let i = 0; i < 5; i++) {
    p.onPerf({ actionType: "a:x", reduce: 1 } as unknown as PerfTiming);
  }
  time.tick(2);
  assertAlmostEquals(p.getVitals().drainRate, 1, 0.01, "5 actions / 5 s");
});

Deno.test("loop probe: a young probe divides by its age, floored at one second", () => {
  using time = new FakeTime(1_000_000);
  const p = createLoopProbe(DEFAULT_THRESHOLDS);
  time.tick(2000);
  for (let i = 0; i < 4; i++) {
    p.onPerf({ actionType: "a:x", reduce: 1 } as unknown as PerfTiming);
  }
  assertAlmostEquals(p.getVitals().drainRate, 2, 0.01, "4 actions / 2 s");
  // First instant of a fresh probe: the count, not an extrapolation.
  p.reset();
  p.onPerf({ actionType: "a:x", reduce: 1 } as unknown as PerfTiming);
  p.onPerf({ actionType: "a:x", reduce: 1 } as unknown as PerfTiming);
  time.tick(3);
  assertEquals(p.getVitals().drainRate, 2);
});
