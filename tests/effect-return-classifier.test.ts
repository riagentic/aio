// AIO-52x: sync and async methods classify a returned ARRAY through the ONE
// shared decider (classifyReturnedArray, cell-methods-internals.ts):
//   all elements effects → run them as effects
//   no elements effects  → the array is the caller's VALUE
//   a mix                → throw, naming the method (loud on both paths)
// The paths used to disagree — sync looked only at element[0] (so
// `[effect, data]` dispatched the data as a bogus effect), async required
// `every(isEffect)` (so the same return silently never armed the timer and
// handed the whole array back as a value).

import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../src/state/cell.ts";
import { isScheduleEffect, schedule } from "../src/state/schedule.ts";
import { bootCells, testCell } from "../src/testing/cell-test.ts";

const rc = cell("retclass52", {
  state: { n: 0 },
  methods: {
    noop(_s) {},
    syncEffects(s) {
      s.n++;
      return [
        schedule.after("rc.a", 10_000, { type: "retclass52:noop" }),
        schedule.cancel("rc.b"),
      ];
    },
    syncValues(s) {
      s.n++;
      return [1, 2, 3];
    },
    syncMixed(s) {
      s.n++;
      return [
        schedule.after("rc.c", 10_000, { type: "retclass52:noop" }),
        { oops: true },
      ];
    },
    async asyncEffects(s) {
      await Promise.resolve();
      s.n++;
      return [
        schedule.after("rc.d", 10_000, { type: "retclass52:noop" }),
        schedule.cancel("rc.e"),
      ];
    },
    async asyncValues(s) {
      await Promise.resolve();
      s.n++;
      return [1, 2, 3];
    },
    async asyncMixed(s) {
      await Promise.resolve();
      s.n++;
      return [
        schedule.after("rc.f", 10_000, { type: "retclass52:noop" }),
        { oops: true },
      ];
    },
  },
});

type Api = {
  syncEffects: () => Promise<unknown>;
  syncValues: () => Promise<unknown>;
  syncMixed: () => Promise<unknown>;
  asyncEffects: () => Promise<unknown>;
  asyncValues: () => Promise<unknown>;
  asyncMixed: () => Promise<unknown>;
};

// ── all-effects arrays run as effects, on both paths ─────────────────────

testCell(rc, "sync: all-effect array → emitted as effects", async (t) => {
  t.init();
  await t.send.syncEffects!();
  t.expect.state((s) => s.n === 1);
  const effects = t.getEffects();
  assertEquals(effects.length, 2);
  assertEquals(effects.every(isScheduleEffect), true);
});

testCell(rc, "async: all-effect array → emitted as effects", async (t) => {
  t.init();
  await t.send.asyncEffects!();
  t.expect.state((s) => s.n === 1);
  const effects = t.getEffects();
  assertEquals(effects.length, 2);
  assertEquals(effects.every(isScheduleEffect), true);
});

// ── no-effects arrays are the caller's value, on both paths ──────────────

testCell(rc, "sync: data array is a VALUE, never effects", async (t) => {
  t.init();
  await t.send.syncValues!();
  assertEquals(t.getEffects().length, 0);
});

Deno.test("data arrays resolve to the caller on both paths", async () => {
  const h = await bootCells([rc]);
  try {
    const api = rc as unknown as Api;
    assertEquals(await api.syncValues(), [1, 2, 3]);
    assertEquals(await api.asyncValues(), [1, 2, 3]);
  } finally {
    h.dispose();
  }
});

// ── mixed arrays throw the same teachable error, on both paths ───────────

Deno.test("mixed effect+data array throws, naming the method (sync)", async () => {
  const h = await bootCells([rc]);
  try {
    const api = rc as unknown as Api;
    const err = await assertRejects(() => api.syncMixed(), Error);
    assert(err.message.includes("syncMixed"), err.message);
    assert(err.message.includes("cannot share a return array"), err.message);
    assert(err.message.includes("retclass52"), err.message);
  } finally {
    h.dispose();
  }
});

Deno.test("mixed effect+data array throws, naming the method (async)", async () => {
  const h = await bootCells([rc]);
  try {
    const api = rc as unknown as Api;
    const err = await assertRejects(() => api.asyncMixed(), Error);
    assert(err.message.includes("asyncMixed"), err.message);
    assert(err.message.includes("cannot share a return array"), err.message);
  } finally {
    h.dispose();
  }
});
