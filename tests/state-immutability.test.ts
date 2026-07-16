// state-immutability — the invariant harness that makes aio's recurring
// "state leak" / Immer-alias bug class UN-SHIPPABLE. These test the INVARIANTS,
// not individual bugs: if any regresses, this file goes red before release.
//
// The invariants:
//   1. testUI is hermetic — state added in one mount never leaks to the next.
//   2. Live state never aliases a cell's declared initial (clone-on-seed).
//   3. Signal identity is stable across reset (reset mutates values in place).
//   4. In dev, mutating a declared initial throws at the site (freeze guard).
//   5. Immer autoFreeze is on (produced state is frozen).
import { assert, assertEquals, assertThrows } from "@std/assert";
import { Window } from "happy-dom";
import { produce, setAutoFreeze } from "immer";
import { h } from "../src/air/vdom.ts";
import { cell } from "../src/state/cell-create.ts";
import { testUI } from "../src/testing/ui-test.ts";
import {
  cloneState,
  deepFreeze,
  freezeInitial,
} from "../src/state/immutable.ts";
import { _resetSignals, getCellSignal } from "../src/state/state-signals.ts";

// deno-lint-ignore no-explicit-any
const doc = () => new Window().document as any;

// ── Invariant 1: testUI hermeticity (the risoto #1 repro, permanent) ──

Deno.test("invariant: testUI does NOT leak cell state between mounts", async () => {
  const accts = cell("inv_accts", {
    state: { list: [] as string[] },
    methods: {
      add(s: { list: string[] }, n: string) {
        s.list.push(n);
      },
    },
  });
  const App = () => h("div", null, String(accts.list.length));

  const a = await testUI(App, { document: doc() });
  accts.add("x");
  await a.settle();
  await a.dispose();

  // Second mount MUST start pristine — the bug was it saw length 1.
  const b = await testUI(App, { document: doc() });
  await b.settle();
  assertEquals(accts.list.length, 0, "state leaked from the previous mount");
  await b.dispose();
});

Deno.test("invariant: three sequential mounts each start pristine", async () => {
  const c = cell("inv_seq", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n += 1;
      },
    },
  });
  const App = () => h("div", null, String(c.n));
  for (let i = 0; i < 3; i++) {
    const ui = await testUI(App, { document: doc() });
    assertEquals(c.n, 0, `mount ${i} started dirty`);
    c.inc();
    await ui.settle();
    await ui.dispose();
  }
});

// ── Invariant 2: live state never aliases the declared initial ──

Deno.test("invariant: mutating live state never touches the declared initial", async () => {
  const c = cell("inv_alias", {
    state: { items: [] as number[] },
    methods: {
      push(s: { items: number[] }, v: number) {
        s.items.push(v);
      },
    },
  });
  // deno-lint-ignore no-explicit-any
  const declared = (c as any).__aio.state;
  const App = () => h("div", null, String(c.items.length));
  const ui = await testUI(App, { document: doc() });
  c.push(1);
  c.push(2);
  await ui.settle();
  assertEquals(
    (declared as { items: number[] }).items.length,
    0,
    "declared initial was mutated in place",
  );
  await ui.dispose();
});

// ── Invariant 3: signal identity stable across reset ──

Deno.test("invariant: _resetSignals keeps the same signal instance", () => {
  const sig = getCellSignal("inv_identity", { a: 1 });
  sig.set({ a: 99 });
  _resetSignals();
  const sigAfter = getCellSignal("inv_identity");
  assert(
    sig === sigAfter,
    "reset swapped the signal instance (orphans getter closures)",
  );
  assertEquals(
    sigAfter.value,
    undefined,
    "reset should clear the value in place",
  );
});

// ── Invariant 4: dev freeze makes initial mutation throw ──

Deno.test("invariant: freezeInitial(dev) makes in-place mutation throw", () => {
  const prev = (globalThis as Record<string, unknown>).__aioDev;
  (globalThis as Record<string, unknown>).__aioDev = true;
  try {
    const frozen = freezeInitial({ list: [] as string[] });
    assertThrows(() => frozen.list.push("x"), TypeError);
  } finally {
    (globalThis as Record<string, unknown>).__aioDev = prev;
  }
});

Deno.test("invariant: freezeInitial always deep-clones (no caller aliasing)", () => {
  const original = { nested: { v: 1 } };
  const copy = freezeInitial(original);
  assert(copy !== original, "did not clone the top level");
  assert(copy.nested !== original.nested, "did not deep-clone");
  assertEquals(copy.nested.v, 1);
});

// ── Invariant 5: Immer autoFreeze is on (a future default flip can't disarm) ──

Deno.test("invariant: Immer autoFreeze is active (produced state is frozen)", () => {
  const next = produce({ list: [] as string[] }, (d) => {
    d.list.push("a");
  });
  assertThrows(
    () => (next.list as string[]).push("b"),
    TypeError,
    undefined,
    "produced state is not frozen — autoFreeze got disabled somewhere",
  );
  // restore the invariant explicitly in case another test toggled it
  setAutoFreeze(true);
});

// ── Utility unit coverage ──

Deno.test("cloneState: deep clone, never throws on circular", () => {
  const a = cloneState({ x: [1, 2], y: { z: 3 } });
  assertEquals(a, { x: [1, 2], y: { z: 3 } });
  // deno-lint-ignore no-explicit-any
  const circular: any = { self: null };
  circular.self = circular;
  cloneState(circular); // must not throw (falls back gracefully)
});

Deno.test("deepFreeze: recursive + cycle-safe", () => {
  // deno-lint-ignore no-explicit-any
  const o: any = { a: { b: 1 } };
  o.loop = o; // cycle
  deepFreeze(o);
  assert(Object.isFrozen(o));
  assert(Object.isFrozen(o.a));
});
