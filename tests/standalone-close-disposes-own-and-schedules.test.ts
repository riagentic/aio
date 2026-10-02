// Round-6 hunt: the standalone runtime's `app.close()` vs the server's.
//
// `src/server/shutdown.ts` Phase 7 ends every app's life by cancelling its
// schedules (`scheduleManager.cancelAll()`) and disposing every owned resource
// (`ownManager.disposeAll()`) — `own.set` is documented as "tie it to the
// cell's lifetime". `src/standalone-air.ts` `app.close()` (the Android APK's
// end of life) aborts, drains, flushes and destroys the cells — and never
// touches either manager. Only the harness-only `_resetState()` does. So on
// the standalone runtime an owned resource outlives the app that owned it,
// and an `every` schedule keeps firing into a closed dispatch.
import { assertEquals } from "@std/assert";
import { cell, own } from "../mod.ts";
import { schedule } from "../src/state/schedule.ts";
import { testServer } from "../src/testing/server-test.ts";

const events: string[] = [];

function makeCell(name: string) {
  return cell(name, {
    state: { ticks: 0 },
    methods: {
      start(s) {
        s.$do(own.set("res", () => {
          events.push(`${name}:acquire`);
          return () => events.push(`${name}:dispose`);
        }));
      },
    },
  });
}

Deno.test("server close(): an owned resource is disposed (baseline)", async () => {
  events.length = 0;
  const c = makeCell("r6ownsrv");
  const srv = await testServer({ cells: [c] });
  await c.start();
  assertEquals(events, ["r6ownsrv:acquire"]);
  await srv.close();
  assertEquals(events, ["r6ownsrv:acquire", "r6ownsrv:dispose"]);
});

Deno.test("standalone close(): an owned resource is disposed, as on the server", async () => {
  events.length = 0;
  const sa = await import("../src/standalone-air.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  sa._reset();
  try {
    const c = makeCell("r6ownsa");
    const app = await sa.aio.run({
      watch: false,
      appId: "r6ownsa",
      cells: [c],
      persist: false,
    });
    await c.start();
    assertEquals(events, ["r6ownsa:acquire"]);
    await app.close();
    // The app is over: whatever it owned must be released NOW — not at some
    // later harness reset that a real APK never performs.
    assertEquals(events, ["r6ownsa:acquire", "r6ownsa:dispose"]);
  } finally {
    sa._reset();
    _resetAioRuntime();
  }
});

Deno.test("standalone close(): an `every` schedule stops firing, as on the server", async () => {
  const sa = await import("../src/standalone-air.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  sa._reset();
  let fired = 0;
  const errors: string[] = [];
  const keep = console.error;
  const keepWarn = console.warn;
  try {
    const ticker = cell("r6ticker", {
      state: { n: 0 },
      methods: {
        begin(s) {
          s.$do(schedule.every("r6tick", 20, { type: "r6ticker:tick" }));
        },
        tick(s) {
          fired++;
          s.n++;
        },
      },
    });
    const app = await sa.aio.run({
      watch: false,
      appId: "r6tick",
      cells: [ticker],
      persist: false,
    });
    await ticker.begin();
    await new Promise((r) => setTimeout(r, 70));
    await app.close();
    const atClose = fired;
    // After close() the timer must be gone. It is not: it keeps firing, and
    // each fire is a dispatch refused by the closed door ("dispatch after
    // close() … ignored") — a live interval in a finished app.
    console.warn = (...a: unknown[]) =>
      void errors.push(a.map(String).join(" "));
    await new Promise((r) => setTimeout(r, 90));
    console.warn = keepWarn;
    assertEquals(fired - atClose, 0);
    assertEquals(
      errors.filter((e) => e.includes("r6ticker:tick")),
      [],
      "the `every` schedule is still armed after close()",
    );
  } finally {
    console.error = keep;
    console.warn = keepWarn;
    sa._reset();
    _resetAioRuntime();
  }
});
