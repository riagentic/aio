// A cron fires ONCE per matching minute, even when the wall clock steps back.
//
// Timers run on the monotonic clock; cron reads the wall clock. When the wall
// clock is stepped backwards while a cron waits (an NTP/chrony step, a VM
// resumed from a snapshot, a manual `date -s`), the timer still fires on time
// — and the wall clock then reads a moment BEFORE the minute it just fired
// for. The re-arm computed "the next matching minute after now" from that
// reading, found the SAME minute, and armed a timer for the seconds left
// until it: the job ran twice (a nightly report sent twice, a charge run
// twice). The next fire is now computed from no earlier than the deadline
// that just fired.
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createScheduleManager,
  createVirtualTimers,
  cronCatchesUp,
  parseCron,
} from "../src/state/schedule.ts";

const quiet = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

Deno.test("cron: a wall clock stepped back mid-wait does not fire the same minute twice", async () => {
  const start = Date.UTC(2026, 0, 1, 8, 58, 30); // 08:58:30 UTC
  const clock = createVirtualTimers(start);
  // The wall clock as the process reads it: the monotonic timer time minus
  // whatever the clock has been stepped back by.
  let stepBack = 0;
  const timers = { ...clock, now: () => clock.now() - stepBack };
  const fired: number[] = [];
  const mgr = createScheduleManager(
    () => {
      fired.push(timers.now());
    },
    quiet,
    { timers },
  );
  mgr.handle({
    type: "__schedule",
    kind: "cron",
    id: "nightly",
    pattern: "0 9 * * *", // 09:00 UTC, once a day
    action: { type: "report:send" },
  });
  // While it waits for 09:00, NTP steps the wall clock back five seconds.
  await clock.advance(10_000);
  stepBack = 5_000;
  // Past 09:00 on the timer clock, well short of the next day.
  await clock.advance(120_000);
  await flush();
  assertEquals(fired.length, 1, "09:00 must fire exactly once");
  mgr.cancelAll();
});

Deno.test("cron: every matching minute still fires once when the clock is steady", async () => {
  const start = Date.UTC(2026, 0, 1, 8, 58, 30);
  const clock = createVirtualTimers(start);
  const fired: number[] = [];
  const mgr = createScheduleManager(
    () => {
      fired.push(clock.now());
    },
    quiet,
    { timers: clock },
  );
  mgr.handle({
    type: "__schedule",
    kind: "cron",
    id: "minutely",
    pattern: "* * * * *",
    action: { type: "tick:go" },
  });
  await clock.advance(5 * 60_000);
  await flush();
  // 08:59, 09:00, 09:01, 09:02, 09:03 — the minutes inside 08:58:30 + 5 min.
  assertEquals(
    fired.map((t) => new Date(t).toISOString().slice(11, 16)),
    ["08:59", "09:00", "09:01", "09:02", "09:03"],
  );
  mgr.cancelAll();
});

Deno.test("cron: a MINUTE-starred pattern keeps its cadence through a step back of two hours, and says so", async () => {
  const start = Date.UTC(2026, 0, 1, 8, 59, 30);
  const clock = createVirtualTimers(start);
  let stepBack = 0;
  const timers = { ...clock, now: () => clock.now() - stepBack };
  const fired: string[] = [];
  const warns: string[] = [];
  const mgr = createScheduleManager(
    () => {
      fired.push(new Date(timers.now()).toISOString().slice(11, 16));
    },
    { ...quiet, warn: (m: string) => warns.push(m) },
    { timers },
  );
  mgr.handle({
    type: "__schedule",
    kind: "cron",
    id: "minutely",
    pattern: "* * * * *",
    action: { type: "tick:go" },
  });
  await clock.advance(10_000);
  // The clock was two hours fast; NTP steps it back mid-wait.
  stepBack = 2 * 3_600_000;
  await clock.advance(31_000); // 09:00 on the timer clock fires (07:00 wall)
  await clock.advance(3 * 60_000);
  await flush();
  // A minute-starred job's cadence continues on the new wall clock. It used
  // to wait out the two hours in silence — a minutely poller dead until 09:01.
  assertEquals(fired, ["07:00", "07:01", "07:02", "07:03"]);
  assertEquals(warns.length, 1, warns.join("\n"));
  assertStringIncludes(warns[0] ?? "", "'minutely'");
  assertStringIncludes(warns[0] ?? "", "stepped back");
  assertStringIncludes(warns[0] ?? "", "minute-starred");
  assertStringIncludes(warns[0] ?? "", "07:01");
  mgr.cancelAll();
});

Deno.test("cron: a fixed-time pattern does not run its slot again after a step back, and says so", async () => {
  const start = Date.UTC(2026, 0, 1, 8, 59, 30);
  const clock = createVirtualTimers(start);
  let stepBack = 0;
  const timers = { ...clock, now: () => clock.now() - stepBack };
  const fired: string[] = [];
  const warns: string[] = [];
  const mgr = createScheduleManager(
    () => {
      fired.push(new Date(timers.now()).toISOString().slice(0, 16));
    },
    { ...quiet, warn: (m: string) => warns.push(m) },
    { timers },
  );
  mgr.handle({
    type: "__schedule",
    kind: "cron",
    id: "nightly",
    pattern: "0 9 * * *",
    action: { type: "report:send" },
  });
  await clock.advance(10_000);
  stepBack = 2 * 3_600_000;
  await clock.advance(31_000); // fires once (07:00 wall)
  await clock.advance(3 * 3_600_000); // the wall clock passes 09:00 again
  await flush();
  assertEquals(fired, ["2026-01-01T07:00"]);
  assertEquals(warns.length, 1, warns.join("\n"));
  assertStringIncludes(warns[0] ?? "", "never runs a slot twice");
  assertStringIncludes(warns[0] ?? "", "2026-01-02T09:00");
  mgr.cancelAll();
});

// A non-idempotent HOURLY job must never repeat: `0 * * * *` is treated as
// fixed-time even though vixie cron (whose "wildcard job" includes a starred
// hour field) would re-run the slots.
Deno.test("cron: an HOURLY pattern never re-runs a slot after a two-hour step back", async () => {
  const start = Date.UTC(2026, 0, 1, 8, 59, 30);
  const clock = createVirtualTimers(start);
  let stepBack = 0;
  const timers = { ...clock, now: () => clock.now() - stepBack };
  const fired: string[] = [];
  const mgr = createScheduleManager(
    () => {
      fired.push(new Date(timers.now()).toISOString().slice(11, 16));
    },
    quiet,
    { timers },
  );
  mgr.handle({
    type: "__schedule",
    kind: "cron",
    id: "hourly",
    pattern: "0 * * * *",
    action: { type: "bill:run" },
  });
  await clock.advance(10_000);
  stepBack = 2 * 3_600_000;
  await clock.advance(31_000); // the 09:00 slot fires (07:00 wall)
  await clock.advance(4 * 3_600_000); // wall 07:00 → 11:00
  await flush();
  // 08:00 and 09:00 already ran by the old reading — never again. Next: 10:00.
  assertEquals(fired, ["07:00", "10:00", "11:00"]);
  mgr.cancelAll();
});

// ── Against a reference model ───────────────────────────────────────
//
// The rule, stated as OUTCOMES (which wall times fire), from a brute-force
// minute scan rather than from the manager's arming mechanics:
//   • a step back under a minute is timer/clock skew — no slot fires twice;
//   • a MINUTE-starred pattern keeps its cadence on the new wall clock;
//   • every other pattern (hourly `0 * * * *` included) never runs a slot it
//     already ran, at any step size.
// Narrower than vixie cron, which also catches up a starred-HOUR pattern and
// re-runs everything after a jump of more than three hours.

const PATTERNS: [string, boolean][] = [
  ["* * * * *", true],
  ["*/5 * * * *", true],
  ["*/7 * * * *", true],
  ["*/20 9-17 * * *", true],
  ["0 * * * *", false],
  ["15,45 * * * *", false],
  ["5 */2 * * *", false],
  ["30 9 * * *", false],
  ["0 9,12 * * *", false],
  ["0-10 3 * * *", false],
  ["45 23 * * *", false],
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fired/expected instant, readable in a failure message only. */
const iso = (t: number) => new Date(t).toISOString().slice(11, 16);

/** Every matching minute in (after, until], by brute force over minutes.
 *  The patterns above restrict only minute and hour. */
function slots(pattern: string, after: number, until: number): number[] {
  const f = parseCron(pattern);
  const out: number[] = [];
  for (let m = Math.floor(after / 60_000) + 1; m * 60_000 <= until; m++) {
    const d = new Date(m * 60_000);
    if (
      f.minute.includes(d.getUTCMinutes()) && f.hour.includes(d.getUTCHours())
    ) out.push(m * 60_000);
  }
  return out;
}

Deno.test("cron step-back: the manager matches the reference model (fuzzed)", async () => {
  const rand = mulberry32(20260919);
  for (let c = 0; c < 150; c++) {
    const [pattern, catchesUp] =
      PATTERNS[Math.floor(rand() * PATTERNS.length)]!;
    assertEquals(cronCatchesUp(pattern), catchesUp, pattern);
    const start = Date.UTC(2026, 0, 1) + Math.floor(rand() * 86_400_000);
    const clock = createVirtualTimers(start);
    let stepBack = 0;
    const timers = { ...clock, now: () => clock.now() - stepBack };
    const fired: number[] = [];
    const mgr = createScheduleManager(
      () => {
        fired.push(timers.now());
      },
      quiet,
      { timers },
    );
    mgr.handle({
      type: "__schedule",
      kind: "cron",
      id: "c",
      pattern,
      action: { type: "x:y" },
    });
    try {
      // The first fire F, and the slot N the manager then waits for.
      const [F, N] = slots(pattern, start, start + 3 * 86_400_000);
      await clock.advance(F! - start);
      await flush();
      assertEquals(fired, [F], `${pattern}: first fire`);
      // Step back by d somewhere inside the wait for N.
      await clock.advance(Math.floor(rand() * (N! - F!)));
      const d = rand() < 0.2
        ? Math.floor(rand() * 60_000) // skew, under a minute
        : 60_000 + Math.floor(rand() * 5 * 3_600_000); // 1 min … 5 h
      stepBack = d;
      const monoEnd = N! + 6 * 3_600_000;
      await clock.advance(monoEnd - clock.now());
      await flush();
      // The armed timer fires at N on the monotonic clock — wall N - d. The
      // rule decides what comes after it.
      const wallEnd = monoEnd - d;
      const resumeFrom = catchesUp && d >= 60_000 ? N! - d : N!;
      const expected = [F!, N! - d, ...slots(pattern, resumeFrom, wallEnd)];
      assertEquals(
        fired,
        expected,
        `${pattern}, start ${new Date(start).toISOString()}, step back ${d}ms` +
          `\n  fired:    ${fired.map(iso).join(" ")}` +
          `\n  expected: ${expected.map(iso).join(" ")}`,
      );
    } finally {
      mgr.cancelAll();
    }
  }
});
