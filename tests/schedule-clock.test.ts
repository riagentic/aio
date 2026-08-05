// The REAL schedule manager, on a virtual clock.
//
// Everything in this file was untestable before `createScheduleManager` took a
// `timers` host: the manager reached straight for global setTimeout/Date, so a
// 35-day timer, a leap-day cron and a 5-second retry could only be tested by
// waiting for them. What lived in that blind spot: `after` had no MAX_DELAY
// clamp (V8 truncates the int32 delay, so 35 days fired in 1ms), a leap-day
// cron was deleted forever with a misleading hint, a failed one-shot's retry
// resurrected a schedule `cancelAll()` had just cancelled, and a HUNG
// `skipIfRunning` tick silently stopped a poller for good.
//
// Every test here fires the real code paths, deterministically, in
// microseconds.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createScheduleManager,
  createVirtualTimers,
  MAX_TIMER_DELAY,
  schedule,
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

/** Let every microtask (a rejected dispatch, a settled tick) land. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const DAY = 86_400_000;
const has = (lines: Line[], level: string, needle: string) =>
  lines.some((l) => l.level === level && l.msg.includes(needle));

// ── BUG 1: the MAX_DELAY clamp ──────────────────────────────────────

Deno.test("after: a 35-day delay fires in 35 days, not immediately", async () => {
  const clock = createVirtualTimers(0);
  const fired: unknown[] = [];
  const { log } = capture();
  const mgr = createScheduleManager(
    (a) => {
      fired.push(a);
    },
    log,
    { timers: clock },
  );

  mgr.handle(schedule.after("reminder", 35 * DAY, { type: "Remind" }));
  // The whole point: setTimeout stores its delay in an int32, so an unclamped
  // 35-day timer used to fire on the NEXT TICK.
  clock.advance(50);
  assertEquals(fired.length, 0, "a 35-day reminder must not fire in 50ms");
  clock.advance(34 * DAY);
  assertEquals(fired.length, 0, "…nor a day early");
  clock.advance(DAY);
  await flush();
  assertEquals(fired.length, 1, "…and it must actually fire on day 35");
  assertEquals(mgr.active(), [], "a fired one-shot leaves no timer behind");
});

Deno.test("after: a beyond-ceiling delay says so, once", () => {
  const clock = createVirtualTimers(0);
  const { lines, log } = capture();
  const mgr = createScheduleManager(() => {}, log, { timers: clock });
  mgr.handle(schedule.after("reminder", 35 * DAY, { type: "Remind" }));
  clock.advance(10 * DAY); // several 24h re-checks
  const warns = lines.filter((l) =>
    l.level === "warn" && l.msg.includes("setTimeout ceiling")
  );
  assertEquals(warns.length, 1, "warns once per arming, not once per re-check");
  assert(warns[0]!.msg.includes("35 days"));
});

Deno.test("backoff: an uncapped attempt cannot collapse into a hot loop", async () => {
  // The documented example is `{ base: 1000 }` with the OPTIONAL max left off,
  // aimed at a rate-limited RPC. At attempt 40 that is 1.1e15 ms, which an
  // int32 truncates to ~1ms: the backoff became a retry storm against exactly
  // the API it was backing off from.
  const e = schedule.backoff("rpc", 40, { base: 1000 }, { type: "Poll" });
  assertEquals(e.kind, "after");
  assertEquals(
    (e as { ms: number }).ms,
    MAX_TIMER_DELAY,
    "an omitted max caps at the timer ceiling",
  );

  const clock = createVirtualTimers(0);
  const fired: unknown[] = [];
  const { log } = capture();
  const mgr = createScheduleManager(
    (a) => {
      fired.push(a);
    },
    log,
    { timers: clock },
  );
  mgr.handle(e);
  clock.advance(60_000);
  await flush();
  assertEquals(fired.length, 0, "a capped backoff does not fire in a minute");
});

Deno.test("poll: an uncapped attempt is capped too", () => {
  const e = schedule.poll("rpc", 40, { every: 5000, backoff: 2 }, {
    type: "Tick",
  });
  assertEquals((e as { ms: number }).ms, MAX_TIMER_DELAY);
});

Deno.test("after: a non-finite delay is refused, not armed", () => {
  const clock = createVirtualTimers(0);
  const { log } = capture();
  const mgr = createScheduleManager(() => {}, log, { timers: clock });
  assertThrows(
    () => mgr.handle(schedule.after("x", Infinity, { type: "A" })),
    Error,
    "finite",
  );
  // NaN is the nastier one: it passes every `<` comparison, so it reached
  // setTimeout/setInterval and became a 1ms hot loop.
  assertThrows(
    () => mgr.handle(schedule.after("x", NaN, { type: "A" })),
    Error,
    "finite",
  );
  assertThrows(
    () => mgr.handle(schedule.every("y", NaN, { type: "A" })),
    Error,
    "finite",
  );
  assertEquals(mgr.active(), []);
});

// ── BUG 3: leap-day cron ────────────────────────────────────────────

const CRON_START = Date.UTC(2026, 2, 1); // 2026-03-01, just past a Feb 29 miss

Deno.test("cron: a leap-day pattern survives and fires on Feb 29", async () => {
  const clock = createVirtualTimers(CRON_START);
  const fired: unknown[] = [];
  const { lines, log } = capture();
  const mgr = createScheduleManager(
    (a) => {
      fired.push(a);
    },
    log,
    { timers: clock },
  );

  // The next 29 Feb is 2028 — ~2 years out, well past the old 366-day search
  // window, so this used to log "Feb 30 does not exist" and delete itself.
  mgr.handle(schedule.cron("leap", "0 0 29 2 *", { type: "LeapDay" }));
  assertEquals(mgr.active(), ["leap"], "the schedule must still exist");
  assert(
    !has(lines, "error", "removing schedule"),
    lines.map((l) => l.msg).join("\n"),
  );

  clock.advance(Date.UTC(2028, 1, 28) - CRON_START);
  await flush();
  assertEquals(fired.length, 0, "not before Feb 29");
  clock.advance(DAY);
  await flush();
  assertEquals(fired.length, 1, "fires on 2028-02-29T00:00Z");
  assertEquals(mgr.active(), ["leap"], "and re-arms for 2032 instead of dying");

  clock.advance(4 * 366 * DAY);
  await flush();
  assertEquals(fired.length, 2, "the next leap day fires as well");
});

Deno.test("cron: an impossible pattern is refused at the call site", () => {
  const clock = createVirtualTimers(CRON_START);
  const { log } = capture();
  const mgr = createScheduleManager(() => {}, log, { timers: clock });
  // Feb 30 / Apr 31 — the hint that used to be shown for VALID leap-day
  // patterns belongs here, and only here.
  assertThrows(
    () => mgr.handle(schedule.cron("never", "0 0 30 2 *", { type: "X" })),
    Error,
    "can never fire",
  );
  assertThrows(
    () => mgr.handle(schedule.cron("never", "0 0 31 4 *", { type: "X" })),
    Error,
    "can never fire",
  );
  // …and NOT for patterns that merely look exotic.
  mgr.handle(schedule.cron("ok1", "0 0 29 2 *", { type: "X" }));
  mgr.handle(schedule.cron("ok2", "0 0 30 2 1", { type: "X" })); // dom+dow OR
  mgr.handle(schedule.cron("ok3", "0 0 31 * *", { type: "X" }));
  assertEquals(mgr.active().sort(), ["ok1", "ok2", "ok3"]);
});

// ── BUG 7: the cron fire path reports failures ──────────────────────

Deno.test("cron: a failing tick is reported (it used to log nothing)", async () => {
  const clock = createVirtualTimers(Date.UTC(2026, 0, 1));
  const { lines, log } = capture();
  let n = 0;
  const mgr = createScheduleManager(
    () => {
      n++;
      return Promise.reject(new Error("boom")) as unknown as void;
    },
    log,
    { timers: clock },
  );

  mgr.handle(schedule.cron("tick", "* * * * *", { type: "Tick" }));
  for (let i = 0; i < 5; i++) {
    clock.advance(60_000);
    await flush();
  }
  assertEquals(n, 5, "a repeating schedule survives failed ticks");
  const errs = lines.filter((l) =>
    l.level === "error" && l.msg.includes("dispatch 'tick' failed")
  );
  assertEquals(errs.length, 5, "every failed cron tick is reported");
});

Deno.test("cron: a CLOSED dispatch loop stops the schedule", async () => {
  const clock = createVirtualTimers(Date.UTC(2026, 0, 1));
  const { log } = capture();
  let n = 0;
  const mgr = createScheduleManager(
    () => {
      n++;
      const e = new Error("dispatch closed") as Error & { code: string };
      e.code = "DISPATCH_CLOSED";
      return Promise.reject(e) as unknown as void;
    },
    log,
    { timers: clock },
  );

  mgr.handle(schedule.cron("tick", "* * * * *", { type: "Tick" }));
  clock.advance(60_000);
  await flush();
  assertEquals(n, 1);
  assertEquals(mgr.active(), [], "cron must not re-arm through a shutdown");
  clock.advance(10 * 60_000);
  await flush();
  assertEquals(n, 1, "and it must not keep firing during the drain");
});

Deno.test("cron: re-arming itself is not a same-id collision", async () => {
  // Every cron in the app printed "is set dynamically twice" on its first
  // re-arm, because the renewal looked exactly like a second registration.
  // A warning that fires for correct code is how people learn to ignore
  // warnings.
  const clock = createVirtualTimers(Date.UTC(2026, 0, 1));
  const { lines, log } = capture();
  const mgr = createScheduleManager(() => {}, log, { timers: clock });
  mgr.handle(schedule.cron("nightly", "* * * * *", { type: "Tick" }));
  clock.advance(5 * 60_000);
  await flush();
  assert(
    !has(lines, "warn", "set dynamically twice"),
    lines.filter((l) => l.level === "warn").map((l) => l.msg).join("\n"),
  );
  // …but a REAL collision still warns.
  mgr.handle(schedule.every("nightly", 1000, { type: "Other" }));
  assert(has(lines, "warn", "set dynamically twice"));
});

// ── BUG 4: a retry must not resurrect a cancelled schedule ──────────

/** A dispatch that always rejects, counting calls. */
function rejecting(): { calls: unknown[]; fn: () => void } {
  const calls: unknown[] = [];
  return {
    calls,
    fn: ((a: unknown) => {
      calls.push(a);
      return Promise.reject(new Error("nope"));
    }) as unknown as () => void,
  };
}

Deno.test("retry: cancelAll() during an in-flight failed tick is final", async () => {
  const clock = createVirtualTimers(0);
  const { calls, fn } = rejecting();
  const { log } = capture();
  const mgr = createScheduleManager(fn, log, { timers: clock });

  mgr.handle(schedule.after("save", 1000, { type: "Save" }));
  clock.advance(1000); // fires; the rejection is still in flight
  mgr.cancelAll(); // ← shutdown Phase 7 does exactly this
  await flush();

  assertEquals(mgr.active(), [], "cancelAll() must actually cancel");
  clock.advance(60_000);
  await flush();
  assertEquals(calls.length, 1, "the retry must not resurrect the schedule");
});

Deno.test("retry: schedule.cancel during an in-flight failed tick is honoured", async () => {
  const clock = createVirtualTimers(0);
  const { calls, fn } = rejecting();
  const { log } = capture();
  const mgr = createScheduleManager(fn, log, { timers: clock });

  mgr.handle(schedule.after("save", 1000, { type: "Save" }));
  clock.advance(1000);
  mgr.handle(schedule.cancel("save")); // the app's own cancel, same window
  await flush();

  clock.advance(60_000);
  await flush();
  assertEquals(calls.length, 1, "a cancelled schedule stays cancelled");
  assertEquals(mgr.active(), []);
});

Deno.test("retry: a same-id replacement is not clobbered by the old retry", async () => {
  const clock = createVirtualTimers(0);
  const seen: string[] = [];
  const { log } = capture();
  const mgr = createScheduleManager(
    (a) => {
      seen.push((a as { type: string }).type);
      if ((a as { type: string }).type === "Old") {
        return Promise.reject(new Error("nope")) as unknown as void;
      }
    },
    log,
    { timers: clock },
  );

  mgr.handle(schedule.after("save", 1000, { type: "Old" }));
  clock.advance(1000); // Old fires and rejects
  mgr.handle(schedule.after("save", 2000, { type: "New" })); // replaces the id
  await flush();

  clock.advance(2000);
  await flush();
  assertEquals(seen, ["Old", "New"]);
  clock.advance(60_000);
  await flush();
  assertEquals(seen, ["Old", "New"], "the old retry must not run at all");
});

Deno.test("retry: a live one-shot still retries a failed dispatch", async () => {
  // The guard must not disarm the feature it protects.
  const clock = createVirtualTimers(0);
  const { calls, fn } = rejecting();
  const { lines, log } = capture();
  const mgr = createScheduleManager(fn, log, { timers: clock });

  mgr.handle(schedule.after("save", 1000, { type: "Save" }));
  clock.advance(1000);
  await flush();
  for (let i = 0; i < 4; i++) {
    clock.advance(5000);
    await flush();
  }
  assertEquals(calls.length, 4, "1 fire + 3 retries");
  assert(has(lines, "error", "after 3 retries"), "and then it gives up");
  assertEquals(mgr.active(), []);
});

Deno.test("cancelByPrefix reaches an in-flight one-shot (cell disable)", async () => {
  const clock = createVirtualTimers(0);
  const { calls, fn } = rejecting();
  const { log } = capture();
  const mgr = createScheduleManager(fn, log, { timers: clock });

  mgr.handle(schedule.after("mycell:save", 1000, { type: "Save" }));
  clock.advance(1000);
  mgr.cancelByPrefix("mycell"); // the cell was just disabled
  await flush();
  clock.advance(60_000);
  await flush();
  assertEquals(calls.length, 1);
});

// ── BUG 5: skipIfRunning must not wedge silently ────────────────────

/** A dispatch whose promise never settles — a hung fetch inside a poll. */
function hanging(): { calls: number[]; fn: () => void } {
  const calls: number[] = [];
  return {
    calls,
    fn: (() => {
      calls.push(1);
      return new Promise(() => {});
    }) as unknown as () => void,
  };
}

Deno.test("skipIfRunning: a hung tick is audible, not silent", async () => {
  const clock = createVirtualTimers(0);
  const { calls, fn } = hanging();
  const { lines, log } = capture();
  const mgr = createScheduleManager(fn, log, { timers: clock });

  mgr.handle(
    schedule.every("poll", 100, { type: "Poll" }, { skipIfRunning: true }),
  );
  clock.advance(60_000); // 600 due ticks; exactly one of them ever ran
  await flush();
  assertEquals(calls.length, 1, "the wedge itself is the documented behaviour");
  const warns = lines.filter((l) =>
    l.level === "warn" && l.msg.includes("consecutive ticks")
  );
  assert(warns.length > 0, "a poller that stopped firing must SAY so");
  assert(warns[0]!.msg.includes("10 consecutive"), warns[0]?.msg);
});

Deno.test("skipIfRunning: cancel + re-create the same id clears the guard", async () => {
  const clock = createVirtualTimers(0);
  const { calls, fn } = hanging();
  const { log } = capture();
  const mgr = createScheduleManager(fn, log, { timers: clock });

  mgr.handle(
    schedule.every("poll", 100, { type: "Poll" }, { skipIfRunning: true }),
  );
  clock.advance(1000);
  await flush();
  assertEquals(calls.length, 1);

  // The obvious operator move: cancel the wedged poll and start it again. The
  // guard used to belong to the ORPHANED tick, so this fired zero more times,
  // forever, with nothing in the log.
  mgr.handle(schedule.cancel("poll"));
  mgr.handle(
    schedule.every("poll", 100, { type: "Poll" }, { skipIfRunning: true }),
  );
  clock.advance(100);
  await flush();
  assertEquals(calls.length, 2, "a re-created schedule is not born wedged");
});

Deno.test("skipIfRunning: a settled tick resets the consecutive-skip count", async () => {
  const clock = createVirtualTimers(0);
  let resolveTick: (() => void) | null = null;
  const calls: number[] = [];
  const { lines, log } = capture();
  const mgr = createScheduleManager(
    (() => {
      calls.push(1);
      return new Promise<void>((r) => {
        resolveTick = r;
      });
    }) as unknown as () => void,
    log,
    { timers: clock },
  );

  mgr.handle(
    schedule.every("poll", 100, { type: "Poll" }, { skipIfRunning: true }),
  );
  clock.advance(500); // 4 skips — under the threshold
  resolveTick!();
  await flush();
  clock.advance(100);
  await flush();
  assertEquals(calls.length, 2);
  assert(
    !has(lines, "warn", "consecutive ticks"),
    "a slow-but-alive poll must not cry wolf",
  );
});

// ── `at` in the past ────────────────────────────────────────────────

Deno.test("at: a past target warns instead of vanishing", () => {
  const clock = createVirtualTimers(Date.UTC(2026, 0, 2));
  const { lines, log } = capture();
  const mgr = createScheduleManager(() => {}, log, { timers: clock });
  mgr.handle(schedule.at("promo", "2026-01-01T00:00:00Z", { type: "Expire" }));
  assertEquals(mgr.active(), [], "it genuinely does not fire");
  assert(
    has(lines, "warn", "is in the past"),
    "…and that has to be visible: it never appears in active() either",
  );
});

// ── the virtual clock itself ────────────────────────────────────────

Deno.test("virtual clock: a runaway re-arm throws instead of hanging", () => {
  const clock = createVirtualTimers(0);
  const tick = () => {
    clock.setTimeout(tick, 0);
  };
  tick();
  assertThrows(() => clock.advance(1), Error, "re-arming itself");
});
