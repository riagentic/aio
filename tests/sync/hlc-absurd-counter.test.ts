// tests/sync/hlc-absurd-counter.test.ts — a peer's HLC counter no real clock
// can reach must not stop this clock from ticking.
//
// `receive` followed any remote counter within the drift window. Past 2^53,
// `counter++` is a no-op (1e300 + 1 === 1e300), so every HLC the node issued
// until its wall clock passed the remote's was IDENTICAL — ordering by HLC
// became ordering by nothing, for up to `maxDrift`.
import { assert, assertEquals } from "@std/assert";
import { compareHLC, createHLC } from "../../src/sync/hlc.ts";
import type { HLC } from "../../src/sync/types.ts";

Deno.test("hlc: an absurd remote counter is not followed — ticks stay strictly increasing", () => {
  const wall = 1_000_000;
  const clock = createHLC("me", () => wall);
  for (const bad of [1e300, Number.MAX_SAFE_INTEGER + 2, -5, 1.5, NaN]) {
    clock.receive([wall, bad, "hostile"] as HLC);
  }
  clock.receive([NaN, 0, "hostile"] as HLC);
  const a = clock.tick();
  const b = clock.tick();
  assert(compareHLC(b, a) > 0, `tick advanced: ${a} → ${b}`);
  assert(
    Number.isSafeInteger(b[1]) && b[1] < 1000,
    `counter stayed sane: ${b[1]}`,
  );
});

Deno.test("hlc: a legitimate remote counter is still followed", () => {
  const wall = 1_000_000;
  const clock = createHLC("me", () => wall);
  clock.receive([wall, 41, "peer"] as HLC);
  assertEquals(clock.tick()[1], 43);
});
