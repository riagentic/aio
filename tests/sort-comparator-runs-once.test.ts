// A `sort` comparator runs where the author wrote it — once — in an async
// method as well as a sync one.
//
// Read-your-writes in an async method is an OVERLAY: every read recomputes the
// effective value by replaying the pending batch over committed state. A
// recorded `sort(cmp)` replayed `cmp` — so the comparator re-ran on every
// later read inside the same method. Measured with the identical body:
//
//   comparator invocations   SYNC 4   ASYNC 28
//   at n=1000 with 10 reads: SYNC 8,536   ASYNC 102,432
//
// A PURE comparator only made that slow. One that counts, logs, memoises or
// appends to a captured array DIVERGED — the same body committed
// `["1","2","2"]` sync and `["1","2","2","1","2","2"]` async.
//
// `CLAUDE.md` promises a method body "behaves identically whether it is sync
// or async" and names `tests/proxy-differential.test.ts` as the proof. That
// fuzzer could not see this: every sort op in `tests/fuzz-ops.ts` used a pure
// `(a, b) => a - b`, which produces the same array however many times it runs.
// It has a counting comparator now, and goes red without the fix.
//
// The fix records the sort's ANSWER — the permutation it produced — instead of
// its question. The comparator runs once; the replay is a reorder.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";

type S = { rows: { id: number }[]; n: number };

let calls = 0;
const initial = (): S => ({
  rows: [{ id: 5 }, { id: 3 }, { id: 9 }, { id: 1 }],
  n: 0,
});
const body = (s: S) => {
  s.rows.sort((a, b) => {
    calls++;
    return a.id - b.id;
  });
  // Five ordinary reads AFTER the sort — this is when the replay happened.
  for (let i = 0; i < 5; i++) s.n = s.rows[0]!.id;
};

const syncCell = cell("sortonce_s", {
  state: initial(),
  methods: {
    run(s: S) {
      body(s);
    },
  },
});
const asyncCell = cell("sortonce_a", {
  state: initial(),
  methods: {
    async run(s: S) {
      body(s);
      await Promise.resolve();
    },
  },
});

Deno.test("sort: the comparator runs the same number of times sync and async", async () => {
  const h = await bootCells([syncCell, asyncCell]);
  try {
    calls = 0;
    await syncCell.run();
    await h.settle();
    const sync = calls;

    calls = 0;
    await asyncCell.run();
    await h.settle();
    const async_ = calls;

    assert(sync > 0, "the comparator really did run");
    assertEquals(
      async_,
      sync,
      `an async method re-ran the comparator on every later READ — ${sync} ` +
        `sync vs ${async_} async. A comparator with a side effect diverges; ` +
        `a pure one is merely quadratic.`,
    );
    // …and the answer is the same one.
    assertEquals(syncCell.rows.map((r) => r.id), [1, 3, 5, 9]);
    assertEquals(asyncCell.rows.map((r) => r.id), [1, 3, 5, 9]);
    assertEquals(asyncCell.n, 1);
  } finally {
    h.dispose();
  }
});

// The same shape with an IMPURE comparator, which is where the count became a
// wrong answer rather than a slow one.
type P = { nums: number[]; seen: string[]; n: number };
const pInit = (): P => ({ nums: [3, 1, 2], seen: [], n: 0 });
const pBody = (s: P) => {
  const local: string[] = [];
  s.nums.sort((a, b) => {
    local.push(String(Math.min(a, b)));
    return a - b;
  });
  s.seen = local;
  for (let i = 0; i < 3; i++) s.n = s.nums[0]!;
};
const pSync = cell("sortpure_s", {
  state: pInit(),
  methods: {
    run(s: P) {
      pBody(s);
    },
  },
});
const pAsync = cell("sortpure_a", {
  state: pInit(),
  methods: {
    async run(s: P) {
      pBody(s);
      await Promise.resolve();
    },
  },
});

Deno.test("sort: a comparator's side effects land once, sync and async", async () => {
  const h = await bootCells([pSync, pAsync]);
  try {
    await pSync.run();
    await h.settle();
    await pAsync.run();
    await h.settle();
    assertEquals(
      pAsync.seen,
      pSync.seen,
      "the comparator's own writes must not be doubled by the overlay replay",
    );
    assertEquals(pSync.nums, [1, 2, 3]);
    assertEquals(pAsync.nums, [1, 2, 3]);
  } finally {
    h.dispose();
  }
});

// And the ordering itself, for the cases a permutation has to get right.
Deno.test("sort: the recorded order is the sort's own, ties and all", async () => {
  type T = { xs: { k: number; tag: string }[] };
  const c = cell("sortties", {
    state: {
      xs: [
        { k: 2, tag: "a" },
        { k: 1, tag: "b" },
        { k: 2, tag: "c" },
        { k: 1, tag: "d" },
      ],
    } as T,
    methods: {
      async run(s: T) {
        s.xs.sort((a, b) => a.k - b.k);
        await Promise.resolve();
      },
    },
  });
  const h = await bootCells([c]);
  try {
    await c.run();
    await h.settle();
    // A stable sort keeps b before d and a before c.
    assertEquals(c.xs.map((x) => x.tag), ["b", "d", "a", "c"]);
  } finally {
    h.dispose();
  }
});
