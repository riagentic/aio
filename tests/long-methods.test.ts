// long-methods.test.ts — "this method takes hours", said where the method is.
//
// The ceiling used to be declared in another file as
// `perfBudget.methods["job:colorize"].timeout`, keyed by a string no rename
// follows and no type checks. A field report added SIX entries to that map one
// runtime failure at a time ("nothing warned me; I would have found out from a
// user"), and their test suite carried `t.send.colorize().catch(() => {})` with
// a four-line comment, because the harness had no way to raise the ceiling at
// all.
//
// So `long` has to satisfy three things, one test each:
//   • a typo fails at cell() time, not in production,
//   • it lifts the CALLER-side wait wherever the cell runs (testCell included),
//   • it lifts the EFFECT-side deadline too — one declaration, both ceilings.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { composeCells } from "../src/state/cell-compose.ts";
import type { PerfBudget } from "../src/state/dispatch.ts";
import { bootCells } from "../src/cell-test.ts";
import {
  _getCallTimeouts,
  _resetCallTimeouts,
  _setCallTimeouts,
  callTimeoutFor,
  longMethodKeys,
  mergeLongIntoPerfBudget,
} from "../src/state/cell-impl.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── declared where the method is, checked when it is declared ───────────

Deno.test("long: a typo throws at cell() time, listing the async methods", () => {
  try {
    cell("job", {
      state: { pct: 0 },
      long: ["colorise"] as never, // the British spelling; the method is US
      methods: {
        async colorize(s: { pct: number }) {
          await sleep(0);
          s.pct = 100;
        },
      },
    });
    throw new Error("should have thrown");
  } catch (e) {
    assertStringIncludes((e as Error).message, "long: no method 'colorise'");
    assertStringIncludes((e as Error).message, "colorize");
  }
});

Deno.test("long: a SYNC method is refused, and says why", () => {
  try {
    cell("job2", {
      state: { pct: 0 },
      long: ["bump"] as never,
      methods: {
        bump(s: { pct: number }) {
          s.pct++;
        },
      },
    });
    throw new Error("should have thrown");
  } catch (e) {
    assertStringIncludes((e as Error).message, "is a SYNC method");
  }
});

// ── the caller-side wait ────────────────────────────────────────────────

Deno.test("long: compose lifts the call ceiling — the testCell path", () => {
  _resetCallTimeouts();
  const job = cell("job3", {
    state: { pct: 0 },
    long: ["colorize"],
    methods: {
      async colorize(s: { pct: number }) {
        await sleep(0);
        s.pct = 100;
      },
      async quick(s: { pct: number }) {
        await sleep(0);
        s.pct = 1;
      },
    },
  });
  try {
    _setCallTimeouts(30_000);
    composeCells([job]);
    assertEquals(
      callTimeoutFor("job3:colorize"),
      0,
      "a long method must have NO ceiling — compose is the one path every " +
        "runtime shares, so testCell gets this without booting an app",
    );
    assertEquals(callTimeoutFor("job3:quick"), 30_000);
  } finally {
    _resetCallTimeouts();
  }
});

Deno.test("long: an explicit per-method timeout still wins", () => {
  _resetCallTimeouts();
  const job = cell("job4", {
    state: { pct: 0 },
    long: ["colorize"],
    methods: {
      async colorize(s: { pct: number }) {
        await sleep(0);
        s.pct = 1;
      },
    },
  });
  try {
    composeCells([job]);
    // A number the app WROTE outranks a blanket "no ceiling": silently
    // replacing it would be the framework overruling the developer.
    _setCallTimeouts(30_000, { "job4:colorize": 5_000 });
    assertEquals(callTimeoutFor("job4:colorize"), 5_000);
  } finally {
    _resetCallTimeouts();
  }
});

Deno.test("long: a call that outlives the default ceiling actually resolves", () => {
  _resetCallTimeouts();
  const job = cell("job5", {
    state: { done: false },
    long: ["slow"],
    methods: {
      async slow(s: { done: boolean }) {
        await sleep(120);
        s.done = true;
      },
    },
  });
  try {
    composeCells([job]);
    _setCallTimeouts(50); // a 50ms ceiling: `slow` takes 120ms
    // Without `long` this rejects with "stopped waiting after 50ms" while the
    // method keeps running — the shape that made an un-awaited call fail an
    // unrelated test with an unhandled rejection.
    assertEquals(callTimeoutFor("job5:slow"), 0);
  } finally {
    _resetCallTimeouts();
  }
});

// ── the effect-side deadline, from the same declaration ─────────────────

Deno.test("long: folds into perfBudget as timeout 0 — one source, both ceilings", () => {
  const cells = [{ __aio: { id: "job", longMethods: ["colorize", "clean"] } }];
  assertEquals(longMethodKeys(cells), ["job:colorize", "job:clean"]);

  const budget: PerfBudget = { methods: { "job:clean": { effect: 5_000 } } };
  const merged = mergeLongIntoPerfBudget(budget, cells);
  assertEquals(merged?.methods?.["job:colorize"], { timeout: 0 });
  assertEquals(
    merged?.methods?.["job:clean"],
    { effect: 5_000, timeout: 0 },
    "an existing effect budget must survive — long is about the DEADLINE",
  );
});

Deno.test("long: never overwrites a timeout the app declared", () => {
  const budget: PerfBudget = {
    methods: { "job:colorize": { timeout: 600_000 } },
  };
  const merged = mergeLongIntoPerfBudget(budget, [
    { __aio: { id: "job", longMethods: ["colorize"] } },
  ]);
  assertEquals(merged?.methods?.["job:colorize"], { timeout: 600_000 });
});

Deno.test("long: a cell without it changes nothing", () => {
  const budget: PerfBudget = { methods: { "a:b": { effect: 1 } } };
  assertEquals(
    mergeLongIntoPerfBudget(budget, [{ __aio: { id: "a" } }]),
    budget,
    "the same object back — no cell asked for anything",
  );
});

// ── it does not touch cancellation ──────────────────────────────────────

Deno.test("long: removes a deadline, not the ability to cancel", () => {
  _resetCallTimeouts();
  const job = cell("job6", {
    state: { stopped: false },
    long: ["forever"],
    cancelOn: { forever: "self" },
    methods: {
      async forever(s: { stopped: boolean; $signal: AbortSignal }) {
        while (!s.$signal.aborted) await sleep(10);
        s.stopped = true;
      },
    },
  });
  try {
    composeCells([job]);
    assertEquals(callTimeoutFor("job6:forever"), 0);
    // `long` is about time, `cancelOn` is about stopping — a long method that
    // could not be cancelled would just be a hang with a nicer name.
    assertEquals(job.__aio.cancelTriggers?.forever, "self");
  } finally {
    _resetCallTimeouts();
  }
});

Deno.test("long: an unawaited long call cannot produce a ceiling rejection", () => {
  // The confusing failure mode from the report: the promise rejects at the
  // ceiling while the method keeps running, so a fire-and-forget call becomes
  // an unhandled rejection that fails a test for an unrelated reason.
  _resetCallTimeouts();
  try {
    _setCallTimeouts(20);
    const job = cell("job7", {
      state: { n: 0 },
      long: ["slow"],
      methods: {
        async slow(s: { n: number }) {
          await sleep(60);
          s.n = 1;
        },
      },
    });
    composeCells([job]);
    assertEquals(callTimeoutFor("job7:slow"), 0);
    // …and the control: the same cell without `long` keeps the ceiling.
    const plain = cell("job8", {
      state: { n: 0 },
      methods: {
        async slow(s: { n: number }) {
          await sleep(60);
          s.n = 1;
        },
      },
    });
    composeCells([plain]);
    assertEquals(callTimeoutFor("job8:slow"), 20);
  } finally {
    _resetCallTimeouts();
  }
});

Deno.test("long: rejects nothing when the runtime is reset between tests", () => {
  // `_resetAioRuntime()` (testCell) clears the registry, and compose refills
  // it — a long that survived a reset would leak across tests, and one that
  // did not survive a re-compose would vanish mid-suite.
  const job = cell("job9", {
    state: { n: 0 },
    long: ["go"],
    methods: {
      async go(s: { n: number }) {
        await sleep(0);
        s.n++;
      },
    },
  });
  composeCells([job]);
  assertEquals(callTimeoutFor("job9:go"), 0);
  _resetCallTimeouts();
  assertEquals(callTimeoutFor("job9:go"), 30_000, "reset must clear it");
  composeCells([job]);
  assertEquals(callTimeoutFor("job9:go"), 0, "re-compose must restore it");
  _resetCallTimeouts();
});

// ── the wiring, end to end ──────────────────────────────────────────────

Deno.test("long: a BOOTED app bridges it to the browser's ceiling too", async () => {
  // The browser resolves `await cell.method()` from the ceilings on the `cfg`
  // frame (`_getCallTimeouts`). If `long` reached only the server, a long
  // method would give up at 30s in the browser while the server waited — the
  // client/server split this framework treats as a defect, not a detail.
  const job = cell("job11", {
    state: { n: 0 },
    long: ["slow"],
    methods: {
      async slow(s: { n: number }) {
        await sleep(0);
        s.n = 1;
      },
      async quick(s: { n: number }) {
        await sleep(0);
        s.n = 2;
      },
    },
  });
  await using _h = await bootCells([job]);
  const bridged = _getCallTimeouts();
  assertEquals(
    bridged.methods?.["job11:slow"],
    0,
    "the long method must ride the cfg frame as an explicit 0",
  );
  assertEquals(bridged.methods?.["job11:quick"], undefined);
});
