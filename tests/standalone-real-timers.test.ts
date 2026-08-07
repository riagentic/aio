// The standalone runtime must use REAL timers unless a test opts out.
//
// `src/standalone-air.ts` is not only the test harness's runtime — it is the
// runtime that ships inside an Android APK. It created a VIRTUAL clock
// unconditionally, and nothing in a shipped app ever advances one, so every
// `after`, `every`, `at` and `cron` was registered and then silently never
// fired. A dead timer with no error anywhere: the exact "silently stops
// firing" class, in production only, invisible to every test because the
// harness drove the clock by hand.
//
// Virtual time is now opt-in (`_useVirtualSchedules()`, called by bootCells
// and testUI). This pins the DEFAULT, which is the half that ships.
import { assert } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { schedule } from "../src/state/schedule.ts";

Deno.test({
  name:
    "standalone: schedules fire on REAL time when nobody opted into virtual",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    _resetAioRuntime();
    // A fresh module instance: the timer host is fixed when the first
    // schedule registers, so a prior import that opted in would mask this.
    const standalone = await import(
      `../src/standalone-air.ts#${crypto.randomUUID()}`
    );
    let fired = 0;
    const ticker = cell("real-timer-probe", {
      state: { n: 0 },
      methods: {
        tick(s: { n: number }) {
          s.n += 1;
          fired++;
        },
        start(_s: unknown) {
          return schedule.after("probe:tick", 20, {
            type: "real-timer-probe:tick",
          });
        },
      },
    });
    await standalone.aio.run({
      appId: "real-timer-probe-app",
      // deno-lint-ignore no-explicit-any
      cells: [ticker] as any,
      persist: false,
      // deno-lint-ignore no-explicit-any
    } as any);
    // deno-lint-ignore no-explicit-any
    await (ticker as any).start();

    // Wall-clock wait — NOBODY advances a virtual clock here, which is
    // precisely the production situation.
    await new Promise((r) => setTimeout(r, 300));
    assert(
      fired > 0,
      "a schedule must fire on real time in a shipped app — it used to be " +
        "registered against a virtual clock nothing advances, and never fired",
    );
    standalone._resetState();
    _resetAioRuntime();
  },
});
