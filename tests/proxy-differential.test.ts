// Differential fuzzer: the live async-method proxy vs the Immer sync draft.
//
// The two are the SAME `s` to an app author — the docs promise that a method
// body behaves identically whether it is sync (Immer draft in the reducer) or
// async (the hand-built live proxy in cell-impl.ts). That proxy re-implements
// JavaScript object semantics by hand — array method interception, overlay
// read-your-writes, nested proxy caching — which is an unbounded surface for
// silent divergence, and the class of bug that has shipped repeatedly
// (find-element writes, iterator support, preventExtensions rejections).
//
// This suite makes the CLASS unshippable instead of chasing instances: random
// programs over the supported state operations run once as a sync method and
// once as an async method, and the final state AND every intermediate read
// must agree exactly. A failure prints the seed + program, so any divergence
// is a one-line repro.
import { assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

type Data = {
  a: number;
  obj: Record<string, unknown>;
  nums: number[];
  items: { id: number; q: number }[];
};
const initData = (): Data => ({
  a: 0,
  obj: { x: 1 },
  nums: [1, 2, 3],
  items: [{ id: 1, q: 10 }, { id: 2, q: 20 }],
});

type Op = { kind: string; i: number; v: number };

/** One program step, interpreted identically for both backends. Reads append
 *  PRIMITIVES to `log` (object reads would compare proxy vs draft identity,
 *  which is not the contract — values are). */
function applyOp(s: { data: Data }, op: Op, log: unknown[]): void {
  const d = s.data;
  switch (op.kind) {
    case "set_scalar":
      d.a = op.v;
      break;
    case "rmw_scalar": {
      const cur = d.a;
      log.push(cur);
      d.a = cur + op.v;
      break;
    }
    case "set_nested":
      d.obj.x = op.v;
      break;
    case "set_new_key":
      d.obj[`k${op.i % 4}`] = op.v;
      break;
    case "del_nested":
      delete d.obj.x;
      break;
    case "read_keys":
      log.push(Object.keys(d.obj).sort().join(","));
      break;
    case "read_in":
      log.push("x" in d.obj);
      break;
    case "arr_push":
      d.nums.push(op.v);
      break;
    case "arr_pop":
      log.push(d.nums.pop());
      break;
    case "arr_unshift":
      d.nums.unshift(op.v);
      break;
    case "arr_shift":
      log.push(d.nums.shift());
      break;
    case "arr_splice":
      d.nums.splice(op.i % (d.nums.length + 1), op.i % 2, op.v);
      break;
    case "arr_set_idx":
      if (d.nums.length) d.nums[op.i % d.nums.length] = op.v;
      break;
    case "arr_reassign_filter":
      d.nums = d.nums.filter((n) => n % 2 === op.i % 2);
      break;
    case "arr_reassign_spread":
      d.nums = [...d.nums, op.v];
      break;
    case "read_join":
      log.push(d.nums.join(","));
      break;
    case "read_spread_len":
      log.push([...d.nums].length);
      break;
    case "read_length":
      log.push(d.nums.length);
      break;
    case "objarr_push":
      d.items.push({ id: op.i, q: op.v });
      break;
    case "objarr_write_idx": {
      const len = d.items.length;
      log.push(len);
      if (len) d.items[op.i % len]!.q = op.v;
      break;
    }
    case "objarr_find_write": {
      const it = d.items.find((x) => x.id === op.i % 5);
      log.push(it !== undefined);
      if (it) it.q = op.v;
      break;
    }
    case "read_map":
      log.push(d.items.map((x) => x.q).join("|"));
      break;
    case "read_leaf":
      log.push(d.items[0]?.q);
      break;
    // The historically-forbidden idiom: reassigning a value derived from the
    // proxy itself. Recorded values are cloned to plain data on install now,
    // so this must simply WORK, identically to the Immer draft.
    case "objarr_reassign_spread":
      d.items = [...d.items, { id: op.i, q: op.v }];
      break;
    case "objarr_reassign_filter":
      d.items = d.items.filter((x) => x.id !== op.i % 5);
      break;
    case "obj_reassign_spread":
      d.obj = { ...d.obj, [`y${op.i % 3}`]: op.v };
      break;
    case "obj_then_deep_write":
      d.obj = { nest: { v: op.v } };
      (d.obj as { nest: { v: number } }).nest.v = op.v + 1;
      break;
    case "arr_sort":
      d.nums.sort((a, b) => a - b);
      break;
    case "arr_reverse":
      d.nums.reverse();
      break;
    case "arr_fill":
      if (d.nums.length) d.nums.fill(op.v, 0, op.i % d.nums.length);
      break;
    case "read_includes":
      log.push(d.nums.includes(op.v));
      break;
    case "read_indexOf":
      log.push(d.nums.indexOf(op.v));
      break;
    case "read_slice":
      log.push(d.nums.slice(0, 2).join(","));
      break;
    case "read_some":
      log.push(d.nums.some((n) => n > op.v));
      break;
    case "read_reduce":
      log.push(d.nums.reduce((a, n) => a + n, 0));
      break;
    case "read_findIndex":
      log.push(d.items.findIndex((x) => x.id === op.i % 5));
      break;
    case "read_entries":
      log.push(Object.entries(d.obj).length);
      break;
    case "push_then_write_pushed": {
      d.items.push({ id: 90 + (op.i % 3), q: op.v });
      const idx = d.items.length - 1;
      d.items[idx]!.q = op.v + 1;
      break;
    }
  }
}

const KINDS = [
  "set_scalar",
  "rmw_scalar",
  "set_nested",
  "set_new_key",
  "del_nested",
  "read_keys",
  "read_in",
  "arr_push",
  "arr_pop",
  "arr_unshift",
  "arr_shift",
  "arr_splice",
  "arr_set_idx",
  "arr_reassign_filter",
  "arr_reassign_spread",
  "read_join",
  "read_spread_len",
  "read_length",
  "objarr_push",
  "objarr_write_idx",
  "objarr_find_write",
  "read_map",
  "read_leaf",
  "objarr_reassign_spread",
  "objarr_reassign_filter",
  "obj_reassign_spread",
  "obj_then_deep_write",
  "arr_sort",
  "arr_reverse",
  "arr_fill",
  "read_includes",
  "read_indexOf",
  "read_slice",
  "read_some",
  "read_reduce",
  "read_findIndex",
  "read_entries",
  "push_then_write_pushed",
];

// The seed is FIXED by default — CI must explore the same programs on every
// run, or a red build is not reproducible from its own commit. But a fuzzer
// pinned to one seed is really a regression test: it re-checks 120 known
// programs forever and can never find anything new. `FUZZ_SEED` (and
// `FUZZ_ROUNDS`) let a sweep explore beyond them without making the default
// run nondeterministic:
//
//     for s in 1 7 31 99 12345; do FUZZ_SEED=$s deno test -A \
//       tests/proxy-differential.test.ts; done
//
// A divergence prints the seed AND the program, so anything a sweep finds
// comes back as a one-line repro — and belongs here as a fixed case.
// A sweep flag we cannot read must THROW, never shrug: `FUZZ_ROUNDS=2k` is
// NaN, `round < NaN` is false, and the fuzzer would report a vacuous green
// over ZERO programs — the same silent-NaN class `parseNumArg` kills in `am`.
function fuzzEnvInt(name: string, def: number, min = 0): number {
  const raw = Deno.env.get(name);
  if (raw === undefined) return def;
  const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n < min) {
    throw new Error(`${name}="${raw}" must be an integer >= ${min}`);
  }
  return n;
}
const SEED = fuzzEnvInt("FUZZ_SEED", 0x6a11f00d) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 120, 1);

Deno.test("differential: a method body behaves identically sync and async", async () => {
  let seed = SEED;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (n: number) => Math.floor(rnd() * n);

  for (let round = 0; round < ROUNDS; round++) {
    const program: Op[] = Array.from(
      { length: 6 + pick(14) },
      () => ({ kind: KINDS[pick(KINDS.length)]!, i: pick(9), v: pick(100) }),
    );
    // The seed is part of the repro: without it a sweep failure names a round
    // number that means nothing on the default seed.
    const repro = `FUZZ_SEED=${SEED} round ${round}: ${
      JSON.stringify(program)
    }`;

    const syncLog: unknown[] = [];
    const asyncLog: unknown[] = [];
    const sc = cell(`fz_s_${round}`, {
      state: { data: initData() } as { data: Data },
      methods: {
        run(s: { data: Data }) {
          for (const op of program) applyOp(s, op, syncLog);
        },
      },
    });
    const ac = cell(`fz_a_${round}`, {
      state: { data: initData() } as { data: Data },
      methods: {
        // deno-lint-ignore require-await
        async run(s: { data: Data }) {
          for (const op of program) applyOp(s, op, asyncLog);
        },
      },
    });

    const h = await bootCells([sc, ac]);
    try {
      await (sc as Any).run();
      await (ac as Any).run();
      await h.settle();
      const syncState = JSON.parse(JSON.stringify((sc as Any).data));
      const asyncState = JSON.parse(JSON.stringify((ac as Any).data));
      assertEquals(asyncState, syncState, `state diverged — ${repro}`);
      assertEquals(asyncLog, syncLog, `reads diverged — ${repro}`);
    } finally {
      h.dispose();
    }
  }
});
