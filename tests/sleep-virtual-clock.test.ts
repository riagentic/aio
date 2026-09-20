// `sleep()` inside a method, under the harness's virtual clock.
//
// `h.advance(ms)` is documented as the way to drive time in a test — it moves
// schedules, the call ceilings and `Date.now()`. `sleep()` (the method-native
// `ctx.sleep`) ignored it and always took REAL time: `await sleep(10_000)` in a
// method made `await h.advance(10_000)` return with the method still parked,
// and the test either waited ten real seconds or asserted on a state that had
// not happened yet.
//
// The fix follows the call ceilings' precedent (`_armCallTimer`): while the
// harness has a virtual clock installed, a sleep is armed on BOTH clocks and
// resolves on whichever fires first. So advancing ends it, and a test that
// never advances still waits in real time exactly as it always did — nothing
// that passed before can hang now. Outside the harness (an app, the Android
// standalone runtime) there is no virtual clock and nothing changes.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { _setSleepClock, race, sleep } from "../src/state/async-helpers.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("sleep in a method ends when the harness advances past it — not ten real seconds later", async () => {
  const c = cell("sleepv_a", {
    state: { done: false },
    methods: {
      async wait(s: Any) {
        await sleep(10_000);
        s.done = true;
      },
    },
  });
  await using h = await bootCells([c] as never);
  const t0 = performance.now();
  const call = (c as Any).wait();
  await h.advance(9_999);
  assertEquals((c as Any).done, false, "not before its time");
  await h.advance(1);
  await call;
  assertEquals((c as Any).done, true);
  assert(performance.now() - t0 < 5_000, "took real time");
});

Deno.test("sleep with no advance still resolves in real time (unchanged)", async () => {
  const c = cell("sleepv_b", {
    state: { done: false },
    methods: {
      async wait(s: Any) {
        await sleep(30);
        s.done = true;
      },
    },
  });
  await using h = await bootCells([c] as never);
  await (c as Any).wait();
  await h.settle();
  assertEquals((c as Any).done, true);
});

Deno.test("race's `timeout: ms` branch honours advance the same way", async () => {
  const c = cell("sleepv_c", {
    state: { winner: "" },
    methods: {
      async wait(s: Any) {
        const r = await race({
          never: new Promise<void>(() => {}),
          timeout: 10_000,
        });
        s.winner = r.winner;
      },
    },
  });
  await using h = await bootCells([c] as never);
  const t0 = performance.now();
  const call = (c as Any).wait();
  await h.advance(10_000);
  await call;
  assertEquals((c as Any).winner, "timeout");
  assert(performance.now() - t0 < 5_000, "took real time");
});

Deno.test("sleep with no virtual clock installed is a plain real-time timer", async () => {
  // The harnesses above installed one for the process; uninstall it so this
  // measures what an app (no harness) gets.
  _setSleepClock(null);
  const t0 = performance.now();
  await sleep(20);
  assert(performance.now() - t0 >= 15);
});
