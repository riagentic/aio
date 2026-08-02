// AIO-381: async methods can return schedule effects, same as sync methods.
// The executor bridges the return value through an internal `__effects`
// action so the effects flow down the standard reduce→effects path.

import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell.ts";
import { testCell } from "../src/testing/cell-test.ts";
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
    async fetchData(s): Promise<ScheduleEffect | undefined> {
      await Promise.resolve();
      s.tries += 1;
      if (s.tries < 3) {
        // Retry with backoff — the documented pattern from scheduling.md,
        // now actually supported from async methods.
        return schedule.after("poller.retry", s.tries * 1000, {
          type: "poller381:refresh",
          payload: { args: [] },
        });
      }
      s.data = "ok";
    },
    async fetchAll(s): Promise<ScheduleEffect[]> {
      await Promise.resolve();
      s.tries += 1;
      return [
        schedule.after("poller.retry", 500, {
          type: "poller381:refresh",
          payload: { args: [] },
        }),
        schedule.cancel("poller.stale"),
      ];
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
    async fetchOnce(s): Promise<ScheduleEffect | undefined> {
      if (s.phase !== "idle") return;
      s.phase = "busy";
      await Promise.resolve();
      s.ran = true;
      return schedule.after("gated.next", 100, {
        type: "gated381:done",
        payload: { args: [] },
      });
    },
  },
});

testCell(
  poller,
  "async method returning a schedule effect emits it",
  async (t) => {
    t.init();
    await t.send.fetchData!();
    t.expect.state((s) => s.tries === 1);
    const effects = t.getEffects();
    assertEquals(effects.length, 1);
    assertEquals(isScheduleEffect(effects[0]), true);
    assertEquals((effects[0] as { kind: string }).kind, "after");
    assertEquals((effects[0] as { id: string }).id, "poller.retry");
  },
);

testCell(
  poller,
  "async method returning an effect array emits all of them",
  async (t) => {
    t.init();
    await t.send.fetchAll!();
    const effects = t.getEffects();
    assertEquals(effects.length, 2);
    assertEquals(effects.every(isScheduleEffect), true);
    assertEquals((effects[1] as { kind: string }).kind, "cancel");
  },
);

testCell(poller, "plain data returns are not misread as effects", async (t) => {
  t.init();
  await t.send.fetchValue!();
  t.expect.state((s) => s.data === "value");
  // Last dispatch was the method's own __set batch — no __effects bridge fired.
  assertEquals(t.getEffects().length, 0);
});

testCell(
  gated,
  "guarded cell: async-returned effect still emitted (__effects path)",
  async (t) => {
    t.init();
    await t.send.fetchOnce!();
    t.expect.state((s) => s.phase === "busy");
    t.expect.state((s) => s.ran === true);
    const effects = t.getEffects();
    assertEquals(effects.length, 1);
    assertEquals((effects[0] as { id: string }).id, "gated.next");
  },
);

// a method returning `schedule.after(...)` is SCHEDULING, not returning a
// value: the docs (and the sync path) resolve `undefined`. The async path
// resolved the effect object itself, so the same source line meant two
// different things depending on whether the method was async.
Deno.test("effect returns resolve undefined in sync AND async methods", async () => {
  const { cell } = await import("../src/state/cell.ts");
  const { schedule } = await import("../src/state/schedule.ts");
  const { bootCells } = await import("../src/testing/cell-test.ts");

  const parity = cell("effect-parity", {
    state: { n: 0 },
    methods: {
      syncEff(s: { n: number }) {
        s.n++;
        return schedule.after("ep1", 10_000, { type: "effect-parity:noop" });
      },
      async asyncEff(s: { n: number }) {
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
    assertEquals(await api.syncEff(), undefined, "sync: effect is not a value");
    assertEquals(
      await api.asyncEff(),
      undefined,
      "async must agree — same source line, same meaning",
    );
  } finally {
    h.dispose();
  }
});
