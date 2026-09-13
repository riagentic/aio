// A schedule typo fails WHERE IT IS WRITTEN — in the method that built it.
//
// docs/state/scheduling.md: "a typo should fail where it is written, not
// quietly disappear at the first fire attempt". The checks lived only in the
// schedule MANAGER, which runs when the effect is executed — after the method
// returned and its call was answered. So `schedule.cron("c", "0 0 30 2 *", …)`
// inside a method resolved `await cell.method()` (and `am dispatch` said ok),
// and the refusal arrived later as an `EFFECT_ERROR` on `__schedule` naming no
// line of the app. The `schedule.*` builders now run the same checks.
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { cell, schedule, self } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { MAX_TIMER_DELAY } from "../src/state/schedule.ts";

const A = { type: "x:tick" };

Deno.test("builders: an impossible cron throws at schedule.cron()", () => {
  assertThrows(
    () => schedule.cron("c", "0 0 30 2 *", A),
    Error,
    "can never fire",
  );
  assertThrows(() => schedule.cron("c", "not a cron", A), Error);
  // Sparse but real patterns still build.
  assertEquals(schedule.cron("leap", "0 0 29 2 *", A).kind, "cron");
});

Deno.test("builders: every past the setInterval ceiling throws at schedule.every()", () => {
  const err = assertThrows(
    () => schedule.every("monthly", MAX_TIMER_DELAY + 1, A),
    Error,
    "setInterval ceiling",
  );
  assertEquals(err.message.includes("cron"), true, "the refusal names the fix");
  assertEquals(schedule.every("edge", MAX_TIMER_DELAY, A).kind, "every");
  assertThrows(() => schedule.every("fast", 5, A), Error, ">= 10");
  assertThrows(
    () => schedule.every("str", "5m" as unknown as number, A),
    Error,
    "plain NUMBER",
  );
});

Deno.test("builders: an invalid id throws at every builder", () => {
  const bad = "has space";
  assertThrows(() => schedule.after(bad, 10, A), Error, "invalid schedule id");
  assertThrows(() => schedule.every(bad, 10, A), Error, "invalid schedule id");
  assertThrows(
    () => schedule.at(bad, "2099-01-01T00:00:00Z", A),
    Error,
    "invalid schedule id",
  );
  assertThrows(
    () => schedule.cron(bad, "* * * * *", A),
    Error,
    "invalid schedule id",
  );
  assertThrows(() => schedule.next(bad, A), Error, "invalid schedule id");
  assertThrows(() => schedule.cancel(bad), Error, "invalid schedule id");
  assertThrows(
    () => schedule.backoff(bad, 0, A, { base: 10 }),
    Error,
    "invalid schedule id",
  );
  assertThrows(
    () => schedule.poll(bad, 0, A, { every: 10 }),
    Error,
    "invalid schedule id",
  );
});

Deno.test("builders: bad after/at values throw at the builder", () => {
  assertThrows(() => schedule.after("a", -1, A), Error, ">= 0");
  assertThrows(() => schedule.after("a", NaN, A), Error, "finite");
  assertThrows(
    () => schedule.at("a", "tomorrow-ish", A),
    Error,
    "invalid schedule.at time",
  );
  // A time in the past is not a typo — the manager warns about it when armed.
  assertEquals(schedule.at("a", "2020-01-01T00:00:00Z", A).kind, "at");
});

Deno.test("a method that writes the typo is the call that FAILS", async () => {
  const hw = cell("hwbadsched", {
    state: { n: 0 },
    methods: {
      badCron(s) {
        s.n++;
        s.$do(schedule.cron("c", "0 0 30 2 *", self("tick")));
      },
      longEvery(s) {
        s.$do(schedule.every("big", 30 * 86_400_000, self("tick")));
      },
      badId(s) {
        s.$do(schedule.after("has space", 10, self("tick")));
      },
      tick(s) {
        s.n++;
      },
    },
  });
  await using _h = await bootCells([hw]);
  await assertRejects(() => hw.badCron(), Error, "can never fire");
  assertEquals(hw.n, 0, "the refused method commits nothing");
  await assertRejects(() => hw.longEvery(), Error, "setInterval ceiling");
  await assertRejects(() => hw.badId(), Error, "invalid schedule id");
});
