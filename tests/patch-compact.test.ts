import { assert, assertEquals } from "@std/assert";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import type { Patch } from "immer";
import { applyPatches, enablePatches, produceWithPatches } from "immer";
import {
  compactPatches,
  narrowArrayPatches,
  narrowPatches,
  narrowStringPatches,
} from "../src/state/patch-compact.ts";
import {
  APPEND_MIN_LENGTH,
  applyWirePatches,
  type WirePatch,
} from "../src/protocol/patch-ops.ts";

// Helper to build a patch
enablePatches();

const replace = (path: (string | number)[], value: unknown): Patch => ({
  op: "replace",
  path,
  value,
});
const add = (path: (string | number)[], value: unknown): Patch => ({
  op: "add",
  path,
  value,
});
const remove = (path: (string | number)[]): Patch => ({
  op: "remove",
  path,
});

Deno.test("compactPatches: empty array", () => {
  assertEquals(compactPatches([]), []);
});

Deno.test("compactPatches: single op passes through", () => {
  const ops = [replace(["a"], 1)];
  assertEquals(compactPatches(ops), ops);
});

Deno.test("compactPatches: same-path replace collapses to last-write-wins", () => {
  const ops = [
    replace(["counter", "count"], 1),
    replace(["counter", "count"], 2),
    replace(["counter", "count"], 3),
  ];
  assertEquals(compactPatches(ops), [replace(["counter", "count"], 3)]);
});

Deno.test("compactPatches: different paths preserved in order", () => {
  const ops = [
    replace(["a"], 1),
    replace(["b"], 2),
    replace(["c"], 3),
  ];
  assertEquals(compactPatches(ops), ops);
});

Deno.test("compactPatches: mixed paths — duplicates collapsed, unique kept", () => {
  const ops = [
    replace(["a"], 1),
    replace(["b"], 10),
    replace(["a"], 2),
    replace(["c"], 30),
    replace(["b"], 20),
    replace(["a"], 3),
  ];
  assertEquals(compactPatches(ops), [
    replace(["c"], 30),
    replace(["b"], 20),
    replace(["a"], 3),
  ]);
});

Deno.test("compactPatches: add ops never collapsed", () => {
  const ops = [
    add(["items", 0], "a"),
    add(["items", 1], "b"),
    add(["items", 0], "c"),
  ];
  assertEquals(compactPatches(ops), ops);
});

Deno.test("compactPatches: remove ops never collapsed", () => {
  const ops = [
    remove(["items", 0]),
    remove(["items", 0]),
  ];
  assertEquals(compactPatches(ops), ops);
});

Deno.test("compactPatches: mixed op types — replace collapsed, add/remove preserved", () => {
  const ops = [
    replace(["price"], 100),
    add(["log", 0], "entry1"),
    replace(["price"], 200),
    add(["log", 1], "entry2"),
    replace(["price"], 300),
  ];
  assertEquals(compactPatches(ops), [
    add(["log", 0], "entry1"),
    add(["log", 1], "entry2"),
    replace(["price"], 300),
  ]);
});

Deno.test("compactPatches: deep nested paths disambiguated", () => {
  // ["a", "b"] vs ["a", "c"] are different paths
  const ops = [
    replace(["a", "b"], 1),
    replace(["a", "c"], 2),
    replace(["a", "b"], 3),
  ];
  const result = compactPatches(ops);
  assertEquals(result, [
    replace(["a", "c"], 2),
    replace(["a", "b"], 3),
  ]);
});

Deno.test("compactPatches: large object values collapsed correctly", () => {
  const big1 = { items: Array.from({ length: 100 }, (_, i) => i) };
  const big2 = { items: Array.from({ length: 100 }, (_, i) => i + 100) };
  const ops = [
    replace(["data"], big1),
    replace(["data"], big2),
  ];
  const result = compactPatches(ops);
  assertEquals(result.length, 1);
  assertEquals(result[0]!.value, big2);
});

// ── narrowArrayPatches ──────────────────────────────────────────────────────
// `s.items = [...s.items, ...batch]` is as idiomatic as `push`, but Immer can
// only describe it as "replace the whole array" — so a growing list re-shipped
// itself on every commit. These pin the rewrite AND, more importantly, that it
// declines every case where the prefix is not provably intact: getting this
// wrong loses state rather than bytes.

Deno.test("narrowArrayPatches: a grown array travels as its appends", () => {
  const a = { x: 1 }, b = { x: 2 }, c = { x: 3 };
  const prev = { items: [a, b], n: 2 };
  const ops = narrowArrayPatches(prev, [
    replace(["items"], [a, b, c]),
    replace(["n"], 3),
  ]);
  assertEquals(ops, [
    { op: "add", path: ["items", 2], value: c },
    replace(["n"], 3),
  ]);
});

Deno.test("narrowArrayPatches: applying the rewrite equals applying the original", () => {
  // The only property that really matters. Immer's own applyPatches is the
  // judge, on the shapes an app actually produces.
  const cases: Array<[unknown[], unknown[]]> = [
    [[1, 2, 3, 4], [1, 2, 3, 4, 5]],
    [[1, 2, 3, 4], [1, 2, 3, 4, 5, 6]],
    [["a"], ["a", "b"]], // grows, but tail >= prefix → left as replace
    [[], [1]], // empty prefix → left as replace
    [[1, 2, 3], [1, 2]], // shrank
    [[1, 2, 3], [3, 2, 1]], // reordered
    [[1, 2, 3], [1, 9, 3, 4]], // edited in place while growing
  ];
  for (const [before, after] of cases) {
    const prev = { items: before };
    const original = [replace(["items"], after)];
    const narrowed = narrowArrayPatches(prev, original);
    assertEquals(
      applyPatches(prev, narrowed),
      applyPatches(prev, original),
      `${JSON.stringify(before)} → ${JSON.stringify(after)}`,
    );
  }
});

Deno.test("narrowArrayPatches: identity, not equality, decides", () => {
  // Objects that merely LOOK like the old ones are a fresh array, and a fresh
  // array may have been rebuilt from anything. Only `===` proves the prefix
  // survived, and that is exactly what spreading preserves.
  const prev = { items: [{ x: 1 }] };
  const ops = [replace(["items"], [{ x: 1 }, { x: 2 }])];
  assertEquals(narrowArrayPatches(prev, ops), ops, "left alone");
});

Deno.test("narrowArrayPatches: nested paths and non-arrays are handled", () => {
  const a = { x: 1 }, b = { x: 2 };
  const prev = { deep: { list: [a] }, obj: { k: 1 } };
  // A path that no longer resolves, and a replace whose value is not an array,
  // must both pass through untouched rather than throw.
  assertEquals(
    narrowArrayPatches(prev, [replace(["missing", "gone"], [1, 2])]),
    [replace(["missing", "gone"], [1, 2])],
  );
  assertEquals(
    narrowArrayPatches(prev, [replace(["obj"], { k: 2 })]),
    [replace(["obj"], { k: 2 })],
  );
  // Nested list still narrows, with the full path preserved.
  const grown = [a, b, { x: 3 }];
  assertEquals(
    narrowArrayPatches({ deep: { list: [a, b] } }, [
      replace(["deep", "list"], grown),
    ]),
    [{ op: "add", path: ["deep", "list", 2], value: grown[2] }],
  );
});

Deno.test("narrowArrayPatches: untouched patch lists are returned as-is", () => {
  const ops = [replace(["a"], 1), add(["b", 0], 2)];
  assertEquals(narrowArrayPatches({ a: 0, b: [] }, ops) === ops, true);
});

// Shrinks and middle edits are the other half of the same shape: `filter` and
// `slice` keep most of a list, and describing them as "here is the whole list
// again" is what made a growing cell expensive in the first place.

Deno.test("narrowArrayPatches: a filtered list travels as its removals", () => {
  const [a, b, c, d] = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];
  const prev = { items: [a, b, c, d] };
  // Dropping ONE from the middle — identity is preserved for the rest.
  assertEquals(
    narrowArrayPatches(prev, [replace(["items"], [a, b, d])]),
    [{ op: "remove", path: ["items", 2] }],
  );
  // Truncation from the end (`slice`). Indices are against the array AS THE
  // OPS APPLY: dropping c then d is "remove 2" twice, because d slides down
  // into the slot c vacated. Equivalence is the contract, not index shape —
  // the randomized check below is what enforces it.
  assertEquals(
    narrowArrayPatches(prev, [replace(["items"], [a, b])]),
    [{ op: "remove", path: ["items", 2] }, {
      op: "remove",
      path: ["items", 2],
    }],
  );
  // Scattered removals — the shape a real `filter` produces, and the one the
  // earlier prefix/suffix-only version had to give up on.
  assertEquals(
    narrowArrayPatches(prev, [replace(["items"], [b, d])]),
    [
      { op: "remove", path: ["items", 0] },
      { op: "remove", path: ["items", 1] },
    ],
  );
  // An insertion in the middle.
  const e = { n: 9 };
  assertEquals(
    narrowArrayPatches(prev, [replace(["items"], [a, b, e, c, d])]),
    [{ op: "add", path: ["items", 2], value: e }],
  );
});

Deno.test("narrowArrayPatches: randomized edits always apply to the same array", () => {
  // The property that matters, over shapes nobody thinks to write by hand.
  // Deterministic PRNG so a failure is reproducible from the seed alone —
  // fixed by default (CI must be reproducible from its own commit), and
  // overridable so a sweep can explore past these 400 programs:
  // `for s in 3 17 501; do FUZZ_SEED=$s deno test -A tests/patch-compact.test.ts; done`
  let seed = fuzzEnvInt("FUZZ_SEED", 0x2f6e2b1) & 0x7fffffff;
  const SEED = seed;
  const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 400, 1);
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (n: number) => Math.floor(rnd() * n);

  for (let round = 0; round < ROUNDS; round++) {
    const len = pick(12);
    const before = Array.from({ length: len }, (_, i) => ({ id: i }));
    // Build `next` by a random sequence of keeps, drops and inserts — keeps
    // reuse the SAME object, which is what identity-based diffing relies on.
    const next: unknown[] = [];
    for (const item of before) {
      const r = rnd();
      if (r < 0.15) continue; // drop
      if (r < 0.25) next.push({ id: 1000 + pick(50) }); // replace with a new object
      else next.push(item); // keep
      if (rnd() < 0.15) next.push({ id: 2000 + pick(50) }); // insert after
    }
    if (rnd() < 0.3) next.push({ id: 3000 + pick(50) }); // append

    const prev = { items: before };
    const original = [replace(["items"], next)];
    const narrowed = narrowArrayPatches(prev, original);
    assertEquals(
      applyPatches(prev, narrowed),
      applyPatches(prev, original),
      `FUZZ_SEED=${SEED} round ${round}: ${
        JSON.stringify(before.map((x) => x.id))
      } → ${JSON.stringify(next.map((x) => (x as { id: number }).id))}`,
    );
  }
});

Deno.test("narrowArrayPatches: the cost model prefers whichever is smaller", () => {
  const big = Array.from({ length: 10_000 }, (_, i) => ({ id: i }));
  // Truncating 10k to one item: 9,999 removes would be a far bigger message
  // than the one-element array — keep the replacement.
  assertEquals(
    narrowArrayPatches({ items: big }, [replace(["items"], [big[0]])]),
    [replace(["items"], [big[0]])],
  );
  // Dropping ONE of 10k is the opposite case — one index, not 9,999 elements.
  const minusOne = big.filter((_, i) => i !== 5000);
  assertEquals(
    narrowArrayPatches({ items: big }, [replace(["items"], minusOne)]),
    [{ op: "remove", path: ["items", 5000] }],
  );
  // Rebuilding a list from all-new objects saves nothing — every element ships
  // either way, so the replacement stays.
  const fresh = big.slice(0, 5).map((x) => ({ ...x }));
  assertEquals(
    narrowArrayPatches({ items: big.slice(0, 5) }, [replace(["items"], fresh)]),
    [replace(["items"], fresh)],
  );
});

Deno.test("narrowArrayPatches: a reorder is left as a replacement", () => {
  // Immer's patch format has no `move`, so a permutation costs a remove plus
  // an add per element — never cheaper than the array. Bailing keeps the
  // rewrite from turning a cheap message into an expensive one.
  const [a, b, c] = [{ n: 1 }, { n: 2 }, { n: 3 }];
  const ops = [replace(["items"], [c, b, a])];
  assertEquals(narrowArrayPatches({ items: [a, b, c] }, ops), ops);
  // A rotation is the same story.
  const rot = [replace(["items"], [b, c, a])];
  assertEquals(narrowArrayPatches({ items: [a, b, c] }, rot), rot);
});

Deno.test("narrowArrayPatches: repeated identities are not reasoned about", () => {
  // With the same element twice, "is this one still needed later" has no single
  // answer, so the whole-array replacement stands. Primitives repeat often.
  const ops = [replace(["items"], [1, 1, 2, 3])];
  assertEquals(narrowArrayPatches({ items: [1, 1, 2] }, ops), ops);
  const x = { n: 1 };
  const dup = [replace(["items"], [x, x])];
  assertEquals(narrowArrayPatches({ items: [x] }, dup), dup);
});

// A batch can carry more than one op for the same path, and every op after the
// first is relative to its PREDECESSOR'S result. Diffing them all against the
// original state appended the same element twice and left the array corrupt —
// found by attacking the narrowing rather than by any caller hitting it, since
// Immer emits one op per path per commit. The contract has to hold anyway: a
// merged or replayed patch list is an obvious thing to hand this function.
Deno.test("narrowArrayPatches: later ops on a path see the earlier ones", () => {
  const [a, b, c, d] = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];
  const prev = { items: [a, b] };

  const twoReplaces = [
    replace(["items"], [a, b, c]),
    replace(["items"], [a, b, c, d]),
  ];
  assertEquals(
    applyPatches(prev, narrowArrayPatches(prev, twoReplaces)),
    applyPatches(prev, twoReplaces),
  );

  // A replacement AFTER a hand-written add: the add moved the array, so the
  // replacement can no longer be diffed against anything known.
  const addThenReplace = [
    add(["items", 2], c),
    replace(["items"], [a, b, c, d]),
  ];
  assertEquals(
    applyPatches(prev, narrowArrayPatches(prev, addThenReplace)),
    applyPatches(prev, addThenReplace),
  );

  // …and a write INSIDE an element invalidates the array that holds it.
  const innerThenReplace = [
    replace(["items", 0, "n"], 99),
    replace(["items"], [a, b, c]),
  ];
  assertEquals(
    applyPatches(prev, narrowArrayPatches(prev, innerThenReplace)),
    applyPatches(prev, innerThenReplace),
  );

  // Nested paths track independently of their parents.
  const deep = { deep: { list: [a] } };
  const nested = [
    replace(["deep", "list"], [a, b]),
    replace(["deep", "list"], [a, b, c]),
  ];
  assertEquals(
    applyPatches(deep, narrowArrayPatches(deep, nested)),
    applyPatches(deep, nested),
  );
});

// ── Overlapping paths in one batch (alpha40 review). The `current`/`untracked`
// machinery exists to make merged/replayed patch lists safe; these three
// shapes each reproduced silent state corruption before the base lookup walked
// ancestors. Ground truth is always Immer's own applyPatches.

Deno.test("narrowArrayPatches: descendant replace, then ancestor replace resurrecting an identity", () => {
  const I = [1, 2];
  const M = { m: 1 };
  const N = { n: 1 };
  const prev = { items: [I, M, N] };
  const ops = [
    replace(["items", 0], [9]), // items[0] := fresh
    replace(["items"], [I, M]), // I resurrected by identity, N dropped
  ];
  assertEquals(
    applyPatches(prev, narrowArrayPatches(prev, ops)),
    applyPatches(prev, ops),
  );
});

Deno.test("narrowArrayPatches: ancestor replace, then descendant replace narrows within it", () => {
  const p = { p: 1 }, q = { q: 1 }, r = { r: 1 };
  const prev = { rows: [[p, q]] };
  const other = [{ z: 1 }];
  const ops = [
    replace(["rows"], [other]), // rows := [other]
    replace(["rows", 0], [...other, r]), // rows[0] grew — base is `other`, not prev
  ];
  const narrowed = narrowArrayPatches(prev, ops);
  assertEquals(applyPatches(prev, narrowed), applyPatches(prev, ops));
  // …and the second op DID narrow (resolved inside the first op's value).
  assertEquals(narrowed[1], { op: "add", path: ["rows", 0, 1], value: r });
});

Deno.test("narrowArrayPatches: an ancestor replace clears stale descendant tracking", () => {
  const a = { a: 1 }, b = { b: 1 }, c = { c: 1 }, d = { d: 1 };
  const prev = { rows: [[a]] };
  const fresh = [[{ z: 1 }]]; // all-new → the ancestor diff keeps the replacement
  const ops = [
    replace(["rows", 0], [a, b]), // narrows; tracks rows.0 = [a,b]
    replace(["rows"], fresh), // whole rows replaced — rows.0 is fresh[0] now
    replace(["rows", 0], [a, b, c, d]), // must NOT diff against the stale [a,b]
  ];
  assertEquals(
    applyPatches(prev, narrowArrayPatches(prev, ops)),
    applyPatches(prev, ops),
  );
});

Deno.test("narrowArrayPatches: a ROOT replace invalidates every tracked path", () => {
  const a = { a: 1 }, b = { b: 1 };
  const prev = { items: [a] };
  const ops: Patch[] = [
    replace(["items"], [a, b]), // tracks "items"
    { op: "replace", path: [], value: { items: [b] } }, // whole state swapped
    replace(["items"], [a, b]), // base is [b] now, not prev.items or [a,b]
  ];
  assertEquals(
    applyPatches(prev, narrowArrayPatches(prev, ops)),
    applyPatches(prev, ops),
  );
});

Deno.test("narrowArrayPatches: randomized SHUFFLES never slip through as edits", () => {
  // The reorder bail is load-bearing: a shuffle mis-read as remove+add would
  // reconstruct the wrong order. The other randomized test never permutes.
  // Same seeding contract as above (`FUZZ_SEED` sweeps, default is fixed).
  let seed = fuzzEnvInt("FUZZ_SEED", 0x51f0a3d) & 0x7fffffff;
  const SEED = seed;
  const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 1000, 1);
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (n: number) => Math.floor(rnd() * n);

  for (let round = 0; round < ROUNDS; round++) {
    const len = 2 + pick(10);
    const before = Array.from({ length: len }, (_, i) => ({ id: i }));
    const next = [...before];
    for (let i = next.length - 1; i > 0; i--) { // Fisher–Yates
      const j = pick(i + 1);
      [next[i], next[j]] = [next[j]!, next[i]!];
    }
    if (pick(3) === 0) next.splice(pick(next.length), 1); // sometimes drop too
    if (pick(3) === 0) {
      next.splice(pick(next.length + 1), 0, { id: 1000 + round });
    }
    const prev = { items: before };
    const ops = [replace(["items"], next)];
    assertEquals(
      applyPatches(prev, narrowArrayPatches(prev, ops)),
      applyPatches(prev, ops),
      `FUZZ_SEED=${SEED} round ${round}`,
    );
  }
});

Deno.test("narrowArrayPatches: NaN and -0 identities do not corrupt", () => {
  const prev = { xs: [NaN, 1, 2] };
  for (
    const next of [[NaN, 1], [1, 2], [NaN, 1, 2, 3], [-0, NaN, 1, 2]] as const
  ) {
    const ops = [replace(["xs"], [...next])];
    assertEquals(
      applyPatches(prev, narrowArrayPatches(prev, ops)),
      applyPatches(prev, ops),
    );
  }
});

// ── narrowStringPatches / narrowPatches ─────────────────────────────────────
// A streamed reply is `s.reply += chunk`, which Immer can only describe as
// "replace the whole string" — quadratic over the stream. A grown string
// travels as `{ op: "append", value: <suffix> }` instead, decided at patch
// generation (the only place the previous value is in hand) and applied by
// every consumer through applyWirePatches (protocol/patch-ops.ts).

const LONG = "x".repeat(APPEND_MIN_LENGTH + 100);

Deno.test("narrowStringPatches: a suffix growth travels as its suffix", () => {
  const prev = { reply: LONG, n: 1 };
  const ops = narrowStringPatches(prev, [
    replace(["reply"], LONG + " more tokens"),
    replace(["n"], 2),
  ]);
  assertEquals(ops, [
    { op: "append", path: ["reply"], value: " more tokens" },
    replace(["n"], 2),
  ]);
  // …and it applies to exactly the new value.
  assertEquals(applyWirePatches(prev, ops), {
    reply: LONG + " more tokens",
    n: 2,
  });
});

Deno.test("narrowStringPatches: a non-suffix change stays a replace", () => {
  const prev = { reply: LONG };
  for (
    const next of [
      "y" + LONG.slice(1) + "tail", // edited prefix
      LONG.slice(0, -1), // truncated
      LONG, // unchanged (Immer would not emit it; the rewrite must not either)
      "", // reset
      LONG.slice(0, 10) + "z".repeat(400), // same length class, different body
    ]
  ) {
    const ops = [replace(["reply"], next)];
    assertEquals(
      narrowStringPatches(prev, ops),
      ops,
      JSON.stringify(next.slice(0, 12)),
    );
  }
});

Deno.test("narrowStringPatches: below the floor a string stays a replace", () => {
  const short = "s".repeat(APPEND_MIN_LENGTH - 1);
  // Old below the floor, new above: still a replace (the old value proves
  // nothing worth an op at that size).
  const grow = [replace(["reply"], short + "!".repeat(50))];
  assertEquals(narrowStringPatches({ reply: short }, grow), grow);
  // Both tiny: a replace.
  const tiny = [replace(["reply"], "ab")];
  assertEquals(narrowStringPatches({ reply: "a" }, tiny), tiny);
  // Exactly at the floor on the OLD side is the first size that appends.
  const atFloor = "f".repeat(APPEND_MIN_LENGTH);
  assertEquals(
    narrowStringPatches({ reply: atFloor }, [
      replace(["reply"], atFloor + "+"),
    ]),
    [{ op: "append", path: ["reply"], value: "+" }],
  );
});

Deno.test("narrowStringPatches: a base touched earlier in the list is not trusted", () => {
  const prev = { rows: [{ text: LONG }, { text: LONG + "B" }] };
  // A removal at index 0 shifts the rows: `rows[0].text` in `prev` is NOT the
  // row the later replace writes into. It must stay a replace.
  const ops: Patch[] = [
    remove(["rows", 0]),
    replace(["rows", 0, "text"], LONG + "B!"),
  ];
  assertEquals(narrowStringPatches(prev, ops), ops);
  // An ancestor replaced earlier: same rule.
  const ops2: Patch[] = [
    replace(["rows"], [{ text: LONG }]),
    replace(["rows", 0, "text"], LONG + "!"),
  ];
  assertEquals(narrowStringPatches(prev, ops2), ops2);
  // And a descendant/root written earlier.
  const ops3: Patch[] = [
    replace([], { reply: LONG }),
    replace(["reply"], LONG + "!"),
  ];
  assertEquals(narrowStringPatches({ reply: LONG }, ops3), ops3);
});

Deno.test("compactPatches: an append followed by a replace at its path is dropped", () => {
  const ops: WirePatch[] = [
    { op: "append", path: ["c", "reply"], value: "abc" },
    replace(["c", "reply"], "reset"),
  ];
  assertEquals(compactPatches(ops), [replace(["c", "reply"], "reset")]);
  // …under a replaced ancestor too.
  const ops2: WirePatch[] = [
    { op: "append", path: ["c", "reply"], value: "abc" },
    replace(["c"], { reply: "" }),
  ];
  assertEquals(compactPatches(ops2), [replace(["c"], { reply: "" })]);
  // A replace THEN an append keeps both, in order — the append extends the
  // replaced value; two appends keep both.
  const ops3: WirePatch[] = [
    replace(["c", "reply"], LONG),
    { op: "append", path: ["c", "reply"], value: "1" },
    { op: "append", path: ["c", "reply"], value: "2" },
  ];
  assertEquals(compactPatches(ops3), ops3);
  assertEquals(
    applyWirePatches({ c: { reply: "old" } }, compactPatches(ops3)),
    { c: { reply: LONG + "12" } },
  );
  // An append is never a SUPERSEDER: an earlier replace at its path stands.
  const ops4: WirePatch[] = [
    replace(["c", "reply"], LONG),
    { op: "append", path: ["c", "reply"], value: "!" },
  ];
  assertEquals(compactPatches(ops4).length, 2);
});

Deno.test("narrowPatches: randomized string programs apply to the same value", () => {
  // Property, not cases: over random grow/edit/reset/truncate programs the
  // narrowed list, applied with the wire applier, equals Immer applying the
  // original — and the rewrite fires often enough to be tested at all.
  const seed = fuzzEnvInt("AIO_STRNARROW_SEED", 4242);
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
  const int = (n: number) => Math.floor(rnd() * n);
  let appends = 0;
  let prev: Record<string, unknown> = {
    a: LONG,
    b: "b".repeat(300),
    items: [{ t: LONG }],
  };
  for (let round = 0; round < 400; round++) {
    const [next, ops] = produceWithPatches(prev, (d) => {
      const n = 1 + int(3);
      for (let i = 0; i < n; i++) {
        const key = rnd() < 0.5 ? "a" : "b";
        const cur = d[key] as string;
        switch (int(5)) {
          case 0:
          case 1:
            d[key] = cur + "c".repeat(1 + int(120));
            break;
          case 2:
            d[key] = cur.slice(0, Math.max(0, cur.length - 1 - int(40)));
            break;
          case 3:
            d[key] = int(2) ? "" : "r".repeat(APPEND_MIN_LENGTH + int(80));
            break;
          default: {
            const items = d.items as { t: string }[];
            if (int(3) === 0) items.push({ t: LONG + int(9) });
            else if (items.length > 0) {
              if (int(2)) items[0]!.t += "z".repeat(1 + int(30));
              else items.shift();
            }
          }
        }
      }
    });
    const narrowed = narrowPatches(prev, ops as Patch[]);
    for (const op of narrowed) if (op.op === "append") appends++;
    assertEquals(
      applyWirePatches(prev, narrowed),
      applyPatches(prev, ops as Patch[]),
      `seed=${seed} round=${round} ops=${JSON.stringify(ops)}`,
    );
    assertEquals(applyWirePatches(prev, narrowed), next);
    prev = next as Record<string, unknown>;
  }
  assert(
    appends > 50,
    `only ${appends} appends in 400 rounds — the program is not reaching the rewrite`,
  );
});
