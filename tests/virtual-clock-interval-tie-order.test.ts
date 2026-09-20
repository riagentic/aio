// The virtual clock orders an interval's repeat the way the platform does.
//
// A real `setInterval` re-arms when its callback RETURNS — it is a new entry
// in the timer queue, behind every timer already armed for the same instant,
// including any the callback itself just armed (and it drifts later, never
// earlier). The virtual clock kept a re-armed
// interval in its ORIGINAL queue position, so on a tie it fired first.
//
// Measured with the same cell on a real server and under bootCells:
// `every(100, tick)` + `after(300, stop)` (stop cancels the every) ran 2
// ticks in production and 3 in the harness — a green test asserting 3 about an
// app that does 2. And a hung `skipIfRunning` tick whose call ceiling lands on
// a tick's instant was skipped in the harness and run in production.
import { assertEquals, assertRejects } from "@std/assert";
import { cell, schedule, self } from "../mod.ts";
import { createVirtualTimers } from "../src/state/schedule.ts";
import { bootCells } from "../src/testing/cell-test.ts";

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: never) => void;
};

/** One timer program, run on any timer host — the differential's two sides. */
async function program(
  t: Timers,
  wait: (ms: number) => Promise<void>,
): Promise<string> {
  const out: string[] = [];
  // The interval is armed FIRST, so it is ahead of T100 in any queue that
  // keeps a repeat in place. On the real clock its repeat is due at
  // (first fire + 50), and a fire is always later than its deadline by the
  // event loop's latency — far more than the microseconds between these two
  // lines — so T100 wins the tie every time (measured 20/20).
  const iv = t.setInterval(() => out.push("I"), 50);
  t.setTimeout(() => out.push("T100"), 100);
  await wait(120);
  t.clearInterval(iv as never);
  return out.join(" ");
}

Deno.test("virtual clock: an interval's repeat loses a tie, as a real setInterval does", async () => {
  const real = await program(
    globalThis as unknown as Timers,
    (ms) => new Promise((r) => setTimeout(r, ms)),
  );
  const v = createVirtualTimers(0);
  const virtual = await program(v as unknown as Timers, (ms) => v.advance(ms));
  // The platform is the reference, not a hand-written expectation.
  assertEquals(real, "I T100 I");
  assertEquals(virtual, real);
});

// The repeat is re-armed AFTER the callback returns (the platform's timer
// list re-inserts it in a `finally`), so a timer the callback itself arms for
// the repeat's instant is ahead of it. Re-queued before the callback, the
// repeat won that tie: "I1 I2 T" here, "I1 T I2" on the real clock (20/20).
async function armedInside(
  t: Timers,
  wait: (ms: number) => Promise<void>,
): Promise<string> {
  const out: string[] = [];
  let n = 0;
  const iv = t.setInterval(() => {
    out.push(`I${++n}`);
    if (n === 1) t.setTimeout(() => out.push("T"), 40);
  }, 40);
  await wait(100);
  t.clearInterval(iv as never);
  return out.join(" ");
}

Deno.test("virtual clock: a timer a callback arms for its own repeat's instant fires first, as on the real clock", async () => {
  const real = await armedInside(
    globalThis as unknown as Timers,
    (ms) => new Promise((r) => setTimeout(r, ms)),
  );
  const v = createVirtualTimers(0);
  const virtual = await armedInside(
    v as unknown as Timers,
    (ms) => v.advance(ms),
  );
  assertEquals(real, "I1 T I2");
  assertEquals(virtual, real);
});

// A callback that clears its own interval is not re-armed by that `finally`;
// one that throws is not dropped by it.
Deno.test("virtual clock: a self-cleared interval stays cleared; a throwing one stays armed", async () => {
  const v = createVirtualTimers(0);
  const out: string[] = [];
  let n = 0;
  const iv = v.setInterval(() => {
    out.push(`A${++n}`);
    if (n === 2) v.clearInterval(iv);
  }, 10);
  let m = 0;
  v.setInterval(() => {
    out.push(`B${++m}`);
    if (m === 1) throw new Error("tick failed");
  }, 25);
  await assertRejects(() => v.advance(30), Error, "tick failed");
  await v.advance(50); // 25 → 75
  assertEquals(out.join(" "), "A1 A2 B1 B2 B3");
  assertEquals(v.pending(), 1);
});

const tie = cell("vtie", {
  state: { ticks: 0 },
  methods: {
    start(s) {
      s.$do(schedule.every("vtie:e", 100, self("tick")));
      s.$do(schedule.after("vtie:stop", 300, self("stop")));
    },
    tick(s) {
      s.ticks++;
    },
    stop(s) {
      s.$do(schedule.cancel("vtie:e"));
    },
  },
});
const T = tie as unknown as { start: () => Promise<void>; ticks: number };

Deno.test("harness: an every cancelled by an after due on its tick fires what production fires", async () => {
  await using h = await bootCells([tie]);
  await T.start();
  await h.advance(450);
  // Production: ticks at ~100 and ~200; the 300 tick drifts behind `stop`.
  assertEquals(T.ticks, 2);
});
