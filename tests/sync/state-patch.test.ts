// tests/sync/state-patch.test.ts — the patch a pushed server write travels as
// reproduces the server's state exactly, for any pair of JSON states.
//
// A randomized property over the three functions together, rather than a
// list of shapes: `applyStatePatch(a, diffState(a, b))` must digest to `b`,
// must not touch `a` (committed state is frozen), and two states holding the
// same data must digest the same whatever their key order.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  applyStatePatch,
  diffState,
  stateDigest,
} from "../../src/sync/state-patch.ts";

/** A small deterministic PRNG, so a failure names a seed that replays it. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ["a", "b", "c", "items", "text", "__proto__", "n"];

function value(r: () => number, depth: number): unknown {
  const k = r();
  if (depth <= 0 || k < 0.35) {
    const p = r();
    if (p < 0.2) return null;
    if (p < 0.4) return Math.floor(r() * 5);
    if (p < 0.55) return r() < 0.5;
    if (p < 0.6) return undefined;
    return ["", "x", "y", "hello"][Math.floor(r() * 4)];
  }
  if (k < 0.65) {
    return Array.from(
      { length: Math.floor(r() * 5) },
      () => value(r, depth - 1),
    );
  }
  const o: Record<string, unknown> = {};
  for (let i = Math.floor(r() * 4); i > 0; i--) {
    Object.defineProperty(o, KEYS[Math.floor(r() * KEYS.length)]!, {
      value: value(r, depth - 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return o;
}

/** `b` as an edit of `a`: mostly the same tree, some leaves and containers
 *  changed — the shape a real write has, and the one that exercises the
 *  walk rather than a root replacement. */
function edit(r: () => number, a: unknown, depth: number): unknown {
  if (r() < 0.15) return value(r, depth);
  if (Array.isArray(a)) {
    const out = a.map((x) => r() < 0.3 ? edit(r, x, depth - 1) : x);
    if (r() < 0.2) out.push(value(r, depth - 1));
    if (r() < 0.2) out.pop();
    return out;
  }
  if (a !== null && typeof a === "object") {
    const out: Record<string, unknown> = { ...a as Record<string, unknown> };
    for (const k of Object.keys(out)) {
      if (r() < 0.3) out[k] = edit(r, out[k], depth - 1);
      else if (r() < 0.1) delete out[k];
    }
    if (r() < 0.3) {
      out[KEYS[Math.floor(r() * KEYS.length)]!] = value(r, depth - 1);
    }
    return out;
  }
  return value(r, depth);
}

function deepFreeze<T>(x: T): T {
  if (x !== null && typeof x === "object") {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}

const root = (r: () => number, v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : { v, pad: value(r, 1) };

Deno.test("property: a patch applied to its base reproduces the target, and leaves the base alone", () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const r = rng(seed);
    const a = root(r, value(r, 4));
    const b = root(r, edit(r, a, 4));
    const before = JSON.stringify(a);
    deepFreeze(a);
    const ops = JSON.parse(JSON.stringify(diffState(a, b)));
    const got = applyStatePatch(a, ops);
    assert(got !== null, `seed ${seed}: the patch did not apply`);
    assertEquals(
      stateDigest(got)?.digest,
      stateDigest(b)?.digest,
      `seed ${seed}: ${before} → ${JSON.stringify(b)} patched to ${
        JSON.stringify(got)
      } via ${JSON.stringify(ops)}`,
    );
    assertEquals(
      JSON.stringify(a),
      before,
      `seed ${seed}: the base was touched`,
    );
  }
});

Deno.test("the digest is the JSON value's: key order and dropped undefineds do not change it, data does", () => {
  const d = (x: unknown) => stateDigest(x)?.digest;
  assertEquals(d({ a: 1, b: [1, undefined] }), d({ b: [1, null], a: 1 }));
  assertEquals(d({ a: 1, gone: undefined }), d({ a: 1 }));
  assertNotEquals(d({ a: 1 }), d({ a: 2 }));
  assertNotEquals(d({ a: "1" }), d({ a: 1 }));
  assertEquals(stateDigest({ a: 1n }), null, "a BigInt is not JSON");
});

Deno.test("a patch that does not fit the state is refused, not half-applied", () => {
  assertEquals(applyStatePatch({ a: 1 }, [{ p: ["a", "b"], v: 2 }]), null);
  assertEquals(applyStatePatch({ a: [1] }, [{ p: ["a", 5], v: 2 }]), null);
  assertEquals(applyStatePatch({ a: 1 }, [{ p: [], v: 2 }]), null);
  assertEquals(applyStatePatch({ a: 1 }, [{ p: ["a"] }]), null);
  // An own "__proto__" key is data, never the prototype.
  const got = applyStatePatch({}, [{ p: ["__proto__"], v: { polluted: 1 } }]);
  assertEquals(Object.getPrototypeOf(got), Object.prototype);
  assertEquals(({} as Record<string, unknown>).polluted, undefined);
});

// A value JSON does not carry — a function, a symbol, `undefined` — is ABSENT
// to a patch, exactly as JSON has it: dropped from an object, `null` in an
// array. A patch that carried one as a value lost it in transit (the wire
// frame, a journal line), the op then did not apply, and a journalled
// reaction chain broke there (review rev8).
Deno.test("a function, symbol or undefined value is absent to a patch, as JSON has it", () => {
  const f = () => 1;
  const sym = Symbol("s");
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [{ a: 1 }, { a: 1, f }],
    [{ a: 1, f }, { a: 1 }],
    [{ a: 1, f }, { a: 2, g: () => 2 }],
    [{ a: 1 }, { a: 1, s: sym, u: undefined }],
    [{ xs: [1, 2] }, { xs: [1, f, sym, undefined, 3] }],
    [{ xs: [f, 2] }, { xs: [() => 3, 2] }],
    [{ o: { f } }, { o: { f, n: 1 } }],
  ];
  for (const [base, next] of cases) {
    const wire = JSON.parse(JSON.stringify(diffState(base, next)));
    const got = applyStatePatch(JSON.parse(JSON.stringify(base)), wire);
    assertEquals(got, JSON.parse(JSON.stringify(next)), JSON.stringify(wire));
    assertEquals(
      stateDigest(got)!.digest,
      stateDigest(next)!.digest,
      "the digest the client checks agrees",
    );
  }
  assertEquals(diffState({ a: 1 }, { a: 1, f }), [], "nothing JSON would see");
});
