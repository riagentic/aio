// The shared coalescer both WS + UDS use — pins the never-drop invariant that
// the a field report UDS bug violated (one transport buffered, one dropped).
import { assert, assertEquals } from "@std/assert";
import { createCoalescer } from "../src/server/broadcast-coalescer.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("coalescer: a synchronous burst flushes once with all items", async () => {
  const flushes: { items: number[]; force: boolean }[] = [];
  const c = createCoalescer<number>(
    0,
    (b, f) => flushes.push({ items: b, force: f }),
  );
  c.add([1]);
  c.add([2]);
  c.add([3]);
  await tick();
  assertEquals(flushes.length, 1, "one coalesced leading flush");
  assertEquals(flushes[0]!.items, [1, 2, 3], "no item dropped");
});

Deno.test("coalescer: items added DURING the throttle window are not dropped", async () => {
  const flushes: number[][] = [];
  const c = createCoalescer<number>(30, (b) => flushes.push(b));
  c.add([1]); // leading flush next microtask
  await tick();
  assertEquals(flushes, [[1]], "leading flush");
  // Now inside the throttle window — these must be buffered, then flushed on the tail.
  c.add([2]);
  c.add([3]);
  await new Promise((r) => setTimeout(r, 50)); // past the throttle
  assertEquals(
    flushes,
    [[1], [2, 3]],
    "trailing flush carried the buffered items — NEVER dropped",
  );
});

Deno.test("coalescer: forceFull requests a full-state flush", async () => {
  const flushes: { n: number; force: boolean }[] = [];
  const c = createCoalescer<number>(
    0,
    (b, f) => flushes.push({ n: b.length, force: f }),
  );
  c.forceFull();
  await tick();
  assertEquals(flushes.length, 1);
  assert(flushes[0]!.force, "force flag propagated");
});

Deno.test("coalescer: add() with no items is a full-state signal", async () => {
  let sawForce = false;
  const c = createCoalescer<number>(0, (_b, f) => (sawForce = f));
  c.add();
  await tick();
  assert(sawForce, "empty add → full-state flush");
});

Deno.test("coalescer: a burst spanning multiple windows loses nothing", async () => {
  const seen: number[] = [];
  const c = createCoalescer<number>(20, (b) => seen.push(...b));
  for (let i = 0; i < 5; i++) {
    c.add([i]);
    await new Promise((r) => setTimeout(r, 8)); // faster than the throttle
  }
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(
    seen.sort((a, b) => a - b),
    [0, 1, 2, 3, 4],
    "every item delivered exactly once",
  );
});
