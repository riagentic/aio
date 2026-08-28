import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  createScheduleManager,
  createVirtualTimers,
  isScheduleEffect,
  nextCronTime,
  parseCron,
  schedule,
  type ScheduleEffect,
} from "../src/state/schedule.ts";

const noop = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ── Effect creators ─────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type AnyFn = (...a: any[]) => any;

Deno.test("schedule.after produces correct shape", () => {
  const e = schedule.after("save", 3000, { type: "Save" });
  assertEquals(e.type, "__schedule");
  assertEquals(e.kind, "after");
  assertEquals(e.id, "save");
  assertEquals((e as Extract<ScheduleEffect, { kind: "after" }>).ms, 3000);
  assertEquals(e, {
    type: "__schedule",
    kind: "after",
    id: "save",
    ms: 3000,
    action: { type: "Save" },
  });
});

Deno.test("schedule.every produces correct shape", () => {
  const e = schedule.every("poll", 5000, { type: "Fetch" });
  assertEquals(e, {
    type: "__schedule",
    kind: "every",
    id: "poll",
    ms: 5000,
    action: { type: "Fetch" },
  });
});

Deno.test("schedule.at produces correct shape", () => {
  const e = schedule.at("deadline", "2026-12-31T23:59:00Z", { type: "Expire" });
  assertEquals(e, {
    type: "__schedule",
    kind: "at",
    id: "deadline",
    time: "2026-12-31T23:59:00Z",
    action: { type: "Expire" },
  });
});

Deno.test("schedule.cron produces correct shape", () => {
  const e = schedule.cron("nightly", "0 2 * * *", { type: "Cleanup" });
  assertEquals(e, {
    type: "__schedule",
    kind: "cron",
    id: "nightly",
    pattern: "0 2 * * *",
    action: { type: "Cleanup" },
  });
});

Deno.test("schedule.cancel produces correct shape", () => {
  const e = schedule.cancel("poll");
  assertEquals(e, { type: "__schedule", kind: "cancel", id: "poll" });
});

Deno.test("isScheduleEffect: true for schedule, false for normal effect", () => {
  assertEquals(isScheduleEffect(schedule.after("x", 100, { type: "A" })), true);
  assertEquals(isScheduleEffect(schedule.cancel("x")), true);
  assertEquals(isScheduleEffect({ type: "Log", payload: {} }), false);
  assertEquals(isScheduleEffect(null), false);
  assertEquals(isScheduleEffect(undefined), false);
  assertEquals(isScheduleEffect("string"), false);
});

// ── Schedule manager ────────────────────────────────────────────────

Deno.test("manager: after fires action after delay, auto-removes", async () => {
  const dispatched: { type: string }[] = [];
  const mgr = createScheduleManager((a) => dispatched.push(a), noop);

  mgr.handle(schedule.after("test", 50, { type: "Fired" }));
  assertEquals(mgr.active().includes("test"), true);

  await new Promise((r) => setTimeout(r, 80));
  assertEquals(dispatched, [{ type: "Fired" }]);
  assertEquals(mgr.active().includes("test"), false); // auto-removed
});

Deno.test("manager: every fires repeatedly, cancel stops it", async () => {
  const dispatched: { type: string }[] = [];
  const mgr = createScheduleManager((a) => dispatched.push(a), noop);

  mgr.handle(schedule.every("tick", 30, { type: "Tick" }));
  await new Promise((r) => setTimeout(r, 85));
  const count = dispatched.length;
  assertEquals(count >= 2, true, `expected >=2, got ${count}`);

  mgr.handle(schedule.cancel("tick"));
  assertEquals(mgr.active().includes("tick"), false);

  const countAfterCancel = dispatched.length;
  await new Promise((r) => setTimeout(r, 60));
  assertEquals(dispatched.length, countAfterCancel); // no more fires
});

Deno.test("manager: at fires at specified time", async () => {
  const dispatched: { type: string }[] = [];
  const mgr = createScheduleManager((a) => dispatched.push(a), noop);

  const target = new Date(Date.now() + 50).toISOString();
  mgr.handle(schedule.at("soon", target, { type: "AtFire" }));

  await new Promise((r) => setTimeout(r, 100));
  assertEquals(dispatched, [{ type: "AtFire" }]);
  assertEquals(mgr.active().includes("soon"), false);
});

Deno.test("manager: at with past time is skipped (AIO-236)", () => {
  const dispatched: { type: string }[] = [];
  const mgr = createScheduleManager((a) => dispatched.push(a), noop);

  const past = new Date(Date.now() - 10_000).toISOString();
  mgr.handle(schedule.at("old", past, { type: "PastFire" }));

  // Past time should be skipped — no timer created, no dispatch
  assertEquals(dispatched, []);
  assertEquals(mgr.active().length, 0);
});

Deno.test("manager: at with invalid date string throws", () => {
  const mgr = createScheduleManager(() => {}, noop);
  assertThrows(
    () => mgr.handle(schedule.at("bad", "garbage", { type: "X" })),
    Error,
    "invalid schedule.at time",
  );
  assertEquals(mgr.active().length, 0);
});

Deno.test("manager: cancel is no-op for unknown id", () => {
  const mgr = createScheduleManager(() => {}, noop);
  mgr.handle(schedule.cancel("nonexistent")); // should not throw
  assertEquals(mgr.active().length, 0);
});

Deno.test("manager: re-schedule same id replaces previous", async () => {
  const dispatched: { type: string }[] = [];
  const mgr = createScheduleManager((a) => dispatched.push(a), noop);

  mgr.handle(schedule.after("x", 200, { type: "Old" }));
  mgr.handle(schedule.after("x", 50, { type: "New" }));

  await new Promise((r) => setTimeout(r, 80));
  assertEquals(dispatched, [{ type: "New" }]); // Old was replaced, never fires

  await new Promise((r) => setTimeout(r, 200));
  assertEquals(dispatched.length, 1); // still just 1
});

Deno.test("manager: cancelAll clears everything", async () => {
  const dispatched: { type: string }[] = [];
  const mgr = createScheduleManager((a) => dispatched.push(a), noop);

  mgr.handle(schedule.after("a", 50, { type: "A" }));
  mgr.handle(schedule.every("b", 30, { type: "B" }));
  assertEquals(mgr.active().length, 2);

  mgr.cancelAll();
  assertEquals(mgr.active().length, 0);

  await new Promise((r) => setTimeout(r, 100));
  assertEquals(dispatched.length, 0); // nothing fired
});

Deno.test("manager: start boots config-level schedules", async () => {
  const dispatched: { type: string }[] = [];
  const mgr = createScheduleManager((a) => dispatched.push(a), noop);

  mgr.start([
    { id: "heartbeat", every: 30, action: { type: "Heartbeat" } },
    { id: "once", after: 50, action: { type: "Once" } },
  ]);
  assertEquals(mgr.active().length, 2);

  await new Promise((r) => setTimeout(r, 80));
  const hbCount = dispatched.filter((a) => a.type === "Heartbeat").length;
  assertEquals(
    hbCount >= 2,
    true,
    `heartbeat should fire >=2 times, got ${hbCount}`,
  );
  assertEquals(dispatched.some((a) => a.type === "Once"), true);

  mgr.cancelAll();
});

// ── Cron parser ─────────────────────────────────────────────────────

Deno.test("parseCron: every minute (* * * * *)", () => {
  const f = parseCron("* * * * *");
  assertEquals(f.minute.length, 60);
  assertEquals(f.hour.length, 24);
  assertEquals(f.dom.length, 31);
  assertEquals(f.month.length, 12);
  assertEquals(f.dow.length, 7);
});

Deno.test("parseCron: every 5 minutes (*/5 * * * *)", () => {
  const f = parseCron("*/5 * * * *");
  assertEquals(f.minute, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
});

Deno.test("parseCron: Monday 9am (0 9 * * 1)", () => {
  const f = parseCron("0 9 * * 1");
  assertEquals(f.minute, [0]);
  assertEquals(f.hour, [9]);
  assertEquals(f.dow, [1]);
});

Deno.test("parseCron: :00 and :30 (0,30 * * * *)", () => {
  const f = parseCron("0,30 * * * *");
  assertEquals(f.minute, [0, 30]);
});

// Every cron refusal names the FIELD and echoes the PATTERN. `invalid cron
// range: 1-70 (0-59)` said neither, so a reader holding "0 1-70 * * *" had to
// deduce that "(0-59)" meant minutes; the step branch beside it had named its
// fix all along.
Deno.test("parseCron: invalid pattern throws, naming the field and echoing the pattern", () => {
  assertThrows(() => parseCron("* * *"), Error, "5 space-separated fields");
  const v = assertThrows(() => parseCron("99 * * * *"), Error);
  assertStringIncludes((v as Error).message, 'invalid value "99"');
  assertStringIncludes((v as Error).message, "minute field");
  assertStringIncludes((v as Error).message, '"99 * * * *"');
  const st = assertThrows(() => parseCron("*/0 * * * *"), Error);
  assertStringIncludes((st as Error).message, 'invalid step "*/0"');
  assertStringIncludes((st as Error).message, "minute field");
  // The field named is the field that is wrong — not always the first one.
  const dow = assertThrows(() => parseCron("* * * * 9"), Error);
  assertStringIncludes((dow as Error).message, "day-of-week field");
});

Deno.test("nextCronTime: computes correct next fire", () => {
  const fields = parseCron("0,30 * * * *"); // every half hour
  const after = new Date("2026-03-01T10:15:00Z");
  const next = nextCronTime(fields, after);
  assertEquals(next.getUTCMinutes(), 30);
  assertEquals(next.getUTCHours(), 10);
});

Deno.test("nextCronTime: every minute fires within 1 minute", () => {
  const fields = parseCron("* * * * *");
  const now = new Date();
  const next = nextCronTime(fields, now);
  const diffMs = next.getTime() - now.getTime();
  assertEquals(diffMs > 0, true);
  assertEquals(diffMs <= 60_000, true);
});

Deno.test("nextCronTime: specific day-of-week", () => {
  const fields = parseCron("0 9 * * 1"); // Monday 9:00
  const wednesday = new Date("2026-03-04T12:00:00Z"); // Wednesday
  const next = nextCronTime(fields, wednesday);
  assertEquals(next.getUTCDay(), 1); // Monday
  assertEquals(next.getUTCHours(), 9);
  assertEquals(next.getUTCMinutes(), 0);
});

// ── Manager: cron ───────────────────────────────────────────────────

Deno.test("manager: cron schedules next fire", () => {
  const mgr = createScheduleManager(() => {}, noop);
  mgr.handle(schedule.cron("every-min", "* * * * *", { type: "Tick" }));
  assertEquals(mgr.active().includes("every-min"), true);
  mgr.cancelAll();
});

// ── Cron parser edge cases ──────────────────────────────────────────

Deno.test("parseCron: range with step (1-5/2 * * * *)", () => {
  const f = parseCron("1-5/2 * * * *");
  assertEquals(f.minute, [1, 3, 5]);
});

Deno.test("parseCron: multiple ranges (1-3,7-9 * * * *)", () => {
  const f = parseCron("1-3,7-9 * * * *");
  assertEquals(f.minute, [1, 2, 3, 7, 8, 9]);
});

Deno.test("parseCron: weekday range (0 9 * * 1-5)", () => {
  const f = parseCron("0 9 * * 1-5");
  assertEquals(f.dow, [1, 2, 3, 4, 5]);
});

Deno.test("parseCron: month range (0 0 1 6-8 *)", () => {
  const f = parseCron("0 0 1 6-8 *");
  assertEquals(f.month, [6, 7, 8]);
});

Deno.test("parseCron: invalid range throws (5-1 * * * *)", () => {
  const e = assertThrows(() => parseCron("5-1 * * * *"), Error);
  assertStringIncludes((e as Error).message, 'invalid range "5-1"');
  assertStringIncludes((e as Error).message, "minute field");
  assertStringIncludes((e as Error).message, "low end first");
});

Deno.test("parseCron: step on month (0 0 * */3 *)", () => {
  const f = parseCron("0 0 * */3 *");
  assertEquals(f.month, [1, 4, 7, 10]);
});

Deno.test("parseCron: dom range (0 0 10-15 * *)", () => {
  const f = parseCron("0 0 10-15 * *");
  assertEquals(f.dom, [10, 11, 12, 13, 14, 15]);
});

Deno.test("parseCron: single values all fields (30 14 15 6 3)", () => {
  const f = parseCron("30 14 15 6 3");
  assertEquals(f.minute, [30]);
  assertEquals(f.hour, [14]);
  assertEquals(f.dom, [15]);
  assertEquals(f.month, [6]);
  assertEquals(f.dow, [3]);
});

// ── nextCronTime edge cases ─────────────────────────────────────────

Deno.test("nextCronTime: wraps to next day", () => {
  const fields = parseCron("0 9 * * *"); // 9:00 daily
  const after = new Date("2026-03-01T10:00:00Z"); // already past 9:00
  const next = nextCronTime(fields, after);
  assertEquals(next.getUTCDate(), 2); // next day
  assertEquals(next.getUTCHours(), 9);
});

Deno.test("nextCronTime: wraps to next month", () => {
  const fields = parseCron("0 0 1 * *"); // 1st of each month
  const after = new Date("2026-03-15T00:00:00Z"); // past the 1st
  const next = nextCronTime(fields, after);
  assertEquals(next.getUTCMonth(), 3); // April (0-indexed)
  assertEquals(next.getUTCDate(), 1);
});

Deno.test("nextCronTime: yearly pattern", () => {
  const fields = parseCron("0 0 1 1 *"); // Jan 1st midnight
  const after = new Date("2026-03-01T00:00:00Z");
  const next = nextCronTime(fields, after);
  assertEquals(next.getUTCFullYear(), 2027);
  assertEquals(next.getUTCMonth(), 0); // January
});

// ── Schedule manager edge cases ─────────────────────────────────────

Deno.test("manager: cancelByPrefix cancels matching timers", async () => {
  const dispatched: { type: string }[] = [];
  const mgr = createScheduleManager((a) => dispatched.push(a), noop);
  mgr.handle(schedule.after("cell:a", 50, { type: "A" }));
  mgr.handle(schedule.after("cell:b", 50, { type: "B" }));
  mgr.handle(schedule.after("other:c", 50, { type: "C" }));
  assertEquals(mgr.active().length, 3);
  mgr.cancelByPrefix("cell"); // AIO-198: prefix without colon — code appends ":"
  assertEquals(mgr.active(), ["other:c"]);
  await new Promise((r) => setTimeout(r, 80));
  assertEquals(dispatched, [{ type: "C" }]); // only other:c fired
  mgr.cancelAll();
});

Deno.test("manager: invalid schedule id throws", () => {
  const mgr = createScheduleManager(() => {}, noop);
  assertThrows(
    () => mgr.handle(schedule.after("bad id!", 100, { type: "X" })),
    Error,
    "invalid schedule id",
  );
  assertThrows(
    () => mgr.handle(schedule.after("", 100, { type: "X" })),
    Error,
    "invalid schedule id",
  );
});

Deno.test("manager: start with cron schedule creates active timer", () => {
  const mgr = createScheduleManager(() => {}, noop);
  mgr.start([{
    id: "cron-job",
    cron: "0 * * * *",
    action: { type: "Hourly" },
  }]);
  assertEquals(mgr.active().includes("cron-job"), true);
  mgr.cancelAll();
});

Deno.test("manager: start with at schedule creates active timer", () => {
  const mgr = createScheduleManager(() => {}, noop);
  const future = new Date(Date.now() + 60_000).toISOString();
  mgr.start([{ id: "timed", at: future, action: { type: "Future" } }]);
  assertEquals(mgr.active().includes("timed"), true);
  mgr.cancelAll();
});

Deno.test("schedule #5: dynamic schedule reusing a static id warns once", () => {
  const warnings: string[] = [];
  const log = { ...noop, warn: (m: string) => warnings.push(m) };
  // deno-lint-ignore no-explicit-any
  const mgr = createScheduleManager(() => {}, log as any);
  mgr.start([{ id: "poll", every: 1000, action: { type: "tick" } }]);
  mgr.handle(schedule.every("poll", 1000, { type: "tick" })); // same id → collision
  mgr.handle(schedule.every("poll", 1000, { type: "tick" })); // again → no dup warn
  mgr.cancelAll();
  assertEquals(
    warnings.filter((w) => w.includes("both statically")).length,
    1,
  );
  assertEquals(warnings[0]!.includes("poll"), true);
});

Deno.test("schedule #5: a fresh dynamic id does NOT warn", () => {
  const warnings: string[] = [];
  const log = { ...noop, warn: (m: string) => warnings.push(m) };
  // deno-lint-ignore no-explicit-any
  const mgr = createScheduleManager(() => {}, log as any);
  mgr.start([{ id: "poll", every: 1000, action: { type: "tick" } }]);
  mgr.handle(schedule.every("other", 1000, { type: "tick" }));
  mgr.cancelAll();
  assertEquals(warnings.length, 0);
});

Deno.test("schedule.backoff: exponential growth, capped at max", () => {
  const A = { type: "poll" };
  const e0 = schedule.backoff("rpc", 0, A, { base: 1000, max: 60000 });
  const e1 = schedule.backoff("rpc", 1, A, { base: 1000, max: 60000 });
  const e2 = schedule.backoff("rpc", 2, A, { base: 1000, max: 60000 });
  const e9 = schedule.backoff("rpc", 9, A, { base: 1000, max: 60000 });
  assertEquals((e0 as { ms: number }).ms, 1000); // base * 2^0
  assertEquals((e1 as { ms: number }).ms, 2000); // base * 2^1
  assertEquals((e2 as { ms: number }).ms, 4000); // base * 2^2
  assertEquals((e9 as { ms: number }).ms, 60000); // capped at max
  assertEquals((e0 as { kind: string }).kind, "after");
  assertEquals((e0 as { id: string }).id, "rpc");
  // custom factor
  const t = schedule.backoff("x", 2, A, { base: 100, factor: 3 });
  assertEquals((t as { ms: number }).ms, 900); // 100 * 3^2
});

Deno.test("schedule.next: defers to next tick", () => {
  const e = schedule.next("rescan", { type: "rescan" }) as {
    kind: string;
    ms: number;
    id: string;
  };
  assertEquals(e.kind, "after");
  // alpha52: a TRUE 0ms timer — `after` accepts 0 now, so `next` no longer
  // carries a 1ms sentinel.
  assertEquals(e.ms, 0);
  assertEquals(e.id, "rescan");
});

Deno.test("schedule.poll: constant while healthy, backs off on failure", () => {
  const A = { type: "tick" };
  // healthy (attempt 0) → the base interval
  assertEquals(
    (schedule.poll("rpc", 0, A, { every: 5000, factor: 2, max: 60000 }) as {
      ms: number;
    }).ms,
    5000,
  );
  // failing → grows every * backoff^attempt, capped at max
  assertEquals(
    (schedule.poll("rpc", 1, A, { every: 5000, factor: 2, max: 60000 }) as {
      ms: number;
    }).ms,
    10000,
  );
  assertEquals(
    (schedule.poll("rpc", 3, A, { every: 5000, factor: 2, max: 60000 }) as {
      ms: number;
    }).ms,
    40000,
  );
  assertEquals(
    (schedule.poll("rpc", 5, A, { every: 5000, factor: 2, max: 60000 }) as {
      ms: number;
    }).ms,
    60000,
  ); // capped
  // default backoff = 1 → constant polling regardless of attempt
  assertEquals(
    (schedule.poll("rpc", 4, A, { every: 3000 }) as { ms: number }).ms,
    3000,
  );
  const e = schedule.poll("rpc", 0, A, { every: 1000 }) as {
    kind: string;
    id: string;
  };
  assertEquals(e.kind, "after");
  assertEquals(e.id, "rpc");
});

// ── alpha52: backoff/poll argument order + `factor` key + 0ms after ──────

Deno.test("schedule.backoff NEW order: (id, attempt, action, opts)", () => {
  const A = { type: "poll" };
  const e = schedule.backoff("rpc2", 3, A, { base: 1000, max: 60_000 }) as {
    kind: string;
    ms: number;
    action: { type: string };
  };
  assertEquals(e.kind, "after");
  assertEquals(e.ms, 8000); // 1000 * 2^3
  assertEquals(e.action.type, "poll");
  // custom factor in the new order
  assertEquals(
    (schedule.backoff("x2", 2, A, { base: 100, factor: 3 }) as { ms: number })
      .ms,
    900,
  );
});

Deno.test("schedule.poll NEW order + `factor` key: (id, attempt, action, opts)", () => {
  const A = { type: "tick" };
  assertEquals(
    (schedule.poll("rpc3", 0, A, { every: 5000, factor: 2, max: 60_000 }) as {
      ms: number;
    }).ms,
    5000,
  );
  assertEquals(
    (schedule.poll("rpc3", 3, A, { every: 5000, factor: 2, max: 60_000 }) as {
      ms: number;
    }).ms,
    40_000,
  );
});

Deno.test("schedule.backoff/poll: the pre-alpha52 (opts, action) order is REFUSED by name (alpha70)", () => {
  const A = { type: "poll" };
  // Detected by shape, so the refusal names the old order and the fix —
  // not `opts.base is undefined` three frames down.
  const oldB = assertThrows(
    () => (schedule.backoff as AnyFn)("legacy-b", 3, { base: 1000 }, A),
    Error,
  ) as Error;
  assertStringIncludes(oldB.message, "schedule.backoff 'legacy-b'");
  assertStringIncludes(oldB.message, "removed in alpha70");
  assertStringIncludes(oldB.message, "am pin v1.0.0-alpha69");
  const oldP = assertThrows(
    () => (schedule.poll as AnyFn)("legacy-p", 2, { every: 100 }, A),
    Error,
  ) as Error;
  assertStringIncludes(oldP.message, "schedule.poll 'legacy-p'");
  assertStringIncludes(oldP.message, "action is 3rd");
});

Deno.test("schedule.poll: the `backoff` option key is REFUSED by name — `factor` is the spelling (alpha70)", () => {
  const A = { type: "tick" };
  const e = assertThrows(
    () => (schedule.poll as AnyFn)("rpc-key", 2, A, { every: 100, backoff: 2 }),
    Error,
  ) as Error;
  assertStringIncludes(e.message, "schedule.poll 'rpc-key'");
  assertStringIncludes(e.message, "factor");
  assertStringIncludes(e.message, "am pin v1.0.0-alpha69");
  // The new key computes the same thing the old one did.
  const ok = schedule.poll("rpc-key2", 2, A, { every: 100, factor: 2 }) as {
    ms: number;
  };
  assertEquals(ok.ms, 400);
});

Deno.test("schedule has NO `blocking` member — `blocking` is a top-level, server-only export (alpha70)", () => {
  assertEquals(
    "blocking" in schedule,
    false,
    "schedule ships to every runtime; a member that is server-only on two of " +
      "three targets is a trap, not an API",
  );
});

Deno.test("schedule.after accepts 0ms (alpha52) and still rejects negatives", () => {
  const dispatched: string[] = [];
  const noop = { info() {}, warn() {}, error() {}, debug() {} };
  const timers = createVirtualTimers();
  const m = createScheduleManager(
    (a) => void dispatched.push(a.type),
    noop,
    { timers },
  );
  m.handle(schedule.next("n0", { type: "x:go" })); // ms: 0 — a real timer now
  timers.advance(0);
  assertEquals(dispatched, ["x:go"], "0ms fires on the next tick");
  assertThrows(
    () => m.handle(schedule.after("neg", -1, { type: "x:go" })),
    Error,
    ">= 0",
  );
});
