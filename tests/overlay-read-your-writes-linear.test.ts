// An async method that reads its own writes must not re-clone state per write.
//
// `effectiveRoot()` overlays the pending batch on committed state so a method
// sees its own writes. It used to memoise on `(committed, pendingArray,
// pending.length)` — and since every write grows the batch, EVERY write
// invalidated the memo and the next read deep-cloned committed state and
// replayed the whole batch. A loop that reads its own writes was therefore
// O(n²) in time AND allocation:
//
//     N=1000   sync 6ms    async    768ms
//     N=2000   sync 12ms   async  3,176ms
//     N=4000   sync 23ms   async 12,882ms
//
// A field report measured 70.7 s of `structuredClone` inside a 150 s profile
// for one sweep over ~11,000 keys, with the event loop stalled for 54 s of it.
// Rewriting the identical body as a SYNC method was a 560× speedup nobody was
// ever told about, and the only diagnostic the author got pointed at a cause
// that was not theirs.
//
// The fix applies only the batch's new TAIL to the overlay it already has.
// Measured on this tree, same bodies: N=4000 went 12,882ms → 62ms.
//
// THIS TEST DOES NOT MEASURE TIME. A timing assertion on a shared machine is a
// flake generator, and the quantity that actually regressed is not
// milliseconds — it is the NUMBER OF DEEP CLONES. One clone per batch is the
// contract; one clone per write is the bug. Counting them is exact, so this
// fails the same way on a fast machine and a loaded one.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell.ts";
import { testCell } from "../src/cell-test.ts";

const WRITES = 400;

/** Deep clones performed while `fn` runs. `structuredClone` is what
 *  `cloneState` reaches for first (src/state/immutable.ts), and the overlay's
 *  snapshot is the only thing in this test big enough to reach it. */
async function clonesDuring(fn: () => Promise<void>): Promise<number> {
  const real = globalThis.structuredClone;
  let n = 0;
  globalThis.structuredClone = ((v: unknown) => {
    n++;
    return real(v);
  }) as typeof structuredClone;
  try {
    await fn();
  } finally {
    globalThis.structuredClone = real;
  }
  return n;
}

const grower = cell("overlay-linear", {
  state: { items: [] as number[], seen: 0 },
  methods: {
    // Reads its own writes on every iteration — `s.items.length` after a push
    // is exactly the shape that was quadratic.
    async grow(s, count: number) {
      for (let i = 0; i < count; i++) {
        s.items.push(i);
        s.seen = s.items.length;
      }
    },
    growSync(s, count: number) {
      for (let i = 0; i < count; i++) {
        s.items.push(i);
        s.seen = s.items.length;
      }
    },
  },
});

testCell(
  grower,
  "an async read-your-writes loop clones ONCE, not once per write",
  async (t) => {
    const clones = await clonesDuring(async () => {
      await t.send.grow(WRITES);
    });

    // The instrument first: if the writes did not happen, a clone count of zero
    // would "pass" and pin nothing.
    assertEquals(t.state.items.length, WRITES, "the method did not write");
    assertEquals(
      t.state.seen,
      WRITES,
      "the method did not read its own writes",
    );

    // The contract. One clone brings the overlay up; the rest of the batch is
    // applied onto it as a tail. A handful of extra clones elsewhere in a
    // dispatch is fine — one PER WRITE is the regression, and at 400 writes the
    // two are three orders of magnitude apart.
    assert(
      clones < WRITES / 4,
      `${clones} deep clones for ${WRITES} writes — the read-your-writes ` +
        `overlay is rebuilding per write again, which is O(n²) in time and ` +
        `allocation. See effectiveRoot() in src/state/cell-impl.ts: the batch ` +
        `only grows in place, so a read applies pending.slice(memo.count) onto ` +
        `the overlay it already has.`,
    );
  },
);

testCell(
  grower,
  "…and the sync path, which was never quadratic, still is not",
  async (t) => {
    // The parity half. The bug made the two flavours differ by 560× on the
    // identical body, which is the kind of gap that sends an author rewriting
    // working code for a reason nobody can name.
    const clones = await clonesDuring(async () => {
      await t.send.growSync(WRITES);
    });
    assertEquals(t.state.items.length, WRITES);
    assert(
      clones < WRITES / 4,
      `${clones} deep clones for ${WRITES} sync writes`,
    );
  },
);
