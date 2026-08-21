// A `scope: "client"` cell's sync method must resolve with what it RETURNED.
//
// The documented contract (docs/state/methods.md) is that a method's return
// value reaches its caller — across the wire in an ack frame for a server cell,
// and raw for an in-process caller, "in-process callers always get the raw
// value". A client cell is the most in-process caller there is: the method runs
// locally against the cell signal, with no dispatch and no network.
//
// It resolved `undefined` forever. The binding called `method(next, ...args)`
// for its mutations and then returned a bare `Promise.resolve()`, so the SAME
// method body — `add(s, x) { s.n += x; return s.n }` — handed back a number on a
// server cell and nothing on a client one. A stated parity contract, broken in
// the direction that is silent: no throw, no warning, just `undefined` where a
// value was.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import {
  _resetCellRegistry,
  bindCellReactive,
} from "../src/state/cell-reactive.ts";
import { _resetSignals } from "../src/state/state-signals.ts";
import { own } from "../src/state/own.ts";
import { schedule } from "../src/state/schedule.ts";
import { isOwnEffect } from "../src/state/own.ts";
import { isScheduleEffect } from "../src/state/schedule.ts";

function reset() {
  _resetCellRegistry();
  _resetSignals();
}

Deno.test("client cell: a sync method's return value reaches its caller", async () => {
  reset();
  const counter = cell("ccret", {
    scope: "client" as const,
    state: { n: 0, log: [] as string[] },
    methods: {
      // The shape every app writes: mutate, then hand back what you made.
      add(s: { n: number }, by: number): number {
        s.n += by;
        return s.n;
      },
      // A slice of the draft — snapshotted, so it survives the method.
      describe(s: { n: number }): { at: number; label: string } {
        return { at: s.n, label: `n=${s.n}` };
      },
      nothing(_s: { n: number }): void {},
    },
  });
  bindCellReactive(counter);

  assertEquals(
    await counter.add(3),
    3,
    "the value the method returned, not undefined",
  );
  assertEquals(await counter.add(4), 7, "…and it reflects the new state");
  assertEquals(await counter.describe(), { at: 7, label: "n=7" });
  assertEquals(
    await counter.nothing(),
    undefined,
    "a method that returns nothing still resolves undefined",
  );
  // The mutation half must not have regressed while the return was added.
  assertEquals(counter.n, 7);
});

Deno.test("client cell: the returned value is the RAW value, not a JSON round-trip", async () => {
  reset();
  // Only the network boundary requires JSON; a client cell has no wire, so it
  // is held to the in-process rule — the caller gets the object it was handed.
  const marker = { deep: { kept: true } };
  const c = cell("ccraw", {
    scope: "client" as const,
    state: { n: 0 },
    methods: {
      give(_s: { n: number }): { deep: { kept: boolean } } {
        return marker;
      },
    },
  });
  bindCellReactive(c);
  const got = await c.give();
  assertEquals(got, marker);
  assert(got.deep.kept);
});

// A client cell has no effect runtime, which `s.$do()` already says loudly. An
// effect RETURNED from the method is exactly as dead and used to be dropped
// without a word — the silent no-op that the $do guard exists to prevent, one
// spelling over.
Deno.test("client cell: returning an effect is refused, not silently dropped", () => {
  reset();
  const c = cell("cceff", {
    scope: "client" as const,
    state: { n: 0 },
    methods: {
      // deno-lint-ignore no-explicit-any
      timer(_s: { n: number }): any {
        return schedule.after("t", 10, { type: "cceff:noop" });
      },
      // deno-lint-ignore no-explicit-any
      resource(_s: { n: number }): any {
        return own.set("r", () => {});
      },
    },
  });
  bindCellReactive(c);

  for (
    const [name, call] of [["timer", () => c.timer()], [
      "resource",
      () => c.resource(),
    ]] as const
  ) {
    let msg = "";
    try {
      call();
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(msg.includes("client"), `${name} must refuse loudly: ${msg}`);
    assert(
      msg.includes("no effect runtime"),
      `${name} must say why: ${msg}`,
    );
  }
});

// `deadClientEffect` in cell-reactive.ts is a hand-kept twin of these two
// guards: the real ones live in modules this browser-reachable file will not
// import (schedule.ts reaches blocking.ts and the Deno worker pool). The twin
// is only honest if something checks it against the real thing, with REAL
// effects rather than hand-written literals — a renamed tag or a new effect
// kind has to fail here.
Deno.test("client cell: the effect twin agrees with the real guards", () => {
  const real = [
    schedule.after("a", 1, { type: "x" }),
    schedule.every("b", 1, { type: "x" }),
    own.set("c", () => {}),
    own.dispose("c"),
  ];
  for (const e of real) {
    assert(
      isScheduleEffect(e) || isOwnEffect(e),
      "fixture must be a real effect",
    );
    const tag = (e as { type?: unknown }).type;
    assert(
      tag === "__schedule" || tag === "__own",
      `an effect the twin cannot see: ${JSON.stringify(e)} — teach ` +
        `deadClientEffect() its tag, or a client cell will drop it silently`,
    );
  }
  // …and the twin must not swallow ordinary values a method may return.
  for (
    const notAnEffect of [
      undefined,
      null,
      0,
      "",
      "__own",
      { type: "cart:add" },
      { type: undefined },
      [],
    ]
  ) {
    assert(
      !isScheduleEffect(notAnEffect) && !isOwnEffect(notAnEffect),
      `${JSON.stringify(notAnEffect)} is not an effect`,
    );
  }
});
