// `aio.run({ schedules })` refused a non-action by name, but the `schedule.*`
// builders took anything: `schedule.after("t", 5000, "timer:tick")` returned
// ok from the method and detonated at FIRE time as a REDUCE_ERROR for reducer
// "?" ("reading 'endsWith'"), naming neither the schedule nor the mistake.
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  createScheduleManager,
  createVirtualTimers,
  schedule,
} from "../src/state/schedule.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
const S = schedule as any;

Deno.test("schedule builders: a string or type-less action is refused at the call, by name", async () => {
  for (const bad of ["t:tick", undefined, null, { payload: 1 }, { type: "" }]) {
    for (
      const [api, call] of [
        ["after", () => S.after("t", 10, bad)],
        ["every", () => S.every("t", 10, bad)],
        ["at", () => S.at("t", "2099-01-01T00:00:00Z", bad)],
        ["cron", () => S.cron("t", "0 3 * * *", bad)],
        ["next", () => S.next("t", bad)],
      ] as const
    ) {
      const m = assertThrows(call, Error).message;
      assertStringIncludes(m, `schedule.${api} 't': action is`);
    }
  }
  // A hand-built effect reaching the manager is refused there, not at fire.
  const mgr = createScheduleManager(
    () => Promise.resolve(),
    { info() {}, warn() {}, error() {}, debug() {} },
    { timers: createVirtualTimers(0) },
  );
  assertThrows(
    () =>
      mgr.handle(
        {
          type: "__schedule",
          kind: "after",
          id: "h",
          ms: 10,
          action: "t:tick",
        } as never,
      ),
    Error,
    "action is",
  );
  assertEquals(mgr.active(), []);

  // …and through a method: the CALL fails instead of an ok call whose timer
  // blows up later.
  const c = cell("sbna", {
    state: { n: 0 },
    methods: {
      arm(s) {
        s.$do(S.after("sbna:x", 10, "sbna:tick"));
      },
      tick(s) {
        s.n++;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    let err: unknown = null;
    try {
      // deno-lint-ignore no-explicit-any
      await (c as any).arm();
    } catch (e) {
      err = e;
    }
    assertStringIncludes(String(err), "schedule.after 'sbna:x': action is");
  } finally {
    h.dispose();
  }
});
