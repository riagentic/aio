// `visible: { exclude: ["accounts.encSecKey"] }` is a SECRET filter, and its
// contract has two rules a reader has to be told: a path through an array
// applies to every element, and — once the head segment has matched — the rest
// of the path applies to the LITERAL key AND to every record below it (a
// records-by-id map is the most ordinary state shape there is).
//
// Four holes have shipped in this area, the last of them attacker-reachable:
// descending only where the head was ABSENT meant one account registered as
// `encSecKey` switched the filter off for every other account. So it is worth
// a property rather than examples.
//
// Two-sided, because a filter can fail in both directions: a secret on the
// targeted path must ALWAYS vanish, and a field the path does not reach must
// ALWAYS survive — over-removal silently empties a UI. The second half is
// checked against an INDEPENDENT reference: every leaf chain of the input is
// enumerated and decided by the rule stated as a sentence ("the segments
// appear in the chain in order, an array index consuming none"), which is a
// different formulation from the recursive rebuild under test.
//
// The generator leans on what breaks such functions: arrays of arrays
// (element-wise must recurse through both), arrays whose elements do not all
// carry the path, nulls and scalars mid-path, and neighbours named
// `constructor` / `0` / `toString` where `in` and object spread get subtle.
import { assert, assertEquals } from "@std/assert";
import { deepExcludePaths } from "../src/state/state-filter.ts";

const SECRET = "SECRET-MUST-VANISH";
const DECOY = "DECOY-MUST-SURVIVE";

/** THE RULE, said as a sentence over one leaf chain (array indices are not in
 *  the chain — an index consumes no segment). Matching greedily and stopping
 *  at the first completion is exact: a completed match removes the whole
 *  subtree below it. */
function excludedByRule(chain: readonly string[], segs: string[]): boolean {
  let j = 0;
  for (const k of chain) {
    if (j < segs.length && k === segs[j]) j++;
    if (j === segs.length) return true;
  }
  return false;
}

type Leaf = { chain: string[]; value: unknown };

/** Every leaf of `v`, as (chain of OBJECT keys, value). */
function leaves(v: unknown, chain: string[], out: Leaf[]): void {
  if (v === null || typeof v !== "object") {
    out.push({ chain, value: v });
    return;
  }
  if (Array.isArray(v)) {
    for (const el of v) leaves(el, chain, out);
    return;
  }
  for (const [k, val] of Object.entries(v)) leaves(val, [...chain, k], out);
}

const leafKey = (l: Leaf) => `${l.chain.join(".")}=${JSON.stringify(l.value)}`;

function tally(ls: Leaf[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of ls) m.set(leafKey(l), (m.get(leafKey(l)) ?? 0) + 1);
  return m;
}

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function build(
  segs: string[],
  rnd: () => number,
  depth = 0,
): unknown {
  if (segs.length === 0) return SECRET;
  const head = segs[0]!;
  const rest = segs.slice(1);
  const leaf = segs[segs.length - 1]!;
  const node: Record<string, unknown> = {};
  const r = rnd();
  node[head] = r < 0.2 && depth < 3
    ? [[build(rest, rnd, depth + 1)], [
      build(rest, rnd, depth + 1),
      build(rest, rnd, depth + 1),
    ]]
    : r < 0.4 && depth < 3
    ? [
      build(rest, rnd, depth + 1),
      { unrelated: 1 },
      7,
      null,
      build(rest, rnd, depth + 1),
    ]
    : build(rest, rnd, depth + 1);
  // Same LEAF NAME, on and off the targeted path — which of these the rule
  // reaches is exactly what the reference decides, per chain.
  if (rnd() < 0.6) node["other"] = { [leaf]: DECOY };
  if (rnd() < 0.5) node["list"] = [{ [leaf]: DECOY }];
  if (rnd() < 0.4) node["plain"] = [1, "x", null, true];
  if (rnd() < 0.3) node["constructor"] = { [leaf]: DECOY };
  if (rnd() < 0.3) node["0"] = { [leaf]: DECOY };
  if (rnd() < 0.2) node["toString"] = DECOY;
  if (rnd() < 0.2) node[head + "x"] = { [leaf]: DECOY };
  return node;
}

Deno.test("deepExclude property: the secret always goes, and only what the rule names goes with it", () => {
  let shapes = 0;
  let removedChains = 0;
  let keptChains = 0;
  for (const seed of [1, 2, 3, 7, 8, 9, 10]) {
    const rnd = makeRng(seed);
    for (let i = 0; i < 120; i++) {
      const depth = 1 + Math.floor(rnd() * 3);
      const segs = Array.from({ length: depth }, (_, k) => `k${k}`);
      segs[segs.length - 1] = "secret";
      const input = build(segs, rnd);
      const inText = JSON.stringify(input);
      const output = deepExcludePaths(input, [segs]);
      const outText = JSON.stringify(output);
      const where = `seed ${seed} #${i} on ${segs.join(".")}\n  in : ${
        inText.slice(0, 240)
      }\n  out: ${outText.slice(0, 240)}`;
      shapes++;

      assert(!outText.includes(SECRET), `a secret survived — ${where}`);

      // The other direction, against the rule stated independently: every
      // input leaf the rule does not name is still there, with its value, at
      // its chain — and nothing was invented.
      const before: Leaf[] = [];
      leaves(input, [], before);
      const after: Leaf[] = [];
      leaves(output, [], after);
      const got = tally(after);
      const want = new Map<string, number>();
      for (const l of before) {
        if (excludedByRule(l.chain, segs)) {
          removedChains++;
          continue;
        }
        keptChains++;
        want.set(leafKey(l), (want.get(leafKey(l)) ?? 0) + 1);
      }
      const diff = [...want]
        .filter(([k, n]) => (got.get(k) ?? 0) !== n)
        .map(([k, n]) => `${k} — want ${n}, got ${got.get(k) ?? 0}`)
        .concat(
          [...got].filter(([k]) => !want.has(k)).map(([k]) =>
            `${k} — invented`
          ),
        );
      assertEquals(
        diff.join("\n"),
        "",
        `the output breaks the rule — ${where}`,
      );
    }
  }
  // VERIFY THE INSTRUMENT: a generator that produced nothing, or one whose
  // chains are all on (or all off) the path, would pass while covering
  // nothing.
  assertEquals(shapes, 840, "the generator must actually produce shapes");
  assert(removedChains > 500, `the rule must remove things (${removedChains})`);
  assert(keptChains > 500, `…and keep things (${keptChains})`);
});

// The attacker-reachable shape, stated once as an example: `accounts` is keyed
// by a user-chosen id, and one account named after the excluded FIELD used to
// take the literal branch and leak every other account's secret.
Deno.test("deepExclude: a record id equal to the field name removes both readings", () => {
  const state = {
    accounts: {
      encSecKey: { note: "an account a user named after the field" },
      alice: { encSecKey: "SECRET-alice", name: "a" },
    },
  };
  assertEquals(deepExcludePaths(state, [["accounts", "encSecKey"]]), {
    accounts: { alice: { name: "a" } },
  });
});

// `in` walks the prototype chain, so `"constructor" in obj` is true for every
// plain object — the literal branch fired on an object that has no such own
// field, and nothing was removed anywhere.
Deno.test("deepExclude: a prototype-chain name is an ordinary field name", () => {
  for (const head of ["constructor", "__proto__", "toString", "valueOf"]) {
    const state = { a: { alice: { [head]: "SECRET-x", keep: 1 } } };
    const out = JSON.stringify(deepExcludePaths(state, [["a", head]]));
    assertEquals(
      out.includes("SECRET-x"),
      false,
      `exclude a.${head} left the field in place: ${out}`,
    );
    assert(out.includes("keep"), `…and the rest must survive: ${out}`);
  }
});

// A path the state does not reach leaves the state alone — the container
// reading only starts once a segment has matched.
Deno.test("deepExclude: a sibling branch is not touched", () => {
  const state = { a: { q: 1 }, other: { b: "kept", deep: { b: "kept too" } } };
  assertEquals(deepExcludePaths(state, [["a", "b"]]), state);
});

// The rule the array case exists for, stated once as an example so a reader
// does not have to run the generator to see it.
Deno.test("deepExclude: a path through an array applies to every element", () => {
  const rows = {
    rows: [
      { id: 1, secret: "a" },
      { id: 2 },
      { id: 3, secret: "c" },
    ],
  };
  assertEquals(deepExcludePaths(rows, [["rows", "secret"]]), {
    rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
  });
  // …and an untouched branch keeps referential identity
  const keep = { a: { b: 1 }, drop: { secret: 1 } };
  const out = deepExcludePaths(keep, [["drop", "secret"]]) as typeof keep;
  assertEquals(out.a, keep.a);
  assert(out.a === keep.a, "untouched branches are not cloned");
});
