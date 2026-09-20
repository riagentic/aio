// The call ceiling runs on the harness's clock, not only the real one.
//
// bootCells/testUI move `Date.now()` and every schedule with `advance(ms)`,
// but the call ceilings (`await cell.method()` giving up, and the
// `skipIfRunning` guard that rides the same registration) were armed on the
// real clock only. Measured against a real server with the same cell and the
// same perfBudget: a hung tick every 100ms with a 250ms ceiling started 4
// times in 1050ms (each with the ceiling warning) — and ONCE in the harness
// after `advance(1050)`, silently. A method hung for 31s of test time was
// still pending where the app gives up at 30s. The harness was the more
// forgiving environment, which CLAUDE.md forbids.
import { assertEquals, assertRejects } from "@std/assert";
import { call, cell, schedule, self } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";

const gates: Array<() => void> = [];
const openGates = () => {
  for (const g of gates.splice(0)) g();
};

const hung = cell("vceil", {
  state: { starts: 0 },
  methods: {
    async hang(s) {
      s.starts++;
      await new Promise<void>((r) => gates.push(r));
    },
    async hangLong(_s) {
      await new Promise<void>((r) => gates.push(r));
    },
    // Real work — a fetch, a file read, a dynamic import — lands on real
    // macrotasks, which the virtual clock does not run: it finishes in
    // milliseconds of real time, however far the test advances meanwhile.
    async io(_s) {
      await new Promise<void>((r) => setTimeout(r, 5));
      return "done";
    },
    arm(s) {
      s.$do(
        schedule.every("vceil:p", 100, self("hang"), { skipIfRunning: true }),
      );
    },
    stop(s) {
      s.$do(schedule.cancel("vceil:p"));
    },
  },
});
const H = hung as unknown as {
  hangLong: () => Promise<void>;
  io: () => Promise<string>;
  arm: () => Promise<void>;
  stop: () => Promise<void>;
  starts: number;
};
// `hangLong`'s ceiling is far beyond the real time a test takes, so only the
// virtual clock can reach it.
const perfBudget = {
  methods: {
    "vceil:hang": { timeout: 250 },
    "vceil:hangLong": { timeout: 20_000 },
    "vceil:io": { timeout: 1000 },
  },
};

Deno.test("harness: advancing past a hung call's ceiling gives up on it, as the app does", async () => {
  const h = await bootCells([hung], { perfBudget });
  try {
    const call = H.hangLong();
    let settled = false;
    call.catch(() => {}).finally(() => (settled = true));
    await h.advance(20_100);
    await Promise.resolve();
    // Was still pending: the ceiling waited for 20s of REAL time.
    assertEquals(settled, true, "the call must give up at its ceiling");
    await assertRejects(() => call, Error, "stopped waiting after 20000ms");
  } finally {
    openGates();
    await h.settle().catch(() => {});
    h.dispose();
  }
});

Deno.test("harness: a hung skipIfRunning tick is let through at its ceiling, as the app does", async () => {
  const h = await bootCells([hung], { perfBudget });
  try {
    await H.arm();
    await h.advance(1050);
    await H.stop();
    // Ticks start at 100, 400, 700 and 1000 — each after the previous one's
    // 250ms ceiling released the guard (a real server measured 4).
    assertEquals(H.starts, 4);
  } finally {
    openGates();
    await h.settle().catch(() => {});
    h.dispose();
  }
});

// The other half of "as the app does": a call that finishes in 5ms of real
// time is not given up on because the test advanced past its ceiling while
// that real work was still landing. The virtual deadline fired synchronously
// inside `advance()`, so `await h.advance(ceiling)` rejected a call the app
// completes in milliseconds — "stopped waiting after 1000ms", and a ceiling
// warning, for a call that never came near it.
Deno.test("harness: a call doing real work is not given up on because the test advanced past its ceiling", async () => {
  await using h = await bootCells([hung], { perfBudget });
  const direct = H.io();
  const wrapped = call({ timeoutMs: 1000 }, () => H.io());
  await h.advance(5_000);
  assertEquals(await direct, "done");
  assertEquals(await wrapped, "done");
});
