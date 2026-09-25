// `schedule.backoff`/`schedule.poll` validated every duration but never the
// `attempt` they scale by. An unset counter (`s.attempts` never initialised)
// made the delay NaN: the method returned ok, and the retry was refused LATER
// by the scheduler as `schedule.after '<id>': ms must be finite` — an
// EFFECT_ERROR naming an API the app never called, the retry silently gone.
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { schedule } from "../src/state/schedule.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
const S = schedule as any;
const A = { type: "c:tick" };

Deno.test("schedule.backoff/poll: an attempt that is not a number is refused at the call, by name", async () => {
  for (const bad of [undefined, NaN, "x", {}]) {
    for (
      const call of [
        () => S.backoff("retry", bad, A, { base: 100 }),
        () => S.poll("p", bad, A, { every: 100, factor: 2 }),
      ]
    ) {
      const m = assertThrows(call, Error).message;
      assertStringIncludes(m, "attempt is");
      assertEquals(m.includes("schedule.after"), false, m);
    }
  }
  // Every input that produced a real delay still does.
  assertEquals(S.backoff("r", 2, A, { base: 100 }).ms, 400);
  assertEquals(S.backoff("r", null, A, { base: 100 }).ms, 100);
  assertEquals(S.backoff("r", -1, A, { base: 100 }).ms, 100);
  assertEquals(S.poll("p", 0, A, { every: 100, factor: 2 }).ms, 100);

  // …and through a method: the CALL fails, instead of an ok call whose retry
  // never arms.
  const c = cell("boAttempt", {
    state: { attempts: undefined as number | undefined },
    methods: {
      fail(s) {
        s.$do(
          schedule.backoff("boAttempt:retry", s.attempts as number, {
            type: "boAttempt:fail",
          }, { base: 100 }),
        );
      },
    },
  });
  const h = await bootCells([c]);
  try {
    let err: unknown = null;
    try {
      // deno-lint-ignore no-explicit-any
      await (c as any).fail();
    } catch (e) {
      err = e;
    }
    assertStringIncludes(String(err), "schedule.backoff 'boAttempt:retry'");
  } finally {
    h.dispose();
  }
});
