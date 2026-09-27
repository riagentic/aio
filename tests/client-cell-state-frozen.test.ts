// A `scope: "client"` cell's committed state is NOT frozen, so a component (or
// the caller of a method that returned a slice) can mutate cell state in place:
// the write silently sticks, and no subscriber is told. CLAUDE.md: "committed
// state is frozen identically [in dev and prod], so an illegal mutation throws".
// A server cell's slice is deep-frozen before it is installed in the cell signal
// (state-signals.ts AIO-4.4) and Immer freezes every commit; the client cell's
// binding installs a bare `structuredClone` (cell-reactive.ts) instead.
import { assertEquals, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import {
  _resetCellRegistry,
  bindCellReactive,
} from "../src/state/cell-reactive.ts";
import { _resetSignals } from "../src/state/state-signals.ts";
import { _resetSubs } from "../src/state/state-subs.ts";
import { effect } from "../src/state/signal.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("client cell: committed state is frozen — an out-of-method mutation throws", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevDev = g.__aioDev;
  g.__aioDev = true; // the harness runs dev-strict; be explicit
  _resetCellRegistry();
  _resetSignals();
  try {
    const c = cell("zzfrozen", {
      scope: "client" as const,
      state: { items: [] as number[] },
      methods: {
        add(s: { items: number[] }, n: number) {
          s.items.push(n);
          return s.items;
        },
      },
    }) as Any;
    bindCellReactive(c);
    let runs = 0;
    const stop = effect(() => {
      void c.items;
      runs++;
    });
    const returned = await c.add(1);
    assertEquals(c.items, [1]);
    assertEquals(runs, 2);

    // Mutating the method's returned value, or the reactive read, must not be
    // able to change committed state behind the signal's back.
    assertThrows(() => returned.push(2));
    assertThrows(() => c.items.push(3));
    assertEquals(c.items, [1], "committed state unchanged");
    stop();
  } finally {
    g.__aioDev = prevDev;
    _resetSubs();
  }
});
