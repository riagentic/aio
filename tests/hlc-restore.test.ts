// HLC clock restore after reboot — a skew bug here corrupts CRDT op ordering.
import { assert, assertEquals } from "@std/assert";
import { compareHLC, createHLC } from "../src/sync/hlc.ts";
import type { HLC } from "../src/sync/types.ts";

const WALL = 1_700_000_000_000;

Deno.test("hlc restore: adopts a trusted persisted clock", () => {
  const c = createHLC("node-a", () => WALL);
  c.restore([WALL - 1000, 7, "node-a"] as HLC);
  // Next tick continues from the restored counter (same ms) or bumps physical.
  const next = c.tick();
  // physical restored to WALL-1000, but wallClock() = WALL > it → jumps to WALL.
  assertEquals(next[0], WALL, "physical advances to wall clock");
  assertEquals(next[1], 0, "counter resets when physical advances");
});

Deno.test("hlc restore: continues the counter when wall clock hasn't advanced", () => {
  // Freeze wall clock exactly at the restored physical time.
  const c = createHLC("node-a", () => WALL);
  c.restore([WALL, 5, "node-a"] as HLC);
  const next = c.tick();
  assertEquals(next[0], WALL);
  assertEquals(next[1], 6, "counter increments from restored value in same ms");
});

Deno.test("hlc restore: rejects a future clock beyond maxDrift (anti-poison)", () => {
  const c = createHLC("node-a", () => WALL);
  // A persisted value an hour+ in the future would hijack causal order.
  c.restore([WALL + 2 * 3_600_000, 99, "node-a"] as HLC);
  const next = c.tick();
  // Restore was rejected → clock reset to now, not the poisoned future value.
  assert(
    next[0] <= WALL,
    `physical must not adopt future skew, got ${next[0]}`,
  );
});

Deno.test("hlc restore: rejects negative physical / counter", () => {
  const c = createHLC("node-a", () => WALL);
  c.restore([-5, -3, "node-a"] as HLC);
  const next = c.tick();
  assert(
    next[0] >= 0 && next[1] >= 0,
    "no negative components survive restore",
  );
});

Deno.test("hlc restore: preserves monotonicity across a reboot", () => {
  const before = createHLC("node-a", () => WALL);
  const last = before.tick(); // some op happened pre-reboot
  // Reboot: fresh clock restored from the persisted last HLC.
  const after = createHLC("node-a", () => WALL);
  after.restore(last);
  const nextOp = after.tick();
  assert(
    compareHLC(nextOp, last) > 0,
    "post-reboot op must sort after the last pre-reboot op",
  );
});
