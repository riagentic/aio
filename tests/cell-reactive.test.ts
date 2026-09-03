// tests/cell-reactive.test.ts — direct reactive state access on cells
import { assertEquals } from "@std/assert";
import { bindCell, cell } from "aio";
import {
  _resetCellRegistry,
  bindCellReactive,
  getRegisteredCells,
} from "../src/state/cell-reactive.ts";
import { _resetSignals, getCellSignal } from "../src/state/state-signals.ts";
import {
  _rejectAllPending,
  _resolveAck,
  _setAckTimeoutMs,
} from "../src/browser/browser-ack.ts";

// ── Registration ─────────────────────────────────────────────────────

Deno.test("cell() registers cell in registry", () => {
  _resetCellRegistry();
  const c = cell("regtest", {
    state: { x: 1 },
    methods: { noop(_s: { x: number }) {} },
  });
  assertEquals(getRegisteredCells().has(c.__aio.id), true);
  _resetCellRegistry();
});

Deno.test("cell() replaces existing entry with same id (dedup)", () => {
  _resetCellRegistry();
  const c1 = cell("dedup", {
    state: { x: 1 },
    methods: { noop(_s: { x: number }) {} },
  });
  // Simulate HMR re-definition: same id, new object reference
  const c2 = cell("dedup", {
    state: { x: 2 },
    methods: { noop(_s: { x: number }) {} },
  });
  assertEquals(getRegisteredCells().size, 1);
  assertEquals(getRegisteredCells().get("dedup"), c2);
  _resetCellRegistry();
});

// ── State key / method-name collision — throws at cell() time ────────

Deno.test("AIO-6.1: cell() throws when a state key collides with a method name", () => {
  _resetCellRegistry();
  let caught: Error | null = null;
  try {
    cell("overlap", {
      state: { count: 0, increment: 0 },
      methods: {
        increment(s: { count: number; increment: number }) {
          s.count++;
        },
      },
    });
  } catch (e) {
    caught = e as Error;
  }
  assertEquals(caught instanceof Error, true);
  assertEquals(
    caught!.message.includes("collides with method 'increment'"),
    true,
  );
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

  // Before reactive binding, state keys return their declared defaults
  // (AIO-391: creation-time getters; overridden by the signal-backed ones below)
  // deno-lint-ignore no-explicit-any
  assertEquals((c as any).value, 10);

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

Deno.test("bindCellReactive wraps action methods with sendFn", async () => {
  _resetCellRegistry();
  _resetSignals();
  _setAckTimeoutMs(0); // disable ack timer — no need for an actual ack
  const c = cell("dispatch", {
    state: { count: 0 },
    methods: {
      increment(s: { count: number }, by = 1) {
        s.count += by;
      },
    },
  });

  const dispatched: { type: string; payload?: unknown; cid?: string }[] = [];
  const sendFn = (
    action: { type: string; payload?: unknown; cid?: string },
  ) => {
    dispatched.push(action);
  };

  bindCellReactive(c, sendFn);

  // Call the method — should dispatch with a cid and return a Promise<void>.
  const result = c.increment(5);
  assertEquals(result instanceof Promise, true);
  // The wrapper sends in a microtask — wait one tick to observe the dispatch.
  await Promise.resolve();
  assertEquals(dispatched.length, 1);
  assertEquals(dispatched[0]!.type, "dispatch:increment");
  assertEquals(typeof dispatched[0]!.cid, "string");
  assertEquals((dispatched[0]!.cid as string).length > 0, true);
  // Resolve the ack so the awaited promise settles.
  _resolveAck(dispatched[0]!.cid!);
  await result;

  _resetCellRegistry();
  _resetSignals();
  _rejectAllPending(new Error("test reset"));
});

Deno.test("bindCellReactive without sendFn leaves method as unbound guard", () => {
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

  // No sendFn — method is not wrapped, so calling it hits the unbound guard.
  bindCellReactive(c);

  // The guard now THROWS (dev + prod) — a pre-boot dispatch has no runtime, so
  // silently no-op'ing would lose the write.
  let threw = false;
  try {
    c.increment();
  } catch (e) {
    threw = true;
    assertEquals(
      (e as Error).message.includes("before the cell's runtime is booted"),
      true,
    );
  }
  assertEquals(
    threw,
    true,
    "unbound method call must throw, not silently no-op",
  );
  // The action descriptor is still reachable for schedules/tests.
  // deno-lint-ignore no-explicit-any
  assertEquals(typeof (c.__aio.actions.increment as any).type, "string");

  _resetCellRegistry();
  _resetSignals();
});

// ── Actions-based cell — overlapping state/action name ────────────────

Deno.test("AIO-6.1: cell throws when a state key collides with a method name", () => {
  // Ported from the actions-form variant (Style B deleted, perfect-aio D1) —
  // the capability is the same: a state key shadowed by a callable must fail
  // loudly at definition time.
  _resetCellRegistry();
  let caught: Error | null = null;
  try {
    cell("actoverlap", {
      state: { error: null as string | null },
      methods: {
        error(s, msg: string) {
          s.error = msg;
        },
      },
    });
  } catch (e) {
    caught = e as Error;
  }
  assertEquals(caught instanceof Error, true);
  assertEquals(caught!.message.includes("collides with method 'error'"), true);
  _resetCellRegistry();
});

// AIO-422: selectors must be callable on the BROWSER cell too — they
// existed only server-side, so `cell.count()` threw `is not a function` in the
// browser with no boot/typecheck warning (a "quiet lie" vs the docs).
Deno.test("bindCellReactive binds selectors (own-slice) callable in browser", () => {
  _resetCellRegistry();
  _resetSignals();
  const c = cell("sel", {
    state: { items: [] as number[] },
    methods: {
      add(s: { items: number[] }, n: number) {
        s.items.push(n);
      },
    },
    selectors: {
      count: (s: { items: number[] }) => s.items.length,
      sum: (s: { items: number[] }) => s.items.reduce((a, b) => a + b, 0),
    },
  });
  bindCellReactive(c);
  // deno-lint-ignore no-explicit-any
  const cc = c as any;
  assertEquals(typeof cc.count, "function", "selector is callable in browser");
  assertEquals(cc.count(), 0);
  getCellSignal("sel").set({ items: [2, 3, 5] });
  assertEquals(cc.count(), 3, "reflects signal update");
  assertEquals(cc.sum(), 10);
  _resetCellRegistry();
  _resetSignals();
});

Deno.test("bindCellReactive: deps-form selector reads another cell in browser", () => {
  _resetCellRegistry();
  _resetSignals();
  const users = cell("users", { state: { list: [] as string[] }, methods: {} });
  const stats = cell("stats", {
    state: { threshold: 1 },
    methods: {},
    selectors: {
      // deps-form: reads the `users` cell's slice via full state
      overThreshold: {
        deps: ["users"],
        fn: (s: { threshold: number }, [u]: unknown[]) =>
          (u as { list: string[] }).list.length >= s.threshold,
      },
    },
  });
  bindCellReactive(users);
  bindCellReactive(stats);
  // deno-lint-ignore no-explicit-any
  const ss = stats as any;
  assertEquals(ss.overThreshold(), false, "0 users < threshold 1");
  getCellSignal("users").set({ list: ["alice"] });
  assertEquals(
    ss.overThreshold(),
    true,
    "cross-cell selector sees users update",
  );
  _resetCellRegistry();
  _resetSignals();
});
