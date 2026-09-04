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

// ── the end of a storm, which is the part nobody was told about ─────────
//
// `createStormDetector`'s own doc promises "`onStorm` fires once when a storm
// starts and once when it ends (rate 0)". Measured, it did neither of the two
// endings correctly:
//
//   • ends by dropping UNDER the threshold (non-zero rate) — reported as a
//     fresh storm, with a rate below the one that triggers one. Fixed earlier
//     by the `ended` flag… which then had no test at all, so deleting it went
//     unnoticed. That is the trap the flag's own comment names: "a claim with
//     no test".
//   • ends by going SILENT — the promised `rate 0` case — emitted NOTHING.
//     `roll` runs only inside `track(type)`, so a type nobody dispatches again
//     never closes its bucket: `onStorm` never fired, `storming()` kept naming
//     it, and the operator's last word in the log was the WARNING. A storm that
//     stopped read as one still raging.
//
// The detector is dispatch-driven on purpose (no timer per app), so the end is
// delivered on the next dispatch of ANYTHING, or the next time someone asks
// `storming()` — both are clock reads, and neither costs an app that is not
// storming more than an integer check.

Deno.test("storm: ending by dropping under the threshold says ENDED", () => {
  const c = clock();
  const seen: StormInfo[] = [];
  const d = createStormDetector({
    rate: 3,
    sustain: 1,
    onStorm: (i) => seen.push(i),
    now: c.now,
  });
  for (let i = 0; i < 4; i++) d.track("a:b");
  c.tick(1000);
  d.track("a:b"); // closes the hot bucket → storm starts
  assertEquals(seen.length, 1);
  assertEquals(seen[0]!.ended, undefined);

  c.tick(1000);
  d.track("a:b"); // one dispatch in that second — under the threshold
  assertEquals(seen.length, 2, "the end must be reported");
  assertEquals(seen[1]!.ended, true, "…as an END, not as a fresh storm");
  assertEquals(d.storming(), []);
});

Deno.test("storm: ending by going SILENT says ENDED too", () => {
  const c = clock();
  const seen: StormInfo[] = [];
  const d = createStormDetector({
    rate: 3,
    sustain: 1,
    onStorm: (i) => seen.push(i),
    now: c.now,
  });
  for (let i = 0; i < 4; i++) d.track("a:b");
  c.tick(1000);
  d.track("a:b");
  assertEquals(seen.length, 1, "storm started");

  // The noisy source stops. Any OTHER dispatch is a clock read.
  c.tick(3000);
  d.track("unrelated:x");
  assertEquals(
    seen.length,
    2,
    `a storm whose source went silent must still end: ${JSON.stringify(seen)}`,
  );
  assertEquals(seen[1]!.ended, true);
  assertEquals(seen[1]!.type, "a:b", "and it must name the type that ended");
  assertEquals(d.storming(), []);
});

Deno.test("storm: asking storming() is a clock read as well", () => {
  const c = clock();
  const seen: StormInfo[] = [];
  const d = createStormDetector({
    rate: 3,
    sustain: 1,
    onStorm: (i) => seen.push(i),
    now: c.now,
  });
  for (let i = 0; i < 4; i++) d.track("a:b");
  c.tick(1000);
  d.track("a:b");
  assertEquals(d.storming(), ["a:b"]);

  // Nothing is dispatched at all — a status surface asks instead.
  c.tick(3000);
  assertEquals(
    d.storming(),
    [],
    "a storm that stopped must not be reported as ongoing",
  );
  assertEquals(seen.length, 2, "and its end reaches onStorm");
  assertEquals(seen[1]!.ended, true);
});
