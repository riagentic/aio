// `diffState` (src/server/timeline.ts) runs on EVERY committed dispatch, prod
// included. Its array branch used to build a key union — a string per index, a
// Set over them, a path string per index — before checking identity, so a
// one-row edit in a 131k-row array cost ≈30 ms per commit. It is now an index
// loop that checks identity first.
//
// A rewrite of a diff is exactly the change hand-reasoning gets wrong, so the
// old walker is kept HERE, verbatim, as the oracle, and random immer-produced
// states (the real input: structural sharing) are diffed by both. One
// deliberate difference, pinned on its own below: the old walker set the
// "truncated" marker when the 200-change cap was reached and merely MORE
// IDENTICAL keys followed; now the marker means a real change was dropped.
//
// Replay a failure: TIMELINE_DIFF_SEED=<seed> TIMELINE_DIFF_ROUNDS=<n>.
import { assert, assertEquals } from "@std/assert";
import { produce } from "immer";
import { type DiffEntry, diffState } from "../src/server/timeline.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

// ── the oracle: the pre-change walker, verbatim ──────────────────────────
const MAX_DIFF_ENTRIES = 200;
const MAX_DEPTH = 12;
const isPlainObj = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};
function oracleDiff(prev: unknown, next: unknown): DiffEntry[] {
  const out: DiffEntry[] = [];
  let truncated = false;
  const segs: string[] = [];
  const walk = (
    a: unknown,
    b: unknown,
    path: string,
    dotted: boolean,
    depth: number,
  ): void => {
    if (a === b) return;
    if (out.length >= MAX_DIFF_ENTRIES) {
      truncated = true;
      return;
    }
    const bothArr = Array.isArray(a) && Array.isArray(b);
    const bothObj = !bothArr && isPlainObj(a) && isPlainObj(b);
    if (depth < MAX_DEPTH && (bothArr || bothObj)) {
      const keys = new Set<string>([
        ...Object.keys(a as object),
        ...Object.keys(b as object),
      ]);
      for (const k of keys) {
        if (out.length >= MAX_DIFF_ENTRIES) {
          truncated = true;
          break;
        }
        segs.push(k);
        walk(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
          path ? `${path}.${k}` : k,
          dotted || k.includes("."),
          depth + 1,
        );
        segs.pop();
      }
      return;
    }
    out.push(
      dotted
        ? { path, before: a, after: b, segments: [...segs] }
        : { path, before: a, after: b },
    );
  };
  walk(prev, next, "", false, 0);
  if (truncated) {
    out.push({
      path: "…",
      before: `(diff truncated at ${MAX_DIFF_ENTRIES} changes)`,
      after: undefined,
    });
  }
  return out;
}

// ── random states and random immer edits ─────────────────────────────────
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type R = () => number;
const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const KEYS = ["a", "b", "c", "x.y", "0", "id", "rows", "n"] as const;

function leaf(r: R): unknown {
  return pick(r, [
    () => Math.floor(r() * 5),
    () => pick(r, ["s", "t", ""]),
    () => null,
    () => r() < 0.5,
    () => undefined,
    () => new Date(Math.floor(r() * 3) * 1000),
  ])();
}
function value(r: R, depth: number): unknown {
  const k = r();
  if (depth > 3 || k < 0.4) return leaf(r);
  if (k < 0.7) {
    const n = Math.floor(r() * 6);
    return Array.from({ length: n }, () => value(r, depth + 1));
  }
  const o: Record<string, unknown> = {};
  const n = Math.floor(r() * 4);
  for (let i = 0; i < n; i++) o[pick(r, KEYS)] = value(r, depth + 1);
  return o;
}

/** One random edit somewhere in a draft: set, push, pop, splice, delete, or a
 *  kind change (array↔object↔leaf). */
function edit(r: R, d: unknown, depth = 0): void {
  if (typeof d !== "object" || d === null || d instanceof Date) return;
  const isArr = Array.isArray(d);
  const keys = Object.keys(d);
  // Descend sometimes, so edits land deep as well as shallow.
  if (keys.length > 0 && r() < 0.5 && depth < 5) {
    const k = pick(r, keys);
    const child = (d as Record<string, unknown>)[k];
    if (
      typeof child === "object" && child !== null && !(child instanceof Date)
    ) {
      return edit(r, child, depth + 1);
    }
  }
  if (isArr) {
    const a = d as unknown[];
    const op = r();
    if (op < 0.35 && a.length) a[Math.floor(r() * a.length)] = value(r, depth);
    else if (op < 0.55) a.push(value(r, depth));
    else if (op < 0.7) a.pop();
    else if (op < 0.85 && a.length) a.splice(Math.floor(r() * a.length), 1);
    else a.unshift(value(r, depth));
  } else {
    const o = d as Record<string, unknown>;
    const op = r();
    if (op < 0.6) o[pick(r, KEYS)] = value(r, depth);
    else if (keys.length) delete o[pick(r, keys)];
  }
}

Deno.test("timeline diff: the index-loop walker matches the key-union walker on random immer states", () => {
  const seed = fuzzEnvInt(
    "TIMELINE_DIFF_SEED",
    Math.floor(Math.random() * 2 ** 31),
  );
  const rounds = fuzzEnvInt("TIMELINE_DIFF_ROUNDS", 3000, 1);
  const r = rng(seed);
  let compared = 0, arrays = 0;
  for (let round = 0; round < rounds; round++) {
    const root: Record<string, unknown> = {
      rows: Array.from(
        { length: Math.floor(r() * 12) },
        () => value(r, 1),
      ),
      meta: value(r, 1),
    };
    const next = produce(root, (d) => {
      const edits = 1 + Math.floor(r() * 4);
      for (let i = 0; i < edits; i++) edit(r, d);
    });
    const want = oracleDiff(root, next);
    const got = diffState(root, next);
    assertEquals(
      got,
      want,
      `seed ${seed} round ${round} — replay with TIMELINE_DIFF_SEED=${seed} ` +
        `TIMELINE_DIFF_ROUNDS=${round + 1}`,
    );
    compared++;
    if (got.some((e) => /(^|\.)\d+(\.|$)/.test(e.path))) arrays++;
  }
  // Not vacuous: the corpus really exercised array indices.
  assert(compared === rounds && arrays > rounds / 10, `arrays=${arrays}`);
});

Deno.test("timeline diff: shape changes, Dates, dotted keys and array length changes match the oracle", () => {
  const cases: [unknown, unknown][] = [
    [{ a: [1, 2, 3] }, { a: [1, 2] }],
    [{ a: [1, 2] }, { a: [1, 2, 3, 4] }],
    [{ a: [1, 2] }, { a: { 0: 1, 1: 2 } }],
    [{ a: [1] }, { a: null }],
    [{ a: [new Date(0)] }, { a: [new Date(1)] }],
    [{ "x.y": [{ "p.q": 1 }] }, { "x.y": [{ "p.q": 2 }] }],
    [[1, [2, [3]]], [1, [2, [4]]]],
    [{ a: [undefined] }, { a: [] }],
    [{ a: [] }, { a: [undefined] }],
  ];
  for (const [a, b] of cases) {
    assertEquals(diffState(a, b), oracleDiff(a, b), JSON.stringify([a, b]));
  }
});

Deno.test("timeline diff: sparse arrays report the same entries (ascending, not a-then-b order)", () => {
  // The only ordering difference: the key union listed `a`'s own indices, then
  // `b`'s; the index loop walks ascending. Same entries.
  const a: unknown[] = [1];
  a[3] = 4;
  const b = [1, 2, 3, 5];
  const byPath = (xs: DiffEntry[]) =>
    [...xs].sort((x, y) => x.path.localeCompare(y.path));
  assertEquals(byPath(diffState(a, b)), byPath(oracleDiff(a, b)));
});

Deno.test("timeline diff: the truncation marker means a REAL change was dropped", () => {
  const base = Array.from({ length: 400 }, (_, i) => i);
  // Exactly the cap in changes, then only identical rows: complete, no marker
  // (the key-union walker claimed a truncation here).
  const exact = base.map((v, i) => (i < MAX_DIFF_ENTRIES ? -v - 1 : v));
  const d1 = diffState(base, exact);
  assertEquals(d1.length, MAX_DIFF_ENTRIES);
  assert(
    d1.every((e) => e.path !== "…"),
    "a complete diff was marked truncated",
  );
  // One real change past the cap: marked, and the first 200 are the oracle's.
  const over = exact.map((v, i) => (i === 399 ? -1000 : v));
  const d2 = diffState(base, over);
  assertEquals(d2.length, MAX_DIFF_ENTRIES + 1);
  assertEquals(d2[MAX_DIFF_ENTRIES]?.path, "…");
  assertEquals(d2.slice(0, -1), oracleDiff(base, over).slice(0, -1));
  // Objects follow the same rule.
  const oa = Object.fromEntries(base.map((v) => [`k${v}`, v]));
  const ob = Object.fromEntries(
    base.map((v) => [`k${v}`, v < MAX_DIFF_ENTRIES ? -v - 1 : v]),
  );
  assert(diffState(oa, ob).every((e) => e.path !== "…"));
});

Deno.test("timeline diff: a one-row edit in a 131k-row array does not walk every row", () => {
  // Coarse and relative, so a loaded CI box cannot flip it: the key-union
  // walker's cost on this input is dominated by 131k key strings + a Set.
  const rows = Array.from({ length: 131_072 }, (_, i) => ({ id: i, v: "x" }));
  const state = { rows };
  const next = produce(state, (d) => {
    d.rows[65_000]!.v = "y";
  });
  const time = (f: () => unknown, n: number) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) f();
    return (performance.now() - t0) / n;
  };
  time(() => diffState(state, next), 3); // warm
  time(() => oracleDiff(state, next), 3);
  const fast = time(() => diffState(state, next), 10);
  const slow = time(() => oracleDiff(state, next), 10);
  assertEquals(diffState(state, next), [
    { path: "rows.65000.v", before: "x", after: "y" },
  ]);
  assert(
    fast * 4 < slow,
    `index loop ${fast.toFixed(2)} ms vs key union ${slow.toFixed(2)} ms — ` +
      `expected ≥4× faster`,
  );
});
