// `schedule.every(…, { skipIfRunning: true })` against a REALLY booted async
// method — not a stub dispatcher.
//
// tests/schedule-skip-if-running.test.ts pins the manager with a stub whose
// dispatch promise lasts as long as the whole tick. A real dispatch does not:
// it settles when the TRIGGER is reduced and its `__exec` effect has started
// the method, which is the method's first `await`, not its end. So the guard
// was released at once and never skipped anything — a 1300 ms poll every
// 500 ms ran three copies at a time in a real dev app, and six under
// bootCells + advance. The tick's lifetime is the METHOD's settlement: the
// same `_callId` registration `await cell.method()` waits on.
import { assert, assertEquals } from "@std/assert";
import { cell, schedule, self } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import {
  createScheduleManager,
  createVirtualTimers,
} from "../src/state/schedule.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("skipIfRunning: an async method's tick holds the guard until the METHOD settles", async () => {
  const poller = cell("skipreal", {
    state: { polls: 0, running: 0, maxRunning: 0 },
    methods: {
      start(s) {
        s.$do(
          schedule.every("poll", 100, self("poll"), { skipIfRunning: true }),
        );
      },
      stop(s) {
        s.$do(schedule.cancel("poll"));
      },
      async poll(s) {
        s.polls++;
        s.running++;
        s.maxRunning = Math.max(s.maxRunning, s.running);
        await sleep(60); // a real await: the dispatch settled long before this
        s.running--;
      },
    },
  });
  await using h = await bootCells([poller]);
  await poller.start();
  // One advance crosses six intervals, back to back, while the FIRST tick is
  // still in its real 60 ms await (the virtual clock does not wait for it).
  await h.advance(600);
  assertEquals(
    poller.polls,
    1,
    "every tick after the first must be skipped while it runs — the guard " +
      "was released at the trigger's reduce",
  );
  assertEquals(poller.maxRunning, 1);
  // advance() settled the in-flight call, so the method has finished: the
  // next tick runs.
  assertEquals(poller.running, 0);
  await h.advance(100);
  assertEquals(
    poller.polls,
    2,
    "the guard must release when the method settles",
  );
  await poller.stop();
});

Deno.test("skipIfRunning: a SYNC method's tick is never skipped (bootCells)", async () => {
  const counter = cell("skipsync", {
    state: { n: 0 },
    methods: {
      start(s) {
        s.$do(
          schedule.every("tick", 50, self("tick"), { skipIfRunning: true }),
        );
      },
      tick(s) {
        s.n++;
      },
    },
  });
  await using h = await bootCells([counter]);
  await counter.start();
  await h.advance(500);
  assertEquals(
    counter.n,
    10,
    "a sync tick settles in its reduce — nothing to skip",
  );
});

Deno.test("skipIfRunning: a tick whose async method THROWS still releases the guard", async () => {
  const flaky = cell("skipthrow", {
    state: { tries: 0 },
    methods: {
      start(s) {
        s.$do(schedule.every("t", 50, self("go"), { skipIfRunning: true }));
      },
      async go(s) {
        s.tries++;
        await sleep(5);
        throw new Error("boom");
      },
    },
  });
  await using h = await bootCells([flaky]);
  await flaky.start();
  for (let i = 0; i < 3; i++) {
    await h.advance(50);
    await sleep(20);
  }
  assert(
    flaky.tries >= 3,
    `a thrown tick wedged the schedule (${flaky.tries})`,
  );
});

Deno.test("skipIfRunning: a dispatcher that knows no calls still releases on its own settlement", async () => {
  // The manager's other contract: a dispatch whose promise is the whole tick
  // (no `_callId` executor behind it) must not wedge on a registration nobody
  // will settle.
  const clock = createVirtualTimers();
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
  let started = 0;
  const m = createScheduleManager(
    (() => {
      started++;
      return Promise.resolve();
    }) as never,
    quiet as never,
    { timers: clock },
  );
  m.handle(
    schedule.every("plain", 20, { type: "nobody:tick" }, {
      skipIfRunning: true,
    }),
  );
  await clock.advance(100);
  m.cancelAll();
  assertEquals(started, 5);
});

Deno.test("skipIfRunning: a real server on real timers never runs two copies of an async tick", async () => {
  const { testServer } = await import("../src/testing/server-test.ts");
  const srvPoller = cell("skipsrv", {
    state: { polls: 0, running: 0, maxRunning: 0 },
    methods: {
      start(s) {
        s.$do(
          schedule.every("poll", 30, self("poll"), { skipIfRunning: true }),
        );
      },
      stop(s) {
        s.$do(schedule.cancel("poll"));
      },
      async poll(s) {
        s.polls++;
        s.running++;
        s.maxRunning = Math.max(s.maxRunning, s.running);
        await sleep(80); // ~3 intervals per tick
        s.running--;
      },
    },
  });
  await using _srv = await testServer({ cells: [srvPoller] });
  await srvPoller.start();
  await sleep(400);
  await srvPoller.stop();
  await sleep(120); // the last tick finishes inside the test
  assertEquals(
    srvPoller.maxRunning,
    1,
    "async ticks overlapped on a real server",
  );
  assert(
    srvPoller.polls >= 3,
    `the schedule must keep ticking (${srvPoller.polls})`,
  );
});

Deno.test("skipIfRunning: a tick past its call ceiling releases the guard OUT LOUD", async () => {
  // An executor that took the call (the method key is in flight) and never
  // answers. At the call ceiling the registration is gone, so the guard could
  // never be released again — it is released there, with a warning.
  const { _setCallTimeouts, _resetCallTimeouts } = await import(
    "../src/state/cell-impl.ts"
  );
  const { bumpPending } = await import("../src/protocol/pending-calls.ts");
  _setCallTimeouts(40);
  const warns: string[] = [];
  const log = {
    debug() {},
    info() {},
    warn: (m: string) => warns.push(m),
    error() {},
    trace() {},
  };
  const clock = createVirtualTimers();
  let started = 0;
  const m = createScheduleManager(
    (() => {
      started++;
      bumpPending("hung:poll", 1); // the executor started the method…
      return Promise.resolve(); // …and the dispatch settled at once
    }) as never,
    log as never,
    { timers: clock },
  );
  try {
    m.handle(
      schedule.every("hung", 20, { type: "hung:poll", payload: { args: [] } }, {
        skipIfRunning: true,
      }),
    );
    await clock.advance(100);
    assertEquals(started, 1, "the in-flight tick holds the guard");
    await sleep(80); // past the 40ms ceiling, in real time
    assert(
      warns.some((w) => w.includes("'hung'") && w.includes("call ceiling")),
      `no ceiling warning: ${JSON.stringify(warns)}`,
    );
    await clock.advance(20);
    assertEquals(started, 2, "the guard is released at the ceiling");
  } finally {
    m.cancelAll();
    bumpPending("hung:poll", -2);
    _resetCallTimeouts();
    const { resetPending } = await import("../src/state/cell-impl.ts");
    resetPending();
  }
});
