// The read-your-writes overlay of an async method is built ONCE per batch and
// kept up to date incrementally — it is not re-cloned per read.
//
// Before this, the overlay memo was keyed on the pending write-set's LENGTH,
// so every write invalidated it and the next read re-ran
// `snapshotForRead` (a structuredClone of the whole cell) plus a replay of the
// whole batch. The idiomatic shape
//
//     for (const k of Object.keys(s.map)) { const p = s.map[k]; s.map[k] = f(p); }
//
// is therefore N full clones of the cell for N keys — quadratic. A field
// report measured it at ~11 000 keys: 70.7 s of structuredClone inside a 150 s
// CPU profile, the event loop stalled for 54 s of it, and the method never
// finished inside its ceiling.
//
// The instrument is the clone itself, not a stopwatch: `structuredClone` is
// counted, so the assertion is exact on any machine.
import { assertEquals, assertLess } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Count structuredClone calls that copy THIS cell's state root (the marker
 *  key is only ever on the cell's own state), while `fn` runs. */
async function cellClones(
  marker: string,
  fn: () => Promise<void>,
): Promise<number> {
  const real = globalThis.structuredClone;
  let n = 0;
  globalThis.structuredClone = ((v: unknown) => {
    if (v !== null && typeof v === "object" && marker in (v as object)) n++;
    return real(v);
  }) as typeof structuredClone;
  try {
    await fn();
  } finally {
    globalThis.structuredClone = real;
  }
  return n;
}

const seed = (n: number): Record<string, number> => {
  const o: Record<string, number> = {};
  for (let i = 0; i < n; i++) o[`k${i}`] = i;
  return o;
};

Deno.test("async overlay: a read-after-write loop clones the cell O(1) times", async () => {
  const N = 200;
  const c = cell("ovl_loop", {
    state: { sol: seed(N), seen: [] as number[] },
    methods: {
      async sweep(s: Any) {
        await Promise.resolve(); // past the await: reads go through the overlay
        for (const k of Object.keys(s.sol)) {
          const prev = s.sol[k]; // read-your-writes
          s.sol[k] = prev + 1; // …invalidates the old memo key
          s.seen.push(s.sol[k]); // read it back
        }
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const clones = await cellClones("sol", async () => {
      await (c as Any).sweep();
      await h.settle();
    });
    // Every write lands, and every read saw the write before it.
    assertEquals((c as Any).sol.k0, 1);
    assertEquals((c as Any).sol[`k${N - 1}`], N);
    assertEquals((c as Any).seen.length, N);
    assertEquals((c as Any).seen[0], 1);
    assertEquals((c as Any).seen[N - 1], N);
    // The overlay is a per-batch structure: a handful of clones for the whole
    // sweep, never one per write. Quadratic would be >= N.
    assertLess(clones, 10);
  } finally {
    h.dispose();
  }
});

Deno.test("async overlay: incremental applies keep alias identity, like the commit", async () => {
  // `ownedValue` de-duplicates one recorded object installed at two paths, so
  // that `s.a` and `s.b` are the SAME object until the commit — exactly as
  // they are on the Immer draft a sync method runs on. That memo belongs to
  // one apply PASS; the overlay's incremental applies are one pass split
  // across reads, so they share it. A read between the two installs is what
  // splits them.
  const body = (s: Any, log: unknown[]) => {
    const o = { v: 1 };
    s.a = o;
    log.push(s.a.v); // forces the overlay up to date between the installs
    s.b = o;
    s.a.v = 2;
    log.push(s.b.v, s.a.v);
  };
  const sl: unknown[] = [];
  const al: unknown[] = [];
  const sc = cell("ovl_alias_s", {
    state: { a: null as unknown, b: null as unknown },
    methods: { run: (s: Any) => body(s, sl) },
  });
  const ac = cell("ovl_alias_a", {
    state: { a: null as unknown, b: null as unknown },
    methods: {
      // deno-lint-ignore require-await
      async run(s: Any) {
        body(s, al);
      },
    },
  });
  const h = await bootCells([sc, ac]);
  try {
    await (sc as Any).run();
    await (ac as Any).run();
    await h.settle();
    assertEquals(al, sl);
    assertEquals(
      JSON.parse(JSON.stringify((ac as Any).a)),
      JSON.parse(JSON.stringify((sc as Any).a)),
    );
    assertEquals(
      JSON.parse(JSON.stringify((ac as Any).b)),
      JSON.parse(JSON.stringify((sc as Any).b)),
    );
  } finally {
    h.dispose();
  }
});

Deno.test("async overlay: a live array view is rebuilt when a write grows the array", async () => {
  // The per-path live-array memo used to prove "unchanged" by the array's
  // IDENTITY alone — true only while every read re-cloned the overlay. The
  // overlay now pushes INTO the array it already handed out, so the write-set
  // cursor is part of that proof. Without it, `toSorted()` after a push in the
  // same method answers from the pre-push view.
  const body = (s: Any, log: unknown[]) => {
    for (const n of s.nums) if (n < 100) s.nums.push(n + 100);
    log.push(s.nums.toSorted((x: number, y: number) => x - y).join(","));
    log.push(s.nums.map((n: number) => n).length);
    s.nums.push(7);
    log.push(s.nums.filter((n: number) => n === 7).length);
  };
  const sl: unknown[] = [];
  const al: unknown[] = [];
  const sc = cell("ovl_arr_s", {
    state: { nums: [1, 2, 3] },
    methods: { run: (s: Any) => body(s, sl) },
  });
  const ac = cell("ovl_arr_a", {
    state: { nums: [1, 2, 3] },
    methods: {
      // deno-lint-ignore require-await
      async run(s: Any) {
        body(s, al);
      },
    },
  });
  const h = await bootCells([sc, ac]);
  try {
    await (sc as Any).run();
    await (ac as Any).run();
    await h.settle();
    assertEquals(sl, ["1,2,3,101,102,103", 6, 1]);
    assertEquals(al, sl);
    assertEquals((ac as Any).nums, (sc as Any).nums);
  } finally {
    h.dispose();
  }
});
