// The harness must be the STRICTEST environment, never the most permissive.
//
// `src/standalone-air.ts` — the runtime behind testCell/testUI/bootCells (and
// Android standalone builds) — used to RE-IMPLEMENT the scheduler to get a
// deterministic clock. Everything the copy did not re-implement became a rule
// tests could not see:
//
//   production                          the old harness copy
//   ------------------------------      ----------------------------------
//   after: throws when ms < 1           Math.max(1, ms)
//   every: throws when ms < 10          Math.max(1, ms)
//   id must match /^[\w\-:.]+$/         no validation at all
//   skipIfRunning drops a tick          ignored — every tick ran
//   at / cron fire                      dropped with a console warn
//   disable ⇒ cancelByPrefix            never wired
//
// So `schedule.every('fast tick!', 5, …)` was green in a test and refused
// twice over by the app it was a test OF. Now the harness drives the REAL
// manager on a virtual clock — the clock is the only thing swapped.
import { assert, assertEquals } from "@std/assert";
import { cell, schedule } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";

const fires: string[] = [];

const poll = cell("hpoll", {
  state: { n: 0, started: false },
  methods: {
    // Below the production floor for `every` (10ms) — must be refused HERE too.
    startTooFast(s) {
      s.started = true;
      s.$do(schedule.every("hpoll:fast", 5, { type: "hpoll:tick" }));
    },
    // An id production rejects (spaces).
    startBadId(s) {
      s.started = true;
      s.$do(schedule.every("bad id!", 1000, { type: "hpoll:tick" }));
    },
    startOk(s) {
      s.started = true;
      s.$do(schedule.every("hpoll:ok", 100, { type: "hpoll:tick" }));
    },
    tick(s: { n: number }) {
      s.n++;
      fires.push("tick");
    },
    stop(s) {
      s.$do(schedule.cancel("hpoll:ok"));
    },
  },
});
const P = poll as unknown as {
  startTooFast: () => Promise<void>;
  startBadId: () => Promise<void>;
  startOk: () => Promise<void>;
  stop: () => Promise<void>;
  n: number;
};

Deno.test("harness: a sub-floor `every` is refused, exactly as in production", async () => {
  fires.length = 0;
  await using h = await bootCells([poll]);
  await P.startTooFast();
  await h.advance(1000); // 200 ticks' worth, if it had been armed
  assertEquals(
    P.n,
    0,
    "the harness must not run a schedule production refuses to arm",
  );
});

Deno.test("harness: an invalid schedule id is refused, exactly as in production", async () => {
  fires.length = 0;
  await using h = await bootCells([poll]);
  await P.startBadId();
  await h.advance(5000);
  assertEquals(P.n, 0, "an id production rejects must not tick in a test");
});

Deno.test("harness: a valid schedule still fires on the virtual clock", async () => {
  fires.length = 0;
  await using h = await bootCells([poll]);
  await P.startOk();
  await h.advance(350);
  assertEquals(P.n, 3);
  await P.stop();
  await h.advance(1000);
  assertEquals(P.n, 3, "cancel still cancels");
});

// ── at / cron now work in the harness ───────────────────────────────

const timed = cell("htimed", {
  state: { fired: 0 },
  methods: {
    atSoon(s) {
      // The harness clock starts at the real Date.now(), so an absolute time
      // is expressed relative to it.
      const when = new Date(Date.now() + 60_000).toISOString();
      s.$do(schedule.at("htimed:at", when, { type: "htimed:mark" }));
    },
    everyMinute(s) {
      s.$do(schedule.cron("htimed:cron", "* * * * *", { type: "htimed:mark" }));
    },
    mark(s: { fired: number }) {
      s.fired++;
    },
  },
});
const T = timed as unknown as {
  atSoon: () => Promise<void>;
  everyMinute: () => Promise<void>;
  fired: number;
};

Deno.test("harness: schedule.at fires instead of being dropped with a warning", async () => {
  await using h = await bootCells([timed]);
  await T.atSoon();
  await h.advance(59_000);
  assertEquals(T.fired, 0);
  await h.advance(2_000);
  assertEquals(T.fired, 1, "`at` is testable now, not a console warning");
});

Deno.test("harness: schedule.cron fires on the virtual clock", async () => {
  await using h = await bootCells([timed]);
  await T.everyMinute();
  await h.advance(3 * 60_000 + 1000);
  assert(T.fired >= 3, `cron ticked ${T.fired} times in 3 minutes`);
});
