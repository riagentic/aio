// tests/cell-reactive.test.ts — direct reactive state access on cells
import { assertEquals } from "@std/assert";
import { bindCell, cell } from "aio";
import {
  _resetCellRegistry,
  bindCellReactive,
  getRegisteredCells,
} from "../src/cell-reactive.ts";
import { _resetSignals, getCellSignal } from "../src/state-signals.ts";

// ── Registration ─────────────────────────────────────────────────────

Deno.test("cell() registers cell in registry", () => {
  _resetCellRegistry();
  const c = cell("regtest", {
    state: { x: 1 },
    methods: { noop(_s: { x: number }) {} },
  });
  assertEquals(getRegisteredCells().has(c), true);
  _resetCellRegistry();
});

// ── State key / method overlap — method wins, no crash ───────────────

Deno.test("cell() allows overlapping state key and method name", () => {
  _resetCellRegistry();
  const c = cell("overlap", {
    state: { count: 0, increment: 0 },
    methods: {
      increment(s: { count: number; increment: number }) {
        s.count++;
      },
    },
  });
  // Method wins — increment is a function, not a state getter
  assertEquals(typeof c.increment, "function");
  _resetCellRegistry();
});

// ── Server-side bindCell state access ────────────────────────────────

Deno.test("bindCell: state getter reads from getState", () => {
  _resetCellRegistry();
  const c = cell("getter", {
    state: { count: 0 },
    methods: {
      bump(s: { count: number }) {
        s.count++;
      },
    },
  });

  const state: Record<string, unknown> = { getter: { count: 99 } };

  bindCell(
    c,
    async () => {},
    () => state,
  );

  // deno-lint-ignore no-explicit-any
  assertEquals((c as any).count, 99);

  // State changes reflected
  state.getter = { count: 200 };
  // deno-lint-ignore no-explicit-any
  assertEquals((c as any).count, 200);
  _resetCellRegistry();
});

Deno.test("bindCell: method not overridden by state getter", () => {
  _resetCellRegistry();
  const c = cell("methodprio", {
    state: { count: 0 },
    methods: {
      bump(s: { count: number }) {
        s.count++;
      },
    },
  });

  const state: Record<string, unknown> = { methodprio: { count: 5 } };
  bindCell(c, async () => {}, () => state);

  assertEquals(typeof c.bump, "function");
  // deno-lint-ignore no-explicit-any
  assertEquals((c as any).count, 5);
  _resetCellRegistry();
});

// ── Browser-side reactive binding ────────────────────────────────────

Deno.test("bindCellReactive installs signal-backed getters", () => {
  _resetCellRegistry();
  _resetSignals();

  const c = cell("reactive", {
    state: { value: 10, label: "hello" },
    methods: {
      setValue(s: { value: number }, v: number) {
        s.value = v;
      },
    },
  });

  // Before reactive binding, state keys are not on the cell
  // deno-lint-ignore no-explicit-any
  assertEquals((c as any).value, undefined);

  // Bind reactively
  bindCellReactive(c);

  // Now reads from signal (initial state)
  // deno-lint-ignore no-explicit-any
  assertEquals((c as any).value, 10);
  // deno-lint-ignore no-explicit-any
  assertEquals((c as any).label, "hello");

  // Update signal — getter reflects new value
  const sig = getCellSignal("reactive");
  sig.set({ value: 42, label: "world" });
  // deno-lint-ignore no-explicit-any
  assertEquals((c as any).value, 42);
  // deno-lint-ignore no-explicit-any
  assertEquals((c as any).label, "world");

  _resetCellRegistry();
  _resetSignals();
});

Deno.test("bindCellReactive is idempotent", () => {
  _resetCellRegistry();
  _resetSignals();

  const c = cell("idem", {
    state: { x: 1 },
    methods: { noop(_s: { x: number }) {} },
  });

  bindCellReactive(c);
  bindCellReactive(c); // second call is no-op

  // deno-lint-ignore no-explicit-any
  assertEquals((c as any).x, 1);

  _resetCellRegistry();
  _resetSignals();
});

Deno.test("bindCellReactive does not override methods", () => {
  _resetCellRegistry();
  _resetSignals();

  const c = cell("nooverride", {
    state: { count: 0 },
    methods: {
      bump(s: { count: number }) {
        s.count++;
      },
    },
  });

  bindCellReactive(c);

  assertEquals(typeof c.bump, "function");
  // deno-lint-ignore no-explicit-any
  assertEquals((c as any).count, 0);

  _resetCellRegistry();
  _resetSignals();
});

// ── AIO-NEW-4: action methods dispatch via sendFn ────────────────────

Deno.test("bindCellReactive wraps action methods with sendFn", () => {
  _resetCellRegistry();
  _resetSignals();

  const c = cell("dispatch", {
    state: { count: 0 },
    methods: {
      increment(s: { count: number }, by = 1) {
        s.count += by;
      },
    },
  });

  const dispatched: { type: string; payload?: unknown }[] = [];
  const sendFn = (action: { type: string; payload?: unknown }) => {
    dispatched.push(action);
  };

  bindCellReactive(c, sendFn);

  // Call the method — should dispatch, not return raw action object
  const result = c.increment(5);
  assertEquals(result, undefined); // dispatch returns void, not action object
  assertEquals(dispatched.length, 1);
  assertEquals(dispatched[0]!.type, "dispatch:increment");

  _resetCellRegistry();
  _resetSignals();
});

Deno.test("bindCellReactive without sendFn leaves action creators as-is", () => {
  _resetCellRegistry();
  _resetSignals();

  const c = cell("nodispatch", {
    state: { count: 0 },
    methods: {
      increment(s: { count: number }) {
        s.count++;
      },
    },
  });

  // No sendFn — action creators should remain raw
  bindCellReactive(c);

  const result = c.increment();
  // Without sendFn, creator returns the action object
  // deno-lint-ignore no-explicit-any
  assertEquals((result as any).type, "nodispatch:increment");

  _resetCellRegistry();
  _resetSignals();
});

// ── Actions-based cell — overlapping state/action name ────────────────

Deno.test("actions cell: allows overlapping state key and action name", () => {
  _resetCellRegistry();
  const c = cell("actoverlap", {
    state: { error: null as string | null },
    actions: {
      error: (msg: string) => ({ msg }),
    },
    reduce: {
      error(s: { error: string | null }, p: { msg: string }) {
        s.error = p.msg;
      },
    },
  });
  // Action wins — error is a function on the cell
  // deno-lint-ignore no-explicit-any
  assertEquals(typeof (c as any).error, "function");
  _resetCellRegistry();
});
