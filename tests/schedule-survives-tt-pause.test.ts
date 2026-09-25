// Pausing time travel does not switch the app's schedules off.
//
// The paused door refuses every action with code DISPATCH_CLOSED (tagged
// `reason: "tt-paused"`), and the scheduler reads DISPATCH_CLOSED as "the app
// is shutting down": it cancelled the schedule, at debug level. So pressing
// pause — or undo, which pauses — in the debug panel silently killed every
// poller whose tick fell inside the pause, and after resume the app simply
// stopped polling until a restart.
import { assert, assertEquals } from "@std/assert";
import {
  createScheduleManager,
  createVirtualTimers,
  schedule,
} from "../src/state/schedule.ts";
import { TT_PAUSED } from "../src/state/dispatch.ts";

/** The paused door's refusal, as `dispatch.ts` builds it — with ITS tag, so
 *  the literal the scheduler matches cannot drift from the one the door sets. */
function pausedRefusal(): Error {
  const e = new Error("time travel is paused — action dropped, not applied");
  Object.assign(e, { code: "DISPATCH_CLOSED", reason: TT_PAUSED });
  return e;
}

Deno.test("schedule: a tick refused by PAUSED time travel keeps the schedule armed", async () => {
  let paused = false;
  let ran = 0;
  const errors: string[] = [];
  const timers = createVirtualTimers();
  const mgr = createScheduleManager(
    () => {
      if (paused) return Promise.reject(pausedRefusal());
      ran++;
      return Promise.resolve();
    },
    {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (m: string) => void errors.push(m),
    },
    { timers },
  );
  const action = { type: "poll:tick", payload: { args: [] } };
  mgr.handle(schedule.every("poll", 10, action));
  mgr.handle(schedule.cron("nightly", "* * * * *", action));
  // A one-shot due inside the pause fires once the pause ends — however long
  // it lasted — instead of giving up after its three failure retries.
  mgr.handle(
    schedule.after("once", 30, { type: "poll:once", payload: { args: [] } }),
  );
  await timers.advance(25);
  assertEquals(ran, 2);
  paused = true;
  await timers.advance(60_000); // every tick AND a cron slot land in the pause
  paused = false;
  assertEquals(
    mgr.active().sort(),
    ["nightly", "once", "poll"],
    "pause cancelled",
  );
  const before = ran;
  await timers.advance(5_000);
  assertEquals(mgr.active().sort(), ["nightly", "poll"], "the one-shot ran");
  assert(ran > before, "the poller never ticked again after resume");
  assertEquals(errors, [], "a developer's pause is not an app error");
});

Deno.test("schedule: a shutdown's DISPATCH_CLOSED still stops the schedule", async () => {
  const timers = createVirtualTimers();
  const mgr = createScheduleManager(
    () =>
      Promise.reject(
        Object.assign(new Error("dispatch after close()"), {
          code: "DISPATCH_CLOSED",
        }),
      ),
    { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    { timers },
  );
  mgr.handle(
    schedule.every("poll", 10, { type: "poll:tick", payload: { args: [] } }),
  );
  await timers.advance(15);
  assertEquals(mgr.active(), []);
});
