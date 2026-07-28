// llama-master, "things that would have made this app easier to write" #3:
// "Every polling cell here opens with `if (s.refreshing) return;`. That guard is
// boilerplate the scheduler could own."
//
// It is worse than boilerplate. Hand-rolled it needs a state field, a reset in a
// `finally`, and if the method throws between the two the flag stays `true` and
// the poll is dead until a restart. The scheduler already knows when a dispatch
// settles, so it can own the whole thing — and a tick that throws still clears.
import { assert, assertEquals } from "@std/assert";
import { createScheduleManager, schedule } from "../src/state/schedule.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const quiet = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  trace() {},
} as unknown as Parameters<typeof createScheduleManager>[1];

function manager(dispatch: (a: { type: string }) => unknown) {
  return createScheduleManager(
    dispatch as unknown as Parameters<typeof createScheduleManager>[0],
    quiet,
  );
}

Deno.test("every: overlapping ticks stack by default (unchanged behaviour)", async () => {
  let started = 0;
  const m = manager(() => {
    started++;
    return sleep(120); // slower than the interval
  });
  m.handle(schedule.every("poll", 20, { type: "x:tick" }));
  await sleep(110);
  m.cancelAll();
  assert(
    started >= 3,
    `default must not silently change: ticks kept firing (${started})`,
  );
});

Deno.test("every: skipIfRunning drops a tick while the previous is in flight", async () => {
  let started = 0;
  const m = manager(() => {
    started++;
    return sleep(120);
  });
  m.handle(
    schedule.every("poll", 20, { type: "x:tick" }, { skipIfRunning: true }),
  );
  await sleep(110);
  m.cancelAll();
  assertEquals(
    started,
    1,
    "one slow tick must not stack five copies of the same poll on top of itself",
  );
});

Deno.test("every: the next tick runs once the previous settles", async () => {
  let started = 0;
  const m = manager(() => {
    started++;
    return sleep(40);
  });
  m.handle(
    schedule.every("poll", 20, { type: "x:tick" }, { skipIfRunning: true }),
  );
  await sleep(150);
  m.cancelAll();
  assert(started >= 2, `polling must continue, not stop (${started})`);
  assert(started <= 5, `and must not stack (${started})`);
});

Deno.test("every: a tick that REJECTS still clears the guard", async () => {
  let started = 0;
  const m = manager(() => {
    started++;
    // The exact failure the hand-rolled `s.refreshing` guard leaks on: the work
    // fails between setting the flag and resetting it.
    return Promise.reject(new Error("poll failed"));
  });
  m.handle(
    schedule.every("poll", 20, { type: "x:tick" }, { skipIfRunning: true }),
  );
  await sleep(90);
  m.cancelAll();
  assert(
    started >= 3,
    `a failing tick must not wedge the schedule off forever (${started})`,
  );
});

Deno.test("every: a SYNC tick is never skipped", async () => {
  let started = 0;
  const m = manager(() => {
    started++; // returns undefined — nothing to wait for
  });
  m.handle(
    schedule.every("poll", 20, { type: "x:tick" }, { skipIfRunning: true }),
  );
  await sleep(90);
  m.cancelAll();
  assert(started >= 3, `sync ticks have no overlap to skip (${started})`);
});
