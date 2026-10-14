// The state-diff line shows 80 characters of each changed value. It was made
// by serializing the WHOLE value (`JSON.stringify`, then a slice) — for one
// flag flipped in a 50 000-row array, 14 ms of a 20 ms dispatch, on every
// action of a dev session. The line is now made from the head of the value
// alone, and this file is the proof that it is the SAME line: the previous
// formatter, kept here word for word, against the new one over generated
// values — and the proof that the tail is no longer read.
import { assert, assertEquals } from "@std/assert";
import { formatDiff } from "../src/diagnostics/state-diff.ts";

const MAX_VAL = 80;
function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value}n` : value;
}
/** `truncate` as it was before the head-only replacer. */
function truncateWhole(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") {
    const s = v.length > MAX_VAL ? v.slice(0, MAX_VAL) + "…" : v;
    return JSON.stringify(s);
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "bigint") return `${v}n`;
  let s: string;
  try {
    s = JSON.stringify(v, bigintSafe) ?? String(v);
  } catch {
    try {
      const seen = new WeakSet<object>();
      s = JSON.stringify(v, function (k, val) {
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
        }
        return bigintSafe(k, val);
      }) ?? String(v);
    } catch {
      s = `[unserializable ${typeof v}]`;
    }
  }
  return s.length > MAX_VAL ? s.slice(0, MAX_VAL) + "…" : s;
}
const whole = (from: unknown, to: unknown) =>
  `c: k ${truncateWhole(from)}→${truncateWhole(to)}`;
const head = (from: unknown, to: unknown) =>
  formatDiff("c", [{ key: "k", from, to }]);

/** mulberry32 — the seed is in every failure message. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A value of every kind `JSON.stringify` treats differently, sized so the
 *  80th character falls before, inside and after every kind of container. */
function gen(r: () => number, depth: number): unknown {
  const pick = (n: number) => Math.floor(r() * n);
  // Wide at the top, and now and then below it (never wide at every level).
  const size = () =>
    depth === 3 || r() < 0.04
      ? [0, 1, 7, 40, 81, 82, 83, 200][pick(8)]!
      : [0, 1, 2, 3, 5][pick(5)]!;
  const leaf = (): unknown =>
    [
      () => pick(1000) - 500,
      () => r() < 0.5,
      () => null,
      () => undefined,
      () => "s" + '"\\\n€'.repeat(pick(3)) + "x".repeat(pick(120)),
      () => BigInt(pick(1e6)),
      () => NaN,
      () => () => 1,
      () => Symbol("s"),
      () => new Date(pick(1e12)),
      () => new Map([[1, 2]]),
      () => new Set([1]),
      () => new Number(pick(9)),
      () => new String("boxed"),
      () => {
        const says = r() < 0.5 ? undefined : { j: pick(9) };
        return { toJSON: () => says };
      },
      () => ({ toJSON: (k: string) => `key:${k}` }),
    ][pick(16)]!();
  if (depth === 0 || r() < 0.35) return leaf();
  const n = size();
  // The shapes whose text is SHORTEST per entry — where a cut made one entry
  // too early shows: one character each, two for an empty container, and an
  // object most of whose keys are not written at all.
  const thin = pick(8);
  if (thin === 0) return Array.from({ length: n }, () => pick(10));
  if (thin === 1) {
    return Array.from({ length: n }, () => (r() < 0.5 ? [] : {}));
  }
  if (thin === 2) {
    const unwritten = [undefined, () => 1, Symbol("u"), {
      toJSON: () => undefined,
    }];
    return Object.fromEntries(
      Array.from(
        { length: n },
        (_, i) => [i, r() < 0.9 ? unwritten[pick(4)] : pick(10)],
      ),
    );
  }
  if (thin === 3) {
    return Object.fromEntries(
      Array.from({ length: n }, (_, i) => [i, pick(10)]),
    );
  }
  if (r() < 0.5) {
    const a: unknown[] = [];
    for (let i = 0; i < n; i++) a.push(gen(r, depth - 1));
    if (n > 3 && r() < 0.2) delete a[1]; // a hole
    return r() < 0.3 ? Object.freeze(a) : a;
  }
  const o: Record<string, unknown> = r() < 0.15 ? Object.create(null) : {};
  for (let i = 0; i < n; i++) {
    const k = ["k" + i, String(n - i), "", "__proto__", 'q"' + i][pick(5)]!;
    Object.defineProperty(o, k, {
      value: gen(r, depth - 1),
      enumerable: r() < 0.95,
      writable: true,
      configurable: true,
    });
  }
  return o;
}

Deno.test("state diff: the line made from a value's head is the line made from the whole value", () => {
  for (let seed = 1; seed <= 4000; seed++) {
    const r = rng(seed);
    const from = gen(r, 3), to = gen(r, 3);
    assertEquals(head(from, to), whole(from, to), `seed ${seed}`);
  }
});

Deno.test("state diff: a cycle and a repeated object read as they did", () => {
  for (let seed = 1; seed <= 600; seed++) {
    const r = rng(seed);
    const shared = { shared: seed };
    // The cycle is where the line still reads it: the fallback reader runs
    // for both, and marks the same repeats.
    const loop: Record<string, unknown> = { a: shared, b: shared };
    loop.self = loop;
    const tail = gen(r, 2);
    for (const v of [loop, [loop, tail], { tail: [shared, shared], loop }]) {
      assertEquals(head(v, tail), whole(v, tail), `seed ${seed}`);
    }
  }
  // One difference, on purpose: a cycle BEYOND what the line shows is not
  // found any more, so an object merely written twice in the head is shown
  // as itself rather than as `[Circular]`.
  const twice = { n: 1 };
  const far: unknown[] = [twice, twice, ...Array(200).fill(0)];
  far.push(far);
  assert(whole(far, 0).startsWith('c: k [{"n":1},"[Circular]",0,'));
  assert(head(far, 0).startsWith('c: k [{"n":1},{"n":1},0,'), head(far, 0));
});

Deno.test("state diff: what the line does not show is not read", () => {
  let read = 0;
  const row = (i: number) => ({
    id: i,
    get done() {
      read++;
      return false;
    },
  });
  const rows = Array.from({ length: 50_000 }, (_, i) => row(i));
  const dict = Object.fromEntries(rows.map((r, i) => [`k${i}`, r]));
  const line = head(rows, { nested: { dict } });
  assertEquals(line, whole(rows, { nested: { dict } }));
  read = 0;
  head(rows, { nested: { dict } });
  assert(
    read > 0 && read < 400,
    `${read} rows were read for two 80-char heads`,
  );
});
