// AIO-381: async methods run schedule effects, same as sync methods — the
// executor bridges them through an internal `__effects` action so they flow
// down the standard reduce→effects path.
//
// alpha76: the channel is `s.$do(...)`. Returning the effect instead was
// retired (src/state/removals.ts) — it ran the effect AND resolved the caller
// with `undefined`, so one channel silently carried two meanings and `return`
// could never be taught to carry an effect-shaped value. The last test here is
// the one that used to pin that swallow; it now pins the refusal, on BOTH
// paths, because a removal that only bites the sync method is a new parity
// break wearing the old one's clothes.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../src/state/cell.ts";
import { bootCells, testCell } from "../src/testing/cell-test.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
import {
  isScheduleEffect,
  schedule,
  type ScheduleEffect,
} from "../src/state/schedule.ts";

const poller = cell("poller381", {
  state: { tries: 0, data: null as string | null },
  methods: {
    refresh(s) {
      s.tries += 1;
    },
    async fetchData(s) {
      await Promise.resolve();
      s.tries += 1;
      if (s.tries < 3) {
        // Retry with backoff — the documented pattern from scheduling.md,
        // supported from async methods.
        s.$do(schedule.after("poller.retry", s.tries * 1000, {
          type: "poller381:refresh",
          payload: { args: [] },
        }));
        return;
      }
      s.data = "ok";
    },
    async fetchAll(s) {
      await Promise.resolve();
      s.tries += 1;
      s.$do(
        schedule.after("poller.retry", 500, {
          type: "poller381:refresh",
          payload: { args: [] },
        }),
        schedule.cancel("poller.stale"),
      );
    },
    async fetchValue(s) {
      await Promise.resolve();
      s.data = "value";
      // Plain data return — must reach direct callers untouched, never
      // be misread as effects.
      return { type: "user-data", items: [1, 2, 3] };
    },
  },
});

// Guard at method top (methods-style replacement for the old machine gate):
// fetchOnce only runs from 'idle' and moves the cell to 'busy'.
const gated = cell("gated381", {
  state: { ran: false, phase: "idle" },
  methods: {
    done(s) {
      s.phase = "idle";
    },
    async fetchOnce(s) {
      if (s.phase !== "idle") return;
      s.phase = "busy";
      await Promise.resolve();
      s.ran = true;
      s.$do(schedule.after("gated.next", 100, {
        type: "gated381:done",
        payload: { args: [] },
      }));
    },
  },
});

// `$do` from an ASYNC method dispatches immediately, so it is observed the way
// an app observes it — the effect FIRES — not by reading the last reduce's
// effects array (which the method's own write batch has already replaced by
// the time the call resolves).
Deno.test("async method: s.$do(schedule.…) arms the effect, and it fires", async () => {
  const h = await bootCells([poller]);
  try {
    await (poller as Any).fetchData();
    assertEquals((poller as Any).tries, 1);
    await h.advance(1100);
    assertEquals((poller as Any).tries, 2, "the $do'd retry fired");
  } finally {
    h.dispose();
  }
});

Deno.test("async method: s.$do(a, b) arms all of them", async () => {
  const h = await bootCells([poller]);
  try {
    // The cancel targets an id nothing armed — it must be accepted, not throw,
    // and the `after` next to it must still arm.
    await (poller as Any).fetchAll();
    assertEquals((poller as Any).tries, 1);
    await h.advance(600);
    assertEquals((poller as Any).tries, 2, "the first of the two $do'd fired");
  } finally {
    h.dispose();
  }
});

Deno.test("guarded cell: $do from an async method still arms (__effects path)", async () => {
  const h = await bootCells([gated]);
  try {
    await (gated as Any).fetchOnce();
    assertEquals((gated as Any).phase, "busy");
    assertEquals((gated as Any).ran, true);
    await h.advance(150);
    assertEquals((gated as Any).phase, "idle", "the $do'd done() ran");
  } finally {
    h.dispose();
  }
});

testCell(poller, "plain data returns are not misread as effects", async (t) => {
  t.init();
  await t.send.fetchValue!();
  t.expect.state((s) => s.data === "value");
  // Last dispatch was the method's own __set batch — no __effects bridge fired.
  assertEquals(t.getEffects().length, 0);
});

// The retired channel: a method that returned `schedule.after(...)` scheduled
// the effect and resolved its caller with `undefined`. Both meanings could not
// live on `return`, so the effect one left in alpha76 — and it has to leave on
// BOTH paths at once, or the sync/async parity this file exists for is broken
// in the other direction.
Deno.test("returning an effect is REFUSED in sync AND async methods", async () => {
  const parity = cell("effect-parity", {
    state: { n: 0 },
    methods: {
      syncEff(s: { n: number }): unknown {
        s.n++;
        return schedule.after("ep1", 10_000, { type: "effect-parity:noop" });
      },
      async asyncEff(s: { n: number }): Promise<unknown> {
        await Promise.resolve();
        s.n++;
        return schedule.after("ep2", 10_000, { type: "effect-parity:noop" });
      },
      noop(_s: { n: number }) {},
    },
  });

  const h = await bootCells([parity]);
  try {
    const api = parity as unknown as {
      syncEff: () => Promise<unknown>;
      asyncEff: () => Promise<unknown>;
    };
    for (
      const [name, call] of [
        ["sync", api.syncEff],
        ["async", api.asyncEff],
      ] as const
    ) {
      const err = await call().then(() => null, (e: unknown) => e);
      assert(err, `${name}: a returned effect must be refused, not swallowed`);
      const msg = String(err);
      assertStringIncludes(msg, "s.$do(effect)");
      assertStringIncludes(msg, "removed in alpha76");
      assertStringIncludes(msg, "am pin v1.0.0-alpha75");
    }
  } finally {
    h.dispose();
  }
});

// A `ScheduleEffect` is still a value a helper may build and hand to `$do` —
// the type did not go anywhere, only the channel did.
Deno.test("an effect is still a value a helper can return", () => {
  const build = (): ScheduleEffect =>
    schedule.after("helper", 1, { type: "x:noop" });
  assertEquals(isScheduleEffect(build()), true);
});
