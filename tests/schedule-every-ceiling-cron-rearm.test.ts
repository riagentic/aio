// Two schedules that did the opposite of what they said, silently.
//
// `every` past the int32 timer ceiling: `armDeadline` clamps after/at/cron
// with 24h re-checks, but an interval has no deadline to re-check, and it was
// handed to `setInterval` unclamped — which truncates the delay to 1ms. A
// 25-day report became ~1000 dispatches a second with nothing logged
// (measured: 48 in 100ms on real timers), and the virtual clock every
// in-process test runs on honoured only the FIRST fire faithfully, so the
// storm was one quiet tick under test. It is refused now, at config time and
// at the call site, and the virtual clock storms exactly as V8 does.
//
// A cron tick whose action re-armed the same id with `after` ("retry in five
// minutes"): the cron's own re-arm checked `timers.has(id)`, which was true
// for the `after` the action had just installed, and `setTimer(internal)`
// cancelled it. The retry never fired. The re-arm now checks the arming's
// epoch, which every cancel and every replace moves.
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  createScheduleManager,
  createVirtualTimers,
  MAX_TIMER_DELAY,
  schedule,
  validateSchedules,
} from "../src/state/schedule.ts";

type Line = { level: string; msg: string };
function capture(): {
  lines: Line[];
  log: Parameters<typeof createScheduleManager>[1];
} {
  const lines: Line[] = [];
  const push = (level: string) => (msg: string) => lines.push({ level, msg });
  return {
    lines,
    log: {
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
      debug: push("debug"),
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const A = { type: "Report" };
const BIG = MAX_TIMER_DELAY + 1;

// ── every past the ceiling ──────────────────────────────────────────

Deno.test("every: past the setInterval ceiling is refused at the call site, naming cron", () => {
  const clock = createVirtualTimers(0);
  const { log } = capture();
  const mgr = createScheduleManager(() => {}, log, { timers: clock });
  const err = assertThrows(
    () => mgr.handle(schedule.every("monthly", BIG, A)),
    Error,
    "setInterval ceiling",
  );
  assertStringIncludes(err.message, "cron");
  assertStringIncludes(err.message, "'monthly'");
  assertEquals(mgr.active(), [], "a refused schedule registers nothing");
  assertEquals(clock.pending(), 0, "…and arms nothing");
});

Deno.test("every: past the ceiling is refused while it is still config", () => {
  const err = assertThrows(
    () => validateSchedules([{ id: "monthly", every: BIG, action: A }]),
    Error,
  );
  assertStringIncludes(err.message, "'monthly'.every");
  assertStringIncludes(err.message, "cron");
});

Deno.test("every: exactly the ceiling is accepted on both paths", async () => {
  validateSchedules([{ id: "edge", every: MAX_TIMER_DELAY, action: A }]);
  const clock = createVirtualTimers(0);
  const fired: unknown[] = [];
  const mgr = createScheduleManager(
    (a) => {
      fired.push(a);
    },
    capture().log,
    { timers: clock },
  );
  mgr.handle(schedule.every("edge", MAX_TIMER_DELAY, A));
  await clock.advance(1000);
  assertEquals(fired.length, 0, "a 24.85-day interval does not fire in 1s");
  mgr.cancelAll();
});

Deno.test("virtual clock: setInterval past the ceiling storms at 1ms, exactly as V8 does", async () => {
  // The harness must be at least as strict as production: a test written on
  // a virtual clock that quietly honoured a 25-day period would be green
  // about a schedule that is a ~1000Hz storm in a real process.
  const clock = createVirtualTimers(0);
  let fires = 0;
  const h = clock.setInterval(() => {
    fires++;
  }, BIG);
  await clock.advance(10);
  clock.clearInterval(h);
  assertEquals(fires, 10, "one fire per millisecond, like the platform");
});

// ── cron re-arm vs. the action's own re-arm ─────────────────────────

Deno.test("cron: a tick whose action re-arms the same id with `after` keeps the after", async () => {
  const clock = createVirtualTimers(0);
  const fired: string[] = [];
  const { lines, log } = capture();
  let mgr!: ReturnType<typeof createScheduleManager>;
  mgr = createScheduleManager(
    (a) => {
      fired.push(`${a.type}@${clock.now()}`);
      if (a.type === "Sync") {
        mgr.handle(schedule.after("job", 5_000, { type: "Retry" }));
      }
    },
    log,
    { timers: clock },
  );
  mgr.handle(schedule.cron("job", "* * * * *", { type: "Sync" }));
  await clock.advance(70_000);
  await flush();
  assertEquals(fired, ["Sync@60000", "Retry@65000"]);
  // Replace semantics, honoured: the id now belongs to the (spent) after, so
  // the cron does not come back at the next minute.
  await clock.advance(60_000);
  await flush();
  assertEquals(fired, ["Sync@60000", "Retry@65000"]);
  assertEquals(mgr.active(), []);
  assertEquals(clock.pending(), 0);
  assertEquals(lines.filter((l) => l.level === "error"), []);
});

Deno.test("cron: a tick whose action replaces it with a new cron under the same id gets the NEW pattern", async () => {
  const clock = createVirtualTimers(0);
  const fired: number[] = [];
  const { log } = capture();
  let mgr!: ReturnType<typeof createScheduleManager>;
  mgr = createScheduleManager(
    () => {
      fired.push(clock.now());
      if (fired.length === 1) {
        mgr.handle(schedule.cron("job", "*/5 * * * *", A));
      }
    },
    log,
    { timers: clock },
  );
  mgr.handle(schedule.cron("job", "* * * * *", A));
  await clock.advance(310_000);
  await flush();
  // Every minute until the first tick, then every five: the old chain must
  // not re-arm over the replacement at 120s.
  assertEquals(fired, [60_000, 300_000]);
  mgr.cancelAll();
});

Deno.test("cron: a tick that cancels its own id does not re-arm (AIO-142 still holds)", async () => {
  const clock = createVirtualTimers(0);
  let fired = 0;
  let mgr!: ReturnType<typeof createScheduleManager>;
  mgr = createScheduleManager(
    () => {
      fired++;
      mgr.handle(schedule.cancel("job"));
    },
    capture().log,
    { timers: clock },
  );
  mgr.handle(schedule.cron("job", "* * * * *", A));
  await clock.advance(200_000);
  await flush();
  assertEquals(fired, 1);
  assertEquals(mgr.active(), []);
  assertEquals(clock.pending(), 0);
});

Deno.test("cron: an untouched tick re-arms as before", async () => {
  const clock = createVirtualTimers(0);
  const fired: number[] = [];
  const mgr = createScheduleManager(
    () => {
      fired.push(clock.now());
    },
    capture().log,
    { timers: clock },
  );
  mgr.handle(schedule.cron("job", "* * * * *", A));
  await clock.advance(180_000);
  await flush();
  assertEquals(fired, [60_000, 120_000, 180_000]);
  mgr.cancelAll();
});
