// `timer.state.x` / `timer.selectors.x()` — the React/Redux reflex. A cell
// handle IS its state (`timer.x`) and its selectors (`timer.x()`), so both
// reads were a silent `undefined`, and the TypeError came one property later,
// naming nothing (field report cc §4, h3 Y4).
//
// Dev (and every harness — tests run dev-strict) THROWS a teachable error;
// prod answers `undefined` exactly as before. Category (b): dev stricter.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";

const timer = cell("reflex-timer", {
  state: { remaining: 25 },
  methods: {
    tick(s) {
      s.remaining--;
    },
  },
  selectors: {
    done: (s) => s.remaining <= 0,
  },
});

const g = globalThis as Record<string, unknown>;

function withDev<T>(on: boolean, fn: () => T): T {
  const prev = g.__aioDev;
  g.__aioDev = on;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete g.__aioDev;
    else g.__aioDev = prev;
  }
}

Deno.test("dev: cell.state throws, naming the right spelling", () => {
  const e = withDev(true, () =>
    // deno-lint-ignore no-explicit-any
    assertThrows(() => (timer as any).state));
  const msg = String(e);
  assertStringIncludes(msg, "reflex-timer");
  assertStringIncludes(msg, "the cell IS its state");
  assertStringIncludes(msg, "reflex-timer.remaining");
  assertStringIncludes(msg, "not reflex-timer.state.remaining");
});

Deno.test("dev: cell.selectors throws, naming the call form", () => {
  const e = withDev(true, () =>
    // deno-lint-ignore no-explicit-any
    assertThrows(() => (timer as any).selectors));
  assertStringIncludes(String(e), "reflex-timer.done()");
});

Deno.test("prod: both read undefined, as before", () => {
  withDev(false, () => {
    // deno-lint-ignore no-explicit-any
    assertEquals((timer as any).state, undefined);
    // deno-lint-ignore no-explicit-any
    assertEquals((timer as any).selectors, undefined);
  });
});

Deno.test("the real reads are untouched, and a cell may still own `selectors`", async () => {
  using _h = await bootCells([timer] as never);
  assertEquals(timer.remaining, 25);
  assertEquals(timer.done(), false);
  // `"state" in` / Object.keys never invoke the getter.
  assert(!Object.keys(timer).includes("state"));
  const own = cell("reflex-own-selectors", {
    state: { n: 1 },
    methods: {},
    selectors: { selectors: (s) => s.n + 1 },
  });
  using _h2 = await bootCells([own] as never);
  // deno-lint-ignore no-explicit-any
  assertEquals((own as any).selectors(), 2, "a selector NAMED selectors wins");
});
