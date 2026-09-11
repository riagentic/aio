// One dep and an undestructured parameter is IRREDUCIBLY ambiguous.
//
// `{ deps: ["prices"], fn: (s, prices) => … }` is the retired SPREAD form.
// `{ deps: ["prices"], fn: (s, deps) => deps[0] }` is the CURRENT form written
// with a named parameter. At runtime they are the same function — one argument
// after the slice, and no `[` to read — so `secondParamIsTuple` cannot tell
// them apart, and only reading the SOURCE TEXT ever could (composer §4).
//
// It resolves toward the spread, so the second one receives the slice where it
// expects a tuple and `deps[0]` is `undefined`: correct-looking code, wrong
// number, no error. MEASURED below, not reasoned about.
//
// The resolution does not change — prod must keep degrading the way it always
// has. What changes is that the message now names BOTH readings, because the
// author of the second one was being told they used a form they had never
// heard of.
import { assert, assertEquals } from "@std/assert";
import {
  _resetSelectorHints,
  scopeSelectors,
} from "../src/state/cell-helpers.ts";

// deno-lint-ignore no-explicit-any
const G = globalThis as any;
/** Removals are fatal exactly where `__aioDev` is — see `removalsAreFatal`. */
const withDev = (on: boolean) => {
  const prev = G.__aioDev;
  G.__aioDev = on;
  return () => {
    if (prev === undefined) delete G.__aioDev;
    else G.__aioDev = prev;
  };
};

// deno-lint-ignore no-explicit-any
type D = any;

const full = { c: { n: 1 }, prices: { btc: 9 } };

function run(fn: unknown, deps: string[] = ["prices"]): unknown {
  const sc = scopeSelectors("c", { sel: { deps, fn } as D });
  return sc.sel!(full.c, full);
}

Deno.test("the documented tuple form receives a TUPLE", () => {
  _resetSelectorHints();
  assertEquals(run((_s: D, [p]: D[]) => p), { btc: 9 });
});

Deno.test("with TWO deps, arity separates the forms — no ambiguity", () => {
  _resetSelectorHints();
  const two = { c: { n: 1 }, a: { x: 1 }, b: { y: 2 } };
  const sc = scopeSelectors("c", {
    sel: { deps: ["a", "b"], fn: (_s: D, [a, b]: D[]) => [a, b] } as D,
  });
  assertEquals(sc.sel!(two.c, two), [{ x: 1 }, { y: 2 }]);
});

Deno.test("the AMBIGUOUS case is measured, not assumed", () => {
  // This is the defect the report found. It is pinned so that a future change
  // to the resolution is a deliberate one, and so the claim in the comment
  // above is checked rather than believed.
  _resetSelectorHints();
  const got = run((_s: D, deps: D) => deps);
  assertEquals(
    got,
    { btc: 9 },
    "a named second parameter gets the SLICE — so `deps[0]` is undefined",
  );
  _resetSelectorHints();
  assertEquals(
    run((_s: D, deps: D) => deps?.[0]),
    undefined,
    "…which is exactly the silent wrong number",
  );
});

Deno.test("the refusal names BOTH readings, and the one-character fix", () => {
  // Dev throws (removals are fatal), so the message is reachable as an error.
  _resetSelectorHints();
  const restore = withDev(true);
  try {
    let msg = "";
    try {
      scopeSelectors("c", {
        sel: { deps: ["prices"], fn: (_s: D, deps: D) => deps } as D,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(msg.length > 0, "dev must refuse the retired spelling");
    assert(msg.includes("SPREAD"), `the reading it chose: ${msg}`);
    assert(msg.includes("named parameter"), `the OTHER reading: ${msg}`);
    assert(msg.includes("undefined"), `what goes wrong: ${msg}`);
    assert(msg.includes("[prices]"), `the fix, spelled out: ${msg}`);
  } finally {
    restore();
    _resetSelectorHints();
  }
});

Deno.test("with TWO deps the message stays the plain registry line", () => {
  // The extra paragraph exists for a case that is genuinely ambiguous. Adding
  // it everywhere would be noise attached to a message that was already right.
  _resetSelectorHints();
  const restore = withDev(true);
  try {
    let msg = "";
    try {
      scopeSelectors("c", {
        sel: { deps: ["a", "b"], fn: (_s: D, _a: D, _b: D) => 1 } as D,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(msg.length > 0);
    assert(
      !msg.includes("named parameter"),
      `an unambiguous case must not carry the ambiguity note: ${msg}`,
    );
  } finally {
    restore();
    _resetSelectorHints();
  }
});
