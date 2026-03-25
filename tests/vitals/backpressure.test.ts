import { assertEquals } from "@std/assert";

// Pure function — same logic that will be inlined in server.ts
function getBackpressureMultiplier(
  staleness: number,
  consecutiveLowPings: number,
  currentMultiplier: number,
): { multiplier: number; consecutiveLow: number } {
  if (staleness > 300) return { multiplier: 4, consecutiveLow: 0 };
  if (staleness > 100) return { multiplier: 2, consecutiveLow: 0 };

  const low = consecutiveLowPings + 1;
  if (low >= 3 && currentMultiplier > 1) {
    const next = Math.max(1, currentMultiplier / 2);
    return { multiplier: next, consecutiveLow: 0 };
  }
  return { multiplier: currentMultiplier, consecutiveLow: low };
}

Deno.test("backpressure: high staleness → multiplier 4", () => {
  const r = getBackpressureMultiplier(400, 0, 1);
  assertEquals(r.multiplier, 4);
  assertEquals(r.consecutiveLow, 0);
});

Deno.test("backpressure: medium staleness → multiplier 2", () => {
  const r = getBackpressureMultiplier(150, 0, 1);
  assertEquals(r.multiplier, 2);
});

Deno.test("backpressure: low staleness, not enough pings → keep current", () => {
  const r = getBackpressureMultiplier(50, 1, 4);
  assertEquals(r.multiplier, 4);
  assertEquals(r.consecutiveLow, 2);
});

Deno.test("backpressure: low staleness, 3 pings → step down 4→2", () => {
  const r = getBackpressureMultiplier(50, 2, 4);
  assertEquals(r.multiplier, 2);
  assertEquals(r.consecutiveLow, 0);
});

Deno.test("backpressure: low staleness, 3 pings → step down 2→1", () => {
  const r = getBackpressureMultiplier(50, 2, 2);
  assertEquals(r.multiplier, 1);
});

Deno.test("backpressure: already at 1 → stays at 1", () => {
  const r = getBackpressureMultiplier(50, 5, 1);
  assertEquals(r.multiplier, 1);
});
