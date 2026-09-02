import {
  assertEquals,
  assertExists,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { schedule } from "../src/state/schedule.ts";
import { until } from "../src/state/async-helpers.ts";
import type { CellEffect } from "../src/state/cell-impl.ts";
import { cell } from "../src/state/cell-create.ts";
import { composeCells } from "../src/state/cell-compose.ts";
import type { Msg } from "../src/state/cell-types.ts";
import type { CellStatus } from "../src/state/cell-compose.ts";

// ── Helper cells ─────────────────────────────────────────────────

const counter = cell("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
    decrement(s, by = 1) {
      s.count -= by;
    },
    reset(s) {
      s.count = 0;
    },
  },
});

const flags = cell("flags", {
  state: { active: false, label: "" },
  methods: {
    activate(s) {
      s.active = true;
    },
    deactivate(s) {
      s.active = false;
    },
    setLabel(s, label: string) {
      s.label = label;
    },
  },
});

// ── 1. composeCells basic — single cell ──────────────────────

Deno.test("compose basic: initialState has cell key", () => {
  const composed = composeCells([counter]);
  assertExists(composed.initialState.counter);
  assertEquals((composed.initialState.counter as { count: number }).count, 0);
});

Deno.test("compose basic: reduce works and returns updated state", () => {
  const composed = composeCells([counter]);
  const action: Msg = { type: "counter:increment", payload: { args: [5] } };
  const result = composed.reduce(composed.initialState, action);
  assertEquals((result.state.counter as { count: number }).count, 5);
});

Deno.test("compose basic: reduce returns effects array", () => {
  // Methods-style: a sync method returning a schedule effect surfaces it in
  // composed.reduce's effects array (ported from Style-B effects, D1).
  const fx = cell("fx", {
    state: { x: 0 },
    methods: {
      // CellEffect annotation breaks the self-referential inference cycle
      // (documented TS trap for `return schedule.after(..., self.x.action())`).
      go(s): CellEffect {
        s.x = 1;
        return schedule.after("later", 1000, fx.go.action());
      },
    },
  });
  const composed = composeCells([fx]);
  const result = composed.reduce(composed.initialState, fx.go.action());
  assertEquals(result.effects.length, 1);
  assertEquals((result.effects[0] as { type: string }).type, "__schedule");
});

Deno.test("compose basic: cellNames populated", () => {
  const composed = composeCells([counter]);
  assertEquals(composed.cellNames, ["counter"]);
});

// ── 2. Multi-cell composition ───────────────────────────────────

Deno.test("multi-cell: each gets own state slice", () => {
  const composed = composeCells([counter, flags]);
  assertExists(composed.initialState.counter);
  assertExists(composed.initialState.flags);
  assertEquals((composed.initialState.counter as { count: number }).count, 0);
  assertEquals(
    (composed.initialState.flags as { active: boolean }).active,
    false,
  );
});

Deno.test("multi-cell: cellNames lists all cells", () => {
  const composed = composeCells([counter, flags]);
  assertEquals(composed.cellNames.includes("counter"), true);
  assertEquals(composed.cellNames.includes("flags"), true);
  assertEquals(composed.cellNames.length, 2);
});

Deno.test("multi-cell: actions are isolated to own slice", () => {
  const composed = composeCells([counter, flags]);
  const r1 = composed.reduce(composed.initialState, {
    type: "counter:increment",
    payload: { args: [10] },
  });
  assertEquals((r1.state.counter as { count: number }).count, 10);
  assertEquals((r1.state.flags as { active: boolean }).active, false); // unchanged

  const r2 = composed.reduce(r1.state, {
    type: "flags:activate",
    payload: { args: [] },
  });
  assertEquals((r2.state.counter as { count: number }).count, 10); // still 10
  assertEquals((r2.state.flags as { active: boolean }).active, true);
});

Deno.test("multi-cell: sequential actions accumulate", () => {
  const composed = composeCells([counter, flags]);
  let state = composed.initialState;
  state = composed.reduce(state, {
    type: "counter:increment",
    payload: { args: [3] },
  }).state;
  state = composed.reduce(state, {
    type: "counter:increment",
    payload: { args: [7] },
  }).state;
  state = composed.reduce(state, {
    type: "flags:setLabel",
    payload: { args: ["hello"] },
  }).state;
  assertEquals((state.counter as { count: number }).count, 10);
  assertEquals((state.flags as { label: string }).label, "hello");
});

// ── 3. Machine guards ──────────────────────────────────────────────

Deno.test("state guard: method ignores calls in the wrong state", () => {
  // Ported from the machine variant (D1): the CAPABILITY is "an action in the
  // wrong state is a no-op" — a guard line at the method top.
  const door = cell("door", {
    state: { status: "closed", opened: false },
    methods: {
      open(s) {
        if (s.status !== "closed" && s.status !== "locked") return;
        s.status = "open";
        s.opened = true;
      },
      close(s) {
        if (s.status !== "open") return;
        s.status = "closed";
        s.opened = false;
      },
      lock(s) {
        if (s.status !== "closed") return;
        s.status = "locked";
      },
    },
  });

  const composed = composeCells([door]);
  // closed — 'close' is a no-op
  const r1 = composed.reduce(composed.initialState, door.close.action());
  assertEquals((r1.state.door as { opened: boolean }).opened, false);

  // closed → open works
  const r2 = composed.reduce(composed.initialState, door.open.action());
  assertEquals((r2.state.door as { opened: boolean }).opened, true);
  assertEquals((r2.state.door as { status: string }).status, "open");

  // open — 'lock' is a no-op
  const r3 = composed.reduce(r2.state, door.lock.action());
  assertEquals((r3.state.door as { status: string }).status, "open");
});

Deno.test("state guard: no-op method keeps the same state reference", () => {
  // Ported (D1): an ignored call must not produce a new state object —
  // reference equality preserved so nothing downstream re-renders.
  const m = cell("m", {
    state: { v: 0, phase: "a" },
    methods: {
      go(s) {
        s.phase = s.phase === "a" ? "b" : "a";
        s.v = 1;
      },
      blocked(s) {
        if (s.phase !== "b") return; // no-op in phase a
        s.v = 99;
      },
    },
  });
  const composed = composeCells([m]);
  const result = composed.reduce(composed.initialState, m.blocked.action());
  assertEquals(result.state, composed.initialState);
});

// ── 4. State validation ────────────────────────────────────────────

Deno.test("validate: valid state passes through", () => {
  const validated = cell("validated", {
    state: { score: 0 },
    methods: {
      setScore(s, n: number) {
        s.score = n;
      },
    },
    validate: (s) => s.score >= 0 ? true : "score must be non-negative",
  });

  const composed = composeCells([validated]);
  const result = composed.reduce(composed.initialState, {
    type: "validated:setScore",
    payload: { args: [10] },
  });
  assertEquals((result.state.validated as { score: number }).score, 10);
});

const validated2 = cell("validated2", {
  state: { score: 0 },
  methods: {
    setScore(s, n: number) {
      s.score = n;
    },
  },
  validate: (s) => s.score >= 0 ? true : "score must be non-negative",
});

Deno.test("validate: invalid state rejects — returns old state", () => {
  const errors: unknown[] = [];
  const composed = composeCells([validated2], {
    onCellError: (err) => errors.push(err),
  });
  const result = composed.reduce(composed.initialState, {
    type: "validated2:setScore",
    payload: { args: [-5] },
  });
  assertEquals((result.state.validated2 as { score: number }).score, 0);
  assertEquals(result.effects.length, 0);
  assertEquals(errors.length, 1);
});

Deno.test("validate: with method guard — invalid state rejects", () => {
  const guarded = cell("guarded", {
    state: { val: 10 },
    methods: {
      set(s, v: number) {
        s.val = v;
      },
    },
    validate: (s) => s.val <= 100 ? true : "val must be <= 100",
  });

  const errors: unknown[] = [];
  const composed = composeCells([guarded], {
    onCellError: (err) => errors.push(err),
  });
  // Valid
  const r1 = composed.reduce(composed.initialState, guarded.set.action(50));
  assertEquals((r1.state.guarded as { val: number }).val, 50);

  // Invalid — exceeds 100 → validate rejects, state unchanged
  const r2 = composed.reduce(r1.state, guarded.set.action(200));
  assertEquals((r2.state.guarded as { val: number }).val, 50); // unchanged
  assertEquals(errors.length, 1);
});

// ── 5. Circuit breaker ─────────────────────────────────────────────

Deno.test("circuit breaker: auto-disables cell after error threshold", async () => {
  // Ported (D1): errors now come from a THROWING ASYNC METHOD flowing through
  // a real dispatch loop (reduce applies state, effects execute, the __error
  // dispatch re-enters reduce, which counts it toward the breaker).
  const tripped: string[] = [];

  const buggy = cell("buggy", {
    state: { x: 0 },
    methods: {
      async crash(_s) {
        throw new Error("boom");
      },
    },
  });

  const errors: unknown[] = [];
  const composed = composeCells([buggy], {
    onCellError: (err) => errors.push(err),
    circuitBreaker: {
      maxErrors: 3,
      onTrip: (name, count) => tripped.push(`${name}:${count}`),
    },
  });

  let state = composed.initialState;
  const app = {
    dispatch: (a: Msg): void => {
      const r = composed.reduce(state, a);
      state = r.state;
      for (const eff of r.effects) {
        composed.execute(app, eff as Msg);
      }
    },
    getState: () => state,
  };
  composed.initAll(app);

  // Trigger 3 async failures through the real loop
  app.dispatch({ type: "buggy:crash", payload: { args: [] } });
  app.dispatch({ type: "buggy:crash", payload: { args: [] } });
  app.dispatch({ type: "buggy:crash", payload: { args: [] } });
  await until(() => tripped.length === 1, { timeoutMs: 2000, intervalMs: 5 });

  assertEquals(tripped[0], "buggy:3");
  assertEquals(composed.registry.isEnabled("buggy"), false);
});

Deno.test("circuit breaker: below threshold keeps cell enabled", async () => {
  const buggy2 = cell("buggy2", {
    state: { n: 0 },
    methods: {
      async crash(_s) {
        throw new Error("boom");
      },
    },
  });

  const composed = composeCells([buggy2], {
    onCellError: () => {},
    circuitBreaker: { maxErrors: 5 },
  });

  let state = composed.initialState;
  const app = {
    dispatch: (a: Msg): void => {
      const r = composed.reduce(state, a);
      state = r.state;
      for (const eff of r.effects) composed.execute(app, eff as Msg);
    },
    getState: () => state,
  };
  composed.initAll(app);

  // Only 2 errors — below threshold of 5
  app.dispatch({ type: "buggy2:crash", payload: { args: [] } });
  app.dispatch({ type: "buggy2:crash", payload: { args: [] } });
  await until(
    () =>
      composed.registry.health(state).find((h) => h.name === "buggy2")!
        .errors === 2,
    { timeoutMs: 2000, intervalMs: 5 },
  );

  assertEquals(composed.registry.isEnabled("buggy2"), true);
});

// ── 6. Registry ────────────────────────────────────────────────────

Deno.test("registry: isEnabled returns true by default", () => {
  const composed = composeCells([counter]);
  assertEquals(composed.registry.isEnabled("counter"), true);
});

Deno.test("registry: disable/enable toggle", () => {
  const composed = composeCells([counter]);
  const app = {
    dispatch: (_a: Msg) => {},
    getState: () => composed.initialState,
  };

  composed.registry.disable("counter", app);
  assertEquals(composed.registry.isEnabled("counter"), false);

  composed.registry.enable("counter", app);
  assertEquals(composed.registry.isEnabled("counter"), true);
});

Deno.test("registry: disabled cell actions are dropped", () => {
  const composed = composeCells([counter]);
  const app = {
    dispatch: (_a: Msg) => {},
    getState: () => composed.initialState,
  };

  composed.registry.disable("counter", app);

  // Action to disabled cell should be dropped (state unchanged)
  const result = composed.reduce(composed.initialState, {
    type: "counter:increment",
    payload: { args: [99] },
  });
  assertEquals((result.state.counter as { count: number }).count, 0); // unchanged
});

// DELETED (D1 machinery): "registry.status returns _status from machine" —
// machine-driven __aio_status dies with Style B; app status is a plain state
// field the app owns (see the door/state-guard tests above).

Deno.test("registry: health returns all cells info", () => {
  const composed = composeCells([counter, flags]);
  const health = composed.registry.health(composed.initialState);
  assertEquals(health.length, 2);

  const counterHealth = health.find((h: CellStatus) => h.name === "counter")!;
  assertEquals(counterHealth.enabled, true);
  assertEquals(counterHealth.errors, 0);

  const flagsHealth = health.find((h: CellStatus) => h.name === "flags")!;
  assertEquals(flagsHealth.enabled, true);
  assertEquals(flagsHealth.errors, 0);
});

Deno.test("registry: list cells via cellNames", () => {
  const composed = composeCells([counter, flags]);
  assertEquals(composed.cellNames.length, 2);
  assertEquals(composed.cellNames.includes("counter"), true);
  assertEquals(composed.cellNames.includes("flags"), true);
});

// ── 7. Cell error counting ──────────────────────────────────────

Deno.test("errors: increment on async method throw, visible in health()", async () => {
  const errFeat = cell("errFeat", {
    state: { n: 0 },
    methods: {
      async fail(_s) {
        throw new Error("test error");
      },
    },
  });

  const composed = composeCells([errFeat], {
    onCellError: () => {},
  });
  let state = composed.initialState;
  const app = {
    dispatch: (a: Msg): void => {
      const r = composed.reduce(state, a);
      state = r.state;
      for (const eff of r.effects) composed.execute(app, eff as Msg);
    },
    getState: () => state,
  };
  composed.initAll(app);

  app.dispatch({ type: "errFeat:fail", payload: { args: [] } });
  app.dispatch({ type: "errFeat:fail", payload: { args: [] } });
  await until(
    () =>
      composed.registry.health(state).find((h) => h.name === "errFeat")!
        .errors === 2,
    { timeoutMs: 2000, intervalMs: 5 },
  );

  const h = composed.registry.health(state).find((h: CellStatus) =>
    h.name === "errFeat"
  )!;
  assertEquals(h.errors, 2);
  assertEquals(h.enabled, true);
});

Deno.test("errors: re-enable resets error counter", async () => {
  const errFeat2 = cell("errFeat2", {
    state: { n: 0 },
    methods: {
      async fail(_s) {
        throw new Error("err");
      },
    },
  });

  const composed = composeCells([errFeat2], {
    onCellError: () => {},
  });
  let state = composed.initialState;
  const app = {
    dispatch: (a: Msg): void => {
      const r = composed.reduce(state, a);
      state = r.state;
      for (const eff of r.effects) composed.execute(app, eff as Msg);
    },
    getState: () => state,
  };
  composed.initAll(app);

  app.dispatch({ type: "errFeat2:fail", payload: { args: [] } });
  await until(
    () =>
      composed.registry.health(state).find((h) => h.name === "errFeat2")!
        .errors === 1,
    { timeoutMs: 2000, intervalMs: 5 },
  );

  // Disable then re-enable resets errors
  composed.registry.disable("errFeat2", app);
  composed.registry.enable("errFeat2", app);
  assertEquals(
    composed.registry.health(state).find((h: CellStatus) =>
      h.name === "errFeat2"
    )!.errors,
    0,
  );
});

// ── AIO-71 #7: Cell method error context ─────────────────────────

Deno.test("reduce error includes cell name and method name in message", () => {
  const buggy = cell("wallet", {
    state: { balance: 0 },
    methods: {
      withdraw(s, amount: number) {
        if (amount > s.balance) {
          throw new Error("insufficient funds");
        }
        s.balance -= amount;
      },
    },
  });

  const composed = composeCells([buggy]);
  const action: Msg = {
    type: "wallet:withdraw",
    payload: { args: [100] },
  };

  let caught: Error | undefined;
  try {
    composed.reduce(composed.initialState, action);
  } catch (e) {
    caught = e as Error;
  }

  assertExists(caught, "should have thrown");
  // Error message must include cell name and method name for DX
  const msg = caught!.message;
  assertEquals(
    msg.includes("wallet") && msg.includes("withdraw"),
    true,
    `error message should include cell name 'wallet' and method name 'withdraw', got: "${msg}"`,
  );
  // Original error message must be preserved
  assertEquals(
    msg.includes("insufficient funds"),
    true,
    `original error message should be preserved, got: "${msg}"`,
  );
});

Deno.test("reduce error includes context for guarded cells", () => {
  const stateful = cell("door2", {
    state: { locked: false },
    methods: {
      open(s) {
        if (s.locked) throw new Error("door is locked");
      },
      close(_s) {},
      lock(s) {
        s.locked = true;
      },
    },
  });

  const composed = composeCells([stateful]);
  // Lock the door first
  const state = composed.reduce(composed.initialState, {
    type: "door2:lock",
    payload: {},
  }).state;
  // Now open — the method throws because locked=true
  let caught: Error | undefined;
  try {
    composed.reduce(state, { type: "door2:open", payload: {} });
  } catch (e) {
    caught = e as Error;
  }

  assertExists(caught, "should have thrown");
  const msg = caught!.message;
  assertEquals(
    msg.includes("door2") && msg.includes("open"),
    true,
    `error message should include cell 'door2' and method 'open', got: "${msg}"`,
  );
  assertEquals(
    msg.includes("door is locked"),
    true,
    `original error preserved, got: "${msg}"`,
  );
});

// ── A bad `cells:` entry names itself ────────────────────────────
// `cells:` is the one array EVERY app writes, and a typo'd or missing import
// is how it goes wrong. `"__aio" in entry` threw a raw JS TypeError on the
// resulting `undefined` — "Cannot use 'in' operator to search for '__aio' in
// undefined" — blaming an operator the app never wrote and naming neither the
// array nor the position.

Deno.test("cells: a bad entry names the array, the index and the likely cause", () => {
  const bad: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["a string", "counter"],
    ["a number", 7],
  ];
  for (const [label, entry] of bad) {
    const err = assertThrows(
      () => composeCells([counter, entry] as never),
      Error,
    );
    assertStringIncludes(err.message, "cells[1]", label);
    assertStringIncludes(err.message, "import", label);
  }
  // An object that simply is not a cell gets its own sentence — the import is
  // fine there, the value is just the wrong thing.
  const err = assertThrows(() => composeCells([{}] as never), Error);
  assertStringIncludes(err.message, "cells[0]");
  assertStringIncludes(err.message, "no __aio");
});

// ── A method or selector that is not a function ──────────────────────────────
// Method NAMES were validated against reserved keys; their VALUES never were.
// `methods: { tick: undefined }` (a typo'd import) surfaced from cell() as
// "Cannot read properties of undefined (reading 'Symbol(aio.async)')", naming
// an internal symbol. A non-function that is not undefined was worse: cell()
// ACCEPTED it, the app booted, and the first call threw "fn is not a function"
// under a remediation hint that said to check the action payload — which was
// never the problem.

Deno.test("cell(): a method that is not a function is refused, by name", () => {
  for (const [label, v] of [["undefined", undefined], ["a string", "tick"]]) {
    const err = assertThrows(
      () => cell("badm", { state: { n: 0 }, methods: { tick: v as never } }),
      Error,
    );
    assertStringIncludes(err.message, "method 'tick'", String(label));
    assertStringIncludes(err.message, "not a function", String(label));
    assertStringIncludes(err.message, "import", String(label));
  }
});

Deno.test("cell(): a selector that is not a function is refused — BOTH forms pass", () => {
  const err = assertThrows(
    () =>
      cell("bads", {
        state: { n: 0 },
        methods: {},
        selectors: { d: undefined as never },
      }),
    Error,
  );
  assertStringIncludes(err.message, "selector 'd'");
  // The deps form is a legitimate object, and must keep working.
  const ok = cell("goods", {
    state: { n: 2 },
    methods: {},
    selectors: {
      plain: (s: { n: number }) => s.n * 2,
      withDeps: { deps: ["counter"], fn: (s: { n: number }) => s.n },
    },
  });
  assertExists(ok);
});

// ── A cell lifecycle hook that never runs ────────────────────────────────────
// The app-level twin of this (validateCallableConfig, server/config.ts) landed
// first; the CELL level was the same class and worse. A typo'd import leaves
// `undefined` and the hook silently never runs — cell()'s own unknown-key
// message already argues why that matters ("A key aio does not read does
// nothing — silently, until you notice the behaviour you configured never
// happened"), and a key it DOES read whose value is undefined does the same.
// A non-function WAS reported, but only at init and in the framework's own
// vocabulary — "TypeError: f.__aio.onInit is not a function", an internal
// field access raised after the cell was built, naming neither the key the app
// wrote nor why it is undefined.

async function cellWarnings(make: () => unknown): Promise<string[]> {
  const { getLogger, setLogger } = await import(
    "../src/diagnostics/logger-api.ts"
  );
  const seen: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") seen.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    make();
  } finally {
    setLogger(prev);
  }
  return seen;
}

Deno.test("cell(): a lifecycle hook that is not a function is refused", () => {
  for (
    const key of ["onInit", "onDestroy", "onRestore", "onMigrate", "validate"]
  ) {
    const err = assertThrows(
      () =>
        cell(`hk${key}`, {
          state: { n: 0 },
          methods: {},
          [key]: "setup",
        } as never),
      Error,
    );
    assertStringIncludes(err.message, `${key} must be a function`, key);
  }
});

Deno.test("cell(): a hook declared as undefined warns — it would never run", async () => {
  const warnings = await cellWarnings(() =>
    cell(
      "hkundef",
      { state: { n: 0 }, methods: {}, onInit: undefined } as never,
    )
  );
  assertEquals(warnings.length, 1, warnings.join("\n"));
  assertStringIncludes(warnings[0]!, "onInit");
  assertStringIncludes(warnings[0]!, "import");
  assertStringIncludes(warnings[0]!, "omit the key");
});

Deno.test("cell(): a real hook, and an ABSENT one, are both silent", async () => {
  assertEquals(
    await cellWarnings(() =>
      cell("hkok", { state: { n: 0 }, methods: {}, onInit: () => {} })
    ),
    [],
  );
  assertEquals(
    await cellWarnings(() =>
      cell("hkabsent", { state: { n: 0 }, methods: {} })
    ),
    [],
  );
});

Deno.test("cell(): a listensTo trigger that is not an action names itself", () => {
  // `listensTo: { onCartCleared: cart.clear }` is the documented form, so a
  // typo'd or missing import makes the VALUE undefined — which reached
  // `tr.type` and threw "Cannot read properties of undefined (reading
  // 'type')". Every other mistake in that block already names the cell, the
  // key and the fix; this one named an internal property access.
  for (const [i, bad] of [undefined, 7, {}].entries()) {
    const err = assertThrows(
      () =>
        cell(`ltbad${i}`, {
          state: { n: 0 },
          methods: {
            onIt(s: { n: number }) {
              s.n++;
            },
          },
          listensTo: { onIt: bad },
        } as never),
      Error,
    );
    assertStringIncludes(err.message, "not an action", String(bad));
    assertStringIncludes(err.message, "import", String(bad));
  }
  // Both documented spellings keep working.
  assertExists(
    cell("ltstr", {
      state: { n: 0 },
      methods: {
        onIt(s: { n: number }) {
          s.n++;
        },
      },
      listensTo: { onIt: "cart:clear" },
    } as never),
  );
  assertExists(
    cell("ltobj", {
      state: { n: 0 },
      methods: {
        onIt(s: { n: number }) {
          s.n++;
        },
      },
      listensTo: { onIt: [{ type: "cart:clear" }] },
    } as never),
  );
});
