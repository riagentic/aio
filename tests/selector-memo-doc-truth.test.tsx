// What docs/basics/concepts.md says about selector memoization is what runs.
//
// It said "Derived state, memoized automatically" beside
// `expensive(s) { return heavyComputation(s.count) } // only runs when s.count
// changes`. Nothing memoized a plain selector: three reads of one unchanged
// state ran it three times, on the server bind and under testUI alike.
//
// It is not memoized AUTOMATICALLY on purpose. On the client a selector runs
// over a fresh ui-filtered, hidden-field-guarded slice and a lazy full-state
// proxy that records which cells it reads — so a cache hit would skip the very
// reads that subscribe the component and report a hidden field, and an
// identity cache could never hit there anyway. And "only when s.count changes"
// is a per-FIELD promise no identity cache keeps (a write to another field of
// the same slice is a new slice). `createSelector` keeps it on every runtime:
// its input selectors still run — so they subscribe and guard — and only the
// expensive combiner is skipped while the inputs are unchanged.
import { assertEquals } from "@std/assert";
import { cell, createSelector } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { testUI } from "../src/testing/ui-test.ts";

let plainRuns = 0;
let memoRuns = 0;
const heavy = (n: number) => n * 10;
type S = { count: number; other: number };

const counter = cell("selmemo", {
  state: { count: 0, other: 0 } as S,
  methods: {
    inc(s) {
      s.count++;
    },
    bumpOther(s) {
      s.other++;
    },
  },
  selectors: {
    // A plain selector runs on every read — the documented contract.
    doubled(s: S) {
      plainRuns++;
      return s.count * 2;
    },
    // The documented way to run only when `s.count` changes.
    expensive: createSelector(
      (s: S) => s.count,
      (count: number) => {
        memoRuns++;
        return heavy(count);
      },
    ),
  },
});

Deno.test("selectors (server bind): plain re-runs per read; createSelector only when its input changes", async () => {
  plainRuns = 0;
  memoRuns = 0;
  await using _h = await bootCells([counter]);
  counter.doubled();
  counter.doubled();
  counter.doubled();
  assertEquals(
    plainRuns,
    3,
    "a plain selector is NOT memoized — the doc must not say it is",
  );

  assertEquals(counter.expensive(), 0);
  counter.expensive();
  counter.expensive();
  assertEquals(memoRuns, 1, "three reads of one count → one run");
  await counter.bumpOther();
  counter.expensive();
  assertEquals(memoRuns, 1, "a change to ANOTHER field does not re-run it");
  await counter.inc();
  assertEquals(counter.expensive(), 10);
  assertEquals(memoRuns, 2, "a change to s.count does");
});

function App() {
  return (
    <main>
      <p>{counter.expensive()}</p>
      <p>{counter.expensive()}</p>
      <span>{counter.other}</span>
    </main>
  );
}

testUI(
  App,
  "selectors (testUI): createSelector skips the combiner and still re-renders on its input",
  async (ui) => {
    memoRuns = 0;
    await ui.settle();
    const afterMount = memoRuns;
    assertEquals(
      afterMount <= 1,
      true,
      `two reads of one count ran ${afterMount}×`,
    );
    await counter.bumpOther();
    await ui.settle();
    assertEquals(
      memoRuns,
      afterMount,
      "an unrelated field change must not re-run it",
    );
    await counter.inc();
    await ui.settle();
    assertEquals(memoRuns, afterMount + 1);
    assertEquals(
      ui.html().includes("10"),
      true,
      "the component still re-rendered with the new value",
    );
  },
);
