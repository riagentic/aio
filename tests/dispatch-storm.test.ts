// Dispatch-storm detector (watcher-loop field report #2) — frequency guard.
import { assert, assertEquals } from "@std/assert";
import {
  createStormDetector,
  type StormInfo,
} from "../src/diagnostics/dispatch-storm.ts";

// Deterministic clock the tests advance by hand
function clock(startMs = 0) {
  let t = startMs;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

// Simulate `perSec` dispatches/sec of `type` for `seconds` wall-seconds
function burst(
  d: ReturnType<typeof createStormDetector>,
  c: ReturnType<typeof clock>,
  type: string,
  perSec: number,
  seconds: number,
): { allowed: number; dropped: number } {
  let allowed = 0, dropped = 0;
  const step = 1000 / perSec;
  for (let s = 0; s < seconds; s++) {
    for (let i = 0; i < perSec; i++) {
      if (d.track(type)) allowed++;
      else dropped++;
      c.tick(step);
    }
  }
  return { allowed, dropped };
}

Deno.test("storm: sustained high rate fires onStorm once with rate+duration", () => {
  const c = clock();
  const storms: StormInfo[] = [];
  const d = createStormDetector({
    rate: 100,
    sustain: 3,
    now: c.now,
    onStorm: (i) => storms.push(i),
  });

  burst(d, c, "app:fsChanged", 500, 5);
  const started = storms.filter((s) => s.rate > 0);
  assertEquals(started.length, 1);
  assertEquals(started[0]!.type, "app:fsChanged");
  assert(started[0]!.rate >= 100, `rate ${started[0]!.rate} >= threshold`);
  assert(started[0]!.seconds >= 3);
  assertEquals(started[0]!.breaking, false);
  assertEquals(d.storming(), ["app:fsChanged"]);
});

Deno.test("storm: quiet types and short bursts never storm", () => {
  const c = clock();
  const storms: StormInfo[] = [];
  const d = createStormDetector({
    rate: 100,
    sustain: 3,
    now: c.now,
    onStorm: (i) => storms.push(i),
  });

  burst(d, c, "app:save", 10, 30); // slow, long
  burst(d, c, "app:spike", 500, 2); // fast, short (< sustain)
  c.tick(3000);
  d.track("app:spike"); // roll the bucket after the gap
  assertEquals(storms.length, 0);
  assertEquals(d.storming(), []);
});

Deno.test("storm: breaker drops mid-storm dispatches, recovers when quiet", () => {
  const c = clock();
  const storms: StormInfo[] = [];
  const d = createStormDetector({
    rate: 100,
    sustain: 2,
    breaker: true,
    now: c.now,
    onStorm: (i) => storms.push(i),
  });

  const r = burst(d, c, "app:loop", 400, 6);
  assert(r.dropped > 0, "breaker dropped dispatches during the storm");
  assert(r.allowed > 0, "pre-storm dispatches were allowed");
  assertEquals(storms.filter((s) => s.rate > 0)[0]!.breaking, true);

  // Goes quiet — storm ends (end event has rate 0), dispatches flow again
  c.tick(5000);
  assertEquals(d.track("app:loop"), true);
  assertEquals(d.storming(), []);
  assert(storms.some((s) => s.rate === 0), "end-of-storm event fired");
});

Deno.test("storm: rates are tracked per action type independently", () => {
  const c = clock();
  const storms: StormInfo[] = [];
  const d = createStormDetector({
    rate: 100,
    sustain: 2,
    now: c.now,
    onStorm: (i) => storms.push(i),
  });

  // Interleave one hot and one cold type in the same wall-clock window
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < 300; i++) {
      d.track("hot:type");
      if (i % 100 === 0) d.track("cold:type");
      c.tick(1000 / 300);
    }
  }
  assertEquals(d.storming(), ["hot:type"]);
});
