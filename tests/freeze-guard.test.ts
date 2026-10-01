// The system-stability guard: aio-owned heavy steps decline to start on a
// machine that is already out of memory headroom, rather than pushing a
// desktop into swap thrash. Pure verdict, so it is tested without a real box.
import { assertEquals } from "@std/assert";
import { headroom, type Memory } from "../src/build/freeze-guard.ts";

const GB = 1024 ** 3;

function mem(over: Partial<Memory> = {}): Memory {
  return {
    totalBytes: 32 * GB,
    availableBytes: 20 * GB,
    swapUsedBytes: 0,
    swapTotalBytes: 8 * GB,
    ...over,
  };
}

Deno.test("headroom: a healthy machine is never slowed", () => {
  assertEquals(headroom(mem()).ok, true);
  // 10% free is above the 5% floor — still fine.
  assertEquals(headroom(mem({ availableBytes: 3.2 * GB })).ok, true);
});

Deno.test("headroom: declines when RAM is nearly spent", () => {
  const v = headroom(mem({ availableBytes: 1 * GB })); // ~3.1% — under the floor
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.reason.includes("RAM available"), true);
});

Deno.test("headroom: declines when swap is thrashing", () => {
  const v = headroom(mem({ swapUsedBytes: 7 * GB })); // 87.5% — over the line
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.reason.includes("swap"), true);
});

Deno.test("headroom: no swap is judged on RAM alone", () => {
  const noSwap = { swapTotalBytes: 0, swapUsedBytes: 0 };
  assertEquals(headroom(mem(noSwap)).ok, true);
  assertEquals(
    headroom(mem({ ...noSwap, availableBytes: 0.5 * GB })).ok,
    false,
  );
});
