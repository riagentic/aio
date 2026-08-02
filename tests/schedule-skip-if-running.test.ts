// a field report, "things that would have made this app easier to write" #3:
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

// `safeDispatch` wrapped `dispatch(action)` in try/catch, but
// `dispatch` reports failure by REJECTING its promise, never by throwing
// synchronously. The handler therefore caught nothing that actually happens:
// the failure escaped as an unhandled rejection, and the retry / give-up paths
// were unreachable. Awaiting it makes them live — and a repeating schedule must
// survive a failed tick rather than switch itself off.
Deno.test("a rejected dispatch is handled, not left unhandled", async () => {
  const seen: string[] = [];
  const orig = globalThis.onunhandledrejection;
  const handler = (e: PromiseRejectionEvent) => {
    seen.push(String(e.reason));
    e.preventDefault();
  };
  globalThis.addEventListener(
    "unhandledrejection",
    handler as unknown as EventListener,
  );
  try {
    const m = manager(() => Promise.reject(new Error("dispatch refused")));
    m.handle(schedule.after("one-shot", 5, { type: "x:tick" }));
    await sleep(80);
    m.cancelAll();
    assertEquals(
      seen.filter((s) => s.includes("dispatch refused")),
      [],
      "the scheduler owns the failure — it must not surface as unhandled",
    );
  } finally {
    globalThis.removeEventListener(
      "unhandledrejection",
      handler as unknown as EventListener,
    );
    globalThis.onunhandledrejection = orig ?? null;
  }
});

Deno.test("a repeating schedule keeps ticking after a failure", async () => {
  let started = 0;
  const m = manager(() => {
    started++;
    return Promise.reject(new Error("transient"));
  });
  m.handle(schedule.every("poll", 20, { type: "x:tick" }));
  await sleep(90);
  m.cancelAll();
  assert(
    started >= 3,
    `one transient failure must not cancel a recurring job (${started})`,
  );
});

Deno.test("a dispatch refused because the loop CLOSED stops the schedule", async () => {
  let started = 0;
  const m = manager(() => {
    started++;
    return Promise.reject(
      Object.assign(new Error("dispatch after close()"), {
        code: "DISPATCH_CLOSED",
      }),
    );
  });
  m.handle(schedule.every("poll", 20, { type: "x:tick" }));
  await sleep(90);
  m.cancelAll();
  assertEquals(
    started,
    1,
    "there is nothing to retry into after shutdown — re-arming would " +
      "resurrect a timer cancelAll() just cleared",
  );
});
