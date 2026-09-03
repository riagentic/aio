// AIO-52x: sync and async methods classify a returned ARRAY through the ONE
// shared decider (classifyReturnedArray, cell-methods-internals.ts):
//   all elements effects → REFUSED (alpha76 — see below)
//   no elements effects  → the array is the caller's VALUE
//   a mix                → throw, naming the method (loud on both paths)
// The paths used to disagree — sync looked only at element[0] (so
// `[effect, data]` dispatched the data as a bogus effect), async required
// `every(isEffect)` (so the same return silently never armed the timer and
// handed the whole array back as a value).
//
// alpha76 moved the top row: an all-effect array WAS the emission, and is now
// refused by name on both paths, because `return` belongs to values and
// `s.$do(...)` is the effect channel (a returned effect resolved the caller
// with `undefined`, so the two could never share it). The matrix still has
// three rows and this file still covers all three — the top one now pins the
// REFUSAL in dev, the log-and-still-run degrade in prod, and the `s.$do(a, b)`
// spelling that produces the emission it used to check.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../src/state/cell.ts";
import { isScheduleEffect, schedule } from "../src/state/schedule.ts";
import { bootCells, testCell } from "../src/testing/cell-test.ts";
import { _resetReturnEffectHints } from "../src/state/cell-methods-internals.ts";
import { log } from "../src/diagnostics/logger-api.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

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
    // The CURRENT spelling of what syncEffects/asyncEffects used to mean.
    syncDo(s) {
      s.n++;
      s.$do(
        schedule.after("rc.g", 10_000, { type: "retclass52:noop" }),
        schedule.cancel("rc.h"),
      );
      return "value";
    },
    async asyncDo(s) {
      await Promise.resolve();
      s.n++;
      s.$do(
        schedule.after("rc.i", 10_000, { type: "retclass52:noop" }),
        schedule.cancel("rc.j"),
      );
      return "value";
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
  syncDo: () => Promise<unknown>;
  asyncDo: () => Promise<unknown>;
};

// ── all-effect arrays are REFUSED (alpha76), on both paths ───────────────
// The classifier still RECOGNISES the shape — that is what lets it name the
// replacement instead of handing an effect array back as a value.

testCell(rc, "sync: all-effect array is refused, naming s.$do", async (t) => {
  t.init();
  const err = await assertRejects(() => t.send.syncEffects!(), Error);
  assert(err.message.includes("s.$do(effect)"), err.message);
  assert(err.message.includes("removed in alpha76"), err.message);
  assert(err.message.includes("retclass52.syncEffects"), err.message);
  t.expect.state((s) => s.n === 0, "a refused reduce commits nothing");
  assertEquals(
    t.getEffects().filter(isScheduleEffect).length,
    0,
    "a refused channel arms nothing",
  );
});

testCell(rc, "async: all-effect array is refused, naming s.$do", async (t) => {
  t.init();
  const err = await assertRejects(() => t.send.asyncEffects!(), Error);
  assert(err.message.includes("s.$do(effect)"), err.message);
  assert(err.message.includes("removed in alpha76"), err.message);
  assert(err.message.includes("retclass52.asyncEffects"), err.message);
  assertEquals(
    t.getEffects().filter(isScheduleEffect).length,
    0,
    "a refused channel arms nothing",
  );
});

const rcdo = cell("retclass52do", {
  state: { n: 0 },
  methods: {
    tick(s) {
      s.n++;
    },
    async armAsync(s) {
      await Promise.resolve();
      s.$do(
        schedule.after("rcdo.a", 10, { type: "retclass52do:tick" }),
        schedule.after("rcdo.b", 10, { type: "retclass52do:tick" }),
      );
      return "value";
    },
  },
});

// …and s.$do is what emits them — the assertion the two cases above used to
// make, moved onto the spelling that still means it.

testCell(
  rc,
  "sync: s.$do(a, b) emits both, and `return` keeps its value",
  async (t) => {
    t.init();
    assertEquals(await t.send.syncDo!(), "value");
    t.expect.state((s) => s.n === 1);
    const effects = t.getEffects();
    assertEquals(effects.length, 2);
    assertEquals(effects.every(isScheduleEffect), true);
  },
);

// The async path dispatches its `$do` effects at CALL time (a separate
// `__effects` dispatch, not the reduce's effects array), so the emission is
// asserted where it lands: on the clock.
Deno.test("async: s.$do(a, b) runs both, and `return` keeps its value", async () => {
  const h = await bootCells([rcdo]);
  try {
    const api = rcdo as unknown as { armAsync: () => Promise<unknown> };
    assertEquals(await api.armAsync(), "value");
    await h.advance(50);
    assertEquals((rcdo as Any).n, 2, "both $do effects fired");
  } finally {
    h.dispose();
  }
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

// ── the prod half of the refusal: loud, once, and still armed ────────────
// dev throws (above); prod logs the registry line once per METHOD and runs
// the effects anyway, so an upgraded app announces the change on every boot
// instead of silently dropping a timer. Category (b) of the dev==prod rule.

const rcp = cell("retclass52prod", {
  state: { n: 0 },
  methods: {
    tick(s) {
      s.n++;
    },
    arm() {
      return [
        schedule.after("rcp.a", 10, { type: "retclass52prod:tick" }),
        schedule.after("rcp.b", 10, { type: "retclass52prod:tick" }),
      ];
    },
  },
});

Deno.test("prod: the refused array logs once per method and STILL runs", async () => {
  _resetReturnEffectHints();
  const h = await bootCells([rcp]);
  const g = globalThis as Record<string, unknown>;
  const prevDev = g.__aioDev;
  const origError = (log as Any).error;
  const errors: string[] = [];
  try {
    g.__aioDev = false;
    (log as Any).error = (...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    };
    await (rcp as unknown as { arm: () => Promise<unknown> }).arm();
    await (rcp as unknown as { arm: () => Promise<unknown> }).arm();
    assertEquals(errors.length, 1, "once per method, not once per call");
    assert(errors[0]!.includes("s.$do(effect)"), errors[0]);
    assert(errors[0]!.includes("removed in alpha76"), errors[0]);
    await h.advance(50);
    assertEquals((rcp as Any).n, 2, "…and both timers were still armed");
  } finally {
    (log as Any).error = origError;
    if (prevDev === undefined) delete g.__aioDev;
    else g.__aioDev = prevDev;
    h.dispose();
  }
});
