// The retained-bytes estimate behind the timeline's byte budget (and dev time
// travel's) is CHEAP, and its accuracy has a stated bound.
//
// It walked every node: ~15–20 ms for a replaced 200k-row array — slower than
// `JSON.stringify` of the same value — on the dispatch path of every action
// that replaced a big value, always on, in production. Large containers are
// sampled now (src/diagnostics/retained-bytes.ts); these pin the speed and the
// bound the module header states, against a reference EXACT walk of the same
// model.
import { assert, assertEquals } from "@std/assert";
import { approxRetainedBytes } from "../src/server/timeline.ts";
import {
  approxDeltaBytes,
  RETAINED_SAMPLE,
  SLOT_BYTES,
} from "../src/diagnostics/retained-bytes.ts";

/** The model, walked exhaustively — the reference the estimate is held to. */
function exact(v: unknown): number {
  let n = 0;
  const stack: unknown[] = [v];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const x = stack.pop();
    if (typeof x === "string") {
      n += x.length + 16;
      continue;
    }
    if (x === null || typeof x !== "object") {
      n += 8;
      continue;
    }
    if (seen.has(x)) continue;
    seen.add(x);
    n += 32;
    if (ArrayBuffer.isView(x)) n += x.byteLength;
    else if (Array.isArray(x)) { for (const y of x) stack.push(y); }
    else if (x instanceof Map) { for (const [k, y] of x) stack.push(k, y); }
    else if (x instanceof Set) { for (const y of x) stack.push(y); }
    else {
      for (const k of Object.keys(x)) {
        n += k.length;
        stack.push((x as Record<string, unknown>)[k]);
      }
    }
  }
  return n;
}

const rows = (count: number, name: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => ({
    id: i,
    name: name(i),
    done: i % 2 === 0,
  }));

/** Deterministic PRNG — a failing bound must reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const within = (est: number, ref: number, tol: number) =>
  Math.abs(est - ref) <= ref * tol;

Deno.test("retained bytes: a small container is walked exactly", () => {
  for (
    const v of [
      rows(2 * RETAINED_SAMPLE, (i) => `row ${i}`),
      { a: [1, 2, "x"], b: new Map([["k", { z: "y" }]]), c: new Set([1, 2]) },
      Object.fromEntries(rows(300, (i) => `r${i}`).map((r) => [r.id, r])),
    ]
  ) {
    assertEquals(approxRetainedBytes(v), exact(v));
  }
});

Deno.test("retained bytes: rows of one shape are estimated within 2%", () => {
  for (const count of [513, 5_000, 200_000]) {
    const v = rows(count, (i) => `row ${i}`);
    const ref = exact(v);
    const est = approxRetainedBytes(v);
    assert(within(est, ref, 0.02), `${count} rows: ${est} vs ${ref}`);
  }
  // A dictionary keyed by id is the same data in another shape.
  const dict = Object.fromEntries(
    rows(50_000, (i) => `row ${i}`).map((r) => [`id-${r.id}`, r]),
  );
  const ref = exact(dict);
  const est = approxRetainedBytes(dict);
  assert(within(est, ref, 0.02), `dict: ${est} vs ${ref}`);
  const map = new Map(rows(20_000, (i) => `row ${i}`).map((r) => [r.id, r]));
  assert(within(approxRetainedBytes(map), exact(map), 0.02), "map");
});

Deno.test("retained bytes: members of varied size stay inside the stated [len×lo, len×hi] bound", () => {
  const rand = rng(42);
  for (let trial = 0; trial < 20; trial++) {
    const count = 1_000 + Math.floor(rand() * 50_000);
    const lens = Array.from({ length: count }, () => Math.floor(rand() * 400));
    const v = lens.map((l) => "x".repeat(l));
    const lo = Math.min(...lens) + 16;
    const hi = Math.max(...lens) + 16;
    const est = approxRetainedBytes(v) - 32; // minus the array's own cost
    assert(
      est >= count * lo && est <= count * hi,
      `trial ${trial}: ${est} outside [${count * lo}, ${count * hi}]`,
    );
    // …and, for sizes spread uniformly, close to the model in practice.
    assert(within(est + 32, exact(v), 0.15), `trial ${trial}: ${est}`);
  }
});

Deno.test("retained bytes: a 200k-row array costs far less than serializing it", () => {
  const v = rows(200_000, (i) => `row ${i}`);
  const time = (f: () => unknown) => {
    for (let i = 0; i < 3; i++) f();
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) f();
    return (performance.now() - t0) / 5;
  };
  const est = time(() => approxRetainedBytes(v));
  const ser = time(() => JSON.stringify(v));
  assert(
    est * 20 < ser,
    `estimate ${est.toFixed(2)} ms vs JSON.stringify ${ser.toFixed(2)} ms — ` +
      `the estimate runs on the dispatch path and must be cheap`,
  );
});

Deno.test("retained bytes: the budget still stops the walk, and unreadable nodes never throw", () => {
  const v = rows(200_000, (i) => `row ${i}`);
  assert(approxRetainedBytes(v, 1000) > 1000);
  const hostile = {
    get boom() {
      throw new Error("getter");
    },
  };
  Object.defineProperty(hostile, "boom", { enumerable: true });
  assert(approxRetainedBytes([hostile, "ok"]) > 0);
});

// ── the DELTA model: what one more history entry costs ────────────────────

Deno.test("retained delta: a subtree the two states share costs nothing", () => {
  const shared = { rows: rows(5_000, (i) => `row ${i}`) };
  const prev = { a: shared, n: 1 };
  const next = { a: shared, n: 2 }; // Immer: the untouched cell is the SAME ref
  assertEquals(approxDeltaBytes(prev, prev), 0);
  const d = approxDeltaBytes(prev, next);
  assert(d < 1_000, `an untouched 5k-row cell must be free: ${d}`);
});

Deno.test("retained delta: a replaced value costs its whole size", () => {
  const prev = { big: { blob: "a".repeat(200_000) } };
  const next = { big: { blob: "b".repeat(200_000) } };
  const d = approxDeltaBytes(prev, next);
  assert(d > 200_000 && d < 260_000, `a replaced 200 KB value: ${d}`);
});

Deno.test("retained delta: a copied array pays for its slots, not its rows", () => {
  const before = rows(50_000, (i) => `row ${i}`);
  const after = [...before, { id: -1, name: "new", done: false }];
  const d = approxDeltaBytes({ list: before }, { list: after });
  const slots = SLOT_BYTES * after.length;
  assert(
    d > slots * 0.9 && d < slots * 1.6,
    `an append copies the backing store (${slots} B of slots) and one row, ` +
      `not 50 000 rows: ${d}`,
  );
  // …and that is far less than holding the whole array again.
  assert(d < approxRetainedBytes(after) / 3, `${d}`);
});

Deno.test("retained delta: new Map and Set members are counted, shared ones are not", () => {
  const key = "k".repeat(2_000);
  const val = "v".repeat(5_000);
  const prevMap = new Map<string, string>([["old", "x"]]);
  const nextMap = new Map(prevMap).set(key, val);
  const dm = approxDeltaBytes({ m: prevMap }, { m: nextMap });
  assert(
    dm > key.length + val.length,
    `a new key AND its value are new memory: ${dm}`,
  );
  const prevSet = new Set([val]);
  const nextSet = new Set(prevSet);
  const ds = approxDeltaBytes({ s: prevSet }, { s: nextSet });
  assert(ds < 1_000, `a copied Set of shared members is nearly free: ${ds}`);
});

Deno.test("retained delta: the budget stops the walk on a huge replacement", () => {
  const prev = { rows: [] as unknown[] };
  const next = { rows: rows(200_000, (i) => `row ${i}`) };
  const t0 = performance.now();
  const d = approxDeltaBytes(prev, next, 1_000);
  const ms = performance.now() - t0;
  assert(d > 1_000, `${d}`);
  assert(ms < 50, `the budget must cut the walk short: ${ms.toFixed(1)}ms`);
});

Deno.test("retained delta: a row REPLACED inside a big shared array is priced, not sampled past", () => {
  // The ONLY shape this function is ever asked about: Immer rewrote one row,
  // so the backing store is fresh and every other row is shared by reference.
  // A uniform stride finds the row that changed 256 times in 100 000 — so a
  // 4 MB row read as ~0, and time travel's byte budget never evicted anything
  // (measured before this: 40 actions each really retaining 16 MB read as
  // 38.7 MB against a 128 MB budget, `droppedForBytes` 0 — a 16× miss).
  //
  // Membership is a REFERENCE compare, ~50× cheaper than the walk it guards
  // (pinned below), so scanning every member and walking only what is NEW is
  // both exact and cheaper than the deep walk sampling exists to avoid.
  const BLOB = 4 * 1024 * 1024;
  const before = rows(100_000, (i) => `row ${i}`);
  const after = before.slice();
  after[50_001] = { id: -1, name: "z".repeat(BLOB), done: false };
  const d = approxDeltaBytes({ list: before }, { list: after });
  assert(d > BLOB, `the replaced row is ${BLOB} B of new memory, read as ${d}`);
  // …and the same for a dictionary keyed by id — the other shape rows take.
  const dictBefore = Object.fromEntries(before.map((r) => [`id-${r.id}`, r]));
  const dictAfter = { ...dictBefore, "id-50001": after[50_001]! };
  const dd = approxDeltaBytes({ m: dictBefore }, { m: dictAfter });
  assert(dd > BLOB, `the replaced entry is ${BLOB} B of new memory: ${dd}`);
});

Deno.test("retained delta: pricing a mostly-shared array stays far cheaper than walking it", () => {
  // The bound that keeps the exactness above affordable: what it adds per
  // member is one reference compare, never a walk.
  const before = rows(200_000, (i) => `row ${i}`);
  const after = before.slice();
  after[123_456] = { id: -1, name: "changed", done: true };
  const time = (f: () => unknown) => {
    for (let i = 0; i < 3; i++) f();
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) f();
    return (performance.now() - t0) / 5;
  };
  const est = time(() => approxDeltaBytes({ l: before }, { l: after }));
  const walk = time(() => exact(after));
  assert(
    est * 5 < walk,
    `delta ${est.toFixed(2)} ms vs a full walk ${walk.toFixed(2)} ms`,
  );
});
