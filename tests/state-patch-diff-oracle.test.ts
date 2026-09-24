// `diffState` (src/sync/state-patch.ts) runs per commit when the journal is on
// (aio.ts reaction deltas) and per server push to sync clients. Its walker
// built `[...path, i]` for every array index — and `[...path, k]` for every
// object key — BEFORE checking identity, so a one-row edit in a 131k-row
// array allocated 131k path arrays to find the one row that moved. It now
// checks identity first (as src/server/timeline.ts's walker does).
//
// A rewrite of a diff is exactly the change hand-reasoning gets wrong, so the
// old walker is kept HERE, verbatim, as the oracle, and random immer-produced
// states (the real input: structural sharing) are diffed by both. The output
// must be IDENTICAL, order included — the ops are applied in order, and the
// journal stores them.
//
// Replay a failure: STATE_PATCH_DIFF_SEED=<seed> STATE_PATCH_DIFF_ROUNDS=<n>.
import { assert, assertEquals } from "@std/assert";
import { produce } from "immer";
import {
  applyStatePatch,
  diffState,
  type StatePatchOp,
  type StatePath,
} from "../src/sync/state-patch.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

// ── the oracle: the pre-change walker, verbatim ──────────────────────────
const isPlainObject = (x: unknown): x is Record<string, unknown> => {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};
const absent = (v: unknown): boolean =>
  v === undefined || typeof v === "function" || typeof v === "symbol";
const inArray = (v: unknown): unknown => absent(v) ? null : v;
function oracleDiff(base: unknown, next: unknown): StatePatchOp[] {
  const out: StatePatchOp[] = [];
  walk(base, next, [], out);
  return out;
}
function walk(
  a: unknown,
  b: unknown,
  path: StatePath,
  out: StatePatchOp[],
): void {
  if (a === b) return;
  // Both `null` in an array's JSON (an object never walks into one).
  if (absent(a) && absent(b)) return;
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const k of Object.keys(b)) {
      const bv = b[k];
      if (absent(bv)) continue;
      const av = Object.hasOwn(a, k) ? a[k] : undefined;
      if (absent(av)) out.push({ p: [...path, k], v: bv });
      else walk(av, bv, [...path, k], out);
    }
    for (const k of Object.keys(a)) {
      if (absent(a[k])) continue;
      if (!Object.hasOwn(b, k) || absent(b[k])) {
        out.push({ p: [...path, k], d: 1 });
      }
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push({ p: path, n: b.length });
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i++) walk(a[i], b[i], [...path, i], out);
    for (let i = a.length; i < b.length; i++) {
      out.push({ p: [...path, i], v: inArray(b[i]) });
    }
    return;
  }
  // NaN is the one value unequal to itself — not a change.
  if (Number.isNaN(a) && Number.isNaN(b)) return;
  if (path.length === 0) {
    // The root is always an object on both sides; a root that is not is not
    // patchable, and the caller falls back to the whole state.
    throw new TypeError(
      "diffState: the root of a cell state must be a plain object",
    );
  }
  // Inside an object both sides are defined (see above); inside an array an
  // `undefined` element is JSON's `null`.
  out.push({ p: path, v: typeof path.at(-1) === "number" ? inArray(b) : b });
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
const FN = () => 0;

function leaf(r: R): unknown {
  return pick(r, [
    () => Math.floor(r() * 5),
    () => pick(r, ["s", "t", ""]),
    () => null,
    () => r() < 0.5,
    () => undefined,
    () => NaN,
    () => FN,
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

/** One random edit somewhere in a draft: set, push, pop, splice, unshift,
 *  delete, or a kind change (array↔object↔leaf). */
function edit(r: R, d: unknown, depth = 0): void {
  if (typeof d !== "object" || d === null || d instanceof Date) return;
  const isArr = Array.isArray(d);
  const keys = Object.keys(d);
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

Deno.test("state-patch diff: the identity-first walker matches the old walker on random immer states, order included", () => {
  const seed = fuzzEnvInt(
    "STATE_PATCH_DIFF_SEED",
    Math.floor(Math.random() * 2 ** 31),
  );
  const rounds = fuzzEnvInt("STATE_PATCH_DIFF_ROUNDS", 3000, 1);
  const r = rng(seed);
  let arrays = 0, applied = 0;
  for (let round = 0; round < rounds; round++) {
    const root: Record<string, unknown> = {
      rows: Array.from({ length: Math.floor(r() * 12) }, () => value(r, 1)),
      meta: value(r, 1),
    };
    const next = produce(root, (d) => {
      const edits = 1 + Math.floor(r() * 4);
      for (let i = 0; i < edits; i++) edit(r, d);
    });
    const want = oracleDiff(root, next);
    const got = diffState(root, next);
    const at = `seed ${seed} round ${round} — replay with ` +
      `STATE_PATCH_DIFF_SEED=${seed} STATE_PATCH_DIFF_ROUNDS=${round + 1}`;
    assertEquals(got, want, at);
    if (got.some((o) => o.p.some((s) => typeof s === "number"))) arrays++;
    // The ops still do their job: base + ops = next, as JSON.
    const patched = applyStatePatch(root, got);
    if (patched) {
      // As JSON values (key order is not part of a state's value).
      const json = (x: unknown) => JSON.parse(JSON.stringify(x));
      assertEquals(json(patched), json(next), at);
      applied++;
    }
  }
  // Not vacuous: the corpus really exercised array indices, and applied.
  assert(arrays > rounds / 10, `arrays=${arrays}`);
  assert(applied > rounds / 2, `applied=${applied}`);
});

Deno.test("state-patch diff: holes, absent values, NaN, shape and length changes match the oracle", () => {
  const holey: unknown[] = [1];
  holey[3] = 4;
  const cases: [unknown, unknown][] = [
    [{ a: [1, 2, 3] }, { a: [1, 2] }],
    [{ a: [1, 2] }, { a: [1, 2, 3, 4] }],
    [{ a: [1, 2] }, { a: { 0: 1, 1: 2 } }],
    [{ a: [1] }, { a: null }],
    [{ a: [new Date(0)] }, { a: [new Date(1)] }],
    [{ a: [undefined, FN, NaN] }, { a: [null, undefined, NaN] }],
    [{ a: [undefined] }, { a: [] }],
    [{ a: [] }, { a: [undefined, FN] }],
    [{ a: holey }, { a: [1, 2, 3, 5] }],
    [{ a: [1, 2, 3, 5] }, { a: holey }],
    [{ a: undefined, b: FN, c: 1 }, { a: 1, b: undefined, d: FN }],
    [{ x: { y: [[1, [2]]] } }, { x: { y: [[1, [3]]] } }],
  ];
  for (const [a, b] of cases) {
    assertEquals(diffState(a, b), oracleDiff(a, b), String([a, b]));
  }
});

Deno.test("state-patch diff: a one-row edit in a 131k-row array does not walk every row", () => {
  // Counted, not timed: every path the walker builds is an array SPREAD
  // (`[...path, i]`), and a spread of an array calls its iterator. Counting
  // iterator calls while ONE diff runs counts the paths it allocated (plus a
  // handful of `for…of` over object keys) — deterministic on any box. The old
  // walker spreads once per ROW; the fixed one once per CHANGED node.
  const rows = Array.from({ length: 131_072 }, (_, i) => ({ id: i, v: "x" }));
  const state = { rows };
  const next = produce(state, (d) => {
    d.rows[65_000]!.v = "y";
  });
  const counted = (f: () => StatePatchOp[]) => {
    const proto = Array.prototype as unknown as Record<symbol, unknown>;
    const orig = proto[Symbol.iterator] as () => Iterator<unknown>;
    let n = 0;
    proto[Symbol.iterator] = function (this: unknown[]) {
      n++;
      return orig.call(this);
    };
    try {
      return { ops: f(), n };
    } finally {
      proto[Symbol.iterator] = orig;
    }
  };
  const want: StatePatchOp[] = [{
    p: ["rows", 65_000, "v"] as StatePath,
    v: "y",
  }];
  const old = counted(() => oracleDiff(state, next));
  const now = counted(() => diffState(state, next));
  assertEquals(old.ops, want);
  assertEquals(now.ops, want);
  // The instrument works: it sees the old walker's per-row paths…
  assert(old.n > 131_000, `instrument blind: old walker counted ${old.n}`);
  // …and the fixed walker builds a path per CHANGED node only.
  assert(now.n < 50, `diffState built ${now.n} paths for a one-row edit`);
});
