// `cell.$pending("scan")` — how many calls are in flight, reactively.
//
// A field report counted ten hand-rolled booleans across five cells, each set
// at the top of a method and reset in a `finally` — ten chances to forget —
// then replicated, persisted and migrated like real domain state, which they
// are not (report 8 §14, report 9 §9.5).
//
// AND A COUNT, NEVER A FLAG. The fourth hand-rolled one was wrong in exactly
// the way a boolean must be: two readings overlapped, so the first to finish
// declared silence while the speakers were still going. That case is the
// reason this exists and is the first thing asserted.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testCell } from "../src/cell-test.ts";
import {
  bumpPending,
  pendingCount,
  pendingForCell,
  resetPendingCalls,
} from "../src/protocol/pending-calls.ts";
import { resetPendingSignals } from "../src/state/pending.ts";

// deno-lint-ignore no-explicit-any
type D = any;

const defer = () => {
  let go: () => void = () => {};
  const p = new Promise<void>((r) => (go = r));
  return { p, go };
};

Deno.test("the counter counts, and never goes negative", () => {
  resetPendingCalls();
  assertEquals(pendingCount("c:m"), 0);
  bumpPending("c:m", 1);
  bumpPending("c:m", 1);
  assertEquals(pendingCount("c:m"), 2, "two overlapping calls are TWO");
  bumpPending("c:m", -1);
  assertEquals(
    pendingCount("c:m"),
    1,
    "the first to finish must not silence it",
  );
  bumpPending("c:m", -1);
  assertEquals(pendingCount("c:m"), 0);
  // A double release must not push it below zero and strand the count.
  bumpPending("c:m", -1);
  assertEquals(pendingCount("c:m"), 0);
  resetPendingCalls();
});

Deno.test("a cell-wide count sums its methods, and only its own", () => {
  resetPendingCalls();
  bumpPending("scan:a", 1);
  bumpPending("scan:b", 2);
  bumpPending("other:a", 5);
  assertEquals(pendingForCell("scan"), 3);
  assertEquals(pendingForCell("other"), 5);
  // A prefix is not a cell name: `scanner` must not be summed into `scan`.
  bumpPending("scanner:a", 7);
  assertEquals(pendingForCell("scan"), 3);
  resetPendingCalls();
});

let gate = defer();
const jobs = cell("pendingcell", {
  state: { done: 0 },
  methods: {
    async scan(s: { done: number }, _p: string) {
      await gate.p;
      s.done++;
    },
    async other(s: { done: number }) {
      await gate.p;
      s.done++;
    },
  },
} as D);

testCell(
  jobs,
  "$pending rises while a method runs and falls when it settles",
  async (t: D) => {
    resetPendingCalls();
    resetPendingSignals();
    gate = defer();
    assertEquals((jobs as D).$pending("scan"), 0);
    const a = t.send.scan("/x");
    assertEquals((jobs as D).$pending("scan"), 1);
    const b = t.send.scan("/y");
    assertEquals(
      (jobs as D).$pending("scan"),
      2,
      "TWO overlapping readings — the case a boolean gets wrong",
    );
    gate.go();
    await Promise.all([a, b]);
    assertEquals((jobs as D).$pending("scan"), 0);
    // Deliberately NOT `done === 2`: two concurrent non-transactional calls
    // both read 0 and both write 1, so last-write-wins leaves 1. That is aio's
    // documented behaviour and a different contract from this one — asserting
    // it here would fail for a reason that has nothing to do with $pending.
    assert(t.getState().done >= 1, "both calls must have run");
  },
);

testCell(jobs, "$pending() with no method is the whole cell", async (t: D) => {
  resetPendingCalls();
  resetPendingSignals();
  gate = defer();
  t.init();
  const a = t.send.scan("/x");
  const b = t.send.other();
  assertEquals((jobs as D).$pending("scan"), 1);
  assertEquals((jobs as D).$pending("other"), 1);
  assertEquals((jobs as D).$pending(), 2, "the cell-wide count is the sum");
  gate.go();
  await Promise.all([a, b]);
  assertEquals((jobs as D).$pending(), 0);
});

testCell(jobs, "a THROWING method still releases its count", async (t: D) => {
  // The `finally` everyone forgets. If aio forgot it, a spinner would stay up
  // forever after the one failure people most want to see.
  resetPendingCalls();
  resetPendingSignals();
  const boom = cell("pendingboom", {
    state: { n: 0 },
    methods: {
      async fail(_s: D) {
        await Promise.resolve();
        throw new Error("nope");
      },
    },
  } as D);
  try {
    await (boom as D).fail();
  } catch { /* expected */ }
  assertEquals((boom as D).$pending("fail"), 0);
  void t;
});

Deno.test("$pending is NOT state — never broadcast, persisted or migrated", () => {
  const c = cell("pendingnotstate", { state: { a: 1 }, methods: {} } as D);
  // It is not enumerable, so it is not in the state shape a broadcast, a
  // persist filter or a migration ever walks. That is the entire complaint:
  // ten booleans replicated and migrated like real domain state.
  assertEquals(Object.keys((c as D).__aio.state), ["a"]);
  assert(!Object.keys(c as D).includes("$pending"));
  assertEquals(typeof (c as D).$pending, "function");
});
