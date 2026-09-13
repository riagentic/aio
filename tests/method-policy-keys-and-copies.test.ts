// `ttl` and `concurrency: "first"` answer a call with ANOTHER call's result
// only when the two calls are provably the same — and every caller owns the
// value its `await` returned.
//
// `argsKey` was `JSON.stringify`, and the domain JSON is faithful on is much
// smaller than the domain of arguments. Measured before the fix:
//
//   ttl    lookup(new Set([1,2])) · lookup(new Set([3])) · lookup(new Map())
//          → all three answered "size=2:1,2"
//   ttl    lookup(NaN) · lookup(null) → one answer
//   first  scan(new Set(["/a"])) | scan(new Set(["/b"])) → "scan:/a" twice
//
// The last one needed a second bug: a call with NO key fell back to the method
// name for its in-flight entry, so every keyless call adopted whichever call of
// that method was running. And both policies handed every caller the SAME
// object: the first caller's `u.roles.push("admin")` was what every later ttl
// hit was told the method returned.
import { assert, assertEquals, assertNotStrictEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";
import {
  argsKey,
  beginPolicyCall,
  resetMethodPolicy,
} from "../src/state/method-policy.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

// ── the property: equal keys ⇒ indistinguishable arguments ────────────────
//
// A generator over the argument shapes that went wrong (collections, class
// instances, non-finite numbers, -0, holes, functions, undefined in every
// position) plus the plain ones that must keep caching. For every pair whose
// keys are EQUAL, the arguments must be identical by a comparison that sees
// everything JSON erases.
class Point {
  constructor(public x: number) {}
}
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Map || a instanceof Set) return false; // never keyable
  const ka = Reflect.ownKeys(a as object);
  const kb = Reflect.ownKeys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) =>
    k === kb[i] &&
    same(
      (a as Record<PropertyKey, unknown>)[k],
      (b as Record<PropertyKey, unknown>)[k],
    )
  );
}

Deno.test("argsKey property: two argument lists with one key are the same call", () => {
  const SEED = fuzzEnvInt("FUZZ_SEED", 0x5eed4a11) & 0x7fffffff;
  let seed = SEED;
  const rounds = fuzzEnvInt("FUZZ_ROUNDS", 3000, 1);
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const leaf = (): unknown =>
    pick<() => unknown>([
      () => 0,
      () => -0,
      () => 1,
      () => NaN,
      () => Infinity,
      () => null,
      () => undefined,
      () => "a",
      () => "",
      () => true,
      () => () => 1,
      () => new Set([pick([1, 2])]),
      () => new Map([["k", pick([1, 2])]]),
      () => new Date(pick([0, 1])),
      () => new Point(pick([1, 2])),
    ])();
  const value = (depth: number): unknown => {
    if (depth <= 0 || rnd() < 0.5) return leaf();
    if (rnd() < 0.5) {
      const arr: unknown[] = [];
      const n = Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) arr.push(value(depth - 1));
      if (rnd() < 0.1) arr.length += 1; // a hole
      return arr;
    }
    const o: Record<string, unknown> = {};
    for (const k of ["a", "b"].slice(0, Math.floor(rnd() * 3))) {
      o[k] = value(depth - 1);
    }
    return o;
  };
  const byKey = new Map<string, unknown[]>();
  let keyed = 0;
  for (let r = 0; r < rounds; r++) {
    const args = Array.from({ length: Math.floor(rnd() * 3) }, () => value(2));
    const k = argsKey(args);
    if (k === null) continue;
    keyed++;
    const prev = byKey.get(k);
    if (prev === undefined) byKey.set(k, args);
    else {
      assert(
        same(prev, args),
        `FUZZ_SEED=${SEED} round ${r}: one key for two different calls — ${k}`,
      );
    }
  }
  assert(
    keyed > rounds / 10,
    `the generator must produce keyable calls too (${keyed})`,
  );
});

Deno.test("argsKey: the collisions JSON.stringify had are no key at all", () => {
  const marker = String.fromCharCode(0) + "aio:undefined";
  for (
    const v of [
      new Set([1]),
      new Map(),
      new Date(0),
      new Point(1),
      NaN,
      Infinity,
      -0,
      { pick: () => "alice" },
      // deno-lint-ignore no-sparse-arrays
      [1, , 2],
      Object.assign([1], { extra: 1 }),
      { [Symbol("s")]: 1 },
      marker, // an argument that spells the undefined-marker
    ]
  ) {
    assertEquals(argsKey([v]), null, `no key for ${String(v)}`);
  }
  // …and the plain domain still keys exactly as before (a changed key would
  // invalidate every entry a running app holds — and prove nothing).
  assertEquals(
    argsKey([1, "x", null, true, { a: [1, 2] }]),
    '[1,"x",null,true,{"a":[1,2]}]',
  );
  const shared = { a: 1 };
  assert(
    argsKey([shared, shared]) !== null,
    "a shared (non-cyclic) value keys",
  );
});

// ── end to end ─────────────────────────────────────────────────────────────

let runs = 0;
const users = cell("policykeys", {
  state: { n: 0 },
  ttl: { lookup: 60_000, profile: 60_000 },
  concurrency: { scan: "first", load: "first" },
  methods: {
    async lookup(_s: Any, ids: Any) {
      runs++;
      await tick();
      return ids instanceof Set || ids instanceof Map
        ? `size=${ids.size}`
        : `v=${String(ids)}`;
    },
    async scan(_s: Any, arg: Any) {
      runs++;
      await tick(15);
      return `scan:${[...arg].join(",")}`;
    },
    async profile(_s: Any, _id: string) {
      await tick();
      return { name: "alice", roles: ["user"] };
    },
    async load(_s: Any) {
      await tick(10);
      return { list: [1, 2] };
    },
  },
} as Any) as Any;

Deno.test("ttl: different collections are different calls", async () => {
  const h = await bootCells([users]);
  try {
    runs = 0;
    const got = [
      await users.lookup(new Set([1, 2])),
      await users.lookup(new Set([3])),
      await users.lookup(new Map()),
      await users.lookup(NaN),
      await users.lookup(null),
    ];
    assertEquals(got, ["size=2", "size=1", "size=0", "v=NaN", "v=null"]);
    assertEquals(runs, 5);
    // A plain argument still caches.
    await users.lookup("u1");
    await users.lookup("u1");
    assertEquals(runs, 6, "an identical plain call is answered from the cache");
  } finally {
    h.dispose();
    resetMethodPolicy();
  }
});

Deno.test('"first": a keyless call is not answered by a running call with other arguments', async () => {
  const h = await bootCells([users]);
  try {
    runs = 0;
    const a = users.scan(new Set(["/a"]));
    const b = users.scan(new Set(["/b"]));
    assertEquals([await a, await b], ["scan:/a", "scan:/b"]);
    assertEquals(runs, 2);
  } finally {
    h.dispose();
    resetMethodPolicy();
  }
});

Deno.test("ttl and first: every caller gets its own copy of the shared result", async () => {
  const h = await bootCells([users]);
  try {
    const u1 = await users.profile("1");
    u1.roles.push("admin");
    u1.name = "mallory";
    const u2 = await users.profile("1");
    assertEquals(u2, { name: "alice", roles: ["user"] }, "a ttl hit");
    const u3 = await users.profile("1");
    assertNotStrictEquals(u3, u2, "two hits are two copies");

    const [x, y] = await Promise.all([users.load(), users.load()]);
    assertNotStrictEquals(x, y);
    x.list.push(3);
    assertEquals(y, { list: [1, 2] }, "the adopter's value is its own");
  } finally {
    h.dispose();
    resetMethodPolicy();
  }
});

Deno.test("a result structuredClone would change is still shared by reference", async () => {
  resetMethodPolicy();
  try {
    const handle = new Point(1);
    const a = beginPolicyCall("pk", "client", [], undefined, 60_000);
    if (a.kind === "run") a.settle({ value: handle });
    const b = beginPolicyCall("pk", "client", [], undefined, 60_000);
    assert(b.kind === "adopt");
    const o = await b.outcome;
    assert(
      o.value === handle,
      "a class instance is not flattened into a lookalike",
    );
  } finally {
    resetMethodPolicy();
  }
});
