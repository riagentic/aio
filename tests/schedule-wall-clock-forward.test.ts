// `at` and `cron` fire on the WALL clock, even when it jumps forward mid-wait.
//
// Timers run on the monotonic clock, and on Linux and macOS that clock stops
// while the machine is suspended (a laptop lid closed, an Android phone in deep
// sleep, a VM paused and resumed). A `cron("0 9 * * *")` armed at 08:00 is a
// one-hour setTimeout: sleep from 08:10 to 09:00 and it still owes fifty
// minutes of awake time, so the 09:00 job ran at 09:50. An `at` reminder slid
// the same way — late by however long the machine slept, up to the whole wait.
// Both now re-read the wall clock at least once a minute and fire when it
// reaches their deadline, whichever of the two clocks gets there first.
import { assertEquals } from "@std/assert";
import {
  createScheduleManager,
  createVirtualTimers,
} from "../src/state/schedule.ts";

const quiet = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

async function sleepThrough(
  effect: Record<string, unknown>,
): Promise<string[]> {
  const clock = createVirtualTimers(Date.UTC(2026, 0, 1, 8, 0, 0));
  let slept = 0; // the wall clock moved on, the monotonic one did not
  const timers = { ...clock, now: () => clock.now() + slept };
  const fired: string[] = [];
  const mgr = createScheduleManager(
    () => {
      fired.push(new Date(timers.now()).toISOString().slice(11, 16));
    },
    quiet,
    { timers },
  );
  mgr.handle(
    {
      type: "__schedule",
      id: "job",
      action: { type: "job:run" },
      ...effect,
    } as never,
  );
  await clock.advance(10 * 60_000); // 08:10
  // Suspended until 08:59:30. The wake is noticed within a minute: the next
  // re-read (08:11 monotonic) sees 09:00:30 on the wall.
  slept = 49.5 * 60_000;
  await clock.advance(2 * 60_000); // awake until 09:01:30
  mgr.cancelAll();
  return fired;
}

Deno.test("cron: a daily job fires when the wall clock reaches it after a suspend, not a sleep's length late", async () => {
  assertEquals(
    await sleepThrough({ kind: "cron", pattern: "0 9 * * *" }),
    ["09:00"],
  );
});

Deno.test("at: a reminder fires when the wall clock reaches it after a suspend", async () => {
  assertEquals(
    await sleepThrough({ kind: "at", time: "2026-01-01T09:00:00Z" }),
    ["09:00"],
  );
});

Deno.test("after: a relative delay still counts awake time only", async () => {
  // `after(ms)` is a duration, not an instant — a debounce must not fire
  // early because the machine slept.
  assertEquals(await sleepThrough({ kind: "after", ms: 3_600_000 }), []);
});

Deno.test("cron: advancing the virtual clock a year is not a runaway — the minute re-reads are bookkeeping", async () => {
  // Each wait re-reads the wall clock every minute; the virtual clock counted
  // those re-reads toward its 1e6-fires guard, so two daily crons advanced a
  // year threw "a schedule is re-arming itself with no delay" — a test that
  // passed in 1.0.20 blamed a runaway that was not there.
  const clock = createVirtualTimers(Date.UTC(2026, 0, 1, 0, 0, 0));
  let fired = 0;
  const mgr = createScheduleManager(() => void fired++, quiet, {
    timers: clock,
  });
  for (const id of ["a", "b"]) {
    mgr.handle(
      {
        type: "__schedule",
        id,
        kind: "cron",
        pattern: "0 9 * * *",
        action: { type: "job:run" },
      } as never,
    );
  }
  await clock.advance(366 * 86_400_000);
  mgr.cancelAll();
  assertEquals(fired, 732);
});
